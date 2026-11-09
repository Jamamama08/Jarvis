import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { useRoute } from "./hooks/useRoute";
import { api } from "./lib/api";
import type { ConversationSummary, SettingsResponse, User } from "./lib/types";
import { AuthScreen } from "./views/AuthScreen";
import { ChatView } from "./views/ChatView";
import { MemoryView } from "./views/MemoryView";
import { TasksView } from "./views/TasksView";
import { ToolsView } from "./views/ToolsView";
import { SettingsView } from "./views/SettingsView";
import { LearnView } from "./views/LearnView";

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
  const [tasksNeedingApproval, setTasksNeedingApproval] = useState(0);

  // Background tasks may need approval while you're elsewhere in the app: check periodically.
  useEffect(() => {
    let stop = false;
    const check = () =>
      api
        .listAgentTasks()
        .then((ts) => !stop && setTasksNeedingApproval(ts.filter((t) => t.status === "waiting_approval").length))
        .catch(() => {});
    void check();
    const t = setInterval(check, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
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
        tasksNeedingApproval={tasksNeedingApproval}
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
            onOpenMemory={() => navigate({ view: "memory" })}
          />
        )}
        {route.view === "settings" && (
          <SettingsView user={user} settings={settings} onSettingsChanged={setSettings} onOpenSidebar={openSidebar} />
        )}
        {route.view === "memory" && (
          <MemoryView onOpenSidebar={openSidebar} onOpenConversation={(id) => navigate({ view: "chat", conversationId: id })} />
        )}
        {route.view === "tasks" && (
          <TasksView onOpenSidebar={openSidebar} onOpenConversation={(id) => navigate({ view: "chat", conversationId: id })} />
        )}
        {route.view === "learn" && (
          <LearnView
            lessonId={route.lessonId}
            settings={settings}
            onOpenSidebar={openSidebar}
            onOpenLesson={(id) => navigate({ view: "learn", lessonId: id })}
          />
        )}
        {route.view === "tools" && <ToolsView settings={settings} onSettingsChanged={setSettings} onOpenSidebar={openSidebar} />}
      </main>
    </div>
  );
}
