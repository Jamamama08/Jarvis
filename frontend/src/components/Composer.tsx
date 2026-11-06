import { useEffect, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Mic, MicOff, Square } from "lucide-react";

export interface ComposerVoice {
  /** Voice input can be used right now. */
  available: boolean;
  /** Why it can't (unsupported browser, disabled in settings). */
  unavailableReason: string | null;
  listening: boolean;
  transcript: string;
  onToggle: () => void;
}

interface Props {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  sendOnEnter: boolean;
  assistantName: string;
  voice?: ComposerVoice;
}

const MAX_HEIGHT = 220;

export function Composer({ draft, onDraftChange, onSend, onStop, streaming, disabled, sendOnEnter, assistantName, voice }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listening = voice?.listening ?? false;
  const shown = listening ? voice?.transcript ?? "" : draft;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [shown]);

  useEffect(() => {
    if (!streaming && !listening) ref.current?.focus();
  }, [streaming, listening]);

  const canSend = draft.trim().length > 0 && !streaming && !disabled && !listening;

  function submit() {
    if (!canSend) return;
    onSend(draft);
    onDraftChange("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const wantsSend = sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (wantsSend) {
      e.preventDefault();
      submit();
    }
  }

  const micTitle = !voice
    ? "Voice input unavailable"
    : !voice.available
      ? voice.unavailableReason ?? "Voice input unavailable"
      : listening
        ? "Stop listening"
        : "Speak your message";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div
        className={`card flex items-end gap-2 p-2 shadow-[0_0_0_1px_rgb(34_211_238/0.04),0_12px_40px_-12px_rgb(0_0_0/0.8)] focus-within:border-arc/40 ${
          listening ? "border-arc/60" : ""
        }`}
      >
        <button
          type="button"
          className={`btn h-10 w-10 shrink-0 rounded-lg p-0 ${
            listening ? "bg-arc/20 text-arc ring-2 ring-arc/50" : "text-ink-dim hover:bg-raised hover:text-ink"
          } ${voice && !voice.available ? "cursor-not-allowed opacity-40" : ""}`}
          onClick={() => voice?.available && voice.onToggle()}
          aria-disabled={!voice?.available}
          aria-pressed={listening}
          title={micTitle}
          aria-label={listening ? "Stop listening" : "Voice input"}
          data-testid="mic-button"
        >
          {voice && !voice.available ? <MicOff size={18} /> : <Mic size={18} className={listening ? "animate-pulse" : ""} />}
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={shown}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={listening ? "Listening…" : `Message ${assistantName}…`}
          aria-label="Message"
          readOnly={listening}
          className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-6 text-ink placeholder:text-ink-faint outline-none"
          disabled={disabled}
        />
        {streaming ? (
          <button type="button" className="btn h-10 w-10 shrink-0 rounded-lg bg-raised p-0 text-ink hover:bg-line-strong" onClick={onStop} aria-label="Stop response" title="Stop">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="btn-primary h-10 w-10 shrink-0 rounded-lg p-0" onClick={submit} disabled={!canSend} aria-label="Send message" title="Send">
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <p className="mt-2 text-center text-[11px] text-ink-faint">
        {listening
          ? "Listening. Pause to finish, or click the mic to stop. Esc cancels."
          : sendOnEnter
            ? "Enter to send · Shift+Enter for a new line"
            : "Ctrl+Enter to send"}
      </p>
    </div>
  );
}
