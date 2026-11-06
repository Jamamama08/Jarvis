/**
 * Turns assistant Markdown into text that sounds natural when read aloud:
 * code blocks are skipped (announced once), links read as their label,
 * formatting symbols and table pipes are removed, and each line ends with
 * punctuation so the voice pauses between list items and headings.
 */
export const CODE_NOTICE = "(Code block omitted.)";

export function markdownToSpeech(md: string): string {
  let text = md.replace(/\r\n/g, "\n");
  // Fenced code blocks (``` or ~~~), including an unterminated one at the end.
  text = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, `$1${CODE_NOTICE}\n`);
  text = text.replace(/<[^>]+>/g, " "); // stray HTML tags
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images -> alt text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links -> label
  text = text.replace(/https?:\/\/\S+/g, "link"); // bare URLs
  text = text.replace(/`([^`]+)`/g, "$1"); // inline code
  const lines = text.split("\n").map((raw) => {
    let line = raw.trim();
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) return ""; // table separator
    if (/^[-*_]{3,}$/.test(line)) return ""; // horizontal rule
    if (line.startsWith("|")) line = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    line = line
      .replace(/^#{1,6}\s+/, "") // headings
      .replace(/^>\s?/, "") // blockquote
      .replace(/^(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "") // list markers / checkboxes
      .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2") // italics (not snake_case)
      .replace(/~~(.+?)~~/g, "$1")
      .trim();
    if (line && !/[.!?:;,…)]$/.test(line)) line += ".";
    return line;
  });
  return lines
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(new RegExp(`(${escapeRegExp(CODE_NOTICE)}\\s*)+`, "g"), `${CODE_NOTICE} `)
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Feeds a streaming Markdown reply to `speak` one complete sentence group at a time,
 * so speech starts before the reply finishes. Text inside an open code fence is held
 * back until the fence closes.
 */
export class StreamingSpeaker {
  private buffer = "";
  private consumed = 0;

  constructor(private speak: (text: string) => void) {}

  push(delta: string): void {
    this.buffer += delta;
    const end = this.safeBoundary();
    if (end > this.consumed) this.emit(end);
  }

  /** The reply finished: speak whatever is left. */
  finish(): void {
    if (this.buffer.length > this.consumed) this.emit(this.buffer.length);
  }

  reset(): void {
    this.buffer = "";
    this.consumed = 0;
  }

  private emit(end: number): void {
    const chunk = markdownToSpeech(this.buffer.slice(this.consumed, end));
    this.consumed = end;
    if (chunk) this.speak(chunk);
  }

  /** Index just after the last sentence end / paragraph break that isn't inside a code fence. */
  private safeBoundary(): number {
    const pending = this.buffer.slice(this.consumed);
    const re = /[.!?…]["')\]]*(?=\s)|\n\n|```[^\n]*\n[\s\S]*?\n```/g;
    let best = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pending))) {
      const end = m.index + m[0].length;
      const before = pending.slice(0, end);
      const fences = (before.match(/^(```|~~~)/gm) ?? []).length;
      if (fences % 2 === 0) best = end;
    }
    return best === -1 ? this.consumed : this.consumed + best;
  }
}
