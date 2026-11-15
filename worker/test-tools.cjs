/* Tests the new tool-calling flow in js/api.js inside plain Node:
   - window stub so the IIFE runs
   - mocked provider SSE streams (tool call round -> final answer round)
   - REAL Open-Meteo calls for the weather tool
   - datetime tool accuracy vs Node's own clock */
globalThis.window = {};
require("../js/api.js");
const AI = globalThis.window.AI;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -> " + extra : "")); }
};

/* SSE response factory */
const sse = (events) => new Response(
  events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } }
);

async function main() {
  const cfg = {
    provider: "blackwhole",
    apiKey: "",
    model: "openai/gpt-oss-120b",
    systemPrompt: "",
    clientContext: "REAL-TIME CONTEXT: test",
    tools: AI.toolkit(),
    temperature: 0.7,
  };

  /* ---- 1. tool call round-trip: model asks for weather, tool answers, model replies ---- */
  {
    let round = 0;
    const seenMessages = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("open-meteo")) return origFetch(url, init); // real weather API
      round++;
      const body = JSON.parse(init.body);
      if (round === 1) {
        if (body.tools) check("tools sent in body", Array.isArray(body.tools) && body.tools[0].function.name === "get_current_datetime");
        check("clientContext in system", /REAL-TIME CONTEXT/.test(body.messages[0].content));
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"loc" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ation\":\"Chennai\"}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      seenMessages.push(body.messages);
      return sse([
        { choices: [{ delta: { content: "It is " } }] },
        { choices: [{ delta: { content: "rainy in Chennai right now." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    };

    const notes = [];
    const deltas = [];
    const answer = await AI.streamChat(cfg, [{ role: "user", content: "weather in Chennai?" }], {
      onDelta: (_d, all) => deltas.push(all),
      onToolCall: (name) => notes.push(name),
    });
    globalThis.fetch = origFetch;

    check("onToolCall fired with get_weather", notes.includes("get_weather"));
    check("final answer streamed", answer === "It is rainy in Chennai right now.", answer);
    check("deltas only from final round", deltas[deltas.length - 1] === answer);
    const last = seenMessages[0];
    const toolMsg = last.find(m => m.role === "tool");
    const asstMsg = last.find(m => m.role === "assistant" && m.tool_calls);
    check("assistant tool_calls appended", asstMsg && asstMsg.tool_calls[0].id === "call_1" &&
      asstMsg.tool_calls[0].function.name === "get_weather" &&
      asstMsg.tool_calls[0].function.arguments === '{"location":"Chennai"}',
      asstMsg && JSON.stringify(asstMsg.tool_calls));
    check("tool result appended", toolMsg && toolMsg.tool_call_id === "call_1" &&
      /temperature_c/.test(toolMsg.content), toolMsg && String(toolMsg.content).slice(0, 120));
    const wx = JSON.parse(toolMsg.content);
    check("weather tool returned real Chennai data", wx.place && /Chennai/.test(wx.place) &&
      typeof wx.now.temperature_c === "number" && wx.now.condition, wx.place + " " + wx.now.temperature_c + "C " + wx.now.condition);
  }

  /* ---- 2. datetime tool: accuracy ---- */
  {
    const raw = await AI.toolkit().execute("get_current_datetime", { timezone: "Asia/Kolkata" });
    const j = JSON.parse(raw);
    check("datetime has utc + iso", j.iso_utc.endsWith("Z") && /GMT/.test(j.utc));
    check("IST local time formatted", /pm|am/i.test(j.local_time) && /Asia\/Kolkata/.test(j.timezone), j.local_time);
    const d = new Date(j.iso_utc);
    check("datetime matches Node clock", Math.abs(Date.now() - d.getTime()) < 5000);
    const bad = await AI.toolkit().execute("get_current_datetime", { timezone: "Not/AZone" });
    check("invalid timezone falls back", /GMT|UTC|am|pm/i.test(JSON.parse(bad).local_time));
  }

  /* ---- 3. provider rejects tools (400) -> retries once without tools ---- */
  {
    let round = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      round++;
      const body = JSON.parse(init.body);
      if (round === 1) {
        check("first round has tools", Array.isArray(body.tools));
        return new Response(JSON.stringify({ error: { message: "'tools' is not supported" } }),
          { status: 400, headers: { "content-type": "application/json" } });
      }
      check("second round has NO tools", body.tools === undefined);
      return sse([{ choices: [{ delta: { content: "plain answer" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
    };
    const a = await AI.streamChat(cfg, [{ role: "user", content: "hi" }], {});
    globalThis.fetch = origFetch;
    check("fallback answer delivered", a === "plain answer", a);
  }

  /* ---- 4. no-tool regression: plain streaming still works ---- */
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => sse([
      { choices: [{ delta: { content: "hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const a = await AI.streamChat({ ...cfg, tools: null }, [{ role: "user", content: "hi" }], {});
    globalThis.fetch = origFetch;
    check("plain streaming regression", a === "hello world", a);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error("CRASH:", e); process.exit(1); });
