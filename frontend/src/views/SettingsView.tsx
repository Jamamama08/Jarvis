import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, DatabaseBackup, Loader2, Menu } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import { formatBytes, relativeTime } from "../lib/format";
import type { Backup, Preferences, SettingsResponse, User } from "../lib/types";

interface Props {
  user: User;
  settings: SettingsResponse | null;
  onSettingsChanged: (s: SettingsResponse) => void;
  onOpenSidebar: () => void;
}

export function SettingsView({ user, settings, onSettingsChanged, onOpenSidebar }: Props) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Settings">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="text-sm font-medium">Settings</h2>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
          {!settings ? (
            <Loader2 className="mx-auto animate-spin text-ink-faint" />
          ) : (
            <>
              <ProfileCard user={user} />
              <AssistantCard settings={settings} onSaved={onSettingsChanged} />
              <SecurityCard />
              <DataCard />
              <AboutCard settings={settings} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

function SaveRow({ busy, saved, error, label = "Save" }: { busy: boolean; saved: boolean; error: string | null; label?: string }) {
  return (
    <div className="flex items-center gap-3">
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" />} {label}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-xs text-ok">
          <Check size={13} /> Saved
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function useSaver() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await fn();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, saved, error, run };
}

function ProfileCard({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [name, setName] = useState(user.display_name);
  const s = useSaver();
  return (
    <Card title="Profile" description="How JARVIS addresses you.">
      <form onSubmit={(e) => { e.preventDefault(); void s.run(async () => setUser(await api.updateProfile(name))); }} className="space-y-4">
        <div>
          <label className="label" htmlFor="profile-name">Display name</label>
          <input id="profile-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        </div>
        <SaveRow {...s} />
      </form>
    </Card>
  );
}

function AssistantCard({ settings, onSaved }: { settings: SettingsResponse; onSaved: (s: SettingsResponse) => void }) {
  const [prefs, setPrefs] = useState<Preferences>(settings.preferences);
  const s = useSaver();
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(async () => {
      const preferences = await api.updateSettings(prefs);
      setPrefs(preferences);
      onSaved({ ...settings, preferences });
    });
  }

  return (
    <Card title="Assistant" description="Model and conversation behaviour. Empty values use the server defaults.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="assistant-name">Assistant name</label>
            <input id="assistant-name" className="input" value={prefs.assistant_name} onChange={(e) => set("assistant_name", e.target.value)} maxLength={40} required />
          </div>
          <div>
            <label className="label" htmlFor="model">Claude model</label>
            <input id="model" className="input font-mono" placeholder={settings.server.default_model} value={prefs.model} onChange={(e) => set("model", e.target.value.trim())} />
          </div>
          <div>
            <label className="label" htmlFor="max-tokens">Max output tokens</label>
            <input id="max-tokens" type="number" min={0} max={64000} className="input" placeholder={String(settings.server.default_max_output_tokens)} value={prefs.max_output_tokens || ""} onChange={(e) => set("max_output_tokens", Number(e.target.value) || 0)} />
          </div>
          <div>
            <label className="label" htmlFor="speech-rate">Speech rate ({prefs.speech_rate.toFixed(1)}×)</label>
            <input id="speech-rate" type="range" min={0.5} max={2} step={0.1} className="w-full accent-arc" value={prefs.speech_rate} onChange={(e) => set("speech_rate", Number(e.target.value))} />
          </div>
        </div>
        <Toggle label="Send message with Enter" hint="Otherwise use Ctrl+Enter." checked={prefs.send_on_enter} onChange={(v) => set("send_on_enter", v)} />
        <Toggle label="Voice input" hint="Microphone input. Active from Phase 4." checked={prefs.voice_input_enabled} onChange={(v) => set("voice_input_enabled", v)} />
        <Toggle label="Speak responses aloud" hint="Text-to-speech. Active from Phase 4." checked={prefs.speak_responses} onChange={(v) => set("speak_responses", v)} />
        <SaveRow {...s} />
      </form>
    </Card>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
      </span>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-5 w-9 shrink-0 rounded-full bg-raised ring-1 ring-line-strong transition-colors peer-checked:bg-arc/80 peer-focus-visible:ring-arc after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-ink after:transition-transform peer-checked:after:translate-x-4" aria-hidden />
    </label>
  );
}

function SecurityCard() {
  const { logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const s = useSaver();
  return (
    <Card title="Security" description="Changing your password signs out every other device.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void s.run(async () => {
            if (next !== confirm) throw new Error("New passwords do not match");
            await api.changePassword(current, next);
            setCurrent(""); setNext(""); setConfirm("");
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="pw-current">Current</label>
            <input id="pw-current" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="pw-new">New</label>
            <input id="pw-new" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="pw-confirm">Confirm</label>
            <input id="pw-confirm" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SaveRow {...s} label="Change password" />
          <button type="button" className="btn-danger" onClick={() => void logout()}>Sign out</button>
        </div>
      </form>
    </Card>
  );
}

function DataCard() {
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const s = useSaver();
  useEffect(() => {
    api.listBackups().then(setBackups).catch(() => setBackups([]));
  }, []);
  return (
    <Card title="Data & backups" description="Your data lives in a local SQLite database. Backups are consistent snapshots (last 20 kept).">
      <form onSubmit={(e) => { e.preventDefault(); void s.run(async () => { const b = await api.createBackup(); setBackups((prev) => [b, ...(prev ?? [])]); }); }}>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-outline" disabled={s.busy}>
            {s.busy ? <Loader2 size={14} className="animate-spin" /> : <DatabaseBackup size={15} />} Back up now
          </button>
          {s.error && <span role="alert" className="text-xs text-danger">{s.error}</span>}
        </div>
      </form>
      {backups && backups.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line text-xs" data-testid="backup-list">
          {backups.slice(0, 5).map((b) => (
            <li key={b.filename} className="flex items-center justify-between px-3 py-2">
              <span className="font-mono text-ink-dim">{b.filename}</span>
              <span className="text-ink-faint">{formatBytes(b.size_bytes)} · {relativeTime(b.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AboutCard({ settings }: { settings: SettingsResponse }) {
  const { server } = settings;
  const rows: [string, string][] = [
    ["Version", server.version],
    ["Build phase", `Phase ${server.phase} of 8`],
    ["AI provider", server.ai_configured ? "Claude (connected)" : "Not connected — Phase 2"],
    ["Default model", server.default_model],
  ];
  return (
    <Card title="About">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-faint">{k}</dt>
            <dd className="font-mono text-xs leading-5 text-ink-dim">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
