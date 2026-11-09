import { ChevronDown, ChevronRight, CircleCheck, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { LessonVisualSpec, VisualNode } from "../../lib/types";

/** Accent colours for diagram parts (full class names so Tailwind keeps them). */
export const ACCENTS = [
  { text: "text-arc", border: "border-arc/45", bg: "bg-arc/10", fill: "bg-arc", stroke: "#22d3ee" },
  { text: "text-violet-300", border: "border-violet-400/45", bg: "bg-violet-400/10", fill: "bg-violet-400", stroke: "#a78bfa" },
  { text: "text-amber-300", border: "border-amber-400/45", bg: "bg-amber-400/10", fill: "bg-amber-400", stroke: "#fbbf24" },
  { text: "text-emerald-300", border: "border-emerald-400/45", bg: "bg-emerald-400/10", fill: "bg-emerald-400", stroke: "#34d399" },
  { text: "text-rose-300", border: "border-rose-400/45", bg: "bg-rose-400/10", fill: "bg-rose-400", stroke: "#fb7185" },
  { text: "text-sky-300", border: "border-sky-400/45", bg: "bg-sky-400/10", fill: "bg-sky-400", stroke: "#38bdf8" },
];
const accent = (i: number) => ACCENTS[i % ACCENTS.length];
const delay = (i: number, base = 0): CSSProperties => ({ animationDelay: `${base + i * 160}ms` });

interface Props {
  visual: LessonVisualSpec;
  /** The highlighted part (walk-through or tap), or null. */
  active: number | null;
  onSelect: (index: number) => void;
}

/** Draws a lesson scene's diagram. Every part can be tapped to see its detail. */
export function LessonVisual({ visual, active, onSelect }: Props) {
  const nodes = visual.nodes;
  const shared = { nodes, active, onSelect };
  let body: ReactNode;
  switch (visual.kind) {
    case "flow":
      body = <Flow {...shared} />;
      break;
    case "cycle":
      body = <Cycle {...shared} />;
      break;
    case "hierarchy":
      body = <Tree {...shared} />;
      break;
    case "concept_map":
      body = <ConceptMap {...shared} />;
      break;
    case "compare":
      body = <Compare {...shared} />;
      break;
    case "timeline":
      body = <Timeline {...shared} />;
      break;
    case "bars":
      body = <Bars {...shared} unit={visual.unit} />;
      break;
    case "layers":
      body = <Layers {...shared} />;
      break;
    default:
      body = (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <Sparkles className="animate-orb-breathe text-arc" size={40} />
          {visual.caption && <p className="max-w-md text-sm text-ink-dim">{visual.caption}</p>}
        </div>
      );
  }
  return (
    <div data-testid="lesson-visual" data-kind={visual.kind}>
      {body}
    </div>
  );
}

type Shared = { nodes: VisualNode[]; active: number | null; onSelect: (i: number) => void };

function Chip({
  node,
  i,
  active,
  onSelect,
  className = "",
  showDetail = false,
  number,
}: {
  node: VisualNode;
  i: number;
  active: number | null;
  onSelect: (i: number) => void;
  className?: string;
  showDetail?: boolean;
  number?: number;
}) {
  const a = accent(i);
  const isActive = active === i;
  const dimmed = active !== null && !isActive;
  return (
    <button
      type="button"
      onClick={() => onSelect(i)}
      aria-pressed={isActive}
      className={`animate-pop-in rounded-xl border px-3 py-2 text-left transition-all duration-300 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-arc/50 focus-visible:outline-none ${a.border} ${a.bg} ${
        isActive ? "scale-105 shadow-[0_0_28px_-6px] shadow-arc/50 ring-2 ring-arc/60" : ""
      } ${dimmed ? "opacity-45" : ""} ${className}`}
      style={delay(i)}
    >
      <span className={`flex items-center gap-2 text-sm font-semibold ${a.text}`}>
        {number !== undefined && (
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] text-void ${a.fill}`}>{number}</span>
        )}
        {node.label}
      </span>
      {showDetail && node.detail && <span className="mt-1 block text-xs leading-snug text-ink-dim">{node.detail}</span>}
    </button>
  );
}

function Flow({ nodes, active, onSelect }: Shared) {
  return (
    <ol className="flex flex-col items-stretch gap-1 md:flex-row md:flex-wrap md:items-center md:justify-center">
      {nodes.map((n, i) => (
        <li key={i} className="flex flex-col items-center md:flex-row">
          <Chip node={n} i={i} active={active} onSelect={onSelect} number={i + 1} showDetail className="w-full md:w-44" />
          {i < nodes.length - 1 && (
            <span className="animate-pop-in p-1 text-ink-faint" style={delay(i, 120)} aria-hidden>
              <ChevronDown className="md:hidden" size={18} />
              <ChevronRight className="hidden md:block" size={20} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Nodes positioned in a square stage (percent coordinates) with SVG connectors underneath. */
function Stage({ children, lines, className = "" }: { children: ReactNode; lines: ReactNode; className?: string }) {
  return (
    <div className={`relative mx-auto aspect-square w-full max-w-[460px] ${className}`}>
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" aria-hidden>
        <defs>
          <marker id="lesson-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#22d3ee" />
          </marker>
        </defs>
        {lines}
      </svg>
      {children}
    </div>
  );
}

function Placed({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="absolute max-w-[42%] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-panel" style={{ left: `${x}%`, top: `${y}%` }}>
      {children}
    </div>
  );
}

function polar(i: number, n: number, r: number) {
  const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
  return { x: 50 + r * Math.cos(angle), y: 50 + r * Math.sin(angle) };
}

function Cycle({ nodes, active, onSelect }: Shared) {
  const n = nodes.length;
  const R = 36;
  const arcs = nodes.map((_, i) => {
    const gap = Math.min(14, 120 / n); // degrees left free around each node
    const from = (-90 + (360 / n) * i + gap) * (Math.PI / 180);
    const to = (-90 + (360 / n) * (i + 1) - gap) * (Math.PI / 180);
    const p = (a: number) => `${50 + R * Math.cos(a)} ${50 + R * Math.sin(a)}`;
    return (
      <path
        key={i}
        d={`M ${p(from)} A ${R} ${R} 0 0 1 ${p(to)}`}
        fill="none"
        stroke="#22d3ee"
        strokeOpacity={0.55}
        strokeWidth={0.8}
        strokeDasharray="2 2"
        markerEnd="url(#lesson-arrow)"
        className="animate-flow"
      />
    );
  });
  return (
    <Stage lines={arcs}>
      <div className="absolute inset-[32%] flex items-center justify-center rounded-full border border-line bg-raised/40 text-center text-[11px] tracking-[0.2em] text-ink-faint uppercase">
        repeats
      </div>
      {nodes.map((node, i) => {
        const { x, y } = polar(i, n, R);
        return (
          <Placed key={i} x={x} y={y}>
            <Chip node={node} i={i} active={active} onSelect={onSelect} number={i + 1} />
          </Placed>
        );
      })}
    </Stage>
  );
}

/** Tidy-ish tree layout: leaves spread evenly, parents centred over their children. */
export function layoutTree(nodes: VisualNode[]) {
  const children = nodes.map(() => [] as number[]);
  const roots: number[] = [];
  nodes.forEach((n, i) => (n.parent >= 0 && n.parent < i ? children[n.parent].push(i) : roots.push(i)));
  const depth: number[] = [];
  const x: number[] = [];
  let leaf = 0;
  const leaves = nodes.filter((_, i) => children[i].length === 0).length || 1;
  const visit = (i: number, d: number) => {
    depth[i] = d;
    if (children[i].length === 0) x[i] = ((leaf++ + 0.5) / leaves) * 100;
    else {
      children[i].forEach((c) => visit(c, d + 1));
      x[i] = children[i].reduce((sum, c) => sum + x[c], 0) / children[i].length;
    }
  };
  roots.forEach((r) => visit(r, 0));
  const levels = Math.max(...depth, 0) + 1;
  return nodes.map((n, i) => ({ x: x[i], y: ((depth[i] + 0.5) / levels) * 100, parent: n.parent >= 0 && n.parent < i ? n.parent : -1, levels }));
}

function Tree({ nodes, active, onSelect }: Shared) {
  const pos = layoutTree(nodes);
  const levels = pos[0]?.levels ?? 1;
  return (
    <div className="relative w-full" style={{ height: `${levels * 96}px` }}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {pos.map((p, i) => {
          if (p.parent < 0) return null;
          const q = pos[p.parent];
          const mid = (q.y + p.y) / 2;
          return (
            <path
              key={i}
              d={`M ${q.x} ${q.y} V ${mid} H ${p.x} V ${p.y}`}
              fill="none"
              stroke={accent(p.parent).stroke}
              strokeOpacity={0.6}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className="animate-fade-in"
              style={delay(i)}
            />
          );
        })}
      </svg>
      {nodes.map((node, i) => (
        <div key={i} className="absolute max-w-[30%] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-panel" style={{ left: `${pos[i].x}%`, top: `${pos[i].y}%` }}>
          <Chip node={node} i={i} active={active} onSelect={onSelect} className="text-center" />
        </div>
      ))}
    </div>
  );
}

function ConceptMap({ nodes, active, onSelect }: Shared) {
  const others = nodes.slice(1);
  const at = (i: number) => (i === 0 ? { x: 50, y: 50 } : polar(i - 1, others.length, 37));
  const lines = nodes.map((n, i) => {
    if (i === 0) return null;
    const from = at(n.parent >= 0 && n.parent < i ? n.parent : 0);
    const to = at(i);
    return (
      <line
        key={i}
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={accent(i).stroke}
        strokeOpacity={0.55}
        strokeWidth={0.7}
        pathLength={1}
        strokeDasharray="1"
        className="animate-draw"
        style={delay(i)}
      />
    );
  });
  return (
    <Stage lines={lines}>
      {nodes.map((node, i) => {
        const { x, y } = at(i);
        return (
          <Placed key={i} x={x} y={y}>
            <Chip node={node} i={i} active={active} onSelect={onSelect} className={i === 0 ? "px-4 py-3 text-[16px]" : ""} />
          </Placed>
        );
      })}
    </Stage>
  );
}

function Compare({ nodes, active, onSelect }: Shared) {
  const cols = nodes.length === 2 ? "sm:grid-cols-2" : nodes.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <div className={`grid grid-cols-1 gap-3 ${cols}`}>
      {nodes.map((node, i) => {
        const a = accent(i);
        const isActive = active === i;
        return (
          <button
            type="button"
            key={i}
            onClick={() => onSelect(i)}
            aria-pressed={isActive}
            className={`animate-pop-in rounded-xl border p-4 text-left transition-all ${a.border} ${a.bg} ${
              isActive ? "ring-2 ring-arc/60" : active !== null ? "opacity-50" : ""
            }`}
            style={delay(i)}
          >
            <div className={`text-[16px] font-semibold ${a.text}`}>{node.label}</div>
            {node.detail && <p className="mt-1 text-xs text-ink-dim">{node.detail}</p>}
            <ul className="mt-3 space-y-1.5">
              {node.points.map((p, j) => (
                <li key={j} className="animate-pop-in flex gap-2 text-sm text-ink" style={delay(j, 250 + i * 120)}>
                  <CircleCheck size={15} className={`mt-0.5 shrink-0 ${a.text}`} />
                  {p}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

function Timeline({ nodes, active, onSelect }: Shared) {
  return (
    <ol className="relative ml-3 border-l border-arc/30 pl-6">
      {nodes.map((node, i) => {
        const a = accent(i);
        return (
          <li key={i} className="animate-pop-in relative pb-5 last:pb-0" style={delay(i)}>
            <span className={`absolute top-1.5 -left-[31px] h-3 w-3 rounded-full ring-4 ring-void ${a.fill}`} aria-hidden />
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={active === i}
              className={`w-full rounded-lg px-2 py-1 text-left transition-all hover:bg-raised ${active === i ? "bg-raised ring-1 ring-arc/50" : active !== null ? "opacity-50" : ""}`}
            >
              <div className={`text-xs font-semibold tracking-wide uppercase ${a.text}`}>{node.label}</div>
              {node.detail && <div className="text-sm text-ink">{node.detail}</div>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function formatValue(value: number, unit: string) {
  const v = Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : String(Math.round(value * 100) / 100);
  if (!unit) return v;
  return unit === "%" || unit.length <= 1 ? `${v}${unit}` : `${v} ${unit}`;
}

function Bars({ nodes, active, onSelect, unit }: Shared & { unit: string }) {
  const max = Math.max(...nodes.map((n) => Math.abs(n.value)), 1);
  return (
    <div className="space-y-3">
      {nodes.map((node, i) => {
        const a = accent(i);
        const pct = Math.max(2, (Math.abs(node.value) / max) * 100);
        return (
          <button
            type="button"
            key={i}
            onClick={() => onSelect(i)}
            aria-pressed={active === i}
            className={`grid w-full grid-cols-[minmax(5rem,9rem)_1fr_auto] items-center gap-3 rounded-lg px-1 py-0.5 text-left transition-opacity ${
              active !== null && active !== i ? "opacity-45" : ""
            }`}
          >
            <span className="truncate text-sm text-ink" title={node.label}>
              {node.label}
            </span>
            <span className="h-7 overflow-hidden rounded-md bg-raised">
              <span
                className={`animate-grow-x block h-full origin-left rounded-md ${a.fill} ${active === i ? "opacity-100" : "opacity-80"}`}
                style={{ width: `${pct}%`, ...delay(i) }}
              />
            </span>
            <span className={`min-w-12 text-right font-mono text-sm ${a.text}`}>{formatValue(node.value, unit)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Layers({ nodes, active, onSelect }: Shared) {
  const n = nodes.length;
  return (
    <div className="flex flex-col items-center gap-1.5">
      {nodes.map((node, i) => {
        const a = accent(i);
        const width = n > 1 ? 55 + (45 * i) / (n - 1) : 100;
        return (
          <button
            type="button"
            key={i}
            onClick={() => onSelect(i)}
            aria-pressed={active === i}
            className={`animate-pop-in rounded-lg border px-4 py-2.5 text-center transition-all ${a.border} ${a.bg} ${
              active === i ? "ring-2 ring-arc/60" : active !== null ? "opacity-45" : ""
            }`}
            style={{ width: `${width}%`, ...delay(i) }}
          >
            <div className={`text-sm font-semibold ${a.text}`}>{node.label}</div>
            {node.detail && <div className="text-xs text-ink-dim">{node.detail}</div>}
          </button>
        );
      })}
    </div>
  );
}
