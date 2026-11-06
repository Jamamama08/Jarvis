import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Ban, Bot, Check, ChevronDown, ChevronRight, CircleAlert, Clock, Layers, Loader2, Play, RotateCcw, ShieldAlert, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { AgentTask, AgentTaskDetail, AgentTaskStatus } from "../lib/types";
import { Markdown } from "./Markdown";
import { ToolActivity } from "./ToolActivity";

const ACTIVE: AgentTaskStatus[] = ["pending", "running", "waiting_approval"];
const LABEL: Record<AgentTaskStatus, string> = {
  pending: "Planning",
  running: "Running",
  waiting_approval: "Needs your approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: AgentTaskStatus }) {
  const cls =
    status === "completed" ? "border-ok/40 text-ok" : status === "failed" ? "border-danger/40 text-danger" : status === "waiting_approval" ? "border-warn/50 text-warn" : status === "cancelled" ? "border-line-strong text-ink-faint" : "border-arc/40 text-arc";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${cls}`} data-testid="task-status">
      {ACTIVE.includes(status) && status !== "waiting_approval" && <Loader2 size={10} className="animate-spin" />}
      {status === "waiting_approval" && <ShieldAlert size={10} />}
      {LABEL[status]}
    </span>
  );
}

function StepIcon({ status }: { status: AgentTaskStatus }) {
  if (status === "completed") return <Check size={13} className="text-ok" />;
  if (status === "failed") return <CircleAlert size={13} className="text-danger" />;
  if (status === "cancelled") return <Ban size={13} className="text-ink-faint" />;
  if (status === "waiting_approval") return <ShieldAlert size={13} className="text-warn" />;
  if (status === "running") return <Loader2 size={13} className="animate-spin text-arc" />;
  return <Clock size={13} className="text-ink-faint" />;
}

/** Autonomous tasks: start a goal, watch the plan run, approve actions, read the verified result. */
export function AgentTasks({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks(await api.listAgentTasks());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const anyActive = tasks?.some((t) => ACTIVE.includes(t.status)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [anyActive, load]);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api.startAgentTask(goal.trim());
      setGoal("");
      setOpen(task.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form className="card space-y-2 p-4" onSubmit={start} aria-label="Start autonomous task">
        <label className="label" htmlFor="task-goal">Give JARVIS a goal to work on by itself</label>
        <textarea
          id="task-goal"
          className="input min-h-20 resize-y"
          placeholder="e.g. Read the reports in my workspace, compare Q2 and Q3 revenue, and save a one-page summary as summary.md"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={4000}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || goal.trim().length < 5}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start task
          </button>
          <span className="text-xs text-ink-faint">
            JARVIS plans the steps, runs them (read-only steps in parallel), asks before risky actions, and checks the result. Each step uses Claude, so tasks cost more than a single message.
          </span>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </form>
      {tasks === null ? (
        <Loader2 className="mx-auto animate-spin text-ink-faint" />
      ) : tasks.length === 0 ? (
        <p className="card flex items-center justify-center gap-2 px-4 py-8 text-sm text-ink-faint"><Bot size={16} /> No autonomous tasks yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="agent-task-list">
          {tasks.map((t) => (
            <AgentTaskCard key={t.id} task={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onChanged={load} onOpenConversation={onOpenConversation} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentTaskCard({ task, open, onToggle, onChanged, onOpenConversation }: { task: AgentTask; open: boolean; onToggle: () => void; onChanged: () => void; onOpenConversation: (id: string) => void }) {
  const pct = task.steps_total ? Math.round((task.steps_done / task.steps_total) * 100) : 0;
  return (
    <li className={`card ${task.status === "waiting_approval" ? "border-warn/40" : ""}`} data-testid="agent-task" data-status={task.status}>
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={16} className="mt-0.5 shrink-0 text-ink-faint" /> : <ChevronRight size={16} className="mt-0.5 shrink-0 text-ink-faint" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{task.title}</span>
            <StatusBadge status={task.status} />
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised" aria-hidden>
            <div className={`h-full rounded-full ${task.status === "failed" ? "bg-danger/70" : "bg-arc"} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-ink-faint">
            <span data-testid="task-progress">{task.steps_total ? `${task.steps_done}/${task.steps_total} steps` : "planning"}</span>
            <span>{task.tokens.toLocaleString()} tokens{task.estimated_cost_usd != null ? ` · ~$${task.estimated_cost_usd.toFixed(task.estimated_cost_usd < 0.01 ? 4 : 2)}` : ""}</span>
            <span>started {relativeTime(task.created_at)}</span>
          </div>
        </div>
      </button>
      {open && <AgentTaskDetailView id={task.id} summary={task} onChanged={onChanged} onOpenConversation={onOpenConversation} />}
    </li>
  );
}

function AgentTaskDetailView({ id, summary, onChanged, onOpenConversation }: { id: string; summary: AgentTask; onChanged: () => void; onOpenConversation: (id: string) => void }) {
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summaryKey = `${summary.status}-${summary.steps_done}-${summary.tokens}`;
  const load = useCallback(() => api.agentTask(id).then(setDetail).catch((e) => setError((e as Error).message)), [id]);
  const keyRef = useRef("");
  useEffect(() => {
    if (keyRef.current !== summaryKey) {
      keyRef.current = summaryKey;
      void load();
    }
  }, [summaryKey, load]);
  useEffect(() => {
    if (!ACTIVE.includes(summary.status)) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [summary.status, load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    onChanged();
    void load();
  }

  if (!detail) return <Loader2 className="mx-auto mb-4 animate-spin text-ink-faint" />;
  const active = ACTIVE.includes(detail.status);
  const pendingTools = detail.tools.filter((t) => t.status === "pending_approval");
  return (
    <div className="space-y-4 border-t border-line px-4 pt-3 pb-4 text-sm" data-testid="agent-task-detail">
      <div>
        <div className="label">Goal</div>
        <p className="whitespace-pre-wrap text-ink-dim">{detail.goal}</p>
        {detail.conversation_id && (
          <button className="mt-1 text-xs text-ink-faint hover:text-ink hover:underline" onClick={() => onOpenConversation(detail.conversation_id!)}>Started from a conversation</button>
        )}
      </div>
      {pendingTools.length > 0 && (
        <div>
          <div className="label text-warn">Waiting for your approval</div>
          <ToolActivity tools={pendingTools} />
        </div>
      )}
      {detail.plan_summary && (
        <div>
          <div className="label">Plan</div>
          <p className="text-ink-dim">{detail.plan_summary}</p>
        </div>
      )}
      {detail.steps.length > 0 && (
        <ol className="space-y-1.5" data-testid="task-steps">
          {detail.steps.map((s) => (
            <StepRow key={s.id} step={s} tools={detail.tools.filter((t) => t.status !== "pending_approval" && t.task_id === s.id)} />
          ))}
        </ol>
      )}
      {detail.result && !active && (
        <div className="rounded-lg border border-line bg-base p-3" data-testid="task-result">
          <div className="label">{detail.status === "completed" ? "Result (verified)" : "Report"}</div>
          <Markdown text={detail.result} />
        </div>
      )}
      {detail.error && !active && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="task-error">{detail.error}</div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {active ? (
          <button className="btn-danger px-3 py-1.5 text-xs" onClick={() => void act(() => api.cancelAgentTask(id))}><X size={13} /> Cancel task</button>
        ) : (
          <>
            <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => void act(() => api.rerunAgentTask(id))}><RotateCcw size={13} /> Run again</button>
            <button className="btn-ghost px-3 py-1.5 text-xs hover:text-danger" onClick={() => void act(() => api.deleteAgentTask(id))}><Trash2 size={13} /> Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, tools }: { step: AgentTaskDetail["steps"][number]; tools: AgentTaskDetail["tools"] }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.result || step.error || tools.length);
  return (
    <li className="rounded-lg border border-line bg-base/60" data-testid="task-step" data-status={step.status}>
      <button className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs" onClick={() => hasDetail && setOpen((o) => !o)} aria-expanded={open}>
        <span className="mt-px"><StepIcon status={step.status} /></span>
        <span className="font-mono text-ink-faint">{step.index}.</span>
        <span className="min-w-0 flex-1">
          <span className="text-ink">{step.title}</span>
          <span className="ml-2 inline-flex flex-wrap gap-1.5 text-[10px] text-ink-faint">
            {step.parallel_safe && <span className="inline-flex items-center gap-0.5"><Layers size={10} /> parallel, read-only</span>}
            {step.depends_on.length > 0 && <span>after {step.depends_on.join(", ")}</span>}
            {step.attempts > 1 && <span>attempt {step.attempts}</span>}
          </span>
        </span>
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {tools.length > 0 && <ToolActivity tools={tools} />}
          {step.result && <div className="text-xs"><Markdown text={step.result} /></div>}
          {step.error && <p className="text-xs text-danger">{step.error}</p>}
        </div>
      )}
    </li>
  );
}
