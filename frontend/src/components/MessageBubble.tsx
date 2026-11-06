import { useState } from "react";
import { AlertTriangle, Check, CircleSlash, Copy, Info } from "lucide-react";
import type { Message } from "../lib/types";
import { Markdown } from "./Markdown";
import { clockTime } from "../lib/format";

export function MessageBubble({ message, assistantName }: { message: Message; assistantName: string }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-fade-up" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
          {message.content}
        </div>
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
        {message.status === "complete" && message.content && <CopyButton text={message.content} />}
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
      className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink focus:opacity-100"
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
