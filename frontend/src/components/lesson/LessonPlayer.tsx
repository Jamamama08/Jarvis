import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Footprints,
  Lightbulb,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trophy,
  Volume2,
  VolumeX,
} from "lucide-react";
import { api } from "../../lib/api";
import type { LessonDetail, LessonLevel, LessonScene, LessonSlide, SettingsResponse } from "../../lib/types";
import { useVoice } from "../../voice/useVoice";
import { Markdown } from "../Markdown";
import { LessonVisual } from "./LessonVisual";

export const LEVEL_LABELS: Record<LessonLevel, string> = { intro: "Beginner", standard: "Standard", advanced: "Advanced" };
const WALK_MS = 3200;

type Glossary = { term: string; definition: string }[];

interface Props {
  lessonId: string;
  settings: SettingsResponse | null;
  onBack: () => void;
}

/**
 * Plays a lesson: an intro (overview), one screen per slide (diagram, explanation, key points,
 * analogy, example, quiz, tutor) and a results screen. Position 0 = intro, 1..n = slides, n+1 = finish.
 */
export function LessonPlayer({ lessonId, settings, onBack }: Props) {
  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [active, setActive] = useState<number | null>(null);
  const [walking, setWalking] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const voice = useVoice(settings?.preferences);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const l = await api.lesson(lessonId);
      setLesson(l);
      setError(null);
      if (!loaded.current) {
        loaded.current = true;
        setPos(Math.min(l.progress.position ?? 0, l.slides.length + 1));
        setAnswers(l.progress.answers ?? {});
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [lessonId]);

  useEffect(() => {
    loaded.current = false;
    void load();
  }, [load]);

  // Poll while Claude is still building scenes.
  useEffect(() => {
    if (lesson?.status !== "processing") return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [lesson?.status, load]);

  const total = lesson?.slides.length ?? 0;
  const slide: LessonSlide | undefined = pos >= 1 && pos <= total ? lesson?.slides[pos - 1] : undefined;
  const scene: LessonScene | undefined = slide ? lesson?.scenes.find((s) => s.slide === slide.index) : undefined;

  const go = useCallback(
    (next: number) => {
      if (!lesson) return;
      const p = Math.max(0, Math.min(next, lesson.slides.length + 1));
      setPos(p);
      setActive(null);
      setWalking(false);
      voice.stopSpeaking();
      const body: Parameters<typeof api.updateLesson>[1] = { position: p };
      if (p === lesson.slides.length + 1) body.completed = true;
      api.updateLesson(lesson.id, body).catch(() => {});
    },
    [lesson, voice],
  );

  // Keyboard: ← / → move between screens (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowRight") go(pos + 1);
      else if (e.key === "ArrowLeft") go(pos - 1);
      else if (e.key === "Escape") {
        setWalking(false);
        setAutoplay(false);
        voice.stopSpeaking();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, pos, voice]);

  // Diagram walk-through: highlight each part in turn.
  useEffect(() => {
    if (!walking || !scene) return;
    const n = scene.visual.nodes.length;
    if (n === 0) return setWalking(false);
    const t = setTimeout(() => {
      setActive((a) => {
        const next = a === null ? 0 : a + 1;
        if (next >= n) {
          setWalking(false);
          return null;
        }
        return next;
      });
    }, active === null ? 0 : WALK_MS);
    return () => clearTimeout(t);
  }, [walking, active, scene]);

  // Auto-play: narrate each scene, then move on (pausing at unanswered questions).
  const wasSpeaking = useRef(false);
  const [narrated, setNarrated] = useState<number | null>(null); // slide whose narration just finished
  useEffect(() => {
    if (!autoplay || !scene) return;
    setNarrated(null);
    voice.readAloud(scene.narration);
    setWalking(true);
  }, [autoplay, scene?.slide]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (wasSpeaking.current && !voice.speaking && scene) setNarrated(scene.slide);
    wasSpeaking.current = voice.speaking;
  }, [voice.speaking, scene]);
  useEffect(() => {
    if (!autoplay || !scene || narrated !== scene.slide) return;
    if (scene.check && answers[String(scene.slide)] === undefined) {
      setAutoplay(false); // let the learner answer first
      return;
    }
    const t = setTimeout(() => go(pos + 1), 1200);
    return () => clearTimeout(t);
  }, [autoplay, narrated, scene, answers, go, pos]);
  useEffect(() => {
    if (autoplay && pos > total) setAutoplay(false);
  }, [autoplay, pos, total]);

  const answer = (choice: number) => {
    if (!lesson || !scene) return;
    setAnswers((a) => ({ ...a, [String(scene.slide)]: choice }));
    api.updateLesson(lesson.id, { answer: [scene.slide, choice] }).catch(() => {});
  };

  const restart = async () => {
    if (!lesson) return;
    await api.updateLesson(lesson.id, { reset_progress: true });
    setAnswers({});
    go(0);
  };

  const rebuild = async (level: LessonLevel) => {
    if (!lesson) return;
    if (!window.confirm(`Rebuild this lesson at the ${LEVEL_LABELS[level]} level? Your progress will be reset.`)) return;
    await api.retryLesson(lesson.id, { level, rebuild: true });
    loaded.current = false;
    setAnswers({});
    setPos(0);
    void load();
  };

  if (error && !lesson) {
    return (
      <Frame onBack={onBack} title="Lesson">
        <p role="alert" className="m-6 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      </Frame>
    );
  }
  if (!lesson) {
    return (
      <Frame onBack={onBack} title="Lesson">
        <div className="flex flex-1 items-center justify-center text-ink-faint">
          <Loader2 className="animate-spin" />
        </div>
      </Frame>
    );
  }

  const glossary = lesson.overview.glossary ?? [];
  const progressPct = total ? (Math.min(pos, total) / total) * 100 : 0;

  return (
    <Frame
      onBack={onBack}
      title={lesson.title}
      tools={
        voice.outputSupported && pos >= 1 && pos <= total ? (
          <button
            className={autoplay ? "btn-primary px-2.5 py-1.5" : "btn-outline px-2.5 py-1.5"}
            onClick={() => {
              if (autoplay) voice.stopSpeaking();
              setAutoplay(!autoplay);
            }}
            aria-pressed={autoplay}
            title="Narrate each slide and move on automatically"
          >
            {autoplay ? <Pause size={14} /> : <Play size={14} />}
            <span className="hidden sm:inline">{autoplay ? "Pause" : "Auto-play"}</span>
          </button>
        ) : null
      }
    >
      <div className="h-1 w-full bg-raised" aria-hidden>
        <div className="h-full bg-arc transition-[width] duration-500" style={{ width: `${progressPct}%` }} />
      </div>

      {lesson.status === "processing" && (
        <div className="flex items-center gap-2 border-b border-line bg-arc/5 px-4 py-2 text-xs text-arc" role="status">
          <Loader2 size={13} className="animate-spin" /> Claude is building your lesson: {lesson.scenes_ready} of {total} slides ready. You can start
          now.
        </div>
      )}
      {lesson.status === "failed" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-danger/20 bg-danger/5 px-4 py-2 text-xs text-danger" role="alert">
          {lesson.error}
          <button
            className="btn-outline ml-auto px-2 py-1 text-xs"
            onClick={() => api.retryLesson(lesson.id).then(() => load()).catch((e: Error) => setError(e.message))}
          >
            <RotateCcw size={12} /> Retry
          </button>
        </div>
      )}

      <div className="hud-grid flex-1 overflow-y-auto">
        <div key={pos} className="animate-fade-up mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
          {pos === 0 && <Intro lesson={lesson} onStart={() => go(1)} onRebuild={rebuild} />}
          {slide && scene && (
            <SceneView
              lessonId={lesson.id}
              slide={slide}
              scene={scene}
              number={pos}
              total={total}
              glossary={glossary}
              active={active}
              onSelect={(i) => {
                setWalking(false);
                setActive((a) => (a === i ? null : i));
              }}
              walking={walking}
              onWalk={() => {
                setActive(null);
                setWalking((w) => !w);
              }}
              chosen={answers[String(scene.slide)]}
              onAnswer={answer}
              speaking={voice.speaking}
              canSpeak={voice.outputSupported}
              onListen={() => (voice.speaking ? voice.stopSpeaking() : voice.readAloud(scene.narration))}
            />
          )}
          {slide && !scene && <Pending lesson={lesson} slide={slide} />}
          {pos === total + 1 && <Finish lesson={lesson} answers={answers} onJump={go} onRestart={restart} onRebuild={rebuild} />}
        </div>
      </div>

      <nav className="flex shrink-0 items-center gap-2 border-t border-line bg-base px-4 py-2.5" aria-label="Lesson navigation">
        <button className="btn-ghost" onClick={() => go(pos - 1)} disabled={pos === 0} aria-label="Previous">
          <ChevronLeft size={16} /> <span className="hidden sm:inline">Back</span>
        </button>
        <div className="flex flex-1 items-center justify-center gap-1 overflow-hidden" aria-hidden>
          {total <= 40 &&
            Array.from({ length: total + 2 }, (_, i) => (
              <button
                key={i}
                tabIndex={-1}
                onClick={() => go(i)}
                className={`h-1.5 rounded-full transition-all ${i === pos ? "w-6 bg-arc" : i < pos ? "w-1.5 bg-arc/50" : "w-1.5 bg-line-strong"}`}
              />
            ))}
          {total > 40 && (
            <span className="text-xs text-ink-faint">
              {Math.min(pos, total)} / {total}
            </span>
          )}
        </div>
        <button className="btn-primary" onClick={() => go(pos + 1)} disabled={pos > total} aria-label="Next">
          <span className="hidden sm:inline">{pos === 0 ? "Start" : pos === total ? "Finish" : "Next"}</span> <ChevronRight size={16} />
        </button>
      </nav>
    </Frame>
  );
}

function Frame({ onBack, title, tools, children }: { onBack: () => void; title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Lesson">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5" onClick={onBack} aria-label="Back to lessons">
          <ArrowLeft size={18} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        {tools}
      </header>
      {children}
    </section>
  );
}

function Intro({ lesson, onStart, onRebuild }: { lesson: LessonDetail; onStart: () => void; onRebuild: (l: LessonLevel) => void }) {
  const o = lesson.overview;
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-arc/30 bg-arc/10">
          <BookOpen className="text-arc" size={28} />
        </div>
        <h1 className="text-2xl font-semibold md:text-3xl">{lesson.title}</h1>
        <p className="mt-2 text-xs text-ink-faint">
          {lesson.slide_count} slides · {LEVEL_LABELS[lesson.level]} level · from {lesson.source_name}
        </p>
        {o.summary ? (
          <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-dim">{o.summary}</p>
        ) : (
          lesson.status === "processing" && (
            <p className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-faint">
              <Loader2 size={14} className="animate-spin" /> Reading your slides…
            </p>
          )
        )}
      </div>

      {!!o.objectives?.length && (
        <div className="card p-5">
          <h3 className="label">By the end you'll be able to</h3>
          <ul className="space-y-2">
            {o.objectives.map((t, i) => (
              <li key={i} className="animate-pop-in flex gap-2 text-sm" style={{ animationDelay: `${i * 120}ms` }}>
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-arc" /> {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!o.glossary?.length && (
        <div className="card p-5">
          <h3 className="label">Key terms</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {o.glossary.map((g, i) => (
              <div key={i} className="rounded-lg border border-line bg-raised/50 p-3">
                <dt className="text-sm font-semibold text-arc">{g.term}</dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-ink-dim">{g.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button className="btn-primary px-6 py-2.5 text-[16px]" onClick={onStart} disabled={lesson.slide_count === 0}>
          <Play size={16} /> Start lesson
        </button>
        {lesson.status !== "processing" && (
          <label className="flex items-center gap-2 text-xs text-ink-faint">
            Explain it at another level
            <select
              className="input w-auto py-1 text-xs"
              value={lesson.level}
              onChange={(e) => onRebuild(e.target.value as LessonLevel)}
              aria-label="Lesson level"
            >
              {(Object.keys(LEVEL_LABELS) as LessonLevel[]).map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function Pending({ lesson, slide }: { lesson: LessonDetail; slide: LessonSlide }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      {lesson.status === "processing" ? <Loader2 size={28} className="animate-spin text-arc" /> : <CircleX size={28} className="text-danger" />}
      <h2 className="text-lg font-medium">{slide.title || `Slide ${slide.index}`}</h2>
      <p className="text-sm text-ink-faint">
        {lesson.status === "processing" ? "Claude is still preparing this part of the lesson…" : "This slide wasn't turned into a lesson. Use Retry above."}
      </p>
    </div>
  );
}

/** Underlines glossary terms in the narration; their definition shows on hover / focus. */
export function withGlossary(text: string, glossary: Glossary): ReactNode[] {
  const terms = glossary.filter((g) => g.term.trim().length > 1).sort((a, b) => b.term.length - a.term.length);
  if (!terms.length) return [text];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(${terms.map((t) => escape(t.term)).join("|")})\\b`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const def = terms.find((t) => t.term.toLowerCase() === m[0].toLowerCase())?.definition ?? "";
    out.push(text.slice(last, m.index));
    out.push(
      <abbr key={m.index} title={def} tabIndex={0} className="cursor-help text-arc-soft underline decoration-arc/40 decoration-dotted underline-offset-4">
        {m[0]}
      </abbr>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

interface SceneProps {
  lessonId: string;
  slide: LessonSlide;
  scene: LessonScene;
  number: number;
  total: number;
  glossary: Glossary;
  active: number | null;
  onSelect: (i: number) => void;
  walking: boolean;
  onWalk: () => void;
  chosen: number | undefined;
  onAnswer: (i: number) => void;
  speaking: boolean;
  canSpeak: boolean;
  onListen: () => void;
}

function SceneView(p: SceneProps) {
  const { scene } = p;
  const node = p.active !== null ? scene.visual.nodes[p.active] : null;
  const paragraphs = scene.narration.split(/\n\s*\n/).filter(Boolean);
  return (
    <article className="space-y-5" data-testid="lesson-scene">
      <header>
        <div className="text-[11px] font-medium tracking-[0.25em] text-arc uppercase">
          Slide {p.number} of {p.total}
        </div>
        <h1 className="mt-1 text-2xl font-semibold md:text-3xl">{scene.title}</h1>
        {scene.hook && <p className="mt-2 text-[16px] text-ink-dim">{scene.hook}</p>}
      </header>

      {scene.visual.kind !== "none" && (
        <figure className="card overflow-hidden p-4 md:p-6">
          <LessonVisual visual={scene.visual} active={p.active} onSelect={p.onSelect} />
          <figcaption className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <div className="min-h-10 min-w-0 flex-1 text-sm" aria-live="polite">
              {node ? (
                <>
                  <span className="font-semibold text-arc">{node.label}</span>
                  {node.detail && <span className="text-ink-dim">: {node.detail}</span>}
                  {node.points.length > 0 && <span className="text-ink-dim"> ({node.points.join("; ")})</span>}
                </>
              ) : (
                <span className="text-ink-faint">{scene.visual.caption || "Tap any part of the diagram to zoom in on it."}</span>
              )}
            </div>
            {scene.visual.nodes.length > 1 && (
              <button className="btn-outline px-2.5 py-1.5 text-xs" onClick={p.onWalk} aria-pressed={p.walking}>
                {p.walking ? <Pause size={13} /> : <Footprints size={13} />} {p.walking ? "Stop" : "Walk me through it"}
              </button>
            )}
          </figcaption>
        </figure>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          <section className="card p-5" aria-label="Explanation">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="label mb-0">Explanation</h3>
              {p.canSpeak && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={p.onListen} aria-pressed={p.speaking}>
                  {p.speaking ? <VolumeX size={14} /> : <Volume2 size={14} />} {p.speaking ? "Stop" : "Listen"}
                </button>
              )}
            </div>
            <div className="space-y-3 text-[15px] leading-relaxed">
              {paragraphs.map((para, i) => (
                <p key={i}>{withGlossary(para, p.glossary)}</p>
              ))}
            </div>
          </section>

          {(scene.analogy || scene.example) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {scene.analogy && (
                <Callout icon={<Lightbulb size={15} />} title="Think of it like this" tone="text-amber-300 border-amber-400/30 bg-amber-400/5">
                  {scene.analogy}
                </Callout>
              )}
              {scene.example && (
                <Callout icon={<Sparkles size={15} />} title="For example" tone="text-violet-300 border-violet-400/30 bg-violet-400/5">
                  {scene.example}
                </Callout>
              )}
            </div>
          )}

          {scene.check && <Check check={scene.check} chosen={p.chosen} onAnswer={p.onAnswer} />}
          <AskTutor lessonId={p.lessonId} slide={scene.slide} />
        </div>

        <aside className="space-y-5">
          {scene.key_points.length > 0 && (
            <section className="card p-5" aria-label="Key points">
              <h3 className="label">Remember</h3>
              <ul className="space-y-2.5">
                {scene.key_points.map((k, i) => (
                  <li key={i} className="animate-pop-in flex gap-2 text-sm" style={{ animationDelay: `${300 + i * 150}ms` }}>
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-arc" /> {k}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <OriginalSlide lessonId={p.lessonId} slide={p.slide} />
        </aside>
      </div>
    </article>
  );
}

function Callout({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: string; children: ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
        {icon} {title}
      </div>
      <p className="text-sm leading-relaxed text-ink">{children}</p>
    </div>
  );
}

function Check({ check, chosen, onAnswer }: { check: NonNullable<LessonScene["check"]>; chosen: number | undefined; onAnswer: (i: number) => void }) {
  const answered = chosen !== undefined;
  const right = chosen === check.answer;
  return (
    <section className="card p-5" aria-label="Check your understanding">
      <h3 className="label">Check your understanding</h3>
      <p className="mb-3 text-[15px] font-medium">{check.question}</p>
      <div className="space-y-2" role="radiogroup">
        {check.options.map((o, i) => {
          const isAnswer = i === check.answer;
          const picked = i === chosen;
          const tone = !answered
            ? "border-line hover:border-arc/50 hover:bg-raised"
            : isAnswer
              ? "border-ok/60 bg-ok/10"
              : picked
                ? "border-danger/60 bg-danger/10"
                : "border-line opacity-60";
          return (
            <button
              key={i}
              role="radio"
              aria-checked={picked}
              disabled={answered}
              onClick={() => onAnswer(i)}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-default ${tone}`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs text-ink-dim">
                {answered && isAnswer ? <CircleCheck size={16} className="text-ok" /> : answered && picked ? <CircleX size={16} className="text-danger" /> : String.fromCharCode(65 + i)}
              </span>
              {o}
            </button>
          );
        })}
      </div>
      {answered && (
        <p className={`animate-fade-up mt-3 rounded-lg p-3 text-sm ${right ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`} role="status">
          <strong>{right ? "Correct!" : "Not quite."}</strong> <span className="text-ink">{check.explanation}</span>
        </p>
      )}
    </section>
  );
}

function AskTutor({ lessonId, slide }: { lessonId: string; slide: number }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ q: string; a: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { answer } = await api.askLesson(lessonId, slide, question);
      setThread((t) => [...t, { q: question, a: answer }]);
      setQ("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5" aria-label="Ask the tutor">
      <h3 className="label flex items-center gap-1.5">
        <MessageCircleQuestion size={14} /> Still confused? Ask about this slide
      </h3>
      {thread.map((t, i) => (
        <div key={i} className="mb-3 space-y-2">
          <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-arc/10 px-3 py-1.5 text-sm">{t.q}</p>
          <div className="rounded-lg border border-line bg-raised/50 px-3 py-2" data-testid="tutor-answer">
            <Markdown text={t.a} />
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      <form onSubmit={ask} className="flex gap-2">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Can you explain that more simply?"
          aria-label="Question for the tutor"
          maxLength={2000}
        />
        <button className="btn-primary shrink-0" disabled={busy || !q.trim()} aria-label="Ask the tutor">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
    </section>
  );
}

function OriginalSlide({ lessonId, slide }: { lessonId: string; slide: LessonSlide }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!slide.image) return;
    let url: string | null = null;
    let live = true;
    api
      .lessonImage(lessonId, slide.index)
      .then((u) => {
        url = u;
        if (live) setSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      live = false;
      setSrc(null);
      if (url) URL.revokeObjectURL(url);
    };
  }, [lessonId, slide.index, slide.image]);

  return (
    <details className="card group p-5" open={!!slide.image}>
      <summary className="label mb-0 cursor-pointer list-none group-open:mb-3">Original slide {slide.index}</summary>
      {src && <img src={src} alt={`Picture from slide ${slide.index}`} className="mb-3 w-full rounded-lg border border-line bg-white/5" />}
      {slide.title && <div className="text-sm font-semibold">{slide.title}</div>}
      {slide.text && <pre className="mt-1 font-sans text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{slide.text}</pre>}
      {slide.notes && <p className="mt-2 border-t border-line pt-2 text-xs text-ink-faint">Notes: {slide.notes}</p>}
    </details>
  );
}

function Finish({
  lesson,
  answers,
  onJump,
  onRestart,
  onRebuild,
}: {
  lesson: LessonDetail;
  answers: Record<string, number>;
  onJump: (pos: number) => void;
  onRestart: () => void;
  onRebuild: (l: LessonLevel) => void;
}) {
  const stats = useMemo(() => {
    const withCheck = lesson.scenes.filter((s) => s.check);
    const correct = withCheck.filter((s) => answers[String(s.slide)] === s.check!.answer).length;
    const missed = withCheck.filter((s) => answers[String(s.slide)] !== s.check!.answer);
    return { total: withCheck.length, correct, missed };
  }, [lesson.scenes, answers]);
  const pct = stats.total ? Math.round((stats.correct / stats.total) * 100) : 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  const posOf = (slideNumber: number) => lesson.slides.findIndex((s) => s.index === slideNumber) + 1;

  return (
    <div className="space-y-6" data-testid="lesson-finish">
      <div className="flex flex-col items-center text-center">
        <div className="relative h-36 w-36">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
            <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" className="text-raised" strokeWidth="10" />
            <circle
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke="#22d3ee"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct / 100)}
              className="transition-[stroke-dashoffset] duration-1000"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <Trophy size={20} className="text-arc" />
            <span className="text-2xl font-semibold">{pct}%</span>
          </div>
        </div>
        <h1 className="mt-4 text-2xl font-semibold">Lesson complete</h1>
        <p className="mt-1 text-sm text-ink-dim">
          You got {stats.correct} of {stats.total} questions right.
        </p>
      </div>

      {stats.missed.length > 0 && (
        <div className="card p-5">
          <h3 className="label">Worth another look</h3>
          <ul className="space-y-1">
            {stats.missed.map((s) => (
              <li key={s.slide}>
                <button className="btn-ghost w-full justify-start text-left" onClick={() => onJump(posOf(s.slide))}>
                  <RotateCcw size={14} className="text-warn" /> {s.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card p-5">
        <h3 className="label">Recap</h3>
        <ol className="space-y-3">
          {lesson.scenes.map((s) => (
            <li key={s.slide}>
              <button className="text-left text-sm font-medium hover:text-arc" onClick={() => onJump(posOf(s.slide))}>
                {s.title}
              </button>
              <ul className="mt-1 ml-4 list-disc text-xs text-ink-dim">
                {s.key_points.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <button className="btn-outline" onClick={onRestart}>
          <RotateCcw size={15} /> Start over
        </button>
        {lesson.level !== "advanced" && (
          <button className="btn-outline" onClick={() => onRebuild(lesson.level === "intro" ? "standard" : "advanced")}>
            <Sparkles size={15} /> Go deeper
          </button>
        )}
      </div>
    </div>
  );
}
