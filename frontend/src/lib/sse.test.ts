import { readSSE, SSEParser } from "./sse";

describe("SSEParser", () => {
  it("parses frames split across chunks", () => {
    const p = new SSEParser();
    expect(p.push('event: delta\ndata: {"te')).toEqual([]);
    expect(p.push('xt":"hi"}\n\nevent: reply_done\n')).toEqual([{ event: "delta", data: '{"text":"hi"}' }]);
    expect(p.push("data: {}\n\n")).toEqual([{ event: "reply_done", data: "{}" }]);
  });

  it("handles CRLF, comments and multi-line data", () => {
    const p = new SSEParser();
    expect(p.push(": keepalive\r\n\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("reads a ReadableStream", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: x\ndata: 1\n\nevent: y\n"));
        c.enqueue(enc.encode("data: 2"));
        c.close();
      },
    });
    const out = [];
    for await (const f of readSSE(body)) out.push(f);
    expect(out).toEqual([
      { event: "x", data: "1" },
      { event: "y", data: "2" },
    ]);
  });
});
