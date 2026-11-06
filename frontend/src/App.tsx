import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, ListChecks, Loader2 } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { useRoute } from "./hooks/useRoute";
import { api } from "./lib/api";
import type { ConversationSummary, SettingsResponse, User } from "./lib/types";
import { AuthScreen } from "./views/AuthScreen";
import { ChatView } from "./views/ChatView";
import { RoadmapView } from "./views/RoadmapView";
import { SettingsView } from "./views/SettingsView";

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

function Root() {
  const { state } = useAuth();
  if (state.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-void text-ink-faint">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (state.phase !== "authenticated") return <AuthScreen />;
  return <Shell user={state.user} />;
}

function Shell({ user }: { user: User }) {
  const { logout } = useAuth();
  const { route, navigate } = useRoute();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef(search);
  searchRef.current = search;

  const refresh = useCallback(async () => {
    try {
      setConversations(await api.listConversations(searchRef.current.trim() || undefined));
    } catch {
      /* surfaced elsewhere; keep last list */
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), search ? 200 : 0);
    return () => clearTimeout(t);
  }, [search, refresh]);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setSettings(null));
  }, []);

  useEffect(() => setSidebarOpen(false), [route]);

  const onDelete = async (c: ConversationSummary) => {
    if (!window.confirm(`Delete "${c.title}"? This permanently removes its messages.`)) return;
    await api.deleteConversation(c.id);
    if (route.view === "chat" && route.conversationId === c.id) navigate({ view: "chat", conversationId: null });
    void refresh();
  };

  const openSidebar = () => setSidebarOpen(true);

  return (
    <div className="flex h-full bg-void">
      <Sidebar
        conversations={conversations}
        loading={loadingList}
        route={route}
        search={search}
        onSearch={setSearch}
        onNavigate={navigate}
        onNewChat={() => navigate({ view: "chat", conversationId: null })}
        onRename={async (id, title) => {
          await api.updateConversation(id, { title });
          void refresh();
        }}
        onTogglePin={async (c) => {
          await api.updateConversation(c.id, { pinned: !c.pinned });
          void refresh();
        }}
        onDelete={onDelete}
        user={user}
        onLogout={() => void logout()}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="flex min-w-0 flex-1">
        {route.view === "chat" && (
          <ChatView
            conversationId={route.conversationId}
            user={user}
            settings={settings}
            onConversationCreated={(id) => navigate({ view: "chat", conversationId: id }, { replace: true })}
            onConversationsChanged={refresh}
            onOpenSidebar={openSidebar}
          />
        )}
        {route.view === "settings" && (
          <SettingsView user={user} settings={settings} onSettingsChanged={setSettings} onOpenSidebar={openSidebar} />
        )}
        {route.view === "memory" && (
          <RoadmapView
            title="Memory"
            icon={<Brain size={20} />}
            phase={3}
            onOpenSidebar={openSidebar}
            summary="Long-term memory you control. Nothing is remembered permanently unless you approve it."
            features={[
              "Preferences, personal details, projects and knowledge you approve",
              "Full-text search (SQLite FTS5) and relevant-context retrieval",
              "Edit, delete and view the change history of every memory",
              "Duplicate detection",
            ]}
          />
        )}
        {route.view === "tasks" && (
          <RoadmapView
            title="Tasks"
            icon={<ListChecks size={20} />}
            phase={7}
            onOpenSidebar={openSidebar}
            summary="A dashboard for multi-step work JARVIS plans and executes on your behalf."
            features={[
              "Execution plans broken into steps, with live progress",
              "Approval prompts for restricted and sensitive actions",
              "Retry, cancel and full execution history",
              "Tool activity log (Phase 5)",
            ]}
          />
        )}
      </main>
    </div>
  );
}
