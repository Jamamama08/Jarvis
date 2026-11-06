/**
 * Incremental Server-Sent Events parser for fetch() response bodies.
 * (EventSource can't send POST bodies or Authorization headers.)
 */
export interface SSEFrame {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = "";

  /** Feed a chunk of text; returns any complete frames. */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const frames: SSEFrame[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw: string): SSEFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
    }
    for (const frame of parser.push(decoder.decode() + "\n\n")) yield frame;
  } finally {
    reader.releaseLock();
  }
}
