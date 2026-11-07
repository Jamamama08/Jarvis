import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bell, CalendarDays, Check, CloudSun, KeyRound, Loader2, Mail, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { EmailSettings, IntegrationsStatus } from "../lib/types";

/** Settings → Connections: Claude API key, email, calendar, notifications, weather. Secrets are never shown again. */
export function ConnectionsCard({ onKeyChanged }: { onKeyChanged: () => void }) {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const load = useCallback(() => api.integrations().then(setStatus).catch(() => {}), []);
  useEffect(() => void load(), [load]);
  if (!status) return null;
  return (
    <div className="card p-5" data-testid="connections">
      <h3 className="text-sm font-semibold">Connections</h3>
      <p className="mt-1 text-xs text-ink-faint">
        Passwords, keys and private links are stored only on this server (in a private secrets file), never in the database, and are never shown again after saving.
      </p>
      <div className="mt-4 divide-y divide-line">
        <ClaudeKey status={status} onChanged={() => { void load(); onKeyChanged(); }} />
        <EmailSection status={status} onChanged={load} />
        <UrlSection
          icon={<CalendarDays size={15} />}
          title="Calendar"
          section="calendar"
          configured={status.calendar.configured}
          hint="Paste your calendar's private iCal (.ics) address: Google Calendar → Settings → your calendar → “Secret address in iCal format”; Outlook → Settings → Shared calendars → Publish. Read-only."
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          onChanged={load}
        />
        <UrlSection
          icon={<Bell size={15} />}
          title="Phone notifications"
          section="notifications"
          configured={status.notifications.configured}
          detail={status.notifications.kind ? `via ${status.notifications.kind}` : undefined}
          hint="A webhook JARVIS can post to: an ntfy topic (free app, e.g. https://ntfy.sh/your-secret-topic), a Discord or Slack incoming webhook, or any URL accepting JSON."
          placeholder="https://ntfy.sh/your-secret-topic"
          onChanged={load}
        />
        <Row icon={<CloudSun size={15} />} title="Weather" status={<Badge ok>Ready</Badge>}>
          <p className="text-xs text-ink-faint">Uses Open-Meteo: free, no account or key needed.</p>
        </Row>
      </div>
    </div>
  );
}

function Row({ icon, title, status, children }: { icon: ReactNode; title: string; status: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="text-arc">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto">{status}</span>
      </div>
      {children}
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${ok ? "border-ok/40 text-ok" : "border-line-strong text-ink-faint"}`}>{children}</span>;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<string | void>, success?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage({ ok: true, text: result || success || "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, run };
}

function Feedback({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return (
    <p role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-ok" : "text-danger"}`}>
      {message.ok && <Check size={12} className="mr-1 inline" />}
      {message.text}
    </p>
  );
}

function ClaudeKey({ status, onChanged }: { status: IntegrationsStatus; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const a = useAction();
  const s = status.anthropic;
  return (
    <Row icon={<KeyRound size={15} />} title="Claude API key" status={<Badge ok={s.configured}>{s.configured ? (s.source === "env" ? "Set in .env" : "Connected") : "Not set"}</Badge>}>
      {s.source === "env" ? (
        <p className="text-xs text-ink-faint">The key comes from the server's .env file; change it there.</p>
      ) : !s.editable ? (
        <p className="text-xs text-ink-faint">Only the owner account (the first account created) can change the Claude API key.</p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void a.run(async () => {
              await api.setAnthropicKey(key.trim());
              setKey("");
              onChanged();
              return "Key verified with Anthropic and saved. Claude is connected.";
            });
          }}
        >
          <p className="text-xs text-ink-faint">
            Create a key at console.anthropic.com → API keys. Usage is billed to that Anthropic account. JARVIS checks the key with a free request before saving it.
          </p>
          <div className="flex flex-wrap gap-2">
            <input className="input flex-1 font-mono" type="password" autoComplete="off" aria-label="Claude API key" placeholder={s.configured ? "Enter a new key to replace the current one" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn-primary" disabled={a.busy || key.trim().length < 20}>
              {a.busy && <Loader2 size={14} className="animate-spin" />} Save key
            </button>
            {s.configured && (
              <button type="button" className="btn-ghost hover:text-danger" onClick={() => void a.run(async () => { await api.removeAnthropicKey(); onChanged(); return "Key removed."; })}>
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
          <Feedback message={a.message} />
        </form>
      )}
    </Row>
  );
}

const PRESETS: Record<string, Partial<EmailSettings>> = {
  Gmail: { imap_host: "imap.gmail.com", imap_port: 993, imap_security: "ssl", smtp_host: "smtp.gmail.com", smtp_port: 587, smtp_security: "starttls" },
  Outlook: { imap_host: "outlook.office365.com", imap_port: 993, imap_security: "ssl", smtp_host: "smtp.office365.com", smtp_port: 587, smtp_security: "starttls" },
  iCloud: { imap_host: "imap.mail.me.com", imap_port: 993, imap_security: "ssl", smtp_host: "smtp.mail.me.com", smtp_port: 587, smtp_security: "starttls" },
};

function EmailSection({ status, onChanged }: { status: IntegrationsStatus; onChanged: () => void }) {
  const e = status.email;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EmailSettings>({
    username: e.username ?? "", password: null, imap_host: e.imap_host ?? "", imap_port: e.imap_port ?? 993,
    imap_security: (e.imap_security as EmailSettings["imap_security"]) ?? "ssl", smtp_host: e.smtp_host ?? "",
    smtp_port: e.smtp_port ?? 587, smtp_security: (e.smtp_security as EmailSettings["smtp_security"]) ?? "starttls",
    from_address: e.from_address ?? "",
  });
  const a = useAction();
  const set = <K extends keyof EmailSettings>(k: K, v: EmailSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Row icon={<Mail size={15} />} title="Email" status={<Badge ok={e.configured}>{e.configured ? e.username : "Not set"}</Badge>}>
      <p className="text-xs text-ink-faint">
        Standard IMAP/SMTP, so it works with Gmail, Outlook, iCloud and most providers. Use an <strong>app password</strong> (required by Gmail and Outlook with 2-step verification). Reading is automatic; sending always asks you first by default.
      </p>
      {!open ? (
        <div className="flex gap-2">
          <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>{e.configured ? "Edit" : "Set up email"}</button>
          {e.configured && (
            <>
              <button className="btn-ghost px-3 py-1.5 text-xs" disabled={a.busy} onClick={() => void a.run(async () => (await api.testIntegration("email")).message)}>Test connection</button>
              <button className="btn-ghost px-3 py-1.5 text-xs hover:text-danger" onClick={() => void a.run(async () => { await api.removeIntegration("email"); onChanged(); return "Email disconnected."; })}>Disconnect</button>
            </>
          )}
        </div>
      ) : (
        <form
          className="space-y-2"
          aria-label="Email settings"
          onSubmit={(ev) => {
            ev.preventDefault();
            void a.run(async () => {
              await api.setEmail(form);
              setOpen(false);
              onChanged();
              return (await api.testIntegration("email")).message;
            });
          }}
        >
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(PRESETS).map(([name, p]) => (
              <button key={name} type="button" className="rounded-md border border-line px-2 py-0.5 text-ink-dim hover:border-arc/50" onClick={() => setForm((f) => ({ ...f, ...p }))}>{name}</button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input" aria-label="Email address" placeholder="you@example.com" value={form.username} onChange={(x) => set("username", x.target.value)} required />
            <input className="input" type="password" autoComplete="new-password" aria-label="App password" placeholder={e.configured ? "App password (leave empty to keep)" : "App password"} value={form.password ?? ""} onChange={(x) => set("password", x.target.value || null)} />
            <input className="input" aria-label="IMAP server" placeholder="imap.example.com" value={form.imap_host} onChange={(x) => set("imap_host", x.target.value)} required />
            <input className="input" aria-label="SMTP server" placeholder="smtp.example.com" value={form.smtp_host} onChange={(x) => set("smtp_host", x.target.value)} required />
          </div>
          <input className="input" aria-label="Send as" placeholder="Send as (optional), e.g. Tony Stark <tony@stark.com>" value={form.from_address} onChange={(x) => set("from_address", x.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={a.busy}>{a.busy && <Loader2 size={13} className="animate-spin" />} Save & test</button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      <Feedback message={a.message} />
    </Row>
  );
}

function UrlSection({ icon, title, section, configured, detail, hint, placeholder, onChanged }: {
  icon: ReactNode; title: string; section: "calendar" | "notifications"; configured: boolean; detail?: string;
  hint: string; placeholder: string; onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const a = useAction();
  return (
    <Row icon={icon} title={title} status={<Badge ok={configured}>{configured ? `Connected${detail ? ` ${detail}` : ""}` : "Not set"}</Badge>}>
      <p className="text-xs text-ink-faint">{hint}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api.setIntegrationUrl(section, url.trim());
            setUrl("");
            onChanged();
            return (await api.testIntegration(section)).message;
          });
        }}
      >
        <input className="input flex-1 font-mono text-xs" type="password" autoComplete="off" aria-label={`${title} URL`} placeholder={configured ? "Paste a new address to replace it" : placeholder} value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn-outline px-3 py-1.5 text-xs" disabled={a.busy || url.trim().length < 10}>Save & test</button>
        {configured && (
          <>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={a.busy} onClick={() => void a.run(async () => (await api.testIntegration(section)).message)}>Test</button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs hover:text-danger" onClick={() => void a.run(async () => { await api.removeIntegration(section); onChanged(); return "Disconnected."; })}>Disconnect</button>
          </>
        )}
      </form>
      <Feedback message={a.message} />
    </Row>
  );
}
