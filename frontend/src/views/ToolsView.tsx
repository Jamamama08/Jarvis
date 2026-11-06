import { useCallback, useEffect, useState } from "react";
import { AppWindow, FolderOpen, Globe, History, Loader2, Menu, ShieldCheck, Wrench } from "lucide-react";
import { AutomationPanel } from "../components/AutomationPanel";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { Decision, PermissionLevel, SettingsResponse, ToolExecution, ToolsOverview } from "../lib/types";
import { toolLabel } from "../components/ToolActivity";

const LEVEL_TEXT: Record<PermissionLevel, { title: string; hint: string }> = {
  automatic: { title: "Automatic", hint: "Reading, searching, calculating, planning. Safe by default." },
  restricted: { title: "Restricted", hint: "Changing files, running code. Asks first by default." },
  sensitive: { title: "Sensitive", hint: "Permanent deletion and other irreversible actions. Always asks; can't be auto-allowed." },
};

const DECISION_TEXT: Record<Decision, string> = { allow: "Run automatically", ask: "Ask me first", deny: "Never" };

export function ToolsView({ settings, onSettingsChanged, onOpenSidebar }: { settings: SettingsResponse | null; onSettingsChanged: (s: SettingsResponse) => void; onOpenSidebar: () => void }) {
  const [tab, setTab] = useState<"tools" | "automation" | "activity">("tools");
  const [overview, setOverview] = useState<ToolsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.toolsOverview().then(setOverview).catch((e) => setError((e as Error).message)), []);
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

  async function setPref(key: "tools_enabled" | "web_search_enabled", value: boolean) {
    await run(async () => {
      const preferences = await api.updateSettings({ [key]: value });
      if (settings) onSettingsChanged({ ...settings, preferences });
    });
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Tools">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">Tools & permissions</h2>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
          <nav className="flex gap-1 rounded-xl border border-line bg-panel p-1" role="tablist">
            {(
              [
                ["tools", "Tools", <Wrench key="w" size={14} />],
                ["automation", "Browser & apps", <AppWindow key="a" size={14} />],
                ["activity", "Activity log", <History key="h" size={14} />],
              ] as const
            ).map(([t, label, icon]) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"}`}>
                {icon} {label}
              </button>
            ))}
          </nav>
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          {tab === "activity" ? (
            <ActivityLog />
          ) : tab === "automation" ? (
            <AutomationPanel />
          ) : !overview ? (
            <Loader2 className="mx-auto animate-spin text-ink-faint" />
          ) : (
            <>
              <div className="card space-y-4 p-5">
                <Switch
                  label="Let JARVIS use tools"
                  hint="When off, JARVIS can only converse."
                  checked={overview.tools_enabled}
                  onChange={(v) => void setPref("tools_enabled", v)}
                />
                <Switch
                  label="Web search"
                  hint="Lets Claude search the web and read pages (run by Anthropic). Paid: $10 per 1,000 searches plus tokens; at most 5 searches per request. Results are treated as untrusted data."
                  checked={overview.web_search_enabled}
                  onChange={(v) => void setPref("web_search_enabled", v)}
                  icon={<Globe size={14} className="text-arc" />}
                />
                <p className="flex items-start gap-2 text-xs text-ink-faint">
                  <FolderOpen size={14} className="mt-px shrink-0" />
                  <span>
                    File tools only work inside the workspace folder: <code className="font-mono text-ink-dim" data-testid="workspace-dir">{overview.workspace_dir}</code>. Put files there for JARVIS to read.
                  </span>
                </p>
                <p className="text-xs text-ink-faint">
                  Limits per message: {overview.limits.max_tool_iterations} steps, {Math.round(overview.limits.turn_timeout_seconds / 60)} minutes, {overview.limits.turn_token_budget.toLocaleString()} tokens. Each tool run times out after {overview.limits.tool_timeout_seconds}s; approval requests expire after {Math.round(overview.limits.approval_timeout_seconds / 60)} minutes.
                </p>
              </div>

              <div className="card p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={15} className="text-arc" /> Permission levels</h3>
                <div className="mt-4 space-y-3">
                  {overview.levels.map((l) => (
                    <div key={l.level} className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm">{LEVEL_TEXT[l.level].title}</div>
                        <div className="text-xs text-ink-faint">{LEVEL_TEXT[l.level].hint}</div>
                      </div>
                      <DecisionSelect
                        label={`${LEVEL_TEXT[l.level].title} actions`}
                        value={l.decision}
                        allowAllowed={l.level !== "sensitive"}
                        onChange={(d) => void run(() => api.setToolPolicy(`level:${l.level}`, d))}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <ul className="space-y-2" data-testid="tool-list">
                {overview.tools.map((t) => (
                  <li key={t.name} className={`card p-4 ${t.enabled ? "" : "opacity-60"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{toolLabel(t.name)}</span>
                          <code className="font-mono text-[11px] text-ink-faint">{t.name}</code>
                          <LevelBadge level={t.level} />
                          {!t.enabled && <span className="text-[11px] text-ink-faint">{t.server ? "off (enable web search)" : "disabled"}</span>}
                        </div>
                        <p className="mt-1 text-xs text-ink-dim">{t.description}</p>
                      </div>
                      {!t.server && (
                        <div className="flex flex-col items-end gap-1">
                          <DecisionSelect
                            label={`Permission for ${t.name}`}
                            value={t.decision}
                            allowAllowed={t.level !== "sensitive"}
                            onChange={(d) => void run(() => api.setToolPolicy(`tool:${t.name}`, d))}
                          />
                          {t.rule === "tool" ? (
                            <button className="text-[11px] text-ink-faint underline-offset-2 hover:underline" onClick={() => void run(() => api.setToolPolicy(`tool:${t.name}`, null))}>
                              Use level setting
                            </button>
                          ) : (
                            <span className="text-[11px] text-ink-faint">{t.rule === "level" ? "from level setting" : "default"}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function LevelBadge({ level }: { level: PermissionLevel }) {
  const cls = level === "automatic" ? "border-ok/30 text-ok" : level === "restricted" ? "border-warn/30 text-warn" : "border-danger/30 text-danger";
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase ${cls}`}>{level}</span>;
}

function DecisionSelect({ label, value, allowAllowed, onChange }: { label: string; value: Decision; allowAllowed: boolean; onChange: (d: Decision) => void }) {
  return (
    <select className="input w-auto py-1 text-xs" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Decision)}>
      {(["allow", "ask", "deny"] as Decision[])
        .filter((d) => d !== "allow" || allowAllowed)
        .map((d) => (
          <option key={d} value={d}>{DECISION_TEXT[d]}</option>
        ))}
    </select>
  );
}

function Switch({ label, hint, checked, onChange, icon }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; icon?: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span>
        <span className="flex items-center gap-1.5 text-sm">{icon}{label}</span>
        <span className="block text-xs text-ink-faint">{hint}</span>
      </span>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-5 w-9 shrink-0 rounded-full bg-raised ring-1 ring-line-strong transition-colors peer-checked:bg-arc/80 peer-focus-visible:ring-arc after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-ink after:transition-transform peer-checked:after:translate-x-4" aria-hidden />
    </label>
  );
}

function ActivityLog() {
  const [items, setItems] = useState<ToolExecution[] | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    api.toolExecutions({ status: status || undefined }).then(setItems).catch(() => setItems([]));
  }, [status]);
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Tool activity</h3>
          <p className="text-xs text-ink-faint">Every tool call, newest first. Secrets are redacted before anything is stored.</p>
        </div>
        <select className="input w-auto py-1 text-xs" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="denied">Not approved</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {!items ? (
        <Loader2 className="mx-auto mt-4 animate-spin text-ink-faint" />
      ) : items.length === 0 ? (
        <p className="mt-4 text-center text-sm text-ink-faint">No tool activity yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line text-xs" data-testid="tool-log">
          {items.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="font-medium text-ink-dim">{toolLabel(t.tool_name)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-faint">{t.summary}</span>
              <span className={t.status === "succeeded" ? "text-ok" : t.status === "failed" ? "text-danger" : "text-ink-faint"}>{t.status.replace("_", " ")}</span>
              <span className="text-ink-faint">{relativeTime(t.created_at)}</span>
              {t.error && <span className="w-full text-ink-faint">{t.error.slice(0, 200)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
