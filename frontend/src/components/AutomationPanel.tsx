import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppWindow, Globe, Loader2, Plus, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import type { AutomationStatus, DesktopApp } from "../lib/types";

/** Browser status and the desktop app allow-list (Tools page). */
export function AutomationPanel() {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [apps, setApps] = useState<DesktopApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.automationStatus(), api.listDesktopApps()]);
      setStatus(s);
      setApps(a);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (!status) return <Loader2 className="mx-auto animate-spin text-ink-faint" />;
  return (
    <div className="space-y-4">
      <div className="card space-y-2 p-5" data-testid="browser-panel">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Globe size={15} className="text-arc" /> Browser</h3>
        <p className="text-xs text-ink-dim">
          JARVIS has its own separate browser: none of your logins or cookies, downloads blocked, closed after 10 minutes idle. Opening and reading pages is automatic; clicking, typing and choosing options ask you first. It never types passwords.
        </p>
        <ul className="space-y-0.5 text-xs text-ink-faint">
          <li>{status.browser_enabled ? "Enabled" : "Disabled (JARVIS_BROWSER_ENABLED=false)"} · {status.browser_headless ? "runs invisibly" : "visible window"}</li>
          <li>
            {status.browser_private_network
              ? "Private-network addresses are allowed (JARVIS_BROWSER_ALLOW_PRIVATE_NETWORK=true)."
              : "Pages on your private network (router, NAS, this computer) are blocked."}
          </li>
        </ul>
        {status.browser_open_url && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-base px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-ink-dim" data-testid="browser-url">Open: {status.browser_open_url}</span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await api.closeBrowser(); await load(); }}>
              <X size={12} /> Close browser
            </button>
          </div>
        )}
      </div>

      <div className="card space-y-3 p-5" data-testid="desktop-panel">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><AppWindow size={15} className="text-arc" /> Desktop apps</h3>
        {!status.desktop_enabled ? (
          <p className="text-xs text-warn">{status.desktop_reason}</p>
        ) : (
          <p className="text-xs text-ink-dim">
            Apps JARVIS may open on this computer (each launch asks you first unless you change that). Only you can add apps. Arguments are fixed; if you allow it, JARVIS may add one web address or workspace file, never a command-line option. Don't add shells or script interpreters (cmd, PowerShell, Terminal, python), since they can run anything.
          </p>
        )}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {apps.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line text-xs" data-testid="desktop-apps">
            {apps.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink">{a.name} {a.allow_target && <span className="font-normal text-ink-faint">· accepts URL or file</span>}</div>
                  <div className="truncate font-mono text-ink-faint">{[a.path, ...a.args].join(" ")}</div>
                  {a.description && <div className="text-ink-dim">{a.description}</div>}
                </div>
                <button className="btn-ghost p-1.5 hover:text-danger" aria-label={`Remove ${a.name}`} onClick={async () => { await api.removeDesktopApp(a.id); await load(); }}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {status.desktop_enabled && <AddApp onAdded={load} platform={status.platform} />}
      </div>
    </div>
  );
}

function AddApp({ onAdded, platform }: { onAdded: () => void; platform: string }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [args, setArgs] = useState("");
  const [allowTarget, setAllowTarget] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const example = platform === "win32" ? "C:\\Program Files\\Mozilla Firefox\\firefox.exe" : platform === "darwin" ? "/Applications/Safari.app" : "/usr/bin/firefox";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addDesktopApp({ name, path, args: args.trim() ? args.trim().split(/\s+/) : [], allow_target: allowTarget, description });
      setName(""); setPath(""); setArgs(""); setDescription(""); setAllowTarget(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-2 rounded-lg border border-line p-3" onSubmit={submit} aria-label="Add desktop app">
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <input className="input" aria-label="App name" placeholder="Name, e.g. Firefox" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
        <input className="input font-mono" aria-label="App path" placeholder={example} value={path} onChange={(e) => setPath(e.target.value)} required />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <input className="input font-mono" aria-label="Fixed arguments" placeholder="Fixed arguments (optional)" value={args} onChange={(e) => setArgs(e.target.value)} />
        <input className="input" aria-label="App description" placeholder="What it's for (helps JARVIS choose)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-dim">
        <input type="checkbox" className="accent-arc" checked={allowTarget} onChange={(e) => setAllowTarget(e.target.checked)} />
        JARVIS may pass a web address or workspace file to this app
      </label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <button className="btn-outline px-3 py-1.5 text-xs" disabled={busy || !name.trim() || !path.trim()}>
        <Plus size={13} /> Approve app
      </button>
    </form>
  );
}
