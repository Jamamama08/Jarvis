import type { ReactNode } from "react";
import { Menu } from "lucide-react";

/**
 * Honest placeholder for areas whose backend lands in a later phase. It states
 * what will exist and when, rather than rendering a fake, non-functional UI.
 */
export function RoadmapView({
  title,
  icon,
  phase,
  summary,
  features,
  onOpenSidebar,
}: {
  title: string;
  icon: ReactNode;
  phase: number;
  summary: string;
  features: string[];
  onOpenSidebar: () => void;
}) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label={title}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">{title}</h2>
      </header>
      <div className="hud-grid flex flex-1 items-center justify-center overflow-y-auto px-4 py-10">
        <div className="card w-full max-w-lg p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-arc/10 text-arc">{icon}</div>
            <div>
              <h3 className="font-semibold">{title}</h3>
              <span className="text-xs text-warn">Arrives in Phase {phase}</span>
            </div>
          </div>
          <p className="mt-4 text-sm text-ink-dim">{summary}</p>
          <ul className="mt-5 space-y-2">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-ink-dim">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-arc" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
