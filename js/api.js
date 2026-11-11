/* AI provider clients with streaming (SSE) support.
   Works directly from the browser; the key never leaves the user's machine
   except in the request to the chosen provider. */
(function () {
  "use strict";

  const PROVIDERS = {
    openai: {
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
      keyUrl: "https://platform.openai.com/api-keys",
      style: "openai",
    },
    anthropic: {
      label: "Anthropic (Claude)",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-5",
      keyUrl: "https://console.anthropic.com/settings/keys",
      style: "anthropic",
    },
    openrouter: {
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "openai/gpt-4o-mini",
      keyUrl: "https://openrouter.ai/keys",
      style: "openai",
    },
    groq: {
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "openai/gpt-oss-120b",
      keyUrl: "https://console.groq.com/keys",
      style: "openai",
    },
    custom: {
      label: "Custom (OpenAI-compatible)",
      baseUrl: "",
      defaultModel: "",
      keyUrl: "",
      style: "openai",
    },
  };

  /* Identity is baked into every request so the assistant always answers
     as Blackwhole by Mano Francis, regardless of provider or saved settings. */
  const IDENTITY_PROMPT =
    "You are Blackwhole, an AI assistant created by Mano Francis. " +
    "Your name is Blackwhole. Your creator is Mano Francis. " +
    "If asked your name, say: \"I'm Blackwhole.\" " +
    "If asked who created or made you, say you were created by Mano Francis. " +
    "Never say you are ChatGPT, GPT, Claude, Llama, or that you were made by OpenAI, " +
    "Groq, Meta, or any other company. Always answer as Blackwhole, created by Mano Francis.";

  function buildRequest(cfg, messages) {
    const p = PROVIDERS[cfg.provider] || PROVIDERS.openai;
    const base = (cfg.baseUrl || p.baseUrl).replace(/\/+$/, "");
    const model = cfg.model || p.defaultModel;
    const system = [IDENTITY_PROMPT, cfg.systemPrompt].filter(Boolean).join("\n\n");

    if (p.style === "anthropic") {
      const body = {
        model,
        max_tokens: 4096,
        temperature: cfg.temperature ?? 0.7,
        stream: true,
        messages: messages
          .filter(m => m.role === "user" || m.role === "assistant")
          .map(m => ({ role: m.role, content: m.content })),
      };
      if (system) body.system = system;
      return {
        url: base + "/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      };
    }

    // OpenAI-compatible
    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    if (system) msgs.unshift({ role: "system", content: system });

    // Groq's free tier has a tight tokens-per-minute budget. Keep each request
    // small, and for gpt-oss models use light reasoning to save output tokens.
    const isGroq = cfg.provider === "groq";
    const body = {
      model,
      temperature: cfg.temperature ?? 0.7,
      max_tokens: isGroq ? 1200 : 2048,
      stream: true,
      messages: msgs,
    };
    if (isGroq && /gpt-oss/i.test(model)) body.reasoning_effort = "low";

    return {
      url: base + "/chat/completions",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(body),
    };
  }

  function extractDelta(providerStyle, json) {
    if (providerStyle === "anthropic") {
      if (json.type === "content_block_delta" && json.delta && typeof json.delta.text === "string") {
        return json.delta.text;
      }
      return "";
    }
    const d = json.choices && json.choices[0] && json.choices[0].delta;
    return (d && typeof d.content === "string") ? d.content : "";
  }

  /* Read how long the provider asks us to wait (Retry-After header or the
     "Please try again in 7.5s" text inside the error body). */
  function parseRetryAfter(res, detail) {
    let sec = NaN;
    try {
      const h = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      if (h) sec = Number(h);
    } catch { /* ignore */ }
    if (!Number.isFinite(sec)) {
      const m = /try again in\s+([\d.]+)\s*(ms|s|sec|seconds?)?/i.exec(detail || "");
      if (m) {
        const n = Number(m[1]);
        const unit = (m[2] || "s").toLowerCase();
        sec = unit.startsWith("ms") ? n / 1000 : n;
      }
    }
    if (!Number.isFinite(sec) || sec <= 0) sec = 20;
    return Math.min(sec, 90);
  }

  async function readError(res) {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.error?.message || j.message || text;
      } catch { detail = text; }
    } catch { /* ignore */ }
    detail = String(detail || "").slice(0, 300);

    const fail = (msg) => {
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    };

    if (res.status === 401 || res.status === 403) {
      fail("Invalid API key (HTTP " + res.status + "). Check it in Settings. " + detail);
    }

    // Request too large for the plan — the client will shrink and retry.
    if (res.status === 413) {
      const e = new Error("Message too long for the current plan. Shortening and retrying…");
      e.status = 413;
      throw e;
    }

    // Tokens-per-minute limit — the client waits and retries automatically.
    if (res.status === 429 || /rate limit|tokens per minute|too many requests/i.test(detail)) {
      const e = new Error("Free-tier rate limit reached. Retrying automatically…");
      e.status = 429;
      e.retryAfter = parseRetryAfter(res, detail);
      throw e;
    }

    fail("Provider error (HTTP " + res.status + "). " + detail);
  }

  /* Rough token estimate (~4 chars/token) with small per-message overhead. */
  function estimateTokens(str) {
    return Math.ceil(((str || "").length) / 4) + 4;
  }

  /* Keep only the most recent messages that fit within a token budget,
     so long chats stay under per-minute (TPM) rate limits. */
  function trimHistory(messages, budget) {
    const kept = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = estimateTokens(messages[i].content);
      if (total + t > budget && kept.length > 0) break;
      kept.unshift(messages[i]);
      total += t;
    }
    return kept;
  }

  async function attempt(cfg, messages, { onDelta, signal } = {}) {
    const p = PROVIDERS[cfg.provider] || PROVIDERS.openai;
    const req = buildRequest(cfg, messages);
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal,
    });

    if (!res.ok) await readError(res);
    if (!res.body) throw new Error("Streaming not supported by this browser.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop(); // keep incomplete tail

      for (const ev of events) {
        for (const line of ev.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json;
          try { json = JSON.parse(payload); } catch { continue; }
          const delta = extractDelta(p.style, json);
          if (delta) {
            full += delta;
            if (onDelta) onDelta(delta, full);
          }
        }
      }
    }

    if (!full.trim()) {
      throw new Error("Empty response from provider. Check the model name in Settings.");
    }
    return full;
  }

  /* Abort-aware delay used between rate-limit retries. */
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const e = new Error("Aborted");
        e.name = "AbortError";
        reject(e);
      };
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * Stream a chat completion. Long conversations are trimmed to fit the plan's
   * tokens-per-minute (TPM) limit, and free-tier rate limits are handled
   * automatically: the client waits and retries instead of failing.
   * @param {object} cfg  {provider, apiKey, baseUrl, model, systemPrompt, temperature}
   * @param {Array}  messages  [{role:'user'|'assistant', content}]
   * @param {object} handlers  {onDelta(text), onRetry(seconds, attempt), signal}
   * @returns {Promise<string>} full assistant text
   */
  async function streamChat(cfg, messages, handlers = {}) {
    if (!cfg.apiKey && cfg.provider !== "custom") {
      throw new Error("No API key set. Open Settings (bottom-left) to add one.");
    }
    if (cfg.provider === "custom" && !cfg.baseUrl) {
      throw new Error("Custom provider needs a Base URL in Settings.");
    }

    const isGroq = cfg.provider === "groq";
    // Groq free tier = ~8,000 tokens/minute. Keep the whole request small.
    let budget = isGroq ? 1800 : 24000;
    let msgs = messages;
    let shrinks = 0;
    let retries = 0;
    const MAX_RETRIES = 6;

    while (true) {
      try {
        return await attempt(cfg, trimHistory(msgs, budget), handlers);
      } catch (err) {
        if (handlers.signal && handlers.signal.aborted) throw err;

        // Too large for the plan (usually a single very long message):
        // halve the context, then truncate as a last resort.
        if (err && err.status === 413 && shrinks < 3) {
          shrinks++;
          budget = Math.max(600, Math.floor(budget / 2));
          if (shrinks >= 2) {
            msgs = msgs.map(m => ({ role: m.role, content: String(m.content || "").slice(-3000) }));
          }
          continue;
        }

        // Free-tier tokens-per-minute limit: wait for the window to reset,
        // trim a little more, and retry automatically.
        if (err && err.status === 429 && retries < MAX_RETRIES) {
          retries++;
          const waitSec = Math.min(Math.ceil(err.retryAfter || 20), 90);
          if (handlers.onRetry) handlers.onRetry(waitSec, retries);
          await delay(waitSec * 1000, handlers.signal);
          budget = Math.max(1000, Math.floor(budget * 0.8));
          continue;
        }

        throw err;
      }
    }
  }

  /** Non-streaming test call used by "Test connection". */
  async function testConnection(cfg) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const req = buildRequest({ ...cfg, temperature: 0 }, [
        { role: "user", content: "Reply with the single word: connected" },
      ]);
      // strip streaming for the test
      const body = JSON.parse(req.body);
      body.stream = false;
      const res = await fetch(req.url, {
        method: "POST", headers: req.headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.ok) await readError(res);
      const j = await res.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
                   (j.content && j.content[0] && j.content[0].text) || "";
      return text.trim().toLowerCase();
    } finally {
      clearTimeout(timer);
    }
  }

  window.AI = { PROVIDERS, streamChat, testConnection };
})();
