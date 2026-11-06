/**
 * Web Speech API implementation of the voice interfaces.
 *
 * Recognition: `SpeechRecognition` (Edge/Safari) or `webkitSpeechRecognition` (Chrome).
 * Not available in Firefox, and Windows WebView2 (the desktop app) exposes the
 * object but has no recognition service, so we detect that and report it.
 * Synthesis: `speechSynthesis`, available in all major browsers and WebView2.
 */
import {
  VoiceError,
  type RecognitionHandlers,
  type SpeakOptions,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type VoiceInfo,
  type VoiceProvider,
} from "./types";

// Minimal typings for the parts of the Web Speech API we use (not in lib.dom for all TS versions).
interface SRAlternative {
  transcript: string;
}
interface SRResult {
  isFinal: boolean;
  length: number;
  [index: number]: SRAlternative;
}
interface SREvent {
  resultIndex: number;
  results: { length: number; [index: number]: SRResult };
}
interface SRErrorEvent {
  error: string;
}
export interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRConstructor = new () => SRInstance;

function recognitionConstructor(): SRConstructor | null {
  const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isTauriWebView(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

const ERROR_MESSAGES: Record<string, [VoiceError["code"], string]> = {
  "not-allowed": ["permission-denied", "Microphone access was blocked. Allow it in your browser's site settings."],
  "service-not-allowed": ["not-supported", "Speech recognition isn't available in this browser."],
  "audio-capture": ["no-microphone", "No microphone was found."],
  "no-speech": ["no-speech", "I didn't hear anything. Try again."],
  network: ["network", "Speech recognition needs an internet connection in this browser."],
  aborted: ["aborted", "Listening stopped."],
  "language-not-supported": ["not-supported", "That recognition language isn't supported. Change it in Settings."],
};

export class BrowserRecognizer implements SpeechRecognizer {
  private current: SRInstance | null = null;
  private discard = false;

  get supported(): boolean {
    return this.unsupportedReason === null;
  }

  get unsupportedReason(): string | null {
    if (!recognitionConstructor()) {
      return "This browser doesn't support speech recognition. Use Chrome, Edge or Safari for voice input.";
    }
    if (isTauriWebView()) {
      return "Voice input isn't available in the desktop app yet (Windows WebView2 has no speech recognition service). Use JARVIS in Chrome or Edge for voice input; spoken replies still work here.";
    }
    return null;
  }

  start({ language }: { language: string }, handlers: RecognitionHandlers): void {
    const reason = this.unsupportedReason;
    const Ctor = recognitionConstructor();
    if (reason || !Ctor) {
      handlers.onError(new VoiceError("not-supported", reason ?? "Speech recognition unavailable."));
      handlers.onEnd();
      return;
    }
    this.abort();
    const rec = new Ctor();
    rec.lang = language;
    rec.continuous = false; // one utterance per press; ends after a pause
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.discard = false;
    rec.onresult = (e) => {
      if (this.discard) return;
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const text = (finalText + " " + interim).replace(/\s+/g, " ").trim();
      handlers.onTranscript(text, interim.trim() === "" && finalText.trim() !== "");
    };
    rec.onerror = (e) => {
      if (this.discard && e.error === "aborted") return;
      const [code, message] = ERROR_MESSAGES[e.error] ?? ["unknown", `Speech recognition error: ${e.error}`];
      handlers.onError(new VoiceError(code, message));
    };
    rec.onend = () => {
      if (this.current === rec) this.current = null;
      handlers.onEnd();
    };
    this.current = rec;
    try {
      rec.start();
    } catch (err) {
      this.current = null;
      handlers.onError(new VoiceError("unknown", (err as Error).message));
      handlers.onEnd();
    }
  }

  stop(): void {
    this.current?.stop();
  }

  abort(): void {
    if (this.current) {
      this.discard = true;
      this.current.abort();
      this.current = null;
    }
  }
}

/**
 * Speaks text via speechSynthesis. Long text is split into sentences first because
 * Chrome silently stops utterances that run longer than ~15 seconds.
 */
export class BrowserSynthesizer implements SpeechSynthesizer {
  private pending = 0;
  private generation = 0;

  get supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  get speaking(): boolean {
    return this.pending > 0;
  }

  voices(): Promise<VoiceInfo[]> {
    if (!this.supported) return Promise.resolve([]);
    const read = () =>
      window.speechSynthesis.getVoices().map((v) => ({
        id: v.voiceURI,
        name: v.name,
        language: v.lang,
        local: v.localService,
        isDefault: v.default,
      }));
    const now = read();
    if (now.length) return Promise.resolve(now);
    // Chrome loads voices asynchronously.
    return new Promise((resolve) => {
      const done = () => resolve(read());
      window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
      setTimeout(done, 1500);
    });
  }

  speak(text: string, options: SpeakOptions = {}): void {
    if (!this.supported) return;
    const chunks = splitForSpeech(text);
    if (!chunks.length) return;
    const voice = options.voiceId ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === options.voiceId) : undefined;
    const generation = this.generation;
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk);
      if (voice) u.voice = voice;
      if (options.language) u.lang = voice?.lang ?? options.language;
      u.rate = options.rate ?? 1;
      this.pending++;
      if (i === 0) u.onstart = () => options.onStart?.();
      const finish = () => {
        if (generation !== this.generation) return; // cancelled
        this.pending = Math.max(0, this.pending - 1);
        if (i === chunks.length - 1) options.onEnd?.();
      };
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    });
  }

  cancel(): void {
    if (!this.supported) return;
    this.generation++;
    this.pending = 0;
    window.speechSynthesis.cancel();
  }
}

/** Split text into sentence-sized chunks of at most `max` characters. */
export function splitForSpeech(text: string, max = 220): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [];
  const out: string[] = [];
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(" ", max);
      const at = cut > max / 2 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

export function createBrowserVoiceProvider(): VoiceProvider {
  return {
    id: "browser",
    label: "Browser (Web Speech API)",
    privacyNote:
      "Uses your browser's built-in speech engines at no cost. Speech recognition in Chrome is processed by Google's servers and in Edge by Microsoft's; spoken replies use voices installed on your device (some browser voices are online).",
    recognizer: new BrowserRecognizer(),
    synthesizer: new BrowserSynthesizer(),
  };
}
