// Minimal local stand-in for the Anthropic Messages streaming API, used only by E2E tests.
// It speaks the real SSE wire format so the official SDK in the backend parses it unchanged.
//   POST /v1/messages   -> streams a Markdown reply that echoes the last user message
//   GET  /__requests     -> JSON list of received request bodies (for assertions)
// A user message containing "slow" streams for ~10s so tests can exercise the stop button.
import http from "node:http";

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 8798);
const requests = [];
const hooks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      // Key check: keys containing "good" are valid.
      const auth = String(req.headers["authorization"] ?? req.headers["x-api-key"] ?? "");
      if (!auth.includes("good")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null }));
      return;
    }
    if (req.method === "GET" && req.url === "/__cal.ics") {
      const d = new Date();
      const ymd = (x) => x.toISOString().slice(0, 10).replaceAll("-", "");
      const tomorrow = new Date(d.getTime() + 86400000);
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mock//EN", "BEGIN:VEVENT", "UID:e2e@mock",
        `DTSTART:${ymd(tomorrow)}T150000Z`, `DTEND:${ymd(tomorrow)}T160000Z`, "SUMMARY:Board meeting",
        "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
      return;
    }
    if (req.url === "/__hook") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      hooks.push(raw);
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/__hooks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hooks));
      return;
    }
    if (req.method === "GET" && req.url === "/__page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Malibu Weather</title></head><body><h1>Malibu</h1><p>Sunny, 24 degrees.</p><a href='/__page'>Refresh</a></body></html>");
      return;
    }
    if (req.method === "GET" && req.url === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const system = String(body.system ?? "");
    const jsonReply = (data) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_json", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify(data) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
    };
    if (system.includes("plan autonomous tasks")) {
      return jsonReply({
        summary: "Research both suits in parallel, then write the comparison.",
        steps: [
          { title: "Research Mark 42", instructions: "Summarise the Mark 42.", depends_on: [], parallel_safe: true },
          { title: "Research Mark 50", instructions: "Summarise the Mark 50.", depends_on: [], parallel_safe: true },
          { title: "Write comparison", instructions: "Save comparison.md.", depends_on: [1, 2], parallel_safe: false },
        ],
      });
    }
    if (system.includes("check whether an autonomous task")) {
      return jsonReply({ success: true, summary: "**All done.** The comparison is saved in `comparison.md`.", issues: [] });
    }
    const stepMatch = JSON.stringify(body.messages[0]?.content ?? "").match(/Your step \((\d+) of (\d+)\): ([^\\"]+)/);
    if (stepMatch) {
      const title = stepMatch[3].trim();
      const lastMsg = body.messages.at(-1)?.content;
      const hasResults = Array.isArray(lastMsg) && lastMsg.some((b) => b.type === "tool_result");
      if (title.startsWith("Write") && !hasResults) {
        return streamTool(res, body, "write_file", { path: "comparison.md", content: "# Mark 42 vs Mark 50\n", mode: "overwrite" });
      }
      return streamText(res, body, `${title}: done. STEP_RESULT: success`);
    }
    if (body.output_config?.format) {
      // Structured-output request (memory suggestions, lessons): reply with a JSON message, not a stream.
      const prompt = String(body.messages.at(-1)?.content ?? "");
      const lesson = lessonReply(prompt);
      if (lesson) return jsonReply(lesson);
      const memories = prompt.includes("vegetarian")
        ? [
            { content: "Is vegetarian.", category: "personal", importance: 4 },
            { content: "Is training for a half marathon in March.", category: "project", importance: 3 },
          ]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_json", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify({ memories }) }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 400, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
      return;
    }
    const lastContent = body.messages.at(-1)?.content ?? "";
    const toolResults = Array.isArray(lastContent) ? lastContent.filter((b) => b.type === "tool_result") : [];
    const last = Array.isArray(lastContent) ? (lastContent.at(-1).text ?? "") : lastContent; // memory context is an earlier block

    // Tool use: specific prompts make the mock call a tool (only when tools are offered).
    const toolNames = new Set((body.tools ?? []).map((t) => t.name));
    const call = !toolResults.length && pickTool(String(last), toolNames);
    if (call) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const usage = { input_tokens: 80, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      res.write(frame("message_start", { type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
      res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } }));
      res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: call.name, input: {} } }));
      res.write(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
      res.write(frame("content_block_stop", { type: "content_block_stop", index: 1 }));
      res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } }));
      res.write(frame("message_stop", { type: "message_stop" }));
      res.end();
      return;
    }
    const slow = String(last).includes("slow");
    const reply = toolResults.length
      ? toolResults.map((r) => `Tool result${r.is_error ? " (error)" : ""}: ${typeof r.content === "string" ? r.content : JSON.stringify(r.content)}. `).join("").match(/.{1,12}/gs)
      : slow
      ? Array.from({ length: 200 }, (_, i) => `word${i} `)
      : `**Acknowledged.** You said: _${last}_\n\nTurn ${body.messages.length} of this conversation.\n\n\`\`\`python\nprint("ok")\n\`\`\`\n`.match(/.{1,12}/gs);

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => (closed = true));
    const usage = { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    res.write(frame("message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
    res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    for (const piece of reply) {
      if (closed) return;
      res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }));
      await sleep(slow ? 50 : 15);
    }
    res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: reply.length } }));
    res.write(frame("message_stop", { type: "message_stop" }));
    res.end();
  })
  .listen(port, "127.0.0.1", () => console.log(`mock anthropic on ${port}`));

function pickTool(text, available) {
  const rules = [
    [/^calculate (.+)$/i, (m) => ({ name: "calculator", input: { expression: m[1] } })],
    [/^save a note$/i, () => ({ name: "write_file", input: { path: "notes/todo.md", content: "Buy milk\n", mode: "create" } })],
    [/^delete the note$/i, () => ({ name: "delete_file", input: { path: "notes/todo.md" } })],
    [/^add task: (.+)$/i, (m) => ({ name: "create_task", input: { title: m[1] } })],
    [/^browse (\S+)$/i, (m) => ({ name: "browser_open", input: { url: m[1] } })],
    [/^open app (.+)$/i, (m) => ({ name: "open_desktop_app", input: { name: m[1] } })],
  ];
  for (const [re, make] of rules) {
    const m = text.match(re);
    if (m) {
      const call = make(m);
      if (available.has(call.name)) return call;
    }
  }
  return null;
}

function streamText(res, body, text) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  res.write(frame("message_start", { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
  res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
  res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }));
  res.write(frame("message_stop", { type: "message_stop" }));
  res.end();
}

function streamTool(res, body, name, input) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  res.write(frame("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
  res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name, input: {} } }));
  res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }));
  res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }));
  res.write(frame("message_stop", { type: "message_stop" }));
  res.end();
}

/** Visual lessons: an overview for the whole deck, scenes for each requested slide, tutor answers. */
function lessonReply(prompt) {
  if (prompt.includes("<deck>")) {
    return {
      title: "How plants make food",
      summary: "You will see how plants turn light, water and air into sugar.",
      objectives: ["Explain photosynthesis", "Name its inputs and outputs"],
      glossary: [{ term: "Chlorophyll", definition: "The green pigment that absorbs light." }],
    };
  }
  if (prompt.includes("<question>")) {
    return { answer: "Chloroplasts are **tiny factories** inside leaf cells." };
  }
  const wanted = prompt.match(/Write one scene for each of slides ([\d, ]+)\./);
  if (!wanted) return null;
  const kinds = ["flow", "cycle", "hierarchy", "compare", "timeline", "bars", "concept_map", "layers"];
  const node = (label, extra = {}) => ({ label, detail: `${label} detail`, value: 0, parent: -1, points: [], ...extra });
  const scenes = wanted[1].split(",").map((n) => Number(n.trim())).map((slide) => {
    const kind = kinds[(slide - 1) % kinds.length];
    const nodes = kind === "hierarchy" || kind === "concept_map"
      ? [node("Plant"), node("Leaf", { parent: 0 }), node("Root", { parent: 0 }), node("Chloroplast", { parent: 1 })]
      : kind === "bars"
        ? [node("Blue light", { value: 45 }), node("Red light", { value: 40 }), node("Green light", { value: 15 })]
        : kind === "compare"
          ? [node("Light reactions", { points: ["Need light", "Make oxygen"] }), node("Calvin cycle", { points: ["Uses CO2", "Makes sugar"] })]
          : [node("Light"), node("Water"), node("Sugar")];
    return {
      slide,
      title: `Scene ${slide}: ${kind.replace("_", " ")}`,
      hook: "Every breath you take depends on this.",
      narration: `Plants capture sunlight with chlorophyll.\n\nThey use it to build sugar from water and carbon dioxide (slide ${slide}).`,
      key_points: ["Light is the energy source", "Oxygen is a by-product"],
      visual: { kind, caption: `A ${kind} diagram`, unit: kind === "bars" ? "%" : "", nodes },
      analogy: "A leaf is like a solar-powered kitchen.",
      example: "An oak tree makes its own food all summer.",
      check: { question: `Quiz ${slide}: what does a plant release?`, options: ["Oxygen", "Helium", "Smoke"], answer: 0, explanation: "Oxygen is released when water is split." },
    };
  });
  return { scenes };
}
