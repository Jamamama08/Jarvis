import { Activity, Loader2, ShieldAlert, Wrench } from "lucide-react";
import { toolLabel } from "./ToolActivity";
import type { SettingsResponse, ToolExecution } from "../lib/types";

/** Header indicators: AI connection state and live tool activity (running / waiting for approval). */
export function StatusPill({ streaming, settings, activeTool }: { streaming: boolean; settings: SettingsResponse | null; activeTool?: ToolExecution | null }) {
  const configured = settings?.server.ai_configured ?? false;
  return (
    <div className="flex items-center gap-2">
      <span
        className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] sm:inline-flex ${
          activeTool?.status === "pending_approval"
            ? "border-warn/40 text-warn"
            : activeTool
              ? "border-arc/40 text-arc"
              : "border-line text-ink-faint"
        }`}
        title="Tool activity"
        data-testid="tool-activity"
      >
        {activeTool?.status === "pending_approval" ? (
          <>
            <ShieldAlert size={11} /> Approval needed: {toolLabel(activeTool.tool_name)}
          </>
        ) : activeTool ? (
          <>
            <Loader2 size={11} className="animate-spin" /> {toolLabel(activeTool.tool_name)}
          </>
        ) : (
          <>
            <Wrench size={11} /> {settings?.preferences.tools_enabled === false ? "Tools off" : "No tools active"}
          </>
        )}
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
