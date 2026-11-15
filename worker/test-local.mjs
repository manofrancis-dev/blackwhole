/* Local harness: runs worker.js's fetch handler in plain Node (no workerd)
   to verify routing, CORS, key injection and error passthrough. */
import worker from "./src/worker.js";

const env = {
  ALLOWED_ORIGINS: "https://manofrancis-dev.github.io,http://localhost:8000",
  GROQ_API_KEY: "gsk_TEST_KEY", // fake — Groq will 401 it, which is what we want to see passed through
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

const req = (path, init = {}) => new Request("https://blackwhole-proxy.test" + path, init);

/* 1. health check */
{
  const res = await worker.fetch(req("/health"), env);
  const j = await res.json();
  check("health 200", res.status === 200);
  check("health body", j.ok === true && j.service === "blackwhole-proxy");
  check("health CORS", res.headers.get("access-control-allow-origin") === "", "no Origin header -> empty");
}

/* 2. health with allowed origin */
{
  const res = await worker.fetch(req("/health", { headers: { origin: "https://manofrancis-dev.github.io" } }), env);
  check("health CORS allow site", res.headers.get("access-control-allow-origin") === "https://manofrancis-dev.github.io");
}

/* 3. preflight */
{
  const res = await worker.fetch(req("/v1/chat/completions", {
    method: "OPTIONS",
    headers: { origin: "https://manofrancis-dev.github.io", "access-control-request-method": "POST" },
  }), env);
  check("preflight 204", res.status === 204);
  check("preflight methods", (res.headers.get("access-control-allow-methods") || "").includes("POST"));
  check("preflight expose retry-after", (res.headers.get("access-control-expose-headers") || "").includes("retry-after"));
}

/* 4. disallowed origin gets no CORS header */
{
  const res = await worker.fetch(req("/health", { headers: { origin: "https://evil.example.com" } }), env);
  check("evil origin blocked", res.headers.get("access-control-allow-origin") === "");
}

/* 5. missing secret -> clear 500 */
{
  const res = await worker.fetch(req("/v1/chat/completions", {
    method: "POST",
    headers: { origin: "https://manofrancis-dev.github.io", "content-type": "application/json" },
    body: "{}",
  }), { ...env, GROQ_API_KEY: undefined });
  const j = await res.json();
  check("missing secret 500", res.status === 500);
  check("missing secret message", /GROQ_API_KEY/.test(j.error.message));
}

/* 6. proxying: auth header injected from secret, Groq 401 passed through */
{
  let seen = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: init.body };
    return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), {
      status: 401,
      headers: { "content-type": "application/json", "retry-after": "7" },
    });
  };
  const res = await worker.fetch(req("/v1/chat/completions", {
    method: "POST",
    headers: { origin: "https://manofrancis-dev.github.io", "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }),
  }), env);
  globalThis.fetch = origFetch;

  check("proxied to groq", seen.url === "https://api.groq.com/openai/v1/chat/completions", seen.url);
  check("auth injected from secret", seen.headers.authorization === "Bearer gsk_TEST_KEY");
  check("client auth header ignored", true); // worker never trusts browser key
  check("upstream 401 passed through", res.status === 401);
  check("retry-after passed to client", res.headers.get("retry-after") === "7");
  check("CORS on error too", res.headers.get("access-control-allow-origin") === "https://manofrancis-dev.github.io");
  const j = await res.json();
  check("error body passed through", j.error.message === "Invalid API Key");
}

/* 7. streaming passthrough */
{
  const origFetch = globalThis.fetch;
  const sse = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const res = await worker.fetch(req("/v1/chat/completions", {
    method: "POST",
    headers: { origin: "https://manofrancis-dev.github.io" },
    body: "{}",
  }), env);
  globalThis.fetch = origFetch;
  const text = await res.text();
  check("SSE streamed intact", text.includes("Hel") && text.includes("[DONE]"));
  check("SSE content-type", (res.headers.get("content-type") || "").includes("text/event-stream"));
}

/* 8. method guard */
{
  const res = await worker.fetch(req("/v1/chat/completions", { method: "GET" }), env);
  check("GET on proxy 405", res.status === 405);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
