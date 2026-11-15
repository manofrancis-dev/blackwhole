/* Local harness for the frontend AI toolkit (js/api.js).
   Loads the IIFE in Node with window/localStorage/fetch stubbed, then
   verifies the new tools: count_text (Fix 2), remember/forget (Fix 4a),
   the rolling-summary note (Fix 4b) and the prompt rules (Fixes 1-3). */

import { readFileSync } from "node:fs";

const store = new Map();
globalThis.window = {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const src = readFileSync(new URL("./js/api.js", import.meta.url), "utf8");
(0, eval)(src);
const AI = globalThis.window.AI;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const exec = (name, args) => AI.toolkit().execute(name, args);
const J = (s) => JSON.parse(s);

/* ---- Fix 2: count_text ---- */
{
  const r = J(await exec("count_text", { text: "An old silent pond\nA frog jumps into the pond—\nSplash! Silence again." }));
  check("haiku line counts", r.lines.map(l => l.characters).join(",") === "18,27,22",
    r.lines.map(l => l.characters));
  check("haiku syllables 5-7-5", r.lines.map(l => l.syllables).join("-") === "5-7-5",
    r.lines.map(l => l.syllables));
  check("haiku words", r.lines.map(l => l.words).join(",") === "4,6,3");
  check("overall chars", r.overall.characters === 69, r.overall.characters);
  check("overall without spaces", r.overall.characters_without_spaces === 57, r.overall.characters_without_spaces);
}
{
  const r = J(await exec("count_text", { text: "hello world, hello moon" }));
  check("word count", r.overall.words === 4, r.overall.words);
  check("letter frequency", r.letter_frequency.l === 5 && r.letter_frequency.o === 5, r.letter_frequency);
  check("sentence count", r.overall.sentences === 1);
}
{
  const r = J(await exec("count_text", { text: "One. Two? Three!" }));
  check("sentences multi", r.overall.sentences === 3, r.overall.sentences);
  // one=1, two=1, three=1 syllable each (vowel-group heuristic)
  check("syllable sanity", r.overall.total_syllables === 3, r.overall.total_syllables);
}
{
  let threw = false;
  try { await exec("count_text", { text: "   " }); } catch { threw = true; }
  check("count_text empty throws", threw);
}

/* ---- Fix 4a: remember / forget + memoryFacts ---- */
{
  const r = J(await exec("remember", { fact: "User's name is Mano" }));
  check("remember ok", r.ok === true && r.total_facts === 1, r);
  check("memoryFacts reads it", AI.memoryFacts()[0].fact === "User's name is Mano");

  await exec("remember", { fact: "User prefers Tanglish replies" });
  await exec("remember", { fact: "User's name is Mano" }); // duplicate refresh
  check("dedupe on re-store", AI.memoryFacts().length === 2, AI.memoryFacts().length);
  check("dedupe keeps newest", AI.memoryFacts()[1].fact === "User's name is Mano");

  const r2 = J(await exec("forget", { fact: "Tanglish" }));
  check("forget removes matching", r2.removed === 1 && r2.remaining === 1, r2);
  check("memory after forget", AI.memoryFacts().length === 1);

  const r3 = J(await exec("forget", {}));
  check("forget clears all", r3.removed === 1 && r3.remaining === 0, r3);
  check("memory empty", AI.memoryFacts().length === 0);
}
{
  const longFact = "x".repeat(301);
  let threw = false;
  try { await exec("remember", { fact: longFact }); } catch { threw = true; }
  check("remember rejects >300 chars", threw);
}
{
  // cap at 30
  for (let i = 0; i < 35; i++) await exec("remember", { fact: "fact " + i });
  check("memory capped at 30", AI.memoryFacts().length === 30, AI.memoryFacts().length);
  check("cap keeps newest", AI.memoryFacts()[29].fact === "fact 34");
  await exec("forget", {});
}

/* ---- Fix 4b: rolling summary note ---- */
{
  // budget small enough to force trimming of the first two messages
  const cfg = { provider: "blackwhole", clientContext: "", tools: null };
  const messages = [
    { role: "user", content: "My name is Mano and I live in Chennai. Remember this for the whole conversation." },
    { role: "assistant", content: "Noted, Mano — Chennai it is. " + "pad ".repeat(8000) },
    { role: "user", content: "What did I say my name was? Answer in one short line." },
  ];
  let sawRequest = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sawRequest = JSON.parse(init.body);
    const sse = 'data: {"choices":[{"delta":{"content":"You said Mano."}}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  // blackwhole -> PROXY_URL/v1/chat/completions; stub it directly
  const out = await AI.streamChat(cfg, messages, {});
  globalThis.fetch = origFetch;

  check("summary: answer streamed", out === "You said Mano.", out);
  const sys = sawRequest.messages.find(m => m.role === "system")?.content || "";
  check("summary: history trimmed", sawRequest.messages.length <= 3, sawRequest.messages.map(m => m.role));
  check("summary: contains compacted user facts",
    /EARLIER IN THIS CONVERSATION/.test(sys) && /My name is Mano/.test(sys),
    sys.slice(0, 300));
}

/* ---- Fix 3 (frontend side): web_search / read_webpage call the worker ---- */
{
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: init.body };
    return new Response(JSON.stringify({
      source: "duckduckgo",
      results: [{ title: "T", url: "https://e.com", snippet: "s" }],
    }), { status: 200 });
  };
  const r = J(await exec("web_search", { query: "ai news" }));
  globalThis.fetch = origFetch;
  check("search hits worker /tools/search", seen.url.endsWith("/tools/search"), seen.url);
  check("search returns results", r.results.length === 1 && r.results[0].title === "T");
}
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "No results found — search sources are unavailable right now." } }), { status: 502 });
  let threw = false;
  try { await exec("web_search", { query: "x" }); } catch { threw = true; }
  globalThis.fetch = origFetch;
  check("search worker 502 -> tool error", threw);
}
{
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: init.body };
    return new Response(JSON.stringify({ url: "https://e.com", text: "hi", truncated: false }), { status: 200 });
  };
  const r = J(await exec("read_webpage", { url: "https://example.com/a" }));
  globalThis.fetch = origFetch;
  check("read hits worker /tools/read", seen.url.endsWith("/tools/read") && JSON.parse(seen.body).url === "https://example.com/a");
  check("read returns text", r.text === "hi");
  let threw = false;
  try { await exec("read_webpage", { url: "javascript:alert(1)" }); } catch { threw = true; }
  check("read rejects non-http url", threw);
}

/* ---- Fixes 1-3: prompt rules present ---- */
{
  // Reach ACCURACY_PROMPT through buildRequest via testConnection's fetch.
  const origFetch = globalThis.fetch;
  let sys = "";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    body.stream = false;
    sys = body.messages.find(m => m.role === "system").content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "connected" } }] }), { status: 200 });
  };
  await AI.testConnection({ provider: "openai", apiKey: "k", model: "gpt-4o-mini" });
  globalThis.fetch = origFetch;

  check("rule 5 (clarify, don't guess)", sys.includes("ask ONE short clarifying question"));
  check("rule 3 uses count_text", sys.includes("call the count_text tool on your draft"));
  check("rule 2 mandates web_search for recent", sys.includes("call the web_search tool FIRST"));
}

/* ---- tool definitions sanity ---- */
{
  const names = AI.toolkit().definitions.map(d => d.function.name);
  for (const n of ["get_current_datetime", "get_weather", "count_text", "web_search", "read_webpage", "remember", "forget"]) {
    check("definition: " + n, names.includes(n));
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
