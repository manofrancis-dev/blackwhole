/* AI provider clients with streaming (SSE) support.
   Default provider: Blackwhole's own proxy — the key lives server-side in the
   worker and is never exposed to the browser. User-supplied providers still
   work directly from the browser. */
(function () {
  "use strict";

  /* Blackwhole's free AI proxy (Cloudflare Worker, see worker/). It holds the
     Groq API key server-side, so no key ever ships in this public bundle and
     visitors chat with zero setup. If the key ever needs rotating, it is
     updated as a worker secret — no code change and no redeploy here. */
  const PROXY_URL = "https://blackwhole-proxy.manofrancis.workers.dev";

  const PROVIDERS = {
    // Default: our own worker proxy. noKey = the browser sends no API key;
    // the worker injects the secret key server-side.
    blackwhole: {
      label: "Blackwhole (Free)",
      baseUrl: PROXY_URL + "/v1",
      defaultModel: "openai/gpt-oss-120b",
      keyUrl: "",
      style: "openai",
      noKey: true,
    },
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

  /* Accuracy rules baked into every request, right after the identity.
     These target the failure modes observed in QA reviews: superseded
     world facts presented as current, invented quotes/citations, and
     form-constrained writing (haiku, letter puzzles) shipped without
     self-verifying the constraint. */
  const ACCURACY_PROMPT =
    "ACCURACY RULES — follow these always.\n" +
    "1. Never fabricate quotes, letters, dialogues, report cards, or citations. " +
    "Quote word-for-word ONLY what you are confident is authentic and verifiable; " +
    "otherwise paraphrase and say it is paraphrased. Never cite a source you are " +
    "not sure exists.\n" +
    "2. Fast-changing facts (currencies, capital-city names, country names, " +
    "officeholders, population/health statistics) go stale. Use the most recent " +
    "value you know with confidence and state the year. Never present a superseded " +
    "value as current — e.g. Croatia uses the euro (adopted 1 Jan 2023, kuna retired); " +
    "Kazakhstan's capital is Astana again (renamed back in 2022). If unsure of the " +
    "latest value, say so and give the last value you are sure of, with its year.\n" +
    "3. For form-constrained writing (haiku, rhymes, acrostics, letter-avoidance, " +
    "fixed counts), verify EVERY line against the constraint before finishing. " +
    "Explicitly count syllables, letters, or sentences; a haiku is exactly 5-7-5. " +
    "If a line violates the constraint, silently rewrite it — never ship a line " +
    "that breaks the requested form.\n" +
    "4. Do not invent people, events, numbers, or details to fill gaps. Saying " +
    "\"I'm not certain\" is always better than a plausible-sounding guess.";

  /* Sent when a reply hits the token cap or a stream drops mid-answer. */
  const CONTINUE_PROMPT =
    "Continue the previous answer from exactly where it stopped. " +
    "Do not repeat anything you already wrote, do not apologise, and do not add a preamble. " +
    "If you were in the middle of code, continue the code seamlessly from the last character.";

  function buildRequest(cfg, messages) {
    const p = PROVIDERS[cfg.provider] || PROVIDERS.openai;
    const base = (cfg.baseUrl || p.baseUrl).replace(/\/+$/, "");
    const model = cfg.model || p.defaultModel;
    /* clientContext carries fresh real-time facts (date/time/timezone) built
       by the UI on every send, so the model never guesses them. */
    const system = [IDENTITY_PROMPT, ACCURACY_PROMPT, cfg.systemPrompt, cfg.clientContext].filter(Boolean).join("\n\n");

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
    // Preserve tool-calling fields — the model needs the assistant's
    // tool_calls and each tool result's tool_call_id to stay paired.
    const msgs = messages.map(m => {
      const out = { role: m.role, content: m.content ?? "" };
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls;
      }
      if (m.role === "tool" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    });
    if (system) msgs.unshift({ role: "system", content: system });

    // Groq's free tier has a tight tokens-per-minute budget. Keep each request
    // small, and for gpt-oss models use light reasoning to save output tokens.
    // The blackwhole provider is Groq behind our own proxy, so the same
    // free-tier limits apply.
    const isGroq = cfg.provider === "groq" || cfg.provider === "blackwhole";
    // gpt-oss counts hidden reasoning against max_tokens, so a small cap like
    // 1200 cut long code answers in half. Size the budget from the actual
    // prompt instead, keeping the whole request under the free-tier TPM limit.
    const promptTokens = msgs.reduce((n, m) => n + estimateTokens(m.content), 0) + estimateTokens(system) + 12;
    const maxTokens = isGroq
      ? Math.max(1200, Math.min(8192, 7400 - promptTokens))
      : 4096;
    const body = {
      model,
      temperature: cfg.temperature ?? 0.7,
      max_tokens: maxTokens,
      stream: true,
      messages: msgs,
    };
    if (isGroq && /gpt-oss/i.test(model)) body.reasoning_effort = "low";

    // Function calling ("tools"), ChatGPT-style: the model can ask the browser
    // for live data (weather, exact date/time) mid-answer. Skipped for the
    // "custom" provider because unknown endpoints may reject the field.
    if (cfg.tools && Array.isArray(cfg.tools.definitions) && cfg.tools.definitions.length &&
        cfg.provider !== "custom") {
      body.tools = cfg.tools.definitions;
      body.tool_choice = "auto";
    }

    const headers = { "content-type": "application/json" };
    // noKey providers (the blackwhole proxy) inject the key server-side —
    // the browser never sends one.
    if (!p.noKey && cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;

    return {
      url: base + "/chat/completions",
      headers,
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

  async function readError(res, noKey) {
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
      if (noKey) {
        // Our proxy is authenticated server-side; a 401 here means the server
        // key needs renewal — nothing the visitor can (or should) fix.
        fail("Blackwhole's free AI service is temporarily unavailable. Please try again in a few minutes.");
      }
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
     so long chats stay under per-minute (TPM) rate limits. Tool-result
     messages whose assistant call was trimmed away are dropped too, because
     a "tool" message without its preceding tool_calls makes the API 400. */
  function trimHistory(messages, budget) {
    const kept = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = estimateTokens(messages[i].content);
      if (total + t > budget && kept.length > 0) break;
      kept.unshift(messages[i]);
      total += t;
    }
    const hasCall = new Set();
    for (const m of kept) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) if (c.id) hasCall.add(c.id);
      }
    }
    return kept.filter(m => m.role !== "tool" || hasCall.has(m.tool_call_id));
  }

  async function attempt(cfg, messages, { onDelta, signal } = {}) {
    const p = PROVIDERS[cfg.provider] || PROVIDERS.openai;
    const req = buildRequest(cfg, messages);
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      if (p.noKey) {
        // Our proxy is down or unreachable — not something the visitor caused.
        throw new Error("Blackwhole's free AI service is unreachable right now. Please try again shortly.");
      }
      throw err;
    }

    if (!res.ok) await readError(res, p.noKey);
    if (!res.body) throw new Error("Streaming not supported by this browser.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "", finishReason = null, providerError = null;
    // Tool calls arrive streamed, split across chunks: accumulate by index.
    const toolAcc = {};

    const handleEvent = (ev) => {
      for (const line of ev.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        // Some providers send an error object inside the stream instead of
        // closing the connection cleanly.
        if (json.error) {
          providerError = new Error(json.error.message || "The provider stopped the response.");
          providerError.status = json.error.code || json.error.status;
          continue;
        }

        const choice = json.choices && json.choices[0];
        const delta = extractDelta(p.style, json);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta, full);
        }
        // Accumulate streamed tool_call fragments (OpenAI-compatible shape).
        const dToolCalls = choice && choice.delta && choice.delta.tool_calls;
        if (Array.isArray(dToolCalls)) {
          for (const tc of dToolCalls) {
            const i = tc.index || 0;
            if (!toolAcc[i]) toolAcc[i] = { id: "", name: "", arguments: "" };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
            if (tc.function && typeof tc.function.arguments === "string") {
              toolAcc[i].arguments += tc.function.arguments;
            }
          }
        }
        if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Accept both LF and CRLF separated SSE events (proxies differ).
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop(); // keep incomplete tail

        for (const ev of events) handleEvent(ev);
      }
      if (buffer.trim()) handleEvent(buffer);
    } catch (err) {
      if (err && err.name === "AbortError") {
        const e = new Error("Aborted");
        e.name = "AbortError";
        e.partial = full;
        throw e;
      }
      // A dropped connection after some text arrived: keep the partial answer
      // and let the caller resume it instead of throwing everything away.
      if (full.trim()) return { text: full, finishReason, incomplete: true };
      throw err;
    }

    if (!full.trim()) {
      if (providerError) throw providerError;
      const calls = Object.values(toolAcc).filter(t => t.name);
      if (calls.length) return { text: "", finishReason, incomplete: false, toolCalls: calls };
      throw new Error("Empty response from provider. Check the model name in Settings.");
    }
    const calls = Object.values(toolAcc).filter(t => t.name);
    return { text: full, finishReason, incomplete: false, toolCalls: calls };
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
   * If the model stops because it hit the token cap (finish_reason=length) or
   * the connection drops mid-answer, the answer is continued automatically so
   * the user never gets a half-finished reply.
   * @param {object} cfg  {provider, apiKey, baseUrl, model, systemPrompt, temperature,
   *                      clientContext, tools: {definitions, execute(name, args)}}
   * @param {Array}  messages  [{role:'user'|'assistant', content}]
   * @param {object} handlers  {onDelta(text, full), onRetry(seconds, attempt), onContinue(n),
   *                            onToolCall(name), onTruncated(), signal}
   * @returns {Promise<string>} full assistant text
   */
  async function streamChat(cfg, messages, handlers = {}) {
    const p = PROVIDERS[cfg.provider] || PROVIDERS.openai;
    if (!p.noKey && !cfg.apiKey && cfg.provider !== "custom") {
      throw new Error("No API key set. Open Settings (bottom-left) to add one.");
    }
    if (p.noKey && p.baseUrl.includes("<")) {
      // Deployment safety net: the proxy URL was never filled in.
      throw new Error("Blackwhole's free AI service is being set up. Please check back soon.");
    }
    if (cfg.provider === "custom" && !cfg.baseUrl) {
      throw new Error("Custom provider needs a Base URL in Settings.");
    }

    const isGroq = cfg.provider === "groq" || cfg.provider === "blackwhole";
    // Groq free tier = ~8,000 tokens/minute. Keep the whole request small.
    let budget = isGroq ? 1800 : 24000;
    let msgs = messages;
    let answer = "";
    let shrinks = 0;
    let retries = 0;
    let continuations = 0;
    let toolRounds = 0;
    let toolsDisabled = false;
    const MAX_RETRIES = 6;
    const MAX_CONTINUATIONS = 4;
    const MAX_TOOL_ROUNDS = 3;

    while (true) {
      try {
        const res = await attempt(cfg, trimHistory(msgs, budget), {
          signal: handlers.signal,
          onDelta: (delta, localFull) => {
            if (handlers.onDelta) handlers.onDelta(delta, answer + localFull);
          },
        });
        answer += res.text;

        // The model asked for a tool (live weather, exact date/time…): run it
        // in the browser, feed the result back, and let it answer with real
        // data — the same loop ChatGPT uses for its built-in tools.
        if (res.toolCalls && res.toolCalls.length && cfg.tools && cfg.tools.execute &&
            toolRounds < MAX_TOOL_ROUNDS) {
          toolRounds++;
          const executed = [];
          for (const call of res.toolCalls) {
            if (handlers.onToolCall) handlers.onToolCall(call.name);
            let result;
            try {
              const args = call.arguments ? JSON.parse(call.arguments) : {};
              result = await cfg.tools.execute(call.name, args);
            } catch (e) {
              result = "Tool error: " + ((e && e.message) || "failed");
            }
            executed.push({
              id: call.id || ("call_" + toolRounds + "_" + executed.length),
              name: call.name,
              arguments: call.arguments || "{}",
              result: String(result),
            });
          }
          msgs = msgs.concat([
            {
              role: "assistant",
              content: res.text || "",
              tool_calls: executed.map(c => ({
                id: c.id, type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            },
            ...executed.map(c => ({ role: "tool", tool_call_id: c.id, content: c.result })),
          ]);
          continue; // next round streams the final, data-backed answer
        }

        // The model ran out of output tokens or the stream was cut off:
        // ask it to carry on, seamlessly, from the last character it wrote.
        const cutOff = res.finishReason === "length" || res.incomplete;
        if (cutOff && !(handlers.signal && handlers.signal.aborted)) {
          if (continuations < MAX_CONTINUATIONS) {
            continuations++;
            if (handlers.onContinue) handlers.onContinue(continuations);
            const tail = answer.slice(-3000);
            msgs = messages.slice(-1).concat([
              { role: "assistant", content: tail },
              { role: "user", content: CONTINUE_PROMPT },
            ]);
            budget = isGroq ? 1800 : 24000;
            continue;
          }
          // Gave up after several resumes: tell the UI so it can offer "continue".
          if (handlers.onTruncated) handlers.onTruncated();
        }

        return answer;
      } catch (err) {
        if (err && err.name === "AbortError") {
          // Keep everything already streamed so "Stop" never wipes the reply.
          err.partial = answer + (err.partial || "");
          throw err;
        }
        if (handlers.signal && handlers.signal.aborted) throw err;

        // Too large for the plan (usually a single very long message):
        // halve the context, then truncate as a last resort.
        if (err && err.status === 413 && shrinks < 3) {
          shrinks++;
          budget = Math.max(600, Math.floor(budget / 2));
          if (shrinks >= 2) {
            // Also drop transient tool exchanges — their JSON payload is the
            // usual culprit, and keeping half a tool pair breaks the API.
            msgs = msgs
              .filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
              .map(m => ({ role: m.role, content: String(m.content || "").slice(-3000) }));
          }
          continue;
        }

        // The endpoint rejected the request — likely it doesn't support
        // tools/function-calling. Retry once without them before giving up.
        if (err && err.status === 400 && cfg.tools && !toolsDisabled) {
          toolsDisabled = true;
          cfg = { ...cfg, tools: null };
          msgs = msgs.filter(m => m.role !== "tool" && !(m.role === "assistant" && m.tool_calls));
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

  /* ---------- Built-in tools (ChatGPT-style function calling) ----------
     The model calls these mid-answer whenever it needs live data it cannot
     know from training: current date/time (any timezone) and real weather.
     Weather uses Open-Meteo — free, keyless, CORS-enabled. */
  const WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
  };

  function toolGetDatetime(args) {
    const now = new Date();
    let tz = (args && typeof args.timezone === "string" && args.timezone.trim()) ||
             Intl.DateTimeFormat().resolvedOptions().timeZone;
    let local;
    try {
      local = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, weekday: "long", day: "numeric", month: "long",
        year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
        hour12: true, timeZoneName: "short",
      }).format(now);
    } catch {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      local = now.toString();
    }
    return JSON.stringify({
      utc: now.toUTCString(),
      iso_utc: now.toISOString(),
      timezone: tz,
      local_time: local,
    });
  }

  async function toolGetWeather(args) {
    const q = String((args && (args.location || args.city || args.place)) || "").trim();
    if (!q) throw new Error("Missing location");
    const geoUrl = "https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(q) + "&count=1&language=en&format=json";
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) throw new Error("Geocoding failed (HTTP " + geoRes.status + ")");
    const geo = await geoRes.json();
    const g = geo.results && geo.results[0];
    if (!g) throw new Error('Place not found: "' + q + '"');

    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + g.latitude +
      "&longitude=" + g.longitude +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation," +
      "weather_code,cloud_cover,wind_speed_10m,wind_direction_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset" +
      "&timezone=auto&forecast_days=2";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather lookup failed (HTTP " + res.status + ")");
    const j = await res.json();
    const c = j.current || {};
    const d = j.daily || {};
    return JSON.stringify({
      place: [g.name, g.admin1, g.country].filter(Boolean).join(", "),
      local_time: c.time,
      timezone: j.timezone,
      now: {
        temperature_c: c.temperature_2m,
        feels_like_c: c.apparent_temperature,
        condition: WMO_CODES[c.weather_code] || "Unknown",
        humidity_percent: c.relative_humidity_2m,
        precipitation_mm: c.precipitation,
        cloud_percent: c.cloud_cover,
        wind_kmh: c.wind_speed_10m,
        wind_direction_deg: c.wind_direction_10m,
      },
      today: {
        max_c: d.temperature_2m_max ? d.temperature_2m_max[0] : null,
        min_c: d.temperature_2m_min ? d.temperature_2m_min[0] : null,
        condition: d.weather_code ? (WMO_CODES[d.weather_code[0]] || null) : null,
        rain_chance_percent: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null,
        sunrise: d.sunrise ? d.sunrise[0] : null,
        sunset: d.sunset ? d.sunset[0] : null,
      },
      tomorrow: {
        max_c: d.temperature_2m_max ? d.temperature_2m_max[1] : null,
        min_c: d.temperature_2m_min ? d.temperature_2m_min[1] : null,
        condition: d.weather_code ? (WMO_CODES[d.weather_code[1]] || null) : null,
        rain_chance_percent: d.precipitation_probability_max ? d.precipitation_probability_max[1] : null,
      },
    });
  }

  const TOOL_DEFINITIONS = [
    {
      type: "function",
      function: {
        name: "get_current_datetime",
        description: "Get the accurate current date and time. Use for any question about the time or date, including other cities or timezones (pass their IANA timezone, e.g. Asia/Kolkata, America/New_York).",
        parameters: {
          type: "object",
          properties: {
            timezone: { type: "string", description: "Optional IANA timezone name, e.g. Europe/Paris" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get live weather right now plus today's and tomorrow's forecast for a city or place. Use for any weather question.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City or place name, e.g. Chennai" },
          },
          required: ["location"],
        },
      },
    },
  ];

  const TOOL_EXECUTORS = {
    get_current_datetime: (args) => toolGetDatetime(args),
    get_weather: (args) => toolGetWeather(args),
  };

  /* Passed by the UI into streamChat as cfg.tools. */
  function toolkit() {
    return {
      definitions: TOOL_DEFINITIONS,
      execute: async (name, args) => {
        const fn = TOOL_EXECUTORS[name];
        if (!fn) return "Unknown tool: " + name;
        return await fn(args || {});
      },
    };
  }

  window.AI = { PROVIDERS, streamChat, testConnection, toolkit };
})();
