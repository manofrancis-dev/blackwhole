/* Blackwhole AI proxy (Cloudflare Worker).
   Holds the Groq API key server-side so it never ships in the public
   frontend bundle. The browser calls this worker with NO key; the worker
   injects the secret and streams the answer back.

   Endpoints:
     GET  /health             -> { ok: true }
     POST /v1/<groq-path>     -> forwarded to https://api.groq.com/openai/v1/<groq-path>
     POST /tools/search {q}   -> keyless web search (DuckDuckGo Lite, Wikipedia fallback)
     POST /tools/read   {url} -> fetch a page, strip HTML to plain text (~8k cap)

   Secrets (set with: npx wrangler secret put GROQ_API_KEY):
     GROQ_API_KEY            Groq key used for every upstream request.

   Vars (worker/wrangler.toml):
     ALLOWED_ORIGINS         Comma-separated origins allowed to call this proxy. */

const GROQ_BASE = "https://api.groq.com/openai/v1";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ---------- HTML helpers for the keyless web tools ---------- */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/* Strip scripts/styles/tags/comments and collapse whitespace to plain text. */
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t\r]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/* Keyless search via DuckDuckGo Lite (HTML scrape), tolerant of attribute
   order; returns [{title, url, snippet}]. */
async function searchDuckDuckGo(q) {
  const res = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), {
    headers: { "user-agent": BROWSER_UA, "accept-language": "en" },
  });
  if (!res.ok) throw new Error("DDG HTTP " + res.status);
  const html = await res.text();
  const snips = [...html.matchAll(/<t[dh][^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => htmlToText(m[1]));
  const results = [];
  let i = 0;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] || "";
    if (!/rel="nofollow"|result-link/i.test(attrs)) continue;
    if (/\/y\.js|ad_provider|ad_domain/i.test(attrs)) continue; // skip ads
    const href = (/href=["']([^"']+)["']/i.exec(attrs) || [])[1];
    if (!href) continue;
    let url = href;
    // Lite wraps targets in a redirect: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { continue; } }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToText(m[2]);
    if (!title) continue;
    results.push({ title, url, snippet: (snips[i] || "").slice(0, 300) });
    if (++i >= 5) break;
  }
  return results;
}

/* Keyless fallback: Wikipedia site search. */
async function searchWikipedia(q) {
  const res = await fetch(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
    encodeURIComponent(q),
    { headers: { "user-agent": "BlackwholeProxy/1.0" } }
  );
  if (!res.ok) throw new Error("Wikipedia HTTP " + res.status);
  const j = await res.json();
  return ((j.query && j.query.search) || []).map(r => ({
    title: r.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(r.title).replace(/ /g, "_")),
    snippet: htmlToText(r.snippet || "").slice(0, 300),
  }));
}

/* Minimal RSS <item> parser for keyless search feeds (Bing). */
function parseRssItems(xml, cap) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && out.length < cap) {
    const block = m[1];
    const pick = (tag) => {
      const t = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i").exec(block);
      if (!t) return "";
      return decodeEntities(t[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
    };
    const title = htmlToText(pick("title"));
    const link = pick("link");
    if (title && /^https?:\/\//i.test(link)) {
      out.push({ title, url: link, snippet: htmlToText(pick("description")).slice(0, 300) });
    }
  }
  return out;
}

/* Keyless general search via Mojeek (independent index, bot-friendly). */
async function searchMojeek(q) {
  const res = await fetch("https://www.mojeek.com/search?q=" + encodeURIComponent(q), {
    headers: { "user-agent": BROWSER_UA, "accept-language": "en" },
  });
  if (!res.ok) throw new Error("Mojeek HTTP " + res.status);
  const html = await res.text();
  // Bot challenges render a "Captcha" page with stray links — only accept
  // list items that look like real results (link + snippet paragraph).
  const results = [];
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    const linkM = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkM) continue;
    const snipM = /<p\b[^>]*class=["'][^"']*\bs["'][^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (!snipM) continue; // no snippet -> not a real result
    const url = linkM[1];
    if (!/^https?:\/\//i.test(url) || /mojeek\.com/i.test(url)) continue;
    const title = htmlToText(linkM[2]);
    if (!title) continue;
    results.push({ title, url, snippet: htmlToText(snipM[1]).slice(0, 300) });
    if (results.length >= 5) break;
  }
  return results;
}

/* Highest-quality option: Brave Search API — needs a key, so it is only
   used when the BRAVE_API_KEY worker secret is set (free tier: 2k/month). */
async function searchBrave(q, env) {
  if (!env.BRAVE_API_KEY) throw new Error("BRAVE_API_KEY secret not set");
  const res = await fetch(
    "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=5",
    { headers: { "x-subscription-token": env.BRAVE_API_KEY, "accept": "application/json" } }
  );
  if (!res.ok) throw new Error("Brave HTTP " + res.status);
  const j = await res.json();
  return ((j.web && j.web.results) || []).slice(0, 5).map(r => ({
    title: r.title,
    url: r.url,
    snippet: String(r.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
  }));
}

/* Keyless real-time news via GDELT (max 1 req / 5 s — fail fast on 429). */
async function searchGdelt(q) {
  const u = "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(q) + "%20sourcelang:eng&mode=artlist&maxrecords=6&format=json&sort=datedesc";
  const res = await fetch(u, { headers: { "user-agent": "BlackwholeProxy/1.0" } });
  if (res.status === 429) throw new Error("GDELT rate limited (1 req / 5 s)");
  if (!res.ok) throw new Error("GDELT HTTP " + res.status);
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("GDELT bad response"); }
  return (j.articles || []).map(a => ({
    title: a.title,
    url: a.url,
    snippet: [a.domain, a.seendate].filter(Boolean).join(" • ").slice(0, 300),
  })).filter(r => r.title && r.url);
}

/* Keyless tech-news via the Hacker News (Algolia) API. */
async function searchHackerNews(q) {
  const res = await fetch(
    "https://hn.algolia.com/api/v1/search_by_date?query=" + encodeURIComponent(q) +
    "&tags=story&hitsPerPage=6",
    { headers: { "user-agent": "BlackwholeProxy/1.0" } }
  );
  if (!res.ok) throw new Error("HN HTTP " + res.status);
  const j = await res.json();
  return (j.hits || []).map(h => ({
    title: h.title || h.story_title || "HN discussion",
    url: h.url || ("https://news.ycombinator.com/item?id=" + h.objectID),
    snippet: [
      (h.points != null ? h.points + " points" : ""),
      (h.num_comments != null ? h.num_comments + " comments" : ""),
      h.created_at,
    ].filter(Boolean).join(" • "),
  })).filter(r => r.title && r.url).slice(0, 5);
}

/* Keyless news search via Google News RSS — reliable from Cloudflare. */
async function searchGoogleNewsRss(q) {
  const res = await fetch(
    "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en",
    { headers: { "user-agent": BROWSER_UA } }
  );
  if (!res.ok) throw new Error("GoogleNews HTTP " + res.status);
  return parseRssItems(await res.text(), 5);
}

/* Keyless general search via Bing's RSS endpoint — reachable from
   Cloudflare Workers, where DuckDuckGo Lite is blocked (HTTP 525). */
async function searchBingRss(q) {
  const res = await fetch(
    "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&format=rss&count=8",
    { headers: { "user-agent": BROWSER_UA } }
  );
  if (!res.ok) throw new Error("Bing HTTP " + res.status);
  return parseRssItems(await res.text(), 5);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    /* Last-resort safety net: an uncaught throw here would make Cloudflare
       return a bare HTML crash page WITHOUT CORS headers — the browser then
       hides the real error and the client sees a network failure instead
       ("service unreachable"). Always answer with CORS-enabled JSON so the
       frontend can read the cause, classify it, and auto-retry. */
    try {
      return await handle(request, env);
    } catch (e) {
      const cors = corsHeaders(request, env);
      return json(
        { error: { message: "Proxy error: " + ((e && e.message) || "unknown") } },
        500,
        { ...cors, "retry-after": "2" }
      );
    }
  },
};

async function handle(request, env) {
  const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "blackwhole-proxy", time: new Date().toISOString() }, 200, cors);
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed. Use POST." } }, 405, cors);
    }

    /* ---- keyless web tools (no GROQ_API_KEY needed) ---- */

    if (url.pathname === "/tools/search") {
      let q = "";
      try { q = String((await request.json()).q || "").trim(); } catch { /* bad body */ }
      if (!q) return json({ error: { message: "Missing q." } }, 400, cors);
      const debug = url.searchParams.get("debug") === "1";
      const errors = debug ? {} : null;
      let results = [], source = "";

      /* Fire keyless sources in parallel and pick by priority, in two
         tiers so cold-start latency stays ~2-4 s: Tier B (general engines
         — best quality when reachable, but they hang/challenge Cloudflare
         IPs) gets a short window; then Tier A (always reachable from CF)
         is awaited by priority. A sequential chain once took 34 s. */
      const pickFrom = async (jobs) => {
        for (const [name, p] of jobs) {
          try {
            const r = await p;
            if (r.length) { source = name; results = r; return true; }
          } catch (e) {
            if (errors) errors[name] = String((e && e.message) || e);
          }
        }
        return false;
      };
      const shortWait = (p) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error("tier-b window elapsed")), 1600)),
      ]);
      const longWait = (p, name) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(name + " timed out")), 6000)),
      ]);
      const tierB = [
        ["duckduckgo", shortWait(searchDuckDuckGo(q))],
        ["mojeek", shortWait(searchMojeek(q))],
        ["google-news", shortWait(searchGoogleNewsRss(q))],
      ];
      const tierA = [
        ...(env.BRAVE_API_KEY ? [["brave", longWait(searchBrave(q, env), "brave")]] : []),
        ["gdelt", longWait(searchGdelt(q), "gdelt")],
        ["hn", longWait(searchHackerNews(q), "hn")],
        ["wikipedia", longWait(searchWikipedia(q), "wikipedia")],
        ["bing-rss", longWait(searchBingRss(q), "bing-rss")],
      ];
      const found = await pickFrom(tierB) || await pickFrom(tierA);
      if (!results.length) {
        return json({ error: { message: "No results found — search sources are unavailable right now." }, errors }, 502, cors);
      }
      return json({ source, results: results.slice(0, 5), errors }, 200, cors);
    }

    if (url.pathname === "/tools/read") {
      let target = "";
      try { target = String((await request.json()).url || "").trim(); } catch { /* bad body */ }
      if (!/^https?:\/\//i.test(target)) {
        return json({ error: { message: "Missing or invalid url (must start with http:// or https://)." } }, 400, cors);
      }
      let host = "";
      try { host = new URL(target).hostname; } catch {
        return json({ error: { message: "Invalid url." } }, 400, cors);
      }
      // Refuse to read this proxy itself — a self-fetch would recurse.
      if (host === url.hostname) {
        return json({ error: { message: "Refusing to read this proxy." } }, 400, cors);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const upstream = await fetch(target, {
          signal: ctrl.signal,
          redirect: "follow",
          headers: { "user-agent": BROWSER_UA, "accept": "text/html,application/xhtml+xml,text/plain,*/*" },
        });
        const ct = upstream.headers.get("content-type") || "";
        if (!upstream.ok) {
          return json({ error: { message: "Upstream HTTP " + upstream.status + " for " + host } }, 502, cors);
        }
        const body = await upstream.text();
        const text = (/html|xml/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body)
          .slice(0, 8000);
        return json({
          url: upstream.url || target,
          content_type: ct,
          truncated: text.length >= 8000,
          text,
        }, 200, cors);
      } catch (e) {
        const msg = e && e.name === "AbortError"
          ? "timed out after 10 s"
          : ((e && e.message) || "fetch failed");
        return json({ error: { message: "Could not read page: " + msg } }, 502, cors);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: { message: "Proxy is not configured yet (GROQ_API_KEY secret missing)." } }, 500, cors);
    }

    // /v1/<path> on the worker maps to api.groq.com/openai/v1/<path>
    const path = url.pathname.replace(/^\/v1\/?/, "");
    if (!path) return json({ error: { message: "Unknown path." } }, 404, cors);

    /* Transient upstream failures (connection resets, Groq 5xx/429) are
       retried HERE with a short backoff, before anything streams, so a
       momentary hiccup never reaches the visitor as an error. Non-retryable
       client errors (400/401/403/413/422…) pass through untouched so the
       frontend's own handling keeps working. */
    const body = await request.text();
    const ATTEMPTS = 3;
    let lastUpstream = null; // last retryable response (for pass-through on exhaust)
    let lastConnError = null; // last connection-level failure
    for (let i = 0; i < ATTEMPTS; i++) {
      let upstream;
      try {
        upstream = await fetch(GROQ_BASE + "/" + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer " + env.GROQ_API_KEY,
          },
          body,
        });
      } catch (e) {
        // Connection-level failure (DNS, TLS, reset) -> back off and retry.
        lastConnError = e;
        await sleep(400 * (i + 1));
        continue;
      }

      if (upstream.ok) {
        // Success: pass everything through — SSE bodies stream straight to
        // the browser (mid-stream drops are healed by the client's
        // partial-answer + automatic-continue logic).
        const headers = new Headers(cors);
        const ct = upstream.headers.get("content-type");
        if (ct) headers.set("content-type", ct);
        const ra = upstream.headers.get("retry-after");
        if (ra) headers.set("retry-after", ra);
        return new Response(upstream.body, { status: upstream.status, headers });
      }

      if (upstream.status >= 500 || upstream.status === 429) {
        // Retryable upstream state. Capture the small error body now (it
        // cannot be re-read later), then back off — honouring Groq's
        // Retry-After on 429, capped so the browser never times out.
        const errText = await upstream.text().catch(() => "");
        const ra = Number(upstream.headers.get("retry-after"));
        lastUpstream = { status: upstream.status, ra, errText, ct: upstream.headers.get("content-type") };
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 400 * (i + 1));
        continue;
      }

      // Non-retryable (400/401/403/413/422…): pass the error through WITH
      // CORS so the browser can read the real cause instead of masking it
      // as a network failure.
      const headers = new Headers(cors);
      const ct = upstream.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      const ra = upstream.headers.get("retry-after");
      if (ra) headers.set("retry-after", ra);
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // All attempts exhausted:
    // - A real upstream 429/5xx is passed through verbatim (status +
    //   Retry-After) so the client's auto-retry logic works as designed.
    // - Connection-level failures get a CORS JSON 502 with a Retry-After
    //   hint — also auto-retried by the client.
    if (lastUpstream) {
      const headers = new Headers(cors);
      if (lastUpstream.ct) headers.set("content-type", lastUpstream.ct);
      if (lastUpstream.ra) headers.set("retry-after", String(lastUpstream.ra));
      return new Response(lastUpstream.errText || '{"error":{"message":"Upstream error."}}', {
        status: lastUpstream.status,
        headers,
      });
    }
    return json(
      { error: { message: "Upstream AI provider is briefly unreachable from the proxy." } },
      502,
      { ...cors, "retry-after": "3" }
    );
}
