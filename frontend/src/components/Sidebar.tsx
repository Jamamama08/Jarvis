import { useState } from "react";
import {
  Brain,
  Check,
  GraduationCap,
  ListChecks,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Route } from "../hooks/useRoute";
import type { ConversationSummary, User } from "../lib/types";
import { relativeTime } from "../lib/format";

interface Props {
  conversations: ConversationSummary[];
  loading: boolean;
  route: Route;
  search: string;
  onSearch: (q: string) => void;
  onNavigate: (route: Route) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (c: ConversationSummary) => void;
  onDelete: (c: ConversationSummary) => void;
  user: User;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
  /** Autonomous tasks waiting for the user's approval. */
  tasksNeedingApproval?: number;
}

export function Sidebar(props: Props) {
  const { conversations, route, onNavigate, open, onClose } = props;
  const activeId = route.view === "chat" ? route.conversationId : null;
  const pinned = conversations.filter((c) => c.pinned);
  const recent = conversations.filter((c) => !c.pinned);

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-line bg-base transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Sidebar"
      >
        <div className="flex items-center gap-3 px-4 pt-4 pb-3">
          <img src="/jarvis.svg" alt="" className="h-8 w-8" />
          <div className="flex-1">
            <div className="text-sm font-semibold tracking-[0.3em]">JARVIS</div>
            <div className="text-[11px] text-ink-faint">Personal assistant</div>
          </div>
          <button className="btn-ghost p-1.5 md:hidden" onClick={onClose} aria-label="Close sidebar">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 px-3">
          <button className="btn-outline w-full justify-start" onClick={props.onNewChat}>
            <Plus size={16} className="text-arc" /> New conversation
          </button>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
            <input
              className="input pl-8"
              placeholder="Search conversations"
              value={props.search}
              onChange={(e) => props.onSearch(e.target.value)}
              aria-label="Search conversations"
            />
          </div>
        </div>

        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
          {props.loading && conversations.length === 0 && <SkeletonList />}
          {!props.loading && conversations.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-faint">
              {props.search ? "No conversations match your search." : "No conversations yet."}
            </p>
          )}
          {pinned.length > 0 && <Section title="Pinned" items={pinned} activeId={activeId} {...props} />}
          {recent.length > 0 && <Section title="Recent" items={recent} activeId={activeId} {...props} />}
        </nav>

        <div className="border-t border-line p-2">
          <NavItem icon={<GraduationCap size={16} />} label="Learn" active={route.view === "learn"} onClick={() => onNavigate({ view: "learn", lessonId: null })} />
          <NavItem icon={<Brain size={16} />} label="Memory" active={route.view === "memory"} onClick={() => onNavigate({ view: "memory" })} />
          <NavItem icon={<ListChecks size={16} />} label="Tasks" active={route.view === "tasks"} onClick={() => onNavigate({ view: "tasks" })} badge={props.tasksNeedingApproval} />
          <NavItem icon={<Wrench size={16} />} label="Tools" active={route.view === "tools"} onClick={() => onNavigate({ view: "tools" })} />
          <NavItem icon={<Settings size={16} />} label="Settings" active={route.view === "settings"} onClick={() => onNavigate({ view: "settings" })} />
          <div className="mt-2 flex items-center gap-2 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-arc/15 text-xs font-semibold text-arc">
              {(props.user.display_name || props.user.username).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{props.user.display_name}</div>
              <div className="truncate text-[11px] text-ink-faint">@{props.user.username}</div>
            </div>
            <button className="btn-ghost p-1.5" onClick={props.onLogout} title="Sign out" aria-label="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Section({ title, items, activeId, ...props }: Props & { title: string; items: ConversationSummary[]; activeId: string | null }) {
  return (
    <div className="mb-2">
      <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-ink-faint uppercase">{title}</div>
      <ul className="space-y-0.5">
        {items.map((c) => (
          <ConversationItem key={c.id} c={c} active={c.id === activeId} {...props} />
        ))}
      </ul>
    </div>
  );
}

function ConversationItem({ c, active, onNavigate, onRename, onTogglePin, onDelete }: Props & { c: ConversationSummary; active: boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);

  if (editing) {
    return (
      <li>
        <form
          className="flex items-center gap-1 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) onRename(c.id, title.trim());
            setEditing(false);
          }}
        >
          <input className="input py-1.5" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onBlur={() => setEditing(false)} aria-label="Conversation title" onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <button type="submit" className="btn-ghost p-1.5" aria-label="Save title" onMouseDown={(e) => e.preventDefault()}>
            <Check size={14} />
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        onClick={() => onNavigate({ view: "chat", conversationId: c.id })}
        className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
          active ? "bg-raised text-ink" : "text-ink-dim hover:bg-raised/60 hover:text-ink"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <MessageSquare size={14} className={`mt-0.5 shrink-0 ${active ? "text-arc" : "text-ink-faint"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{c.title}</span>
          <span className="block truncate text-[11px] text-ink-faint">{relativeTime(c.updated_at)}</span>
        </span>
      </button>
      <button
        className={`absolute top-1.5 right-1.5 rounded-md p-1 text-ink-faint hover:bg-panel hover:text-ink ${menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        onClick={() => setMenu((m) => !m)}
        aria-label={`Actions for ${c.title}`}
        aria-expanded={menu}
      >
        <MoreHorizontal size={15} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden />
          <div className="card absolute top-8 right-1 z-20 w-40 p-1 shadow-xl" role="menu">
            <MenuItem icon={<Pencil size={14} />} label="Rename" onClick={() => { setMenu(false); setTitle(c.title); setEditing(true); }} />
            <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} label={c.pinned ? "Unpin" : "Pin"} onClick={() => { setMenu(false); onTogglePin(c); }} />
            <MenuItem icon={<Trash2 size={14} />} label="Delete" danger onClick={() => { setMenu(false); onDelete(c); }} />
          </div>
        </>
      )}
    </li>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-raised ${danger ? "text-danger" : "text-ink-dim hover:text-ink"}`}>
      {icon}
      {label}
    </button>
  );
}

function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-raised text-ink" : "text-ink-dim hover:bg-raised/60 hover:text-ink"
      }`}
      aria-current={active ? "page" : undefined}
    >
      <span className={active ? "text-arc" : ""}>{icon}</span>
      {label}
      {badge ? (
        <span className="ml-auto rounded-full bg-warn/20 px-1.5 text-[11px] text-warn" data-testid="tasks-badge" title="Tasks waiting for your approval">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2 px-3 py-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-raised/60" />
      ))}
    </div>
  );
}
