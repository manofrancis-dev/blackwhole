# 🛠️ Roadmap — fixing the assistant's known weaknesses

Turns the weaknesses found in QA ("what is your weakness" review) into concrete,
small work items. Everything fits the existing architecture: prompt rules in
`js/api.js`, ChatGPT-style tools via `AI.toolkit()`, and server-side helpers in
the Cloudflare Worker (`worker/src/worker.js`).

> **Status (Nov 15 2026): all four fixes shipped, tested and verified live.**
> Fix 1 ✅ live · Fix 2 ✅ live (haiku verified 5-7-5 via tool) ·
> Fix 3 ✅ live (real Nov-2026 news with links; see worker/README.md for the
> search-source saga — DDG/Google-News/Mojeek all bot-challenge CF IPs, so the
> worker races keyless sources in parallel) · Fix 4a ✅ live (name remembered
> across chats) · Fix 4b ✅ unit-tested (mechanical rolling summary, no extra
> API call) · Fix 5 ✅ hotfixed (blank "finished" reply after tool rounds).
> Upgrade path for best search quality: set a `BRAVE_API_KEY`
> worker secret.

Legend: 🟢 prompt-only · 🟡 frontend tool · 🔴 worker change

---

## Fix 1 — Ambiguity → ask, don't guess 🟢 (quick win, ~15 min)

**Problem:** vague questions get a confident guess instead of a clarifying question.

**Change:** add one rule to `ACCURACY_PROMPT` in `js/api.js` (after rule 4):

> 5. If a request is ambiguous or missing a key detail (which date? which
> version? which of several possible meanings?), ask ONE short clarifying
> question first instead of guessing. If the most likely reading is obvious,
> answer it and note the assumption in one line.

**Accept:** QA prompt "ethula fix pannu?" style vague ask → bot asks what to fix.

---

## Fix 2 — Verify counts with code, not mental math 🟡 (~2 h)

**Problem:** haikus, letter counts, character limits are asserted without
verifying (rule 3 says verify, but the model counts in its head).

**Change:**
1. New browser tool `count_text` in `TOOL_DEFINITIONS` / `TOOL_EXECUTORS`
   (`js/api.js`, next to `get_weather`): exact character count (with/without
   spaces), word count, sentence count, per-letter frequency, and an English
   syllable estimate (standard heuristic: vowel groups, silent-e, -le endings).
2. Rule 3 of `ACCURACY_PROMPT` → "call `count_text` on your draft and fix any
   line that fails before sending".

**Accept:** "5-7-5 haiku about rain" → every line verified by the tool;
QA suite (`worker/test-local.mjs` / accuracy-report prompts) passes.

---

## Fix 3 — Real-time knowledge: web search tool 🔴🟡 (~half day)

**Problem:** model only knows training data; date/time + weather are covered by
tools, but news / current facts / "latest version of X" are not.

**Change (server-side, like the Groq key — never client-side):**
1. `worker/src/worker.js`: new routes next to `/health`:
   - `POST /tools/search` `{ q }` → query a keyless source (DuckDuckGo Lite HTML
     scrape; Wikipedia REST fallback) → return top ~5 `{title, url, snippet}`.
   - `POST /tools/read` `{ url }` → fetch a page, strip HTML to plain text,
     cap at ~8k chars, 10 s timeout.
   - Keep the existing `ALLOWED_ORIGINS` CORS guard on both.
2. `js/api.js`: add `web_search` + `read_webpage` tools whose executors
   `fetch(PROXY_URL + "/tools/search", …)`; extend `ACCURACY_PROMPT` rule 2 →
   "if the user asks about anything recent, call `web_search` first and cite
   the source URL".
3. Existing `MAX_TOOL_ROUNDS = 3` already bounds search+read+answer rounds.

**Why through the worker:** browser-side scraping dies on CORS; and a search
API key (if ever needed) must live server-side — same lesson as the 401 key
leak in `worker/README.md`.

**Deploy:** `npx wrangler deploy` from `worker/`, then push the frontend.

**Accept:** "What happened in AI this week?" → real Nov-2026 answers with links.

---

## Fix 4 — Memory: don't lose older details 🟡 (2 steps)

**Problem:** `trimHistory()` drops old messages under the TPM budget, so long
chats lose early context; no long-term memory between sessions.

**4a — Long-term memory 🟡 (~3 h):**
1. Tools `remember(fact)` and `forget()` in `TOOL_DEFINITIONS`/`TOOL_EXECUTORS`
   → read/write `localStorage["bw_memory"]` (array of `{fact, ts}`, cap 30).
2. In `js/app.js` (~line 737, where `clientContext: realtimeContext()` is
   built): inject the latest 30 facts into `clientContext` so every request
   carries them — zero API change.

**4b — Rolling summary 🟡 (~half day):**
1. Before `trimHistory()` discards overflow, append the dropped tail to a
   compact running summary stored per chat (`chats[i].summary`).
2. Send it as a `system` note: "Earlier in this conversation (summary): …"
3. On each continue of the summary, keep it ≤ ~200 tokens (ask the model to
   compress when it grows).

**Accept:** tell the bot your name in chat #1, open chat #2 → it remembers;
in one very long chat it still recalls the first message's key details.

---

## Fix 5 — Blank "finished" reply after tool rounds 🟡 (hotfix, Nov 15 2026)

**Problem (seen live):** "what going on in chennai today" → bubble stuck on
"🔎 Searching the web…" with copy/retry buttons but NO text — marked finished.
Cause: the search sources failed for that query (Mojeek 403, GDELT timeout,
Google-News window elapsed → only irrelevant Wikipedia results), so the model
kept re-calling `web_search` with reworded queries. After `MAX_TOOL_ROUNDS = 3`
executions, `streamChat()` still returned only tool calls — the loop fell
through and `return answer;` resolved with `""`. The UI pushed an empty
assistant message, kept the tool-status paint, and showed the action icons.

**Change (`js/api.js`):**
1. When the tool budget is exhausted but the model still asks for tools, force
   ONE final tools-free round with a nudge message (`TOOL_BUDGET_PROMPT`):
   "answer now from the results you already have".
2. Hard guard before returning: an empty `answer` throws a clear error
   ("The model returned an empty reply. Please try again.") so the UI shows
   its ⚠️ + ↻ Try-again block instead of a silent blank bubble.
3. New `ACCURACY_PROMPT` rule 6: don't hammer a failing tool — try at most one
   different query, then tell the user and answer from what you know.

**Accept:** simulated model that returns tool calls forever → final text answer
via the forced round (`worker/test-tools.cjs` tests 5-6, 24/24 passing); a
model that asks for tools even when stripped → visible retryable error.

---

## Suggested order

| Phase | Item | Effort | Impact |
|---|---|---|---|
| 1 | Fix 1 (clarity rule) | 15 min | High |
| 2 | Fix 2 (`count_text` tool) | 2 h | Medium |
| 3 | Fix 3 (web search via worker) | half day | High |
| 4 | Fix 4a (memory) → 4b (summary) | 3 h → half day | High |

Each phase is independently shippable — no big-bang release needed.
