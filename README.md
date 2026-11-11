# 🕳️ Blackwhole — ChatGPT-style AI Chat Website

A complete ChatGPT-like chatbot website built with pure HTML, CSS, and JavaScript —
no frameworks, no build step, no backend required. Open `index.html` in any modern
browser and you're ready to chat with a real AI.

## ✨ Features

- **Real AI, streaming responses** — answers appear word-by-word like ChatGPT
- **Multi-provider support** — OpenAI, Anthropic (Claude), OpenRouter, Groq,
  or any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM…)
- **Conversation history** — chats are saved in your browser (localStorage),
  with auto-titles, delete, and a **live search** that matches titles and
  message content (highlighted results + snippets)
- **Edit any message** — rewrite a prompt inline; the conversation branches from
  that point and the answer regenerates
- **Markdown rendering** — headings, lists, tables, quotes, and syntax-highlight
  style code blocks with one-click **Copy code** buttons
- **Dark & light themes** — follows your system preference, toggleable
- **Fully responsive** — works great on phones (collapsible sidebar)
- **Stop generation** — halt a response mid-stream like the real thing
- **Regenerate** — re-roll the last answer
- **Zero setup** — ships with a built-in Groq key; **Groq + `openai/gpt-oss-120b`**
  and temperature **0.7** are pre-configured, so users just open it and chat
- **Rate-limit friendly** — context is trimmed to fit the free tier and
  token-per-minute limits are retried automatically instead of failing
- **Safe rendering** — all AI/user text is HTML-escaped before markdown parsing
- **SEO-ready** — title/description, Open Graph + Twitter cards, JSON-LD structured
  data, sitemap, robots.txt, PWA manifest and a full favicon set
- **Cinematic intro** — animated star-warp splash (click or press any key to skip)
- **Keyboard shortcuts** — `Ctrl/Cmd + K` search, `Ctrl/Cmd + N` new chat

## 🚀 Quick start

1. Open `index.html` in your browser (double-click works).
   - Or serve it locally: `python -m http.server 8000` then visit
     `http://localhost:8000`
2. Start chatting! No key or setup is needed — the built-in Groq key is used
   automatically. Use the suggestion cards or type your own message.

## 🔒 About the built-in API key

The Groq key is compiled into `js/app.js` (`BUILT_IN_API_KEY`) so every visitor
can chat with zero setup. That also means:

- **Anyone who opens the page can read the key** (open DevTools → Sources, or
  just view `js/app.js`). This is how client-side apps work — there is no way to
  hide a key in front-end code.
- Anyone can use the key and consume the free quota, so treat it as a **public,
  shared key**. Rotate it at https://console.groq.com/keys if it gets abused.
- For a truly private/production setup, move the request behind a tiny backend
  proxy and keep the key on the server.

To swap the key, edit `BUILT_IN_API_KEY` at the top of `js/app.js`.

## ⌨️ Controls

| Action | How |
|---|---|
| Send message | `Enter` (or click ➤) |
| New line | `Shift + Enter` |
| Stop generating | Click ■ while streaming |
| Search chats | Search box in sidebar, or `Ctrl/Cmd + K` |
| New chat | "New chat" button, or `Ctrl/Cmd + N` |
| Edit a message | Hover your message → pencil → **Save & send** |
| Copy AI reply / code | Hover a message → copy icon; code blocks have Copy buttons |
| Regenerate last reply | Hover the last AI message → ↻ |
| Toggle dark/light | 🌙 icon in the header |

## 📁 Files

```
ai-chatbot-v2/
├── index.html            # Page + SEO metadata + JSON-LD
├── css/styles.css        # ChatGPT-style themes & layout (light/dark)
├── js/markdown.js        # Safe markdown → HTML renderer
├── js/api.js             # Streaming clients for OpenAI-compatible & Anthropic APIs
├── js/app.js             # UI logic: chats, storage, streaming, built-in key
├── assets/icons/         # Favicons 16–512 px, Apple touch icon, maskable icon
├── assets/og-image.png   # Social share image (1200×630)
├── favicon.ico           # Root favicon (Google search result icon)
├── robots.txt            # Crawler rules + sitemap URL
├── sitemap.xml           # Homepage sitemap with image
├── site.webmanifest      # PWA name/icons/theme
└── .nojekyll             # Tells GitHub Pages to serve files as-is
```

## 🌐 Deploy on GitHub Pages

1. Create a **public** repo named **`blackwhole`** under
   `https://github.com/manofrancis-dev`.
2. Push this folder to the repo root (branch `main`).
3. Repo → **Settings → Pages → Source: Deploy from a branch → `main` / `root`** → Save.
4. Wait 1–2 minutes. Your site will be:
   `https://manofrancis-dev.github.io/blackwhole/`

> If you use a different repo name, replace every
> `https://manofrancis-dev.github.io/blackwhole/` in `index.html`, `robots.txt` and
> `sitemap.xml` with your real URL.

### Included for SEO

- Title, meta description, keywords, author, robots directives and canonical URL
- Open Graph + Twitter/X large-image cards
- JSON-LD structured data: `WebSite`, `WebApplication`, and `Person` (Mano Francis)
- Complete favicon set + `favicon.ico` + Apple touch icon + web manifest
- `robots.txt`, `sitemap.xml` and a `<noscript>` description for crawlers

### Get indexed (do this right after deploying)

1. **Google Search Console** → add your URL as a property → verify it with the
   `google-site-verification` meta tag (a comment slot is waiting in `index.html`).
2. **Sitemaps** → submit
   `https://manofrancis-dev.github.io/blackwhole/sitemap.xml`.
3. **URL Inspection** → paste the homepage → **Request indexing**.
4. **Bing Webmaster Tools** → add the site and submit the same sitemap.
5. Share the link on GitHub, LinkedIn, X, WhatsApp, etc. — real backlinks and
   traffic are what move rankings.

### Honest expectation about ranking

The metadata makes the site **eligible** and gives Google the correct name, logo and
description — but no one can guarantee **#1** for broad words like “AI” or “mano”.
Those depend on backlinks, traffic and competition. Brand searches (“Blackwhole”,
“Blackwhole AI”, “Mano Francis Dev”, “Mano Francis AI”) are realistic and should
rank once indexed. Google can also keep showing a generic globe for days or weeks
until it recrawls the favicon; the files are correct, so it will update.

## 🛠️ Troubleshooting

- **Invalid API key (HTTP 401/403)** — the built-in key was revoked or rotated;
  replace `BUILT_IN_API_KEY` in `js/app.js`.
- **Rate limit reached / tokens-per-minute (HTTP 413 or 429)** — Groq's free tier
  allows ~8,000 tokens per minute. Blackwhole trims older messages automatically
  before each send and retries automatically. If it still happens: wait about a
  minute, shorten your message, start a new chat, or upgrade at console.groq.com.
- **Empty response** — Groq may be having an outage; try again in a moment.
- **Key exhausted by other users** — the key is shared publicly; create a new one
  at https://console.groq.com/keys and update `js/app.js`.

Enjoy! 🕳️ Blackwhole
