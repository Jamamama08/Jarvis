import { useState } from "react";
import { AlertTriangle, Brain, Check, CircleSlash, Copy, Info, Volume2 } from "lucide-react";
import type { Message } from "../lib/types";
import { Markdown } from "./Markdown";
import { ToolActivity } from "./ToolActivity";
import { clockTime } from "../lib/format";

export function MessageBubble({ message, assistantName, onReadAloud }: { message: Message; assistantName: string; onReadAloud?: (text: string) => void }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1 animate-fade-up" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
          {message.content}
        </div>
        {message.memory_ids.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint" data-testid="memories-used" title="Saved memories sent to Claude with this message">
            <Brain size={11} className="text-arc" /> {message.memory_ids.length} {message.memory_ids.length === 1 ? "memory" : "memories"} used
          </span>
        )}
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex justify-center animate-fade-up" data-role="system">
        <div className="flex max-w-[90%] items-start gap-2.5 rounded-xl border border-warn/20 bg-warn/5 px-4 py-3 text-sm leading-relaxed text-ink-dim">
          <Info size={16} className="mt-0.5 shrink-0 text-warn" />
          <span className="whitespace-pre-wrap">
            {message.content}
            {message.status === "streaming" && <Caret />}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-3 animate-fade-up" data-role="assistant">
      <div className="mt-1 h-7 w-7 shrink-0 rounded-full border border-arc/40 bg-[radial-gradient(circle_at_50%_40%,#cffafe,#22d3ee_45%,#083344)] shadow-[0_0_12px_rgb(34_211_238/0.35)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-faint">
          <span className="font-medium tracking-wider text-ink-dim">{assistantName}</span>
          <span>{clockTime(message.created_at)}</span>
          {message.model && <span className="font-mono text-[10px]">{message.model}</span>}
        </div>
        {message.tools && message.tools.length > 0 && <ToolActivity tools={message.tools} />}
        <div className="text-ink" data-testid="assistant-content">
          {message.content ? <Markdown text={message.content} /> : null}
          {message.status === "streaming" && <Caret />}
        </div>
        {message.status === "complete" && message.error && (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle size={13} className="mt-0.5" /> {message.error}
          </div>
        )}
        {message.status === "cancelled" && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-faint">
            <CircleSlash size={12} /> Response stopped
          </div>
        )}
        {message.status === "error" && (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={13} className="mt-0.5" /> {message.error || "The response failed."}
          </div>
        )}
        {message.status === "complete" && message.content && (
          <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={message.content} />
            {onReadAloud && (
              <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-faint hover:text-ink" onClick={() => onReadAloud(message.content)} aria-label="Read aloud">
                <Volume2 size={12} /> Read aloud
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-arc animate-caret" aria-hidden />;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-faint hover:text-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      aria-label="Copy response"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
    </button>
  );
}
