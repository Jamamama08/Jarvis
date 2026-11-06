import { CODE_NOTICE, markdownToSpeech, StreamingSpeaker } from "./speechText";
import { splitForSpeech } from "./browser";

describe("markdownToSpeech", () => {
  it("strips formatting and reads links and lists naturally", () => {
    const md = "## Plan for today\n\n- **Call** Pepper at 5pm\n- Check the [lab report](https://x.y/z)\n1. Fix _the_ suit\n\n> Quote here";
    expect(markdownToSpeech(md)).toBe("Plan for today. Call Pepper at 5pm. Check the lab report. Fix the suit. Quote here.");
  });

  it("skips code blocks, keeps inline code text and snake_case", () => {
    const md = "Run this:\n\n```python\nprint('hi')\nx = 1\n```\n\nThen set `max_tokens` and my_var.";
    const out = markdownToSpeech(md);
    expect(out).toBe(`Run this: ${CODE_NOTICE} Then set max_tokens and my_var.`);
    expect(out).not.toContain("print");
  });

  it("reads tables as comma-separated rows and drops URLs and HTML", () => {
    const md = "| Suit | Status |\n|---|---|\n| Mark 42 | Ready |\n\nSee https://example.com <b>now</b>";
    expect(markdownToSpeech(md)).toBe("Suit, Status. Mark 42, Ready. See link now.");
  });

  it("handles an unterminated code block", () => {
    expect(markdownToSpeech("Here:\n```js\nconst a = 1;")).toBe(`Here: ${CODE_NOTICE}`);
  });
});

describe("StreamingSpeaker", () => {
  it("speaks complete sentences as they stream and the rest at the end", () => {
    const spoken: string[] = [];
    const s = new StreamingSpeaker((t) => spoken.push(t));
    for (const piece of ["Good eve", "ning, Tony. The suit", " is ready! Shall I", " prepare it"]) s.push(piece);
    expect(spoken).toEqual(["Good evening, Tony.", "The suit is ready!"]);
    s.finish();
    expect(spoken).toEqual(["Good evening, Tony.", "The suit is ready!", "Shall I prepare it."]);
  });

  it("holds back text inside an open code fence", () => {
    const spoken: string[] = [];
    const s = new StreamingSpeaker((t) => spoken.push(t));
    s.push("Try this.\n\n```python\nprint('a. b. c.')\n");
    expect(spoken).toEqual(["Try this."]);
    s.push("```\n\nDone. ");
    expect(spoken).toEqual(["Try this.", `${CODE_NOTICE} Done.`]);
    s.finish();
    expect(spoken).toHaveLength(2);
  });
});

describe("splitForSpeech", () => {
  it("splits sentences and long runs", () => {
    expect(splitForSpeech("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const parts = splitForSpeech(long, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
});
