import { useState } from "react";
import { Ban, Check, ChevronDown, ChevronRight, CircleAlert, Clock, Loader2, ShieldAlert, ShieldCheck, Wrench, X } from "lucide-react";
import { api } from "../lib/api";
import type { ToolExecution, ToolStatus } from "../lib/types";

const LABEL: Record<ToolStatus, string> = {
  preparing: "Preparing",
  pending_approval: "Needs your approval",
  approved: "Approved",
  denied: "Not run",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PRETTY: Record<string, string> = {
  calculator: "Calculator",
  current_datetime: "Date & time",
  read_file: "Read file",
  search_files: "Search files",
  write_file: "Write file",
  delete_file: "Delete file",
  summarize_document: "Summarize document",
  create_task: "Create task",
  list_tasks: "List tasks",
  update_task: "Update task",
  delete_task: "Delete task",
  search_memories: "Search memories",
  suggest_memory: "Suggest memory",
  run_python: "Run Python",
  web_search: "Web search",
  web_fetch: "Fetch web page",
};

export function toolLabel(name: string): string {
  return PRETTY[name] ?? name;
}

function StatusIcon({ status }: { status: ToolStatus }) {
  switch (status) {
    case "preparing":
    case "running":
    case "approved":
      return <Loader2 size={13} className="animate-spin text-arc" />;
    case "pending_approval":
      return <ShieldAlert size={13} className="text-warn" />;
    case "succeeded":
      return <Check size={13} className="text-ok" />;
    case "failed":
      return <CircleAlert size={13} className="text-danger" />;
    case "denied":
      return <Ban size={13} className="text-ink-faint" />;
    case "cancelled":
      return <X size={13} className="text-ink-faint" />;
  }
}

export function ToolActivity({ tools }: { tools: ToolExecution[] }) {
  if (!tools.length) return null;
  return (
    <ul className="mb-2 space-y-1.5" data-testid="tool-activity-list">
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
    </ul>
  );
}

function ToolCard({ tool }: { tool: ToolExecution }) {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = tool.status === "pending_approval";
  const detail = tool.output || tool.error;

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.decideTool(tool.id, approve, approve && remember);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <li
      className={`rounded-lg border text-xs ${pending ? "border-warn/40 bg-warn/5" : "border-line bg-base/60"}`}
      data-testid="tool-card"
      data-tool={tool.tool_name}
      data-status={tool.status}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => detail && setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!detail}
      >
        <StatusIcon status={tool.status} />
        <Wrench size={12} className="text-ink-faint" />
        <span className="font-medium text-ink-dim">{toolLabel(tool.tool_name)}</span>
        {tool.summary && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{tool.summary}</span>}
        <span className={`ml-auto shrink-0 ${pending ? "text-warn" : "text-ink-faint"}`}>
          {LABEL[tool.status]}
          {tool.duration_ms != null && tool.status === "succeeded" ? ` · ${tool.duration_ms < 1000 ? `${tool.duration_ms} ms` : `${(tool.duration_ms / 1000).toFixed(1)} s`}` : ""}
        </span>
        {detail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {pending && (
        <div className="space-y-2 border-t border-warn/20 px-3 py-2.5" role="group" aria-label={`Approve ${toolLabel(tool.tool_name)}`}>
          <p className="flex items-start gap-1.5 text-ink-dim">
            {tool.permission_level === "sensitive" ? <ShieldAlert size={13} className="mt-px shrink-0 text-danger" /> : <ShieldCheck size={13} className="mt-px shrink-0 text-warn" />}
            <span>
              {tool.permission_level === "sensitive"
                ? "This is a sensitive action (it can't be undone). Allow it?"
                : "JARVIS wants to do this. Allow it?"}
            </span>
          </p>
          {tool.input && <InputPreview input={tool.input} />}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary px-3 py-1 text-xs" disabled={busy} onClick={() => void decide(true)}>
              <Check size={12} /> Allow
            </button>
            <button className="btn-outline px-3 py-1 text-xs" disabled={busy} onClick={() => void decide(false)}>
              <X size={12} /> Deny
            </button>
            {tool.permission_level === "restricted" && (
              <label className="flex items-center gap-1.5 text-ink-faint">
                <input type="checkbox" className="accent-arc" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Always allow {toolLabel(tool.tool_name).toLowerCase()}
              </label>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-faint">
              <Clock size={11} /> Waiting for you
            </span>
          </div>
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>
      )}
      {open && detail && (
        <pre className="max-h-64 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-ink-dim">{detail}</pre>
      )}
    </li>
  );
}

function InputPreview({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([k]) => !k.startsWith("_"));
  if (!entries.length) return null;
  return (
    <dl className="max-h-48 overflow-auto rounded-md border border-line bg-void/60 p-2 font-mono text-[11px]" data-testid="tool-input">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="shrink-0 text-ink-faint">{k}:</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-ink-dim">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
