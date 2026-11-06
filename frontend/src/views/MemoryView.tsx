import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Brain,
  Check,
  Clock,
  FolderKanban,
  History,
  Loader2,
  Menu,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { relativeTime } from "../lib/format";
import {
  MEMORY_CATEGORIES,
  type Memory,
  type MemoryCategory,
  type MemoryHistoryEntry,
  type MemoryInput,
  type Project,
  type ProjectStatus,
} from "../lib/types";

type Tab = "saved" | "pending" | "projects" | "activity";

export function MemoryView({ onOpenSidebar, onOpenConversation }: { onOpenSidebar: () => void; onOpenConversation: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("saved");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<MemoryCategory | "">("");
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(() => api.listProjects().then(setProjects).catch(() => {}), []);

  const load = useCallback(async () => {
    if (tab !== "saved" && tab !== "pending") return;
    try {
      const res = await api.listMemories({ q: q.trim() || undefined, category: category || undefined, state: tab === "saved" ? "approved" : "pending" });
      setMemories(res.items);
      setCounts(res.counts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [tab, q, category]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => void loadProjects(), [loadProjects]);

  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Memory">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">Memory</h2>
        <span className="hidden text-xs text-ink-faint sm:inline">Only memories you approve are ever shared with Claude.</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
          <nav className="flex flex-wrap gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="Memory sections">
            <TabButton id="saved" tab={tab} setTab={setTab} icon={<Brain size={14} />} label="Saved" count={counts.approved} />
            <TabButton id="pending" tab={tab} setTab={setTab} icon={<Sparkles size={14} />} label="Suggestions" count={counts.pending} highlight />
            <TabButton id="projects" tab={tab} setTab={setTab} icon={<FolderKanban size={14} />} label="Projects" count={projects.length} />
            <TabButton id="activity" tab={tab} setTab={setTab} icon={<History size={14} />} label="Activity" />
          </nav>

          {(tab === "saved" || tab === "pending") && (
            <>
              {tab === "saved" && <AddMemory projects={projects} onSaved={load} />}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
                  <input className="input pl-8" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
                </div>
                <select className="input sm:w-44" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory | "")} aria-label="Filter by category">
                  <option value="">All categories</option>
                  {MEMORY_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {tab === "saved" && counts[c.id] ? ` (${counts[c.id]})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              {memories === null ? (
                <Loader2 className="mx-auto animate-spin text-ink-faint" />
              ) : memories.length === 0 ? (
                <Empty tab={tab} filtered={Boolean(q || category)} />
              ) : (
                <ul className="space-y-2" data-testid="memory-list">
                  {memories.map((m) => (
                    <MemoryCard key={m.id} memory={m} projects={projects} projectName={projectName(m.project_id)} onChanged={load} onOpenConversation={onOpenConversation} />
                  ))}
                </ul>
              )}
            </>
          )}
          {tab === "projects" && <ProjectsPanel projects={projects} onChanged={loadProjects} />}
          {tab === "activity" && <ActivityPanel />}
        </div>
      </div>
    </section>
  );
}

function TabButton({ id, tab, setTab, icon, label, count, highlight }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; icon: ReactNode; label: string; count?: number; highlight?: boolean }) {
  const active = id === tab;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setTab(id)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${active ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"}`}
    >
      <span className={active ? "text-arc" : ""}>{icon}</span>
      {label}
      {count !== undefined && count > 0 && (
        <span className={`rounded-full px-1.5 text-[11px] ${highlight ? "bg-arc/20 text-arc" : "bg-line-strong text-ink-dim"}`}>{count}</span>
      )}
    </button>
  );
}

function Empty({ tab, filtered }: { tab: Tab; filtered: boolean }) {
  const text = filtered
    ? "No memories match."
    : tab === "pending"
      ? "No suggestions waiting. In a conversation, use “Suggest memories” and Claude will propose things worth remembering for you to review."
      : "Nothing saved yet. Add something you'd like JARVIS to remember, such as a preference or an ongoing project.";
  return <p className="card px-4 py-8 text-center text-sm text-ink-faint">{text}</p>;
}

// --- Add / edit -----------------------------------------------------------------

function MemoryFields({ value, onChange, projects, idPrefix }: { value: MemoryInput; onChange: (v: MemoryInput) => void; projects: Project[]; idPrefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor={`${idPrefix}-category`}>Category</label>
        <select id={`${idPrefix}-category`} className="input" value={value.category} onChange={(e) => onChange({ ...value, category: e.target.value as MemoryCategory })}>
          {MEMORY_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-importance`}>Importance</label>
        <select id={`${idPrefix}-importance`} className="input" value={value.importance} onChange={(e) => onChange({ ...value, importance: Number(e.target.value) })}>
          <option value={5}>5: use in almost every reply</option>
          <option value={4}>4: high</option>
          <option value={3}>3: when relevant</option>
          <option value={2}>2: low</option>
          <option value={1}>1: minor</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-project`}>Project</label>
        <select id={`${idPrefix}-project`} className="input" value={value.project_id ?? ""} onChange={(e) => onChange({ ...value, project_id: e.target.value || null })}>
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

const BLANK: MemoryInput = { content: "", category: "preference", importance: 3, project_id: null };

function AddMemory({ projects, onSaved }: { projects: Project[]; onSaved: () => void }) {
  const [value, setValue] = useState<MemoryInput>(BLANK);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nearDuplicate, setNearDuplicate] = useState(false);

  async function submit(e: FormEvent, force = false) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createMemory({ ...value, allow_near_duplicate: force });
      setValue({ ...BLANK, category: value.category });
      setNearDuplicate(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setNearDuplicate(err instanceof ApiError && err.status === 409 && err.message.includes("similar"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-outline w-full justify-start" onClick={() => setOpen(true)}>
        <Plus size={16} className="text-arc" /> Add a memory
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4" aria-label="Add memory">
      <div>
        <label className="label" htmlFor="new-memory">What should JARVIS remember?</label>
        <textarea id="new-memory" className="input min-h-20 resize-y" maxLength={2000} placeholder="e.g. Prefers concise answers with bullet points." value={value.content} onChange={(e) => setValue({ ...value, content: e.target.value })} autoFocus required />
      </div>
      <MemoryFields value={value} onChange={setValue} projects={projects} idPrefix="new" />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
          {nearDuplicate && (
            <button type="button" className="ml-2 underline" onClick={(e) => void submit(e, true)}>Save anyway</button>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy || !value.content.trim()}>
          {busy && <Loader2 size={14} className="animate-spin" />} Save memory
        </button>
        <button type="button" className="btn-ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}

// --- Memory card ------------------------------------------------------------------

function MemoryCard({ memory, projects, projectName, onChanged, onOpenConversation }: { memory: Memory; projects: Project[]; projectName?: string; onChanged: () => void; onOpenConversation: (id: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "history" | "delete">("view");
  const [draft, setDraft] = useState<MemoryInput>({ content: memory.content, category: memory.category, importance: memory.importance, project_id: memory.project_id });
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = !memory.approved;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode("view");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = (approve: boolean) =>
    run(async () => {
      await api.updateMemory(memory.id, draft);
      if (approve) await api.approveMemory(memory.id);
    });

  return (
    <li className={`card p-4 ${pending ? "border-arc/25" : ""}`} data-testid="memory-card">
      {mode === "edit" ? (
        <div className="space-y-3">
          <textarea aria-label="Memory content" className="input min-h-16 resize-y" maxLength={2000} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
          <MemoryFields value={draft} onChange={setDraft} projects={projects} idPrefix={`edit-${memory.id}`} />
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || !draft.content.trim()} onClick={() => void save(pending)}>
              <Check size={14} /> {pending ? "Save & approve" : "Save"}
            </button>
            <button className="btn-ghost" onClick={() => setMode("view")}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[15px] leading-relaxed text-ink">{memory.content}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
            <Chip>{MEMORY_CATEGORIES.find((c) => c.id === memory.category)?.label}</Chip>
            <span title={`Importance ${memory.importance} of 5`} aria-label={`Importance ${memory.importance} of 5`} className="tracking-tight text-arc">
              {"●".repeat(memory.importance)}
              <span className="text-line-strong">{"●".repeat(5 - memory.importance)}</span>
            </span>
            {projectName && <Chip><FolderKanban size={10} /> {projectName}</Chip>}
            {memory.source === "assistant" && <Chip><Sparkles size={10} /> Suggested by Claude</Chip>}
            {memory.source_conversation_id && (
              <button className="underline-offset-2 hover:text-ink hover:underline" onClick={() => onOpenConversation(memory.source_conversation_id!)}>
                from conversation
              </button>
            )}
            <span>Updated {relativeTime(memory.updated_at)}</span>
            {memory.last_used_at && <span className="inline-flex items-center gap-1"><Clock size={10} /> used {relativeTime(memory.last_used_at)}</span>}
          </div>
        </>
      )}

      {mode === "history" && <HistoryList memoryId={memory.id} />}
      {mode === "delete" && (
        <div className="mt-3 space-y-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm" role="alertdialog" aria-label="Confirm delete">
          <p>Delete this memory? JARVIS will stop using it immediately.</p>
          <label className="flex items-center gap-2 text-xs text-ink-dim">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} className="accent-danger" />
            Also erase its change history (otherwise the history keeps the old text)
          </label>
          <div className="flex gap-2">
            <button className="btn-danger" disabled={busy} onClick={() => void run(() => api.deleteMemory(memory.id, purge))}>Delete permanently</button>
            <button className="btn-ghost" onClick={() => setMode("view")}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}

      {mode !== "edit" && mode !== "delete" && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {pending ? (
            <>
              <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void run(() => api.approveMemory(memory.id))}><Check size={13} /> Approve</button>
              <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => setMode("edit")}><Pencil size={13} /> Edit</button>
              <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => void run(() => api.rejectMemory(memory.id))}><X size={13} /> Reject</button>
            </>
          ) : (
            <>
              <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setMode("edit")}><Pencil size={13} /> Edit</button>
              <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setMode(mode === "history" ? "view" : "history")} aria-expanded={mode === "history"}><History size={13} /> History</button>
              <button className="btn-ghost px-2.5 py-1 text-xs hover:text-danger" onClick={() => setMode("delete")}><Trash2 size={13} /> Delete</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5">{children}</span>;
}

const ACTION_LABEL: Record<MemoryHistoryEntry["action"], string> = {
  create: "Created",
  suggest: "Suggested by Claude",
  update: "Edited",
  approve: "Approved",
  reject: "Rejected",
  delete: "Deleted",
};

function HistoryList({ memoryId }: { memoryId: string }) {
  const [items, setItems] = useState<MemoryHistoryEntry[] | null>(null);
  useEffect(() => {
    api.memoryHistory(memoryId).then(setItems).catch(() => setItems([]));
  }, [memoryId]);
  if (!items) return <Loader2 size={14} className="mt-3 animate-spin text-ink-faint" />;
  return <Timeline items={items} />;
}

function Timeline({ items }: { items: MemoryHistoryEntry[] }) {
  return (
    <ol className="mt-3 space-y-2 border-l border-line pl-4 text-xs" data-testid="memory-history">
      {items.map((h) => (
        <li key={h.id} className="relative">
          <span className="absolute top-1.5 -left-[19px] h-1.5 w-1.5 rounded-full bg-arc" />
          <span className="font-medium text-ink-dim">{ACTION_LABEL[h.action] ?? h.action}</span>
          <span className="ml-2 text-ink-faint">{relativeTime(h.created_at)}</span>
          {h.action === "update" && h.old_content !== h.new_content && (
            <div className="mt-1 space-y-0.5">
              <div className="text-ink-faint line-through">{h.old_content}</div>
              <div className="text-ink-dim">{h.new_content}</div>
            </div>
          )}
          {(h.action === "delete" || h.action === "reject") && h.old_content && <div className="mt-1 text-ink-faint">{h.old_content}</div>}
          {(h.action === "create" || h.action === "suggest") && h.new_content && <div className="mt-1 text-ink-faint">{h.new_content}</div>}
        </li>
      ))}
    </ol>
  );
}

function ActivityPanel() {
  const [items, setItems] = useState<MemoryHistoryEntry[] | null>(null);
  useEffect(() => {
    api.recentMemoryHistory().then(setItems).catch(() => setItems([]));
  }, []);
  if (!items) return <Loader2 className="mx-auto animate-spin text-ink-faint" />;
  if (items.length === 0) return <p className="card px-4 py-8 text-center text-sm text-ink-faint">No memory activity yet.</p>;
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold">Recent changes</h3>
      <p className="mt-1 text-xs text-ink-faint">Every create, edit, approval, rejection and deletion, newest first.</p>
      <Timeline items={items} />
    </div>
  );
}

// --- Projects -----------------------------------------------------------------------

const STATUSES: ProjectStatus[] = ["active", "paused", "completed", "archived"];

function ProjectsPanel({ projects, onChanged }: { projects: Project[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <form
        className="card space-y-3 p-4"
        aria-label="New project"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.createProject({ name, description });
            setName("");
            setDescription("");
            onChanged();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <div>
            <label className="label" htmlFor="project-name">Project name</label>
            <input id="project-name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="project-description">Description</label>
            <input id="project-description" className="input" maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button type="submit" className="btn-primary" disabled={!name.trim()}><Plus size={14} /> Add project</button>
      </form>
      {projects.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-ink-faint">No projects yet. Projects group related memories and track progress notes.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectCard({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [notes, setNotes] = useState(project.progress_notes);
  const [saved, setSaved] = useState(false);
  const update = async (body: Parameters<typeof api.updateProject>[1]) => {
    await api.updateProject(project.id, body);
    onChanged();
  };
  return (
    <li className="card space-y-3 p-4" data-testid="project-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{project.name}</h3>
          {project.description && <p className="text-sm text-ink-dim">{project.description}</p>}
          <p className="mt-1 text-[11px] text-ink-faint">{project.memory_count} linked memories · updated {relativeTime(project.updated_at)}</p>
        </div>
        <select className="input w-auto py-1 text-xs" value={project.status} aria-label={`Status of ${project.name}`} onChange={(e) => void update({ status: e.target.value as ProjectStatus })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`notes-${project.id}`}>Progress notes</label>
        <textarea id={`notes-${project.id}`} className="input min-h-16 resize-y" maxLength={20000} value={notes} onChange={(e) => { setNotes(e.target.value); setSaved(false); }} />
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-outline px-3 py-1.5 text-xs" disabled={notes === project.progress_notes} onClick={async () => { await update({ progress_notes: notes }); setSaved(true); }}>Save notes</button>
        {saved && <span className="text-xs text-ok">Saved</span>}
        <button
          className="btn-ghost ml-auto px-2.5 py-1 text-xs hover:text-danger"
          onClick={async () => {
            if (!window.confirm(`Delete project "${project.name}"? Its memories are kept but unlinked.`)) return;
            await api.deleteProject(project.id);
            onChanged();
          }}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </li>
  );
}
