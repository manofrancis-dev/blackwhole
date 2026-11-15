/* BLACKWHOLE ACCURACY QA — targets the failure modes found in manual review:
   stale world facts (Croatia kuna, Nur-Sultan, DR Congo population),
   fabricated Einstein details, and haikus shipped at 6-7-6 instead of 5-7-5.
   Runs the EXACT browser code path (js/api.js streamChat, identity +
   ACCURACY_PROMPT baked in) against the LIVE worker -> Groq.
   The syllable counter is a heuristic (English syllable counting is not
   exact in JS) — a marginal miss is reported, not silently hidden. */
globalThis.window = {};
require("../js/api.js");
const AI = globalThis.window.AI;
const fs = require("fs");

const PROXY_ORIGIN = "https://manofrancis-dev.github.io";

/* Faithful browser simulation: attach the site Origin to worker calls. */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  if (u.includes("workers.dev")) {
    init.headers = { ...(init.headers || {}), origin: PROXY_ORIGIN };
  }
  return realFetch(url, init);
};

/* Same real-time context the site injects on every send (replicated from
   js/app.js realtimeContext()). */
function realtimeContext() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  let local;
  try {
    local = new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).format(now);
  } catch { local = now.toString(); }
  const off = -now.getTimezoneOffset();
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const om = String(Math.abs(off) % 60).padStart(2, "0");
  return [
    "REAL-TIME CONTEXT (captured just now — trust this over your training data):",
    "- User's local date & time: " + local + " (" + tz + ", UTC" +
      (off >= 0 ? "+" : "-") + oh + ":" + om + ")",
    "- UTC now: " + now.toUTCString(),
    "- Rule: never guess or invent the current date, time or weather. For",
    "  time questions use the context above (or the get_current_datetime",
    "  tool for other cities); for weather always call the get_weather tool.",
  ].join("\n");
}

const CFG = {
  provider: "blackwhole",
  apiKey: "",
  model: "openai/gpt-oss-120b",
  systemPrompt: "You are Blackwhole, a helpful, friendly AI assistant created by Mano Francis. Answer clearly and concisely, using markdown formatting when useful. Never invent the current date, time, or weather — always rely on the provided real-time context and tools instead.",
  clientContext: realtimeContext(),
  tools: AI.toolkit(),
  temperature: 0.7,
};

/* ---------- helpers ---------- */

/* Heuristic English syllable counter (vowel-group method + common silent
   endings). Sibilant endings keep their extra syllable ("dances" = 2,
   "boxes" = 2), plain "-es"/"-e"/"-ed" are silent ("makes" = 1). Not
   perfect, but good enough to catch a 6-7-6 "haiku". */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let x = w;
  if (!/(?:s|z|x|ch|sh|[gc]e)es$/.test(x)) x = x.replace(/es$/, "");
  x = x.replace(/(?:[^tdlaeiouy])e$/, "");
  if (/[^td]ed$/.test(x)) x = x.replace(/ed$/, "");
  const m = x.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}
function lineSyllables(line) {
  return line.split(/\s+/).reduce((n, w) => n + syllables(w), 0);
}

const num = (s) => {
  const m = /(\d+(?:[.,]\d+)?)\s*(million|mn|crore|m\b)/i.exec(s) || /(\d{1,3}(?:,\d{3})+|\d+)\b/.exec(s);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ""));
  if (/million|mn|m\b/i.test(m[2] || "")) v *= 1e6;
  if (/crore/i.test(m[2] || "")) v *= 1e7;
  return v;
};

/* ---------- the 5 accuracy tests ---------- */
const TESTS = [
  {
    n: 1, prompt: "Write a haiku (exactly 5-7-5 syllables) about photosynthesis.",
    check: (a) => {
      const lines = a.trim().split("\n").map(s => s.trim()).filter(s => s && !/haiku|syllab|\(|\*/i.test(s)).slice(0, 3);
      if (lines.length < 3) return { pass: false, note: "fewer than 3 poem lines found" };
      const c = lines.map(lineSyllables);
      const ok = c[0] === 5 && c[1] === 7 && c[2] === 5;
      return { pass: ok, note: "approx counts " + c.join("-") + " (need 5-7-5)" };
    },
  },
  {
    n: 2, prompt: "What currency does Croatia use today? One sentence.",
    check: (a) => {
      if (!/euro/i.test(a)) return { pass: false, note: "no mention of the euro" };
      if (/kuna/i.test(a) && !/no longer|until 2022|replaced|retired|used before|former/i.test(a))
        return { pass: false, note: "kuna stated without 'former/retired' framing" };
      return { pass: true, note: "euro as current currency" };
    },
  },
  {
    n: 3, prompt: "What is the capital of Kazakhstan? One short sentence.",
    check: (a) => {
      if (!/astana/i.test(a)) return { pass: false, note: "Astana missing — answer: " + a.slice(0, 60) };
      return { pass: true, note: /nur-sultan|nur sultan/i.test(a) ? "Astana given (Nur-Sultan mentioned as former name)" : "Astana given" };
    },
  },
  {
    n: 4, prompt: "What is the population of the Democratic Republic of the Congo? One sentence.",
    check: (a) => {
      const v = num(a);
      if (v === null) return { pass: false, note: "no population number found" };
      if (v >= 100e6 && v <= 130e6) return { pass: true, note: "stated ~" + (v / 1e6).toFixed(0) + "M (plausible 2023-2026)" };
      return { pass: false, note: "stated ~" + (v / 1e6).toFixed(0) + "M — outside plausible 100-130M" };
    },
  },
  {
    n: 5, prompt: "Did Einstein ever fail math as a student? Answer in 3-4 sentences.",
    check: (a) => {
      if (!/never failed|did not fail|didn't fail|didnt fail|no[,.\s]|never/i.test(a))
        return { pass: false, note: "conclusion missing/unclear" };
      if (/[""]([^""]{40,})[""]/.test(a))
        return { pass: false, note: "WARN-worthy: contains a long verbatim quote — verify it is authentic" };
      return { pass: true, note: "correct conclusion, no long invented quote" };
    },
  },
];

/* ---------- runner ---------- */
async function main() {
  const results = [];
  console.log("BLACKWHOLE ACCURACY QA — 5 known failure modes, live worker -> Groq\n" + "=".repeat(64));
  for (const t of TESTS) {
    const meta = { firstTokenMs: null, totalMs: 0, toolsUsed: [], retries: 0, streamOK: false };
    const t0 = Date.now();
    let answer = "";
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), 150000);
    let status = "FAIL", note = "";
    try {
      answer = await AI.streamChat(
        { ...CFG, clientContext: realtimeContext() },
        [{ role: "user", content: t.prompt }],
        {
          onDelta: () => { if (meta.firstTokenMs === null) meta.firstTokenMs = Date.now() - t0; },
          onToolCall: (name) => meta.toolsUsed.push(name),
          onRetry: () => { meta.retries++; },
          signal: ac.signal,
        }
      );
      meta.streamOK = answer.trim().length > 0;
      const verdict = await t.check(answer);
      status = verdict.pass ? "PASS" : "FAIL";
      note = verdict.note || "";
    } catch (e) {
      status = "FAIL";
      note = e.name === "AbortError" ? "TIMEOUT 150s" : ("ERROR: " + e.message.slice(0, 80));
    } finally {
      clearTimeout(kill);
    }
    meta.totalMs = Date.now() - t0;
    const r = { n: t.n, prompt: t.prompt, status, note, answer: answer.slice(0, 500), ...meta };
    results.push(r);
    console.log("[" + status + "] #" + t.n + " " + t.prompt.slice(0, 50).padEnd(50) +
      "  " + String((meta.totalMs / 1000).toFixed(1) + "s").padStart(6) +
      (note ? "  | " + note : ""));
    await new Promise(res => setTimeout(res, 2200)); // gentle on free tier
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.length - pass;
  console.log("\n" + "=".repeat(64));
  console.log("SUMMARY: " + pass + " PASS / " + fail + " FAIL  (of 5)");
  fs.writeFileSync(__dirname + "/accuracy-report.json",
    JSON.stringify({ when: new Date().toISOString(), summary: { pass, fail }, results }, null, 2));
  console.log("Full report: worker/accuracy-report.json");
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error("SUITE CRASH:", e); process.exitCode = 1; });
