/**
 * Voice engine interfaces. The app only talks to these, so a local engine
 * (e.g. Whisper for recognition, Piper for synthesis, via a Tauri command or
 * the backend) can be added later without touching the UI.
 */

export type RecognitionErrorCode =
  | "not-supported"
  | "permission-denied"
  | "no-microphone"
  | "no-speech"
  | "network"
  | "aborted"
  | "unknown";

export class VoiceError extends Error {
  constructor(
    public code: RecognitionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RecognitionHandlers {
  /** Called with the full transcript so far; `final` is true once the phrase is complete. */
  onTranscript: (text: string, final: boolean) => void;
  onError: (error: VoiceError) => void;
  /** Recognition stopped (after a final result, an error, or stop()). */
  onEnd: () => void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  /** Human-readable reason when unsupported. */
  readonly unsupportedReason: string | null;
  start(options: { language: string }, handlers: RecognitionHandlers): void;
  /** Stop listening and deliver any pending final result. */
  stop(): void;
  /** Stop immediately and discard the result. */
  abort(): void;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  local: boolean;
  isDefault: boolean;
}

export interface SpeakOptions {
  voiceId?: string;
  rate?: number;
  language?: string;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface SpeechSynthesizer {
  readonly supported: boolean;
  voices(): Promise<VoiceInfo[]>;
  /** Queue one utterance (appended after anything already speaking). */
  speak(text: string, options?: SpeakOptions): void;
  /** Stop speaking and clear the queue. */
  cancel(): void;
  readonly speaking: boolean;
}

export interface VoiceProvider {
  id: "browser";
  label: string;
  /** Where audio is processed, shown to the user. */
  privacyNote: string;
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
}
