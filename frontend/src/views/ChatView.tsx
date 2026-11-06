import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Menu, Sparkles, Volume2, VolumeX } from "lucide-react";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";
import { StatusPill } from "../components/StatusPill";
import { VoiceOrb, type OrbState } from "../components/VoiceOrb";
import { api } from "../lib/api";
import { greeting } from "../lib/format";
import type { Message, SettingsResponse, ToolExecution, User } from "../lib/types";
import { useVoice, type ReplySpeaker } from "../voice/useVoice";

interface Props {
  conversationId: string | null;
  user: User;
  settings: SettingsResponse | null;
  onConversationCreated: (id: string) => void;
  onConversationsChanged: () => void;
  onOpenSidebar: () => void;
  onOpenMemory: () => void;
}

const SUGGESTIONS = [
  "Help me plan my week",
  "Summarise what we discussed last time",
  "Draft a project brief for a new idea",
  "What can you help me with?",
];

export function ChatView({ conversationId, user, settings, onConversationCreated, onConversationsChanged, onOpenSidebar, onOpenMemory }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; review: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(conversationId);
  const createdHereRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useState("");
  const prefs = settings?.preferences;
  const voice = useVoice(prefs);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const assistantName = settings?.preferences.assistant_name || "JARVIS";
  const aiConfigured = settings?.server.ai_configured ?? false;

  // Load conversation when the route changes (but not when we just created it ourselves mid-stream).
  useEffect(() => {
    activeIdRef.current = conversationId;
    setError(null);
    setNotice(null);
    if (conversationId && createdHereRef.current === conversationId) {
      createdHereRef.current = null;
      return;
    }
    abortRef.current?.abort();
    if (!conversationId) {
      setMessages([]);
      setTitle("");
      setStreaming(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getConversation(conversationId)
      .then((c) => {
        if (cancelled) return;
        setMessages(c.messages);
        setTitle(c.title);
        stickToBottom.current = true;
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(
    async (text: string, viaVoice = false) => {
      setError(null);
      voiceRef.current.stopSpeaking(); // a new message interrupts any reply being read out
      let id = activeIdRef.current;
      let speaker: ReplySpeaker | null = null;
      let listenAfterReply = viaVoice && Boolean(prefsRef.current?.voice_conversation_mode);
      let paragraphBreak = false; // text after a tool call starts a new paragraph
      const updateStreaming = (fn: (last: Message) => Message) =>
        setMessages((m) => {
          const last = m[m.length - 1];
          if (!last || last.status !== "streaming") return m;
          return [...m.slice(0, -1), fn(last)];
        });
      const tempId = `temp-${Date.now()}`;
      const optimistic: Message = {
        id: tempId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        content: text,
        status: "complete",
        model: null,
        error: null,
        created_at: new Date().toISOString(),
        memory_ids: [],
      };
      setMessages((m) => [...m, optimistic]);
      setStreaming(true);
      stickToBottom.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        if (!id) {
          const created = await api.createConversation();
          id = created.id;
          activeIdRef.current = id;
          createdHereRef.current = id;
          onConversationCreated(id);
        }
        for await (const ev of api.sendMessage(id, text, controller.signal)) {
          if (activeIdRef.current !== id) break;
          switch (ev.event) {
            case "user_message":
              setMessages((m) => m.map((x) => (x.id === tempId ? ev.data : x)));
              break;
            case "conversation":
              setTitle(ev.data.title);
              onConversationsChanged();
              break;
            case "reply_start":
              setMessages((m) => [...m, ev.data]);
              if (ev.data.role === "assistant") {
                const conversationId = id;
                const listenWhenSpoken = listenAfterReply; // captured now: the flag is cleared below
                speaker = voiceRef.current.replySpeaker(() => {
                  // Conversation mode: once the spoken reply ends, listen for the next message.
                  if (listenWhenSpoken && activeIdRef.current === conversationId) listenAgain();
                });
                if (speaker) listenAfterReply = false; // handled when speech finishes
              }
              break;
            case "reset": {
              // A fallback model took over mid-stream (or a request is retried): drop the discarded text.
              voiceRef.current.stopSpeaking();
              speaker?.reset();
              const keep = ev.data.text ?? "";
              updateStreaming((last) => ({ ...last, content: keep }));
              paragraphBreak = false;
              break;
            }
            case "tool_start":
              paragraphBreak = true;
              updateStreaming((last) => ({
                ...last,
                tools: upsertTool(last.tools ?? [], {
                  id: `start-${ev.data.id}`,
                  tool_use_id: ev.data.id,
                  tool_name: ev.data.name,
                  status: "preparing",
                  summary: "",
                  permission_level: "automatic",
                  conversation_id: id,
                  message_id: last.id,
                  input: null,
                  output: null,
                  error: null,
                  duration_ms: null,
                  created_at: new Date().toISOString(),
                  finished_at: null,
                }),
              }));
              break;
            case "tool_call":
            case "tool_result":
              paragraphBreak = true;
              updateStreaming((last) => ({ ...last, tools: upsertTool(last.tools ?? [], ev.data) }));
              break;
            case "delta": {
              speaker?.push(ev.data.text);
              const brk = paragraphBreak;
              paragraphBreak = false;
              updateStreaming((last) => ({
                ...last,
                content: last.content + (brk && last.content.trim() ? "\n\n" : "") + ev.data.text,
              }));
              break;
            }
            case "reply_done":
              setMessages((m) => m.map((x) => (x.id === ev.data.id ? ev.data : x)));
              if (ev.data.status === "complete") speaker?.finish();
              else {
                voiceRef.current.stopSpeaking(); // refused/failed/stopped: don't keep reading
                listenAfterReply = false;
              }
              break;
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
          setMessages((m) => m.filter((x) => x.id !== tempId));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (activeIdRef.current === id) setStreaming(false);
        onConversationsChanged();
        if (listenAfterReply && activeIdRef.current === id) listenAgain();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onConversationCreated, onConversationsChanged],
  );

  const onVoiceFinal = useCallback(
    (text: string) => {
      if (prefsRef.current?.voice_auto_send ?? true) void send(text, true);
      else setDraft((d) => (d ? `${d} ${text}` : text));
    },
    [send],
  );

  function listenAgain() {
    setTimeout(() => {
      if (!voiceRef.current.listening && voiceRef.current.inputEnabled) voiceRef.current.startListening(onVoiceFinalRef.current);
    }, 300);
  }
  const onVoiceFinalRef = useRef(onVoiceFinal);
  onVoiceFinalRef.current = onVoiceFinal;

  const toggleListening = useCallback(() => {
    if (voice.listening) voice.stopListening();
    else voice.startListening(onVoiceFinal);
  }, [voice, onVoiceFinal]);

  // Esc: cancel listening, or stop speaking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (voiceRef.current.listening) voiceRef.current.cancelListening();
      else if (voiceRef.current.speaking) voiceRef.current.stopSpeaking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving a conversation stops listening and speech.
  useEffect(() => {
    voiceRef.current.cancelListening();
    voiceRef.current.stopSpeaking();
  }, [conversationId]);

  const stop = useCallback(async () => {
    const id = activeIdRef.current;
    const controller = abortRef.current;
    if (!id) return;
    voiceRef.current.stopSpeaking();
    try {
      await api.cancelGeneration(id);
    } catch {
      /* fall through to abort */
    }
    // If the server doesn't close the stream promptly, drop the connection; the backend persists partial output either way.
    setTimeout(() => {
      if (abortRef.current === controller) controller?.abort();
    }, 3000);
  }, []);

  async function suggestMemories() {
    if (!conversationId) return;
    setSuggesting(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api.suggestMemories(conversationId);
      const n = res.created.length;
      const skipped = res.skipped_duplicates ? ` (${res.skipped_duplicates} skipped as duplicates or unsafe)` : "";
      setNotice(
        n
          ? { text: `${n} memory suggestion${n === 1 ? "" : "s"} ready for your review${skipped}.`, review: true }
          : { text: `Nothing new worth remembering in this conversation${skipped}.`, review: false },
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  const lastMessage = messages[messages.length - 1];
  const liveTools = streaming && lastMessage?.status === "streaming" ? lastMessage.tools ?? [] : [];
  const activeTool =
    liveTools.find((t) => t.status === "pending_approval") ??
    liveTools.find((t) => t.status === "running" || t.status === "preparing" || t.status === "approved") ??
    null;
  const orbState: OrbState = voice.listening
    ? "listening"
    : voice.speaking
      ? "speaking"
      : !aiConfigured
    ? "offline"
    : streaming
      ? lastMessage?.status === "streaming" && lastMessage.content
        ? "speaking"
        : "thinking"
      : "idle";
  const empty = !loading && messages.length === 0;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col" aria-label="Conversation">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button className="btn-ghost p-1.5 md:hidden" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Menu size={18} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="conversation-title">
          {conversationId ? title || " " : "New conversation"}
        </h2>
        {conversationId && aiConfigured && (
          <button
            className="btn-ghost px-2.5 py-1 text-xs"
            onClick={suggestMemories}
            disabled={suggesting || streaming || messages.length === 0}
            title="Ask Claude to propose things worth remembering from this conversation. Nothing is saved until you approve it."
          >
            {suggesting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} className="text-arc" />}
            <span className="hidden sm:inline">Suggest memories</span>
          </button>
        )}
        {voice.speaking && (
          <button className="btn-ghost px-2.5 py-1 text-xs text-arc" onClick={voice.stopSpeaking} title="Stop speaking (Esc)">
            <VolumeX size={13} /> <span className="hidden sm:inline">Stop speaking</span>
          </button>
        )}
        {voice.outputSupported && prefs?.speak_responses && (
          <button
            className="btn-ghost p-1.5"
            onClick={voice.toggleMute}
            aria-pressed={voice.muted}
            aria-label={voice.muted ? "Unmute spoken replies" : "Mute spoken replies"}
            title={voice.muted ? "Spoken replies muted" : "Spoken replies on"}
            data-testid="mute-toggle"
          >
            {voice.muted ? <VolumeX size={16} className="text-ink-faint" /> : <Volume2 size={16} className="text-arc" />}
          </button>
        )}
        <StatusPill streaming={streaming} settings={settings} activeTool={activeTool} />
      </header>
      {voice.listening && (
        <div className="flex items-center justify-center gap-3 border-b border-arc/20 bg-arc/5 py-2" role="status" aria-live="polite" data-testid="listening-banner">
          <VoiceOrb state="listening" level={voice.level} size={32} />
          <span className="text-xs tracking-wider text-arc">LISTENING ({voice.language})</span>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="hud-grid flex-1 overflow-y-auto" data-testid="message-scroll">
        {loading && (
          <div className="flex h-full items-center justify-center text-ink-faint">
            <Loader2 className="animate-spin" size={20} />
          </div>
        )}
        {empty && (
          <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
            <VoiceOrb state={orbState === "thinking" ? "idle" : orbState} level={voice.level} size={150} showLabel />
            <h1 className="mt-8 text-2xl font-light tracking-tight text-ink">
              {greeting()}, <span className="font-medium">{user.display_name || user.username}</span>.
            </h1>
            <p className="mt-2 max-w-md text-sm text-ink-dim">
              {aiConfigured
                ? `${assistantName} is online. How can I help?`
                : "Claude isn't connected. Add ANTHROPIC_API_KEY to your .env file and restart the backend."}
            </p>
            <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)} className="card px-4 py-3 text-left text-sm text-ink-dim transition-colors hover:border-arc/40 hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {!loading && messages.length > 0 && (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8" data-testid="message-list">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} assistantName={assistantName} onReadAloud={voice.outputSupported ? voice.readAloud : undefined} />
            ))}
            {streaming && lastMessage?.role === "user" && (
              <div className="flex items-center gap-3 pl-1">
                <VoiceOrb state="thinking" size={28} />
                <span className="text-xs text-ink-faint">Thinking…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="mx-auto mb-2 w-full max-w-3xl px-4">
          <div className="flex items-center gap-3 rounded-lg border border-arc/30 bg-arc/10 px-3 py-2 text-sm text-ink">
            <Sparkles size={14} className="shrink-0 text-arc" />
            <span className="flex-1">{notice.text}</span>
            {notice.review && (
              <button className="text-arc underline underline-offset-2" onClick={onOpenMemory}>
                Review
              </button>
            )}
            <button className="text-ink-faint hover:text-ink" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="mx-auto mb-2 w-full max-w-3xl px-4">
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
        </div>
      )}
      {voice.error && (
        <div role="alert" className="mx-auto mb-2 w-full max-w-3xl px-4" data-testid="voice-error">
          <div className="flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
            <span className="flex-1">{voice.error}</span>
            <button onClick={voice.clearError} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        voice={{
          available: voice.inputEnabled,
          unavailableReason: !voice.inputSupported
            ? voice.inputUnsupportedReason
            : "Voice input is turned off. Turn it on in Settings.",
          listening: voice.listening,
          transcript: voice.transcript,
          onToggle: toggleListening,
        }}
        onSend={(t) => void send(t)}
        onStop={stop}
        streaming={streaming}
        sendOnEnter={settings?.preferences.send_on_enter ?? true}
        assistantName={assistantName}
      />
    </section>
  );
}

/** Insert or update a tool execution, matching streaming placeholders by tool_use_id. */
export function upsertTool(list: ToolExecution[], next: ToolExecution): ToolExecution[] {
  const i = list.findIndex((t) => t.id === next.id || (next.tool_use_id != null && t.tool_use_id === next.tool_use_id));
  if (i === -1) return [...list, next];
  const copy = list.slice();
  copy[i] = { ...copy[i], ...next };
  return copy;
}
