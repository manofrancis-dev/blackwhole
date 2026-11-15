/* BLACKWHOLE QA SUITE — 20 production-faithful tests.
   Runs the EXACT browser code path: js/api.js streamChat + tools +
   real-time context, against the LIVE worker -> Groq, with real Open-Meteo.
   Verifies answers (identity, clock accuracy vs this machine, weather vs
   live API, math, code, markdown) and prints a pass/fail report. */
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
const h24 = (tz) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find(x => x.type === t).value;
  return { h: parseInt(g("hour"), 10) % 24, m: parseInt(g("minute"), 10) };
};
/* Answers may mention several clocks ("12:33 PM UTC ... 6:03 PM IST"), so
   collect every time mentioned and let the test pass if ANY is correct. */
const extractAllTimes = (s) => {
  const times = [];
  const re = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?|(\d{1,2}):(\d{2})\s*h/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      let h = parseInt(m[1], 10) % 12;
      if (m[3] && /p/i.test(m[3])) h += 12;
      times.push({ h, m: parseInt(m[2], 10) });
    } else {
      times.push({ h: parseInt(m[4], 10) % 24, m: parseInt(m[5], 10) });
    }
  }
  return times;
};
const anyTimeMatches = (a, real, tol) =>
  extractAllTimes(a).some(t => {
    const d = Math.abs(t.h * 60 + t.m - (real.h * 60 + real.m));
    return Math.min(d, 1440 - d) <= tol;
  });
const extractTemp = (s) => {
  const m = /(-?\d{1,2}(?:\.\d)?)\s*(?:°|degrees?)?\s*c\b/i.exec(s);
  return m ? parseFloat(m[1]) : null;
};
const liveTemp = async (city) => {
  const g = await (await realFetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(city) + "&count=1&language=en&format=json")).json();
  const p = g.results[0];
  const j = await (await realFetch("https://api.open-meteo.com/v1/forecast?latitude=" + p.latitude + "&longitude=" + p.longitude + "&current=temperature_2m&timezone=auto")).json();
  return j.current.temperature_2m;
};
const LEAK = /\b(i am|i'm|my name is)\s+(chatgpt|gpt|claude|gemini|llama|groq)\b|made by (openai|groq|anthropic|google)/i;

/* Models emit typographic punctuation and Unicode spaces (curly apostrophes,
   narrow no-break spaces inside names) that break literal-space regexes.
   Normalize once, centrally, before every check. */
const norm = (s) => s
  .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
  .replace(/[\u2018\u2019\u201B]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014]/g, "-");

/* ---------- the 20 tests ---------- */
const TESTS = [
  { n: 1, prompt: "Who are you?", check: (a) => ({ pass: /blackwhole/i.test(a) && /mano francis/i.test(a) && !LEAK.test(a), note: /blackwhole/i.test(a) ? (/mano francis/i.test(a) ? (!LEAK.test(a) ? "identity clean" : "LEAK detected") : "creator missing") : "name missing" }) },
  { n: 2, prompt: "Who created you? Who made you?", check: (a) => ({ pass: /mano francis/i.test(a) && !LEAK.test(a), note: /mano francis/i.test(a) ? (!LEAK.test(a) ? "correct" : "LEAK detected") : "wrong creator" }) },
  { n: 3, prompt: "Are you ChatGPT?", check: (a) => ({ pass: /blackwhole/i.test(a) && !/\b(i am|i'm)\s+(chatgpt|gpt)\b/i.test(a), note: "deny + re-identity" }) },
  { n: 4, prompt: "What time is it right now?", wantTool: "get_current_datetime", check: (a) => { const now = h24("Asia/Kolkata"); return { pass: anyTimeMatches(a, now, 5), note: "real " + now.h + ":" + String(now.m).padStart(2, "0") + " IST" }; } },
  { n: 5, prompt: "What time is it in New York right now?", wantTool: "get_current_datetime", check: (a) => { const now = h24("America/New_York"); return { pass: anyTimeMatches(a, now, 8), note: "real NY " + now.h + ":" + String(now.m).padStart(2, "0") }; } },
  { n: 6, prompt: "What time is it in London right now?", wantTool: "get_current_datetime", check: (a) => { const now = h24("Europe/London"); return { pass: anyTimeMatches(a, now, 8), note: "real London " + now.h + ":" + String(now.m).padStart(2, "0") }; } },
  { n: 7, prompt: "What day of the week is today?", check: (a) => { const real = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "long" }).format(new Date()); return { pass: new RegExp(real, "i").test(a), note: "expected: " + real }; } },
  { n: 8, prompt: "What is the weather in Chennai right now?", wantTool: "get_weather", check: async (a) => { const t = extractTemp(a); const real = await liveTemp("Chennai"); return { pass: t !== null && Math.abs(t - real) <= 3.5, note: "stated " + t + "°C vs live " + real + "°C" }; } },
  { n: 9, prompt: "How is the weather in Tokyo today?", wantTool: "get_weather", check: async (a) => { const t = extractTemp(a); const real = await liveTemp("Tokyo"); return { pass: t !== null && Math.abs(t - real) <= 3.5, note: "stated " + t + "°C vs live " + real + "°C" }; } },
  { n: 10, prompt: "Will it rain in Paris today? What's the weather?", wantTool: "get_weather", check: async (a) => { const t = extractTemp(a); const real = await liveTemp("Paris"); return { pass: t !== null && Math.abs(t - real) <= 3.5, note: "stated " + t + "°C vs live " + real + "°C" }; } },
  { n: 11, prompt: "What is 17 × 23? Give just the number.", check: (a) => ({ pass: /\b391\b/.test(a), note: "expected 391" }) },
  { n: 12, prompt: "I have 3 apples and I buy 2 more, then I eat 1. How many apples do I have now?", check: (a) => ({ pass: /\b4\b/.test(a) && !/\b5\b/.test(a), note: "expected 4" }) },
  { n: 13, prompt: "What is the capital of France?", check: (a) => ({ pass: /paris/i.test(a), note: "expected Paris" }) },
  { n: 14, prompt: 'Translate "good morning" to Tamil.', check: (a) => ({ pass: /காலை|வணக்கம்|Kaalai|Vanakkam/i.test(a), note: "Tamil expected" }) },
  { n: 15, prompt: "Write a Python function to reverse a string.", check: (a) => ({ pass: /def\s+\w+|def reverse/i.test(a) && /(\[::-1\]|reversed|"".join)/.test(a), note: "python code expected" }) },
  { n: 16, prompt: "Show me a markdown table with 3 fruits and their colors.", check: (a) => ({ pass: (a.match(/\|/g) || []).length >= 8, note: "table syntax expected" }) },
  { n: 17, prompt: "Explain quantum computing in simple terms in 2-3 sentences.", check: (a) => ({ pass: /quantum|qubit/i.test(a) && a.length > 120, note: a.length + " chars" }) },
  { n: 18, prompt: "Summarize in ONE sentence: The Eiffel Tower, completed in 1889 in Paris, was designed by Gustave Eiffel's company for the 1889 World's Fair. It stands 330 metres tall and was the world's tallest structure until 1930. It remains one of the most visited paid monuments in the world.", check: (a) => ({ pass: /eiffel/i.test(a) && a.length < 600, note: "key term check" }) },
  { n: 19, prompt: "What is 2+2?", check: (a) => ({ pass: /\b4\b/.test(a), note: "expected 4" }) },
  { n: 20, prompt: "Tell me one interesting fact about black holes in one sentence.", check: (a) => ({ pass: /black hole/i.test(a), note: "topic check" }) },
];

/* ---------- runner ---------- */
async function main() {
  const results = [];
  console.log("BLACKWHOLE QA — 20 prompts, live worker -> Groq, real tools\n" + "=".repeat(64));
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
      const verdict = await t.check(norm(answer));
      status = verdict.pass ? "PASS" : "FAIL";
      note = verdict.note || "";
      if (t.wantTool && !meta.toolsUsed.includes(t.wantTool)) {
        status = "WARN"; note = (note ? note + " | " : "") + "tool not used (answered from context)";
      }
    } catch (e) {
      status = "FAIL";
      note = e.name === "AbortError" ? "TIMEOUT 150s" : ("ERROR: " + e.message.slice(0, 80));
    } finally {
      clearTimeout(kill);
    }
    meta.totalMs = Date.now() - t0;
    const r = { n: t.n, prompt: t.prompt, status, note, answer: answer.slice(0, 400), ...meta };
    results.push(r);
    const icon = status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : "FAIL";
    console.log("[" + icon + "] #" + t.n + " " + t.prompt.slice(0, 46).padEnd(46) +
      " " + String((meta.totalMs / 1000).toFixed(1) + "s").padStart(6) +
      "  " + (meta.firstTokenMs !== null ? "first~" + (meta.firstTokenMs / 1000).toFixed(1) + "s" : "no-stream") +
      (meta.toolsUsed.length ? "  tools:" + meta.toolsUsed.join(",") : "") +
      (note ? "  | " + note : ""));
    await new Promise(res => setTimeout(res, 2200)); // gentle on free tier
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const warn = results.filter(r => r.status === "WARN").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const lat = results.filter(r => r.firstTokenMs !== null).map(r => r.firstTokenMs);
  const avgFirst = lat.length ? (lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(2) : "-";
  const avgTotal = (results.reduce((a, b) => a + b.totalMs, 0) / results.length / 1000).toFixed(1);

  console.log("\n" + "=".repeat(64));
  console.log("SUMMARY: " + pass + " PASS / " + warn + " WARN / " + fail + " FAIL  (of 20)");
  console.log("Avg first-token: " + avgFirst + "s | Avg total: " + avgTotal + "s | 429 auto-retries: " + results.reduce((a, b) => a + b.retries, 0));
  fs.writeFileSync(__dirname + "/qa-report.json", JSON.stringify({ when: new Date().toISOString(), summary: { pass, warn, fail, avgFirstTokenSec: avgFirst, avgTotalSec: avgTotal }, results }, null, 2));
  console.log("Full report: worker/qa-report.json");
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error("SUITE CRASH:", e); process.exitCode = 1; });
