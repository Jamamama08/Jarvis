import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  sendOnEnter: boolean;
  assistantName: string;
}

const MAX_HEIGHT = 220;

export function Composer({ onSend, onStop, streaming, disabled, sendOnEnter, assistantName }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  const canSend = text.trim().length > 0 && !streaming && !disabled;

  function submit() {
    if (!canSend) return;
    onSend(text);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const wantsSend = sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (wantsSend) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="card flex items-end gap-2 p-2 shadow-[0_0_0_1px_rgb(34_211_238/0.04),0_12px_40px_-12px_rgb(0_0_0/0.8)] focus-within:border-arc/40">
        <button
          type="button"
          className="btn-ghost h-10 w-10 shrink-0 rounded-lg p-0"
          disabled
          title="Voice input arrives in Phase 4"
          aria-label="Voice input (available in Phase 4)"
        >
          <Mic size={18} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${assistantName}…`}
          aria-label="Message"
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
        {sendOnEnter ? "Enter to send · Shift+Enter for a new line" : "Ctrl+Enter to send"}
      </p>
    </div>
  );
}
