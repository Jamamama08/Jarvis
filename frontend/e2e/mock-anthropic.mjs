// Minimal local stand-in for the Anthropic Messages streaming API, used only by E2E tests.
// It speaks the real SSE wire format so the official SDK in the backend parses it unchanged.
//   POST /v1/messages   -> streams a Markdown reply that echoes the last user message
//   GET  /__requests     -> JSON list of received request bodies (for assertions)
// A user message containing "slow" streams for ~10s so tests can exercise the stop button.
import http from "node:http";

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 8798);
const requests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

http
  .createServer(async (req, res) => {
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
    if (body.output_config?.format) {
      // Structured-output request (memory suggestions): reply with a JSON message, not a stream.
      const prompt = String(body.messages.at(-1)?.content ?? "");
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
    const last = (() => {
      const c = body.messages.at(-1)?.content ?? "";
      return Array.isArray(c) ? c.at(-1).text : c; // memory context arrives as an earlier block
    })();
    const slow = String(last).includes("slow");
    const reply = slow
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
