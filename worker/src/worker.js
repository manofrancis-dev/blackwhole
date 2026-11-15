/* Blackwhole AI proxy (Cloudflare Worker).
   Holds the Groq API key server-side so it never ships in the public
   frontend bundle. The browser calls this worker with NO key; the worker
   injects the secret and streams the answer back.

   Endpoints:
     GET  /health             -> { ok: true }
     POST /v1/<groq-path>     -> forwarded to https://api.groq.com/openai/v1/<groq-path>

   Secrets (set with: npx wrangler secret put GROQ_API_KEY):
     GROQ_API_KEY            Groq key used for every upstream request.

   Vars (worker/wrangler.toml):
     ALLOWED_ORIGINS         Comma-separated origins allowed to call this proxy. */

const GROQ_BASE = "https://api.groq.com/openai/v1";

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ||
    "https://manofrancis-dev.github.io,http://localhost:8000,http://127.0.0.1:8000,http://localhost:5500,http://127.0.0.1:5500")
    .split(",").map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allow = allowedOrigins(env).includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-api-key",
    "Access-Control-Expose-Headers": "retry-after, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (data, status, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "blackwhole-proxy", time: new Date().toISOString() }, 200, cors);
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed. Use POST." } }, 405, cors);
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: { message: "Proxy is not configured yet (GROQ_API_KEY secret missing)." } }, 500, cors);
    }

    // /v1/<path> on the worker maps to api.groq.com/openai/v1/<path>
    const path = url.pathname.replace(/^\/v1\/?/, "");
    if (!path) return json({ error: { message: "Unknown path." } }, 404, cors);

    const upstream = await fetch(GROQ_BASE + "/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + env.GROQ_API_KEY,
      },
      body: await request.text(),
    });

    // Pass everything through — including errors — so the client's own
    // handling (401 / 413 / 429 + Retry-After auto-retry) keeps working.
    // SSE bodies stream straight to the browser.
    const headers = new Headers(cors);
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const ra = upstream.headers.get("retry-after");
    if (ra) headers.set("retry-after", ra);

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
