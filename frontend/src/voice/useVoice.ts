import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserVoiceProvider } from "./browser";
import { startMicLevel } from "./micLevel";
import { markdownToSpeech, StreamingSpeaker } from "./speechText";
import type { VoiceProvider } from "./types";

export interface VoicePrefs {
  voice_input_enabled: boolean;
  speak_responses: boolean;
  voice_name: string;
  speech_rate: number;
  voice_language: string;
}

const MUTE_KEY = "jarvis.voice.muted";

let defaultProvider: VoiceProvider | null = null;
/** The active voice provider. Only the browser engine exists today. */
export function getVoiceProvider(): VoiceProvider {
  defaultProvider ??= createBrowserVoiceProvider();
  return defaultProvider;
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function recognitionLanguage(pref: string): string {
  return pref || (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

export interface ReplySpeaker {
  push(delta: string): void;
  /** Reset what's been collected (a fallback model replaced the text mid-stream). */
  reset(): void;
  finish(): void;
}

export function useVoice(prefs: VoicePrefs | undefined, provider: VoiceProvider = getVoiceProvider()) {
  const { recognizer, synthesizer } = provider;
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(readMuted);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const listeningRef = useRef(false);
  /** The current listening session; cancelListening() marks it so its result is discarded. */
  const session = useRef({ cancelled: false });
  const speechDone = useRef<(() => void) | null>(null);
  const replyOpen = useRef(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const language = recognitionLanguage(prefs?.voice_language ?? "");
  const inputEnabled = (prefs?.voice_input_enabled ?? true) && recognizer.supported;

  const settleSpeaking = useCallback(() => {
    if (synthesizer.speaking || replyOpen.current) return;
    setSpeaking(false);
    const done = speechDone.current;
    speechDone.current = null;
    done?.();
  }, [synthesizer]);

  const speakText = useCallback(
    (text: string) => {
      const p = prefsRef.current;
      if (!text || !synthesizer.supported) return;
      setSpeaking(true);
      synthesizer.speak(text, {
        voiceId: p?.voice_name || undefined,
        rate: p?.speech_rate ?? 1,
        language: recognitionLanguage(p?.voice_language ?? ""),
        onEnd: settleSpeaking,
      });
    },
    [synthesizer, settleSpeaking],
  );

  const stopSpeaking = useCallback(() => {
    replyOpen.current = false;
    speechDone.current = null;
    synthesizer.cancel();
    setSpeaking(false);
  }, [synthesizer]);

  /** Read any Markdown text aloud now (the per-message "read aloud" button). Ignores mute. */
  const readAloud = useCallback(
    (markdown: string) => {
      stopSpeaking();
      speakText(markdownToSpeech(markdown));
    },
    [speakText, stopSpeaking],
  );

  /**
   * A speaker for a streaming reply, or null when replies shouldn't be spoken.
   * `onDone` runs once everything has been spoken (used by conversation mode).
   */
  const replySpeaker = useCallback(
    (onDone?: () => void): ReplySpeaker | null => {
      if (!prefsRef.current?.speak_responses || mutedRef.current || !synthesizer.supported) return null;
      stopSpeaking();
      replyOpen.current = true;
      speechDone.current = onDone ?? null;
      const streaming = new StreamingSpeaker(speakText);
      return {
        push: (d) => replyOpen.current && streaming.push(d),
        reset: () => streaming.reset(),
        finish: () => {
          if (!replyOpen.current) return;
          streaming.finish();
          replyOpen.current = false;
          settleSpeaking();
        },
      };
    },
    [synthesizer, speakText, stopSpeaking, settleSpeaking],
  );

  const stopMeterNow = () => {
    stopMeter.current?.();
    stopMeter.current = null;
  };

  /** Start listening; `onFinal` receives the recognised text when the user stops talking. */
  const startListening = useCallback(
    (onFinal: (text: string) => void) => {
      if (!recognizer.supported) {
        setError(recognizer.unsupportedReason);
        return;
      }
      stopSpeaking(); // barge-in: talking over JARVIS interrupts it
      setError(null);
      setTranscript("");
      setListening(true);
      const thisSession = { cancelled: false };
      session.current = thisSession;
      let finalText = "";
      void startMicLevel(setLevel).then((stop) => {
        // If recognition already ended, release the mic immediately.
        if (stopMeter.current === null && !listeningRef.current) stop();
        else stopMeter.current = stop;
      });
      recognizer.start(
        { language: recognitionLanguage(prefsRef.current?.voice_language ?? "") },
        {
          onTranscript: (text, final) => {
            setTranscript(text);
            if (final) finalText = text;
          },
          onError: (e) => {
            if (e.code !== "aborted") setError(e.message);
          },
          onEnd: () => {
            setListening(false);
            listeningRef.current = false;
            stopMeterNow();
            setTranscript("");
            if (finalText.trim() && !thisSession.cancelled) onFinal(finalText.trim());
          },
        },
      );
      listeningRef.current = true;
    },
    [recognizer, stopSpeaking],
  );
  const stopListening = useCallback(() => recognizer.stop(), [recognizer]);

  const cancelListening = useCallback(() => {
    session.current.cancelled = true;
    recognizer.abort();
    listeningRef.current = false;
    setListening(false);
    setTranscript("");
    stopMeterNow();
  }, [recognizer]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      if (next) stopSpeaking();
      return next;
    });
  }, [stopSpeaking]);

  // Stop everything when the component using voice unmounts.
  useEffect(
    () => () => {
      recognizer.abort();
      synthesizer.cancel();
      stopMeter.current?.();
    },
    [recognizer, synthesizer],
  );

  return useMemo(
    () => ({
      provider,
      inputSupported: recognizer.supported,
      inputUnsupportedReason: recognizer.unsupportedReason,
      inputEnabled,
      outputSupported: synthesizer.supported,
      language,
      listening,
      transcript,
      level,
      speaking,
      muted,
      error,
      clearError: () => setError(null),
      startListening,
      stopListening,
      cancelListening,
      stopSpeaking,
      readAloud,
      replySpeaker,
      toggleMute,
    }),
    [provider, recognizer, synthesizer, inputEnabled, language, listening, transcript, level, speaking, muted, error,
     startListening, stopListening, cancelListening, stopSpeaking, readAloud, replySpeaker, toggleMute],
  );
}

export type Voice = ReturnType<typeof useVoice>;
