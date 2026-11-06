import { useCallback, useEffect, useState } from "react";
import { Check, ListChecks, Loader2, Menu, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { Task } from "../lib/types";

/** The user's task list. JARVIS manages it with its task tools; autonomous execution of tasks is Phase 7. */
export function TasksView({ onOpenSidebar, onOpenConversation }: { onOpenSidebar: () => void; onOpenConversation: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.listTasks().then(setTasks).catch((e) => setError((e as Error).message)), []);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  }

  const open = tasks?.filter((t) => t.status === "pending" || t.status === "running") ?? [];
  const done = tasks?.filter((t) => !open.includes(t)) ?? [];

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Tasks">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">Tasks</h2>
        <span className="hidden text-xs text-ink-faint sm:inline">Ask JARVIS to add or update tasks, or manage them here. Autonomous task execution arrives in Phase 7.</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
          <form
            className="card flex gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) void run(async () => { await api.createTask(title.trim()); setTitle(""); });
            }}
          >
            <input className="input flex-1" placeholder="Add a task" aria-label="New task" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
            <button className="btn-primary" disabled={!title.trim()}><Plus size={14} /> Add</button>
          </form>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {!tasks ? (
            <Loader2 className="mx-auto animate-spin text-ink-faint" />
          ) : tasks.length === 0 ? (
            <p className="card flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-ink-faint">
              <ListChecks size={20} /> No tasks yet. Try "JARVIS, add a task to renew my passport".
            </p>
          ) : (
            <>
              <TaskList tasks={open} run={run} onOpenConversation={onOpenConversation} />
              {done.length > 0 && (
                <>
                  <h3 className="pt-2 text-xs font-medium tracking-wider text-ink-faint uppercase">Done</h3>
                  <TaskList tasks={done} run={run} onOpenConversation={onOpenConversation} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskList({ tasks, run, onOpenConversation }: { tasks: Task[]; run: (fn: () => Promise<unknown>) => Promise<void>; onOpenConversation: (id: string) => void }) {
  return (
    <ul className="space-y-1.5" data-testid="task-list">
      {tasks.map((t) => {
        const finished = t.status === "completed" || t.status === "cancelled";
        return (
          <li key={t.id} className="card group flex items-start gap-3 px-4 py-3" data-testid="task-item">
            <button
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${finished ? "border-ok/50 bg-ok/15 text-ok" : "border-line-strong hover:border-arc"}`}
              aria-label={finished ? `Reopen ${t.title}` : `Complete ${t.title}`}
              onClick={() => void run(() => api.updateTask(t.id, { status: finished ? "pending" : "completed" }))}
            >
              {finished && <Check size={13} />}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${finished ? "text-ink-faint line-through" : "text-ink"}`}>{t.title}</div>
              {t.description && <div className="mt-0.5 text-xs text-ink-dim">{t.description}</div>}
              <div className="mt-1 flex gap-3 text-[11px] text-ink-faint">
                <span>{t.status === "cancelled" ? "Cancelled" : finished ? `Done ${relativeTime(t.finished_at ?? t.updated_at)}` : `Added ${relativeTime(t.created_at)}`}</span>
                {t.conversation_id && (
                  <button className="hover:text-ink hover:underline" onClick={() => onOpenConversation(t.conversation_id!)}>from conversation</button>
                )}
              </div>
            </div>
            <button className="btn-ghost p-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger" aria-label={`Delete ${t.title}`} onClick={() => void run(() => api.deleteTask(t.id))}>
              <Trash2 size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
