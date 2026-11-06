import { Activity, Wrench } from "lucide-react";
import type { SettingsResponse } from "../lib/types";

/** Header indicators: AI connection state and tool activity (tools arrive in Phase 5). */
export function StatusPill({ streaming, settings }: { streaming: boolean; settings: SettingsResponse | null }) {
  const configured = settings?.server.ai_configured ?? false;
  return (
    <div className="flex items-center gap-2">
      <span
        className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-faint sm:inline-flex"
        title="Tool activity"
        data-testid="tool-activity"
      >
        <Wrench size={11} /> No tools active
      </span>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
          configured ? "border-ok/30 text-ok" : "border-warn/30 text-warn"
        }`}
        data-testid="ai-status"
      >
        {streaming ? <Activity size={11} className="animate-pulse" /> : <span className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-ok" : "bg-warn"}`} />}
        {configured ? (streaming ? "Responding" : "Claude online") : "Claude not connected"}
      </span>
    </div>
  );
}
