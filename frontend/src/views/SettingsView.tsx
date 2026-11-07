import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, DatabaseBackup, Loader2, Menu, Play } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import { formatBytes, relativeTime } from "../lib/format";
import type { Backup, Effort, Preferences, SettingsResponse, UsageSummary, User } from "../lib/types";
import { getVoiceProvider } from "../voice/useVoice";
import { ConnectionsCard } from "../components/ConnectionsCard";
import type { VoiceInfo } from "../voice/types";

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
              <ConnectionsCard onKeyChanged={() => void api.getSettings().then(onSettingsChanged)} />
              <AssistantCard settings={settings} onSaved={onSettingsChanged} />
              <VoiceCard settings={settings} onSaved={onSettingsChanged} />
              <UsageCard settings={settings} />
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
      const { assistant_name, model, effort, max_output_tokens, memory_enabled, send_on_enter } = prefs;
      const preferences = await api.updateSettings({ assistant_name, model, effort, max_output_tokens, memory_enabled, send_on_enter });
      setPrefs(preferences);
      onSaved({ ...settings, preferences });
    });
  }

  return (
    <Card title="Assistant" description="Model and response behaviour. Empty values use the server defaults. Higher effort and larger models cost more per message.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="assistant-name">Assistant name</label>
            <input id="assistant-name" className="input" value={prefs.assistant_name} onChange={(e) => set("assistant_name", e.target.value)} maxLength={40} required />
          </div>
          <ModelPicker settings={settings} value={prefs.model} onChange={(v) => set("model", v)} />
          <div>
            <label className="label" htmlFor="effort">Effort</label>
            <select id="effort" className="input" value={prefs.effort} onChange={(e) => set("effort", e.target.value as Effort)}>
              <option value="">Model default</option>
              <option value="low">Low: fastest, cheapest</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max: most thorough, most tokens</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="max-tokens">Max output tokens</label>
            <input id="max-tokens" type="number" min={0} max={128000} className="input" placeholder={String(settings.server.default_max_output_tokens)} value={prefs.max_output_tokens || ""} onChange={(e) => set("max_output_tokens", Number(e.target.value) || 0)} />
          </div>
        </div>
        <Toggle label="Use memories in replies" hint="Send relevant approved memories to Claude with each message." checked={prefs.memory_enabled} onChange={(v) => set("memory_enabled", v)} />
        <Toggle label="Send message with Enter" hint="Otherwise use Ctrl+Enter." checked={prefs.send_on_enter} onChange={(v) => set("send_on_enter", v)} />
        <SaveRow {...s} />
      </form>
    </Card>
  );
}

const CUSTOM = "__custom__";

function ModelPicker({ settings, value, onChange }: { settings: SettingsResponse; value: string; onChange: (v: string) => void }) {
  const { models, default_model } = settings.server;
  const known = value === "" || models.some((m) => m.id === value);
  const [custom, setCustom] = useState(!known);
  const defaultLabel = models.find((m) => m.id === default_model)?.label ?? default_model;
  return (
    <div>
      <label className="label" htmlFor="model">Claude model</label>
      <select
        id="model"
        className="input"
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Server default ({defaultLabel})</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · ${m.input_per_mtok} / ${m.output_per_mtok} per M tokens
          </option>
        ))}
        <option value={CUSTOM}>Other model ID…</option>
      </select>
      {custom && (
        <input aria-label="Custom model ID" className="input mt-2 font-mono" placeholder="claude-…" value={value} onChange={(e) => onChange(e.target.value.trim())} />
      )}
    </div>
  );
}

function UsageCard({ settings }: { settings: SettingsResponse }) {
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.usage(days).then(setUsage).catch((e) => setError((e as Error).message));
  }, [days]);
  const t = usage?.totals;
  const fmt = (n: number) => n.toLocaleString();
  const cost = (c: number | null) => (c === null ? "n/a" : c > 0 && c < 0.01 ? "< $0.01" : "$" + c.toFixed(2));
  return (
    <Card
      title="API usage"
      description={
        settings.server.ai_configured
          ? "Tokens used by your Claude requests. Costs are estimates from list prices; your Anthropic invoice is authoritative."
          : "Usage appears here once Claude is connected."
      }
    >
      <div className="flex items-center gap-2">
        {[7, 30, 365].map((d) => (
          <button key={d} type="button" onClick={() => setDays(d)} className={"rounded-md px-2.5 py-1 text-xs " + (d === days ? "bg-raised text-ink" : "text-ink-faint hover:text-ink")}>
            {d === 365 ? "1 year" : d + " days"}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {t && usage && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="usage-totals">
            <Stat label="Requests" value={fmt(t.requests)} />
            <Stat label="Input tokens" value={fmt(t.input_tokens + t.cache_read_tokens + t.cache_write_tokens)} />
            <Stat label="Output tokens" value={fmt(t.output_tokens)} />
            <Stat label="Est. cost" value={cost(t.estimated_cost_usd)} />
          </div>
          {usage.by_model.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line text-xs">
              {usage.by_model.map((r) => (
                <li key={r.model} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono text-ink-dim">{r.model}</span>
                  <span className="text-ink-faint">
                    {fmt(r.requests)} req · {fmt(r.cache_read_tokens)} cached tokens · {cost(r.estimated_cost_usd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-base px-3 py-2">
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-ink">{value}</div>
    </div>
  );
}

const LANGUAGES = ["en-US", "en-GB", "en-AU", "en-IN", "es-ES", "es-MX", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "ja-JP", "ko-KR", "zh-CN", "hi-IN", "vi-VN"];

function VoiceCard({ settings, onSaved }: { settings: SettingsResponse; onSaved: (s: SettingsResponse) => void }) {
  const provider = getVoiceProvider();
  const [prefs, setPrefs] = useState<Preferences>(settings.preferences);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const s = useSaver();
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setPrefs((p) => ({ ...p, [k]: v }));
  const browserLang = typeof navigator !== "undefined" ? navigator.language : "en-US";
  const lang = prefs.voice_language || browserLang;

  useEffect(() => {
    void provider.synthesizer.voices().then(setVoices);
  }, [provider]);

  const base = lang.split("-")[0].toLowerCase();
  const sorted = [...voices].sort(
    (a, b) => Number(b.language.toLowerCase().startsWith(base)) - Number(a.language.toLowerCase().startsWith(base)) || a.name.localeCompare(b.name),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(async () => {
      const { voice_input_enabled, speak_responses, voice_name, speech_rate, voice_language, voice_auto_send, voice_conversation_mode } = prefs;
      const preferences = await api.updateSettings({ voice_input_enabled, speak_responses, voice_name, speech_rate, voice_language, voice_auto_send, voice_conversation_mode });
      setPrefs(preferences);
      onSaved({ ...settings, preferences });
    });
  }

  function testVoice() {
    provider.synthesizer.cancel();
    provider.synthesizer.speak(`Good day. I'm ${settings.preferences.assistant_name || "JARVIS"}, and this is how I sound.`, {
      voiceId: prefs.voice_name || undefined,
      rate: prefs.speech_rate,
      language: lang,
    });
  }

  const inputReason = provider.recognizer.unsupportedReason;
  return (
    <Card title="Voice" description={provider.privacyNote}>
      <ul className="space-y-1 text-xs" data-testid="voice-support">
        <li className={inputReason ? "text-warn" : "text-ok"}>
          {inputReason ? `Voice input: ${inputReason}` : "Voice input: supported in this browser."}
        </li>
        <li className={provider.synthesizer.supported ? "text-ok" : "text-warn"}>
          {provider.synthesizer.supported
            ? `Spoken replies: supported (${voices.length} voice${voices.length === 1 ? "" : "s"} available).`
            : "Spoken replies: this browser doesn't support speech synthesis."}
        </li>
      </ul>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="voice-name">Voice</label>
            <select id="voice-name" className="input" value={prefs.voice_name} onChange={(e) => set("voice_name", e.target.value)}>
              <option value="">System default</option>
              {sorted.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.language}){v.local ? "" : " · online"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="voice-language">Recognition language</label>
            <select id="voice-language" className="input" value={prefs.voice_language} onChange={(e) => set("voice_language", e.target.value)}>
              <option value="">Browser default ({browserLang})</option>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="speech-rate">Speech rate ({prefs.speech_rate.toFixed(1)}×)</label>
            <input id="speech-rate" type="range" min={0.5} max={2} step={0.1} className="w-full accent-arc" value={prefs.speech_rate} onChange={(e) => set("speech_rate", Number(e.target.value))} />
          </div>
          <div className="flex items-end">
            <button type="button" className="btn-outline" onClick={testVoice} disabled={!provider.synthesizer.supported}>
              <Play size={14} /> Test voice
            </button>
          </div>
        </div>
        <Toggle label="Voice input" hint="Show the microphone button for speaking your messages." checked={prefs.voice_input_enabled} onChange={(v) => set("voice_input_enabled", v)} />
        <Toggle label="Send voice messages automatically" hint="Send as soon as you stop talking. Off: the words go into the message box for you to edit." checked={prefs.voice_auto_send} onChange={(v) => set("voice_auto_send", v)} />
        <Toggle label="Speak replies aloud" hint="Read replies out as they arrive. Mute anytime from the chat header; Esc stops speaking." checked={prefs.speak_responses} onChange={(v) => set("speak_responses", v)} />
        <Toggle label="Hands-free conversation" hint="After a spoken message, listen again once the reply has been read out." checked={prefs.voice_conversation_mode} onChange={(v) => set("voice_conversation_mode", v)} />
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
    ["AI provider", server.ai_configured ? "Claude (connected)" : "Not connected: set ANTHROPIC_API_KEY"],
    ["Default model", server.default_model],
    ["Refusal fallback", server.refusal_fallback ? "On (Anthropic's recommended fallback model)" : "Off"],
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
