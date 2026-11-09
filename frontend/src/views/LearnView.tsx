import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { FileText, GraduationCap, Loader2, Menu, Presentation, RotateCcw, Trash2, Upload, Wand2, Waypoints } from "lucide-react";
import { LEVEL_LABELS, LessonPlayer } from "../components/lesson/LessonPlayer";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { LessonLevel, LessonSummary, SettingsResponse } from "../lib/types";

const ACCEPT = ".pptx,.pdf,.md,.markdown,.txt";

interface Props {
  lessonId: string | null;
  settings: SettingsResponse | null;
  onOpenSidebar: () => void;
  onOpenLesson: (id: string | null) => void;
}

export function LearnView({ lessonId, settings, onOpenSidebar, onOpenLesson }: Props) {
  if (lessonId) return <LessonPlayer key={lessonId} lessonId={lessonId} settings={settings} onBack={() => onOpenLesson(null)} />;
  return <Library settings={settings} onOpenSidebar={onOpenSidebar} onOpenLesson={onOpenLesson} />;
}

function Library({ settings, onOpenSidebar, onOpenLesson }: Omit<Props, "lessonId">) {
  const [lessons, setLessons] = useState<LessonSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLessons(await api.listLessons());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => void load(), [load]);
  const building = lessons?.some((l) => l.status === "processing");
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [building, load]);

  const remove = async (l: LessonSummary) => {
    if (!window.confirm(`Delete the lesson "${l.title}"?`)) return;
    await api.deleteLesson(l.id).catch((e: Error) => setError(e.message));
    void load();
  };

  const claudeReady = settings?.server.ai_configured ?? true;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Learn">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">Learn</h2>
        <span className="hidden text-xs text-ink-faint sm:inline">Turn any slideshow into a visual lesson.</span>
      </header>
      <div className="hud-grid flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold md:text-3xl">Learn from your slides, visually</h1>
            <p className="mx-auto mt-2 max-w-2xl text-sm text-ink-dim">
              Drop in a lecture deck. Claude explains each slide with an animated diagram, a plain-language walkthrough you can listen to,
              analogies, examples and quick questions to check what stuck.
            </p>
          </div>

          {!claudeReady && (
            <p role="alert" className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
              Claude isn't connected yet. Add your Anthropic API key in Settings to build lessons.
            </p>
          )}

          <UploadCard disabled={!claudeReady} onCreated={(id) => onOpenLesson(id)} />

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: <Presentation size={18} />, title: "1. Upload", text: "PowerPoint, PDF or Markdown. Speaker notes are used too." },
              { icon: <Wand2 size={18} />, title: "2. Claude teaches", text: "Every slide becomes a diagram, an explanation and a quiz." },
              { icon: <Waypoints size={18} />, title: "3. Explore", text: "Walk through diagrams, listen, ask the tutor, track your score." },
            ].map((s) => (
              <div key={s.title} className="rounded-xl border border-line bg-panel/60 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-arc">
                  {s.icon} {s.title}
                </div>
                <p className="text-xs leading-relaxed text-ink-dim">{s.text}</p>
              </div>
            ))}
          </div>

          <div>
            <h3 className="label">Your lessons</h3>
            {error && (
              <p role="alert" className="mb-3 text-sm text-danger">
                {error}
              </p>
            )}
            {lessons === null && <Loader2 className="mx-auto animate-spin text-ink-faint" />}
            {lessons?.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No lessons yet. Upload a slideshow to start.</p>}
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="lesson-list">
              {lessons?.map((l) => (
                <LessonCard key={l.id} lesson={l} onOpen={() => onOpenLesson(l.id)} onDelete={() => void remove(l)} onRetry={() => api.retryLesson(l.id).then(load).catch((e: Error) => setError(e.message))} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function UploadCard({ disabled, onCreated }: { disabled: boolean; onCreated: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<LessonLevel>("standard");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const lesson = await api.uploadLesson(file, { title: title.trim() || undefined, level });
      onCreated(lesson.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Choose a slideshow"
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${
          drag ? "border-arc bg-arc/10" : "border-line-strong hover:border-arc/50 hover:bg-raised/50"
        }`}
      >
        {file ? <FileText size={30} className="text-arc" /> : <Upload size={30} className="text-ink-faint" />}
        <div className="text-sm font-medium">{file ? file.name : "Drop a slideshow here, or click to choose"}</div>
        <div className="text-xs text-ink-faint">
          {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ".pptx, .pdf, .md or .txt (Markdown slides separated by ---) · up to 40 MB"}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          data-testid="lesson-file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="lesson-title">
            Title (optional)
          </label>
          <input id="lesson-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Claude will suggest one" maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="lesson-level">
            Explain it for
          </label>
          <select id="lesson-level" className="input" value={level} onChange={(e) => setLevel(e.target.value as LessonLevel)}>
            <option value="intro">A beginner</option>
            <option value="standard">A typical student</option>
            <option value="advanced">Someone who knows the basics</option>
          </select>
        </div>
        <button className="btn-primary" disabled={!file || busy || disabled}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <GraduationCap size={15} />} Build lesson
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function LessonCard({ lesson, onOpen, onDelete, onRetry }: { lesson: LessonSummary; onOpen: () => void; onDelete: () => void; onRetry: () => void }) {
  const done = lesson.completed ? lesson.slide_count : Math.max(0, Math.min(lesson.position, lesson.slide_count + 1) - 1);
  const pct = lesson.slide_count ? Math.round((Math.min(done, lesson.slide_count) / lesson.slide_count) * 100) : 0;
  return (
    <li className="card group flex flex-col p-4" data-testid="lesson-card">
      <button className="flex-1 text-left" onClick={onOpen}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-arc/25 bg-arc/10 text-arc">
            <GraduationCap size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium group-hover:text-arc">{lesson.title}</div>
            <div className="truncate text-xs text-ink-faint">
              {lesson.slide_count} slides · {LEVEL_LABELS[lesson.level]} · {relativeTime(lesson.updated_at)}
            </div>
          </div>
        </div>
      </button>
      <div className="mt-3 flex items-center gap-3">
        {lesson.status === "processing" && (
          <span className="flex items-center gap-1.5 text-xs text-arc" role="status">
            <Loader2 size={12} className="animate-spin" /> Building {lesson.scenes_ready}/{lesson.slide_count}
          </span>
        )}
        {lesson.status === "failed" && (
          <button className="flex items-center gap-1.5 text-xs text-danger hover:underline" onClick={onRetry} title={lesson.error ?? ""}>
            <RotateCcw size={12} /> Failed, retry
          </button>
        )}
        {lesson.status === "ready" && (
          <div className="flex flex-1 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-arc" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11px] text-ink-faint">{lesson.completed ? "Done" : `${pct}%`}</span>
          </div>
        )}
        <button className="btn-ghost ml-auto p-1.5" onClick={onDelete} aria-label={`Delete ${lesson.title}`}>
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
