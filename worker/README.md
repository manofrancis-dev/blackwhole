# Blackwhole AI proxy (Cloudflare Worker)

This tiny worker holds the Groq API key **server-side** so it never ships in
the public frontend bundle. The website calls the worker; the worker calls
Groq and streams the answer back.

Why: API keys hardcoded in a public GitHub repo get found by provider
scanners and automatically revoked within days (this already happened once —
that is why every visitor saw "Invalid API key (HTTP 401)"). With the key on
the server, rotating it never touches the site code.

## First-time deploy (one person, ~5 minutes)

Prerequisites: Node.js installed.

1. **Create a free Cloudflare account** — https://dash.cloudflare.com/sign-up
   (email + password, no card needed).

2. **Create a Groq key** — https://console.groq.com/keys → *Create API Key*.
   (Also delete the old leaked one if it still appears there.)

3. From this `worker/` folder:

   ```bash
   npx wrangler login          # browser opens → click Allow
   npx wrangler deploy         # prints: https://blackwhole-proxy.<subdomain>.workers.dev
   npx wrangler secret put GROQ_API_KEY
   # paste the Groq key when prompted, press Enter
   ```

4. Copy the deployed URL from step 3 and set it in `js/api.js`:

   ```js
   const PROXY_URL = "https://blackwhole-proxy.<subdomain>.workers.dev";
   ```

5. Push the frontend — GitHub Pages redeploys automatically in ~1 minute.

## Rotating the key later (when users never notice)

```bash
npx wrangler secret put GROQ_API_KEY
```

That's it — no code change, no redeploy, the site keeps working.

## Endpoints

| Route | Description |
|---|---|
| `GET /health` | `{ ok: true }` — use for uptime checks |
| `POST /v1/*` | Proxied to `https://api.groq.com/openai/v1/*` (SSE streams pass through) |
| `POST /tools/search` `{ q }` | Keyless web search → `{ source, results: [{title, url, snippet}] }` |
| `POST /tools/read` `{ url }` | Fetch a page, strip HTML → `{ text }` (plain text, ~8k cap, 10 s timeout) |

Search sources are tried in order and the first that returns results wins:
`brave` (only if the `BRAVE_API_KEY` secret is set — best quality, free tier
2k/month) → `duckduckgo` → `mojeek` → `google-news` → `gdelt` (real-time
news, max 1 req / 5 s) → `hn` (Hacker News) → `wikipedia` → `bing-rss`.

Verified live from Cloudflare (Nov 2026): DuckDuckGo Lite and Google News
RSS are blocked/challenged from worker IPs (`525` / `503`), Bing RSS returns
unrelated results — so in production GDELT / HN answer news queries and
Wikipedia answers fact queries. Run `/tools/search?debug=1` to see each
source's error. Add a `BRAVE_API_KEY` secret for Google-quality relevance:

```bash
npx wrangler secret put BRAVE_API_KEY   # https://brave.com/search/api/
```

## Configuration

- `GROQ_API_KEY` — secret, set via `wrangler secret put`
- `BRAVE_API_KEY` — optional secret; enables the best search source
- `ALLOWED_ORIGINS` — var in `wrangler.toml`; only these origins may call the
  proxy (site + local dev). Everyone else gets no CORS header.

Free-tier limits: 100,000 requests/day, streaming included.
