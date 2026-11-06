import { act, renderHook } from "@testing-library/react";
import { BrowserRecognizer, type SRInstance } from "./browser";
import type { RecognitionHandlers, SpeakOptions, SpeechRecognizer, SpeechSynthesizer, VoiceProvider } from "./types";
import { VoiceError } from "./types";
import { useVoice, type VoicePrefs } from "./useVoice";

// --- BrowserRecognizer against a fake Web Speech API ----------------------------

class FakeSR implements SRInstance {
  static last: FakeSR | null = null;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: SRInstance["onresult"] = null;
  onerror: SRInstance["onerror"] = null;
  onend: SRInstance["onend"] = null;
  started = false;
  constructor() {
    FakeSR.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  }
  emit(parts: [string, boolean][]) {
    const results = Object.assign(
      parts.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal })),
      { length: parts.length },
    );
    this.onresult?.({ resultIndex: 0, results } as never);
  }
}

function handlers() {
  const calls = { transcripts: [] as [string, boolean][], errors: [] as VoiceError[], ended: 0 };
  const h: RecognitionHandlers = {
    onTranscript: (t, f) => calls.transcripts.push([t, f]),
    onError: (e) => calls.errors.push(e),
    onEnd: () => calls.ended++,
  };
  return { calls, h };
}

describe("BrowserRecognizer", () => {
  afterEach(() => {
    delete (window as never as Record<string, unknown>).webkitSpeechRecognition;
    delete (window as never as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("reports unsupported browsers and the desktop WebView", () => {
    const r = new BrowserRecognizer();
    expect(r.supported).toBe(false);
    expect(r.unsupportedReason).toMatch(/doesn't support speech recognition/);
    (window as never as Record<string, unknown>).webkitSpeechRecognition = FakeSR;
    expect(r.supported).toBe(true);
    (window as never as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(r.unsupportedReason).toMatch(/desktop app/);
    const { calls, h } = handlers();
    r.start({ language: "en-US" }, h);
    expect(calls.errors[0].code).toBe("not-supported");
    expect(calls.ended).toBe(1);
  });

  it("streams interim and final transcripts in the chosen language", () => {
    (window as never as Record<string, unknown>).webkitSpeechRecognition = FakeSR;
    const r = new BrowserRecognizer();
    const { calls, h } = handlers();
    r.start({ language: "en-GB" }, h);
    const sr = FakeSR.last!;
    expect(sr.lang).toBe("en-GB");
    expect(sr.interimResults).toBe(true);
    expect(sr.continuous).toBe(false);
    sr.emit([["open the", false]]);
    sr.emit([["open the garage", true], [" door", false]]);
    sr.emit([["open the garage", true], [" door", true]]);
    expect(calls.transcripts).toEqual([
      ["open the", false],
      ["open the garage door", false],
      ["open the garage door", true],
    ]);
    r.stop();
    expect(calls.ended).toBe(1);
  });

  it("maps errors to friendly messages and abort discards results", () => {
    (window as never as Record<string, unknown>).webkitSpeechRecognition = FakeSR;
    const r = new BrowserRecognizer();
    const { calls, h } = handlers();
    r.start({ language: "en-US" }, h);
    FakeSR.last!.onerror?.({ error: "not-allowed" });
    expect(calls.errors[0].code).toBe("permission-denied");
    expect(calls.errors[0].message).toMatch(/Microphone access was blocked/);
    r.start({ language: "en-US" }, h);
    const sr = FakeSR.last!;
    r.abort();
    sr.emit([["ignored", true]]);
    expect(calls.transcripts).toEqual([]);
    expect(calls.errors).toHaveLength(1); // the abort itself isn't reported as an error
  });
});

// --- useVoice with a fake provider -------------------------------------------------

class FakeRecognizer implements SpeechRecognizer {
  supported = true;
  unsupportedReason: string | null = null;
  handlers: RecognitionHandlers | null = null;
  language = "";
  start(o: { language: string }, h: RecognitionHandlers) {
    this.language = o.language;
    this.handlers = h;
  }
  stop() {
    this.handlers?.onEnd();
  }
  abort() {
    const h = this.handlers;
    this.handlers = null;
    h?.onEnd();
  }
}

class FakeSynth implements SpeechSynthesizer {
  supported = true;
  spoken: { text: string; options?: SpeakOptions }[] = [];
  pending: SpeakOptions[] = [];
  cancels = 0;
  get speaking() {
    return this.pending.length > 0;
  }
  voices() {
    return Promise.resolve([]);
  }
  speak(text: string, options?: SpeakOptions) {
    this.spoken.push({ text, options });
    this.pending.push(options ?? {});
  }
  /** Finish the oldest utterance. */
  finishOne() {
    const o = this.pending.shift();
    o?.onEnd?.();
  }
  cancel() {
    this.cancels++;
    this.pending = [];
  }
}

function setup(overrides: Partial<VoicePrefs> = {}) {
  const recognizer = new FakeRecognizer();
  const synthesizer = new FakeSynth();
  const provider: VoiceProvider = { id: "browser", label: "fake", privacyNote: "", recognizer, synthesizer };
  const prefs: VoicePrefs = { voice_input_enabled: true, speak_responses: true, voice_name: "v1", speech_rate: 1.3, voice_language: "en-GB", ...overrides };
  const hook = renderHook(() => useVoice(prefs, provider));
  return { recognizer, synthesizer, hook };
}

describe("useVoice", () => {
  beforeEach(() => localStorage.clear());

  it("listens, shows the transcript, and hands over the final text", () => {
    const { recognizer, hook } = setup();
    const onFinal = vi.fn();
    act(() => hook.result.current.startListening(onFinal));
    expect(hook.result.current.listening).toBe(true);
    expect(recognizer.language).toBe("en-GB");
    act(() => recognizer.handlers!.onTranscript("what's the", false));
    expect(hook.result.current.transcript).toBe("what's the");
    act(() => recognizer.handlers!.onTranscript("what's the weather", true));
    act(() => recognizer.handlers!.onEnd());
    expect(onFinal).toHaveBeenCalledWith("what's the weather");
    expect(hook.result.current.listening).toBe(false);
  });

  it("cancelling listening discards the transcript", () => {
    const { recognizer, hook } = setup();
    const onFinal = vi.fn();
    act(() => hook.result.current.startListening(onFinal));
    act(() => recognizer.handlers!.onTranscript("never mind", true));
    act(() => hook.result.current.cancelListening());
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("speaks a streaming reply sentence by sentence with the chosen voice and calls onDone at the end", () => {
    const { synthesizer, hook } = setup();
    const onDone = vi.fn();
    let speaker: ReturnType<typeof hook.result.current.replySpeaker> = null;
    act(() => {
      speaker = hook.result.current.replySpeaker(onDone);
    });
    act(() => speaker!.push("**Hello** Tony. The weather"));
    expect(synthesizer.spoken.map((s) => s.text)).toEqual(["Hello Tony."]);
    expect(synthesizer.spoken[0].options).toMatchObject({ voiceId: "v1", rate: 1.3, language: "en-GB" });
    expect(hook.result.current.speaking).toBe(true);
    act(() => speaker!.push(" is sunny"));
    act(() => speaker!.finish());
    expect(synthesizer.spoken.map((s) => s.text)).toEqual(["Hello Tony.", "The weather is sunny."]);
    act(() => synthesizer.finishOne());
    expect(onDone).not.toHaveBeenCalled(); // one utterance still playing
    act(() => synthesizer.finishOne());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(hook.result.current.speaking).toBe(false);
  });

  it("starting to listen interrupts speech (barge-in)", () => {
    const { synthesizer, hook } = setup();
    const onDone = vi.fn();
    let speaker: ReturnType<typeof hook.result.current.replySpeaker> = null;
    act(() => {
      speaker = hook.result.current.replySpeaker(onDone);
    });
    act(() => speaker!.push("A long answer. "));
    act(() => hook.result.current.startListening(() => {}));
    expect(synthesizer.cancels).toBeGreaterThan(0);
    expect(hook.result.current.speaking).toBe(false);
    act(() => speaker!.push("More text. "));
    expect(synthesizer.spoken).toHaveLength(1); // nothing new spoken after the interruption
    expect(onDone).not.toHaveBeenCalled();
  });

  it("mute stops speech, persists, and disables spoken replies; read-aloud still works", () => {
    const { synthesizer, hook } = setup();
    act(() => hook.result.current.toggleMute());
    expect(hook.result.current.muted).toBe(true);
    expect(localStorage.getItem("jarvis.voice.muted")).toBe("1");
    expect(hook.result.current.replySpeaker()).toBeNull();
    act(() => hook.result.current.readAloud("# Title\n\nBody text"));
    expect(synthesizer.spoken.map((s) => s.text)).toEqual(["Title. Body text."]);
  });

  it("no reply speaker when spoken replies are off", () => {
    const { hook } = setup({ speak_responses: false });
    expect(hook.result.current.replySpeaker()).toBeNull();
  });

  it("voice input can be disabled in settings", () => {
    const { hook } = setup({ voice_input_enabled: false });
    expect(hook.result.current.inputEnabled).toBe(false);
  });
});
