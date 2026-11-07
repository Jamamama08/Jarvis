import { useState, type FormEvent } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { VoiceOrb } from "../components/VoiceOrb";
import { useAuth } from "../hooks/useAuth";

export function AuthScreen() {
  const { state, login, setup, retry } = useAuth();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.phase === "offline") {
    return (
      <Frame>
        <VoiceOrb state="offline" size={120} />
        <h1 className="mt-6 text-lg font-semibold">Connecting to JARVIS…</h1>
        <p className="mt-2 max-w-sm text-center text-sm text-ink-dim">{state.error}</p>
        <p className="mt-1 max-w-sm text-center text-xs text-ink-faint">
          Retrying automatically. If this persists, start the backend (<code className="font-mono">scripts/dev.sh</code> or <code className="font-mono">scripts/start.sh</code>).
        </p>
        <button className="btn-outline mt-6" onClick={retry}>
          <RefreshCw size={15} /> Retry
        </button>
      </Frame>
    );
  }
  if (state.phase !== "anonymous") return null;

  const isSetup = state.status.setup_required;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (isSetup && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (isSetup) {
        await setup({
          username: username.trim(),
          password,
          display_name: displayName.trim(),
          setup_token: setupToken || undefined,
        });
      } else {
        await login(username.trim(), password);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <VoiceOrb state="idle" size={112} />
      <h1 className="mt-6 text-2xl font-semibold tracking-[0.3em]">JARVIS</h1>
      <p className="mt-2 text-sm text-ink-dim">
        {isSetup ? "First-run setup — create your owner account." : "Welcome back. Please sign in."}
      </p>

      <form onSubmit={submit} className="card mt-8 w-full max-w-sm space-y-4 p-6" aria-label={isSetup ? "Create account" : "Sign in"}>
        <Field label="Username" htmlFor="username">
          <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        {isSetup && (
          <Field label="Your name" htmlFor="display-name">
            <input id="display-name" className="input" placeholder="How should JARVIS address you?" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        )}
        <Field label="Password" htmlFor="password">
          <input id="password" type="password" className="input" autoComplete={isSetup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {isSetup && (
          <Field label="Confirm password" htmlFor="confirm">
            <input id="confirm" type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        )}
        {isSetup && state.status.setup_token_required && (
          <Field label="Setup token" htmlFor="setup-token">
            <input id="setup-token" className="input font-mono" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy && <Loader2 size={15} className="animate-spin" />}
          {isSetup ? "Create account" : "Sign in"}
        </button>
      </form>
      <p className="mt-6 flex items-center gap-1.5 text-xs text-ink-faint">
        <ShieldCheck size={13} /> Credentials are stored locally and hashed with scrypt.
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="hud-grid flex min-h-full flex-col items-center justify-center px-4 py-12">{children}</main>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
