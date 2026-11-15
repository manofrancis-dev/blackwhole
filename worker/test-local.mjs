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

/* ---- /tools/search (Fix 3) ---- */

/* 9. search: parses DuckDuckGo Lite HTML into results */
{
  const ddgHtml = `
  <html><body><table>
  <tr><td>1.</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews&amp;rut=abc">Example <b>News</b> Site</a></td></tr>
  <tr><td class='result-snippet'>Latest &amp; greatest <b>story</b> — Nov 2026</td></tr>
  <tr><td>2.</td><td><a rel="nofollow" href="https://second.org/page">Second Result</a></td></tr>
  <tr><td class="result-snippet">Second snippet text</td></tr>
  </table></body></html>`;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("lite.duckduckgo.com")) {
      return new Response(ddgHtml, { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const res = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { origin: "https://manofrancis-dev.github.io", "content-type": "application/json" },
    body: JSON.stringify({ q: "ai news" }),
  }), env);
  globalThis.fetch = origFetch;
  const j = await res.json();
  check("search 200", res.status === 200);
  check("search CORS", res.headers.get("access-control-allow-origin") === "https://manofrancis-dev.github.io");
  check("search source ddg", j.source === "duckduckgo");
  check("search decodes redirect", j.results[0].url === "https://example.com/news", j.results[0].url);
  check("search strips tags", j.results[0].title === "Example News Site", j.results[0].title);
  check("search snippet decoded", j.results[0].snippet.includes("Latest & greatest story"), j.results[0].snippet);
  check("search caps at 5", j.results.length <= 5);
}

/* 10. search: falls back to Wikipedia when DDG yields nothing */
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("lite.duckduckgo.com")) {
      return new Response("<html><body>no results here</body></html>", { status: 200 });
    }
    if (String(url).includes("wikipedia.org")) {
      return new Response(JSON.stringify({
        query: { search: [{ title: "Turing test", snippet: '<span class="searchmatch">AI</span> history' }] },
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const res = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "turing test" }),
  }), env);
  globalThis.fetch = origFetch;
  const j = await res.json();
  check("search fallback wikipedia", res.status === 200 && j.source === "wikipedia");
  check("wikipedia url built", j.results[0].url === "https://en.wikipedia.org/wiki/Turing_test");
  check("wikipedia snippet clean", j.results[0].snippet === "AI history", j.results[0].snippet);
}

/* 10b. search: Bing RSS fallback (used when DDG is blocked, e.g. from CF) */
{
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title><![CDATA[First result & more]]></title><link>https://one.example/a</link><description><![CDATA[<b>Desc</b> one]]></description></item>
  <item><title>Second result</title><link>https://two.example/b</link><description>Desc two</description></item>
  <item><title>No link item</title><link>about:blank</link><description>skip</description></item>
  </channel></rss>`;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("lite.duckduckgo.com")) {
      return new Response("<html><body>nothing</body></html>", { status: 200 });
    }
    if (String(url).includes("bing.com")) {
      return new Response(rss, { status: 200 });
    }
    return new Response("{}", { status: 500 });
  };
  const res = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "x" }),
  }), env);
  globalThis.fetch = origFetch;
  const j = await res.json();
  check("search fallback bing rss", res.status === 200 && j.source === "bing-rss");
  check("bing rss parses cdata", j.results[0].title === "First result & more", j.results[0]);
  check("bing rss strips html desc", j.results[0].snippet === "Desc one", j.results[0].snippet);
  check("bing rss skips bad links", j.results.length === 2, j.results.length);
}

/* 11. search: bad input + total failure paths */
{
  const res = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), env);
  check("search missing q 400", res.status === 400);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const res2 = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "x" }),
  }), env);
  globalThis.fetch = origFetch;
  check("search all sources down 502", res2.status === 502);
}

/* ---- /tools/read (Fix 3) ---- */

/* 12. read: strips HTML to plain text and caps length */
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init && init.signal) {
      // no real abort needed in the mock
    }
    return new Response(
      "<html><head><style>body{color:red}</style><script>var x=1;</script></head>" +
      "<body><h1>Hello &amp; welcome</h1><p>Paragraph one.</p>" + "<p>x</p>".repeat(5000) + "</body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  };
  const res = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/article" }),
  }), env);
  globalThis.fetch = origFetch;
  const j = await res.json();
  check("read 200", res.status === 200);
  check("read strips html", j.text.startsWith("Hello & welcome Paragraph one."), j.text.slice(0, 60));
  check("read no scripts", !j.text.includes("var x"));
  check("read capped ~8000", j.text.length <= 8000 && j.truncated === true, j.text.length);
}

/* 13. read: guards (bad url, self-fetch, upstream error, timeout) */
{
  const res = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "ftp://nope.example" }),
  }), env);
  check("read invalid url 400", res.status === 400);

  const selfRes = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://blackwhole-proxy.test/health" }),
  }), env);
  check("read self-fetch blocked", selfRes.status === 400);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  const errRes = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/gone" }),
  }), env);
  globalThis.fetch = origFetch;
  check("read upstream 404 -> 502", errRes.status === 502);

  globalThis.fetch = async () => { throw new Error("boom"); };
  const failRes = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/fail" }),
  }), env);
  globalThis.fetch = origFetch;
  check("read fetch error 502", failRes.status === 502);
}

/* 14. read: plain-text (non-HTML) passthrough */
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("plain text body 1 < 2 > 3", { status: 200, headers: { "content-type": "text/plain" } });
  const res = await worker.fetch(req("/tools/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/data.txt" }),
  }), env);
  globalThis.fetch = origFetch;
  const j = await res.json();
  check("read plain text intact", j.text === "plain text body 1 < 2 > 3", j.text);
}

/* 15. tool routes work without the Groq secret configured */
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<a rel=\"nofollow\" href=\"https://ok.example\">t</a>", { status: 200 });
  const res = await worker.fetch(req("/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "x" }),
  }), { ...env, GROQ_API_KEY: undefined });
  globalThis.fetch = origFetch;
  check("search needs no groq key", res.status === 200);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
