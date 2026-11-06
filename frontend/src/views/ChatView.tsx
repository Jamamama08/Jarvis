import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";
import { StatusPill } from "../components/StatusPill";
import { VoiceOrb, type OrbState } from "../components/VoiceOrb";
import { api } from "../lib/api";
import { greeting } from "../lib/format";
import type { Message, SettingsResponse, User } from "../lib/types";

interface Props {
  conversationId: string | null;
  user: User;
  settings: SettingsResponse | null;
  onConversationCreated: (id: string) => void;
  onConversationsChanged: () => void;
  onOpenSidebar: () => void;
}

const SUGGESTIONS = [
  "Help me plan my week",
  "Summarise what we discussed last time",
  "Draft a project brief for a new idea",
  "What can you help me with?",
];

export function ChatView({ conversationId, user, settings, onConversationCreated, onConversationsChanged, onOpenSidebar }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(conversationId);
  const createdHereRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const assistantName = settings?.preferences.assistant_name || "JARVIS";
  const aiConfigured = settings?.server.ai_configured ?? false;

  // Load conversation when the route changes (but not when we just created it ourselves mid-stream).
  useEffect(() => {
    activeIdRef.current = conversationId;
    setError(null);
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
    async (text: string) => {
      setError(null);
      let id = activeIdRef.current;
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
              break;
            case "delta":
              setMessages((m) => {
                const last = m[m.length - 1];
                if (!last || last.status !== "streaming") return m;
                return [...m.slice(0, -1), { ...last, content: last.content + ev.data.text }];
              });
              break;
            case "reply_done":
              setMessages((m) => m.map((x) => (x.id === ev.data.id ? ev.data : x)));
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
      }
    },
    [onConversationCreated, onConversationsChanged],
  );

  const stop = useCallback(async () => {
    const id = activeIdRef.current;
    const controller = abortRef.current;
    if (!id) return;
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

  const lastMessage = messages[messages.length - 1];
  const orbState: OrbState = !aiConfigured
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
        <StatusPill streaming={streaming} settings={settings} />
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="hud-grid flex-1 overflow-y-auto" data-testid="message-scroll">
        {loading && (
          <div className="flex h-full items-center justify-center text-ink-faint">
            <Loader2 className="animate-spin" size={20} />
          </div>
        )}
        {empty && (
          <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
            <VoiceOrb state={orbState === "offline" ? "offline" : "idle"} size={150} showLabel />
            <h1 className="mt-8 text-2xl font-light tracking-tight text-ink">
              {greeting()}, <span className="font-medium">{user.display_name || user.username}</span>.
            </h1>
            <p className="mt-2 max-w-md text-sm text-ink-dim">
              {aiConfigured
                ? `${assistantName} is online. How can I help?`
                : "Conversations are saved locally. Claude replies are enabled in Phase 2."}
            </p>
            <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="card px-4 py-3 text-left text-sm text-ink-dim transition-colors hover:border-arc/40 hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {!loading && messages.length > 0 && (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8" data-testid="message-list">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} assistantName={assistantName} />
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

      {error && (
        <div role="alert" className="mx-auto mb-2 w-full max-w-3xl px-4">
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
        </div>
      )}
      <Composer
        onSend={send}
        onStop={stop}
        streaming={streaming}
        sendOnEnter={settings?.preferences.send_on_enter ?? true}
        assistantName={assistantName}
      />
    </section>
  );
}
