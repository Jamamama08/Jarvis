import { readSSE } from "./sse";
import type {
  AuthStatus,
  Backup,
  ConversationDetail,
  ConversationSummary,
  LoginResponse,
  Memory,
  MemoryHistoryEntry,
  MemoryInput,
  MemoryList,
  Project,
  AgentTask,
  AgentTaskDetail,
  AutomationStatus,
  EmailSettings,
  IntegrationsStatus,
  DesktopApp,
  Task,
  ToolExecution,
  ToolsOverview,
  Preferences,
  LessonDetail,
  LessonLevel,
  LessonSummary,
  SettingsResponse,
  StreamEvent,
  UsageSummary,
  User,
} from "./types";

const TOKEN_KEY = "jarvis.token";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Same-origin in the browser (Vite proxy or FastAPI-served build); explicit URL in the desktop app. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? (isTauri() ? "http://127.0.0.1:8765" : "");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token: string | null) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
  onUnauthorized: (fn: Listener) => {
    unauthorizedListeners.add(fn);
    return () => {
      unauthorizedListeners.delete(fn);
    };
  },
};

async function errorFrom(res: Response): Promise<ApiError> {
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail) && body.detail[0]?.msg) message = body.detail[0].msg;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(res.status, message);
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...init, headers });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "Cannot reach the JARVIS backend. Is it running?");
  }
  if (res.status === 401 && token && !path.startsWith("/api/auth/login")) {
    tokenStore.set(null);
    unauthorizedListeners.forEach((fn) => fn());
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawRequest(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health"),

  authStatus: () => request<AuthStatus>("/api/auth/status"),
  setup: (body: { username: string; password: string; display_name?: string; setup_token?: string }) =>
    request<LoginResponse>("/api/auth/setup", json("POST", body)),
  login: (username: string, password: string) =>
    request<LoginResponse>("/api/auth/login", json("POST", { username, password })),
  logout: () => request<void>("/api/auth/logout", json("POST")),
  me: () => request<User>("/api/auth/me"),
  updateProfile: (display_name: string) => request<User>("/api/auth/me", json("PATCH", { display_name })),
  changePassword: (current_password: string, new_password: string) =>
    request<void>("/api/auth/password", json("POST", { current_password, new_password })),

  listConversations: (q?: string) =>
    request<ConversationSummary[]>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createConversation: (title?: string) => request<ConversationDetail>("/api/conversations", json("POST", { title })),
  getConversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}`),
  updateConversation: (id: string, body: { title?: string; pinned?: boolean }) =>
    request<ConversationSummary>(`/api/conversations/${id}`, json("PATCH", body)),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, json("DELETE")),
  cancelGeneration: (id: string) => request<{ cancelled: boolean }>(`/api/conversations/${id}/cancel`, json("POST")),

  async *sendMessage(id: string, content: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await rawRequest(`/api/conversations/${id}/messages`, { ...json("POST", { content }), signal });
    if (!res.body) throw new ApiError(0, "Streaming is not supported by this browser");
    for await (const frame of readSSE(res.body)) {
      yield { event: frame.event, data: JSON.parse(frame.data) } as StreamEvent;
    }
  },

  getSettings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (body: Partial<Preferences>) => request<Preferences>("/api/settings", json("PATCH", body)),
  listMemories: (params: { q?: string; category?: string; state?: "approved" | "pending" | "all"; project_id?: string }) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<MemoryList>(`/api/memories?${qs}`);
  },
  createMemory: (body: MemoryInput) => request<Memory>("/api/memories", json("POST", body)),
  updateMemory: (id: string, body: Partial<MemoryInput>) => request<Memory>(`/api/memories/${id}`, json("PATCH", body)),
  approveMemory: (id: string) => request<Memory>(`/api/memories/${id}/approve`, json("POST")),
  rejectMemory: (id: string) => request<void>(`/api/memories/${id}/reject`, json("POST")),
  deleteMemory: (id: string, purgeHistory = false) =>
    request<void>(`/api/memories/${id}${purgeHistory ? "?purge_history=true" : ""}`, json("DELETE")),
  memoryHistory: (id: string) => request<MemoryHistoryEntry[]>(`/api/memories/${id}/history`),
  recentMemoryHistory: () => request<MemoryHistoryEntry[]>("/api/memories/history"),
  suggestMemories: (conversationId: string) =>
    request<{ created: Memory[]; skipped_duplicates: number }>(`/api/conversations/${conversationId}/suggest-memories`, json("POST")),
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (body: { name: string; description?: string }) => request<Project>("/api/projects", json("POST", body)),
  updateProject: (id: string, body: Partial<Pick<Project, "name" | "description" | "status" | "progress_notes">>) =>
    request<Project>(`/api/projects/${id}`, json("PATCH", body)),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, json("DELETE")),

  toolsOverview: () => request<ToolsOverview>("/api/tools"),
  setToolPolicy: (scope: string, decision: "allow" | "ask" | "deny" | null) =>
    request<void>("/api/tools/policies", json("PUT", { scope, decision })),
  decideTool: (executionId: string, approve: boolean, remember = false) =>
    request<void>(`/api/tools/executions/${executionId}/decision`, json("POST", { approve, remember })),
  toolExecutions: (params: { tool?: string; status?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<ToolExecution[]>(`/api/tools/executions?${qs}`);
  },
  integrations: () => request<IntegrationsStatus>("/api/integrations"),
  setAnthropicKey: (api_key: string) => request<void>("/api/integrations/anthropic", json("PUT", { api_key })),
  removeAnthropicKey: () => request<void>("/api/integrations/anthropic", json("DELETE")),
  setEmail: (body: EmailSettings) => request<void>("/api/integrations/email", json("PUT", body)),
  setIntegrationUrl: (section: "calendar" | "notifications", url: string) => request<void>(`/api/integrations/${section}`, json("PUT", { url })),
  testIntegration: (section: "email" | "calendar" | "notifications") => request<{ message: string }>(`/api/integrations/${section}/test`, json("POST")),
  removeIntegration: (section: "email" | "calendar" | "notifications") => request<void>(`/api/integrations/${section}`, json("DELETE")),
  browserInstalled: () => request<{ installed: boolean }>("/api/browser/installed"),
  installBrowser: () => request<{ installed: boolean; log: string }>("/api/browser/install", json("POST")),
  automationStatus: () => request<AutomationStatus>("/api/automation/status"),
  closeBrowser: () => request<void>("/api/browser/close", json("POST")),
  listDesktopApps: () => request<DesktopApp[]>("/api/desktop/apps"),
  addDesktopApp: (body: Omit<DesktopApp, "id">) => request<DesktopApp>("/api/desktop/apps", json("POST", body)),
  removeDesktopApp: (id: string) => request<void>(`/api/desktop/apps/${id}`, json("DELETE")),
  listAgentTasks: () => request<AgentTask[]>("/api/agent-tasks"),
  agentTask: (id: string) => request<AgentTaskDetail>(`/api/agent-tasks/${id}`),
  startAgentTask: (goal: string) => request<AgentTask>("/api/agent-tasks", json("POST", { goal })),
  cancelAgentTask: (id: string) => request<void>(`/api/agent-tasks/${id}/cancel`, json("POST")),
  rerunAgentTask: (id: string) => request<AgentTask>(`/api/agent-tasks/${id}/rerun`, json("POST")),
  deleteAgentTask: (id: string) => request<void>(`/api/agent-tasks/${id}`, json("DELETE")),
  listTasks: (state: "open" | "done" | "all" = "all") => request<Task[]>(`/api/tasks?state=${state}`),
  createTask: (title: string, description = "") => request<Task>("/api/tasks", json("POST", { title, description })),
  updateTask: (id: string, body: Partial<Pick<Task, "title" | "description">> & { status?: "pending" | "completed" | "cancelled" }) =>
    request<Task>(`/api/tasks/${id}`, json("PATCH", body)),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, json("DELETE")),

  listLessons: () => request<LessonSummary[]>("/api/lessons"),
  lesson: (id: string) => request<LessonDetail>(`/api/lessons/${id}`),
  uploadLesson: (file: File, opts: { title?: string; level?: LessonLevel } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (opts.title) form.append("title", opts.title);
    form.append("level", opts.level ?? "standard");
    return request<LessonDetail>("/api/lessons", { method: "POST", body: form });
  },
  updateLesson: (
    id: string,
    body: { title?: string; position?: number; answer?: [number, number]; completed?: boolean; reset_progress?: boolean },
  ) => request<LessonSummary>(`/api/lessons/${id}`, json("PATCH", body)),
  retryLesson: (id: string, body: { level?: LessonLevel; rebuild?: boolean } = {}) =>
    request<LessonSummary>(`/api/lessons/${id}/retry`, json("POST", body)),
  deleteLesson: (id: string) => request<void>(`/api/lessons/${id}`, json("DELETE")),
  askLesson: (id: string, slide: number, question: string) =>
    request<{ answer: string }>(`/api/lessons/${id}/ask`, json("POST", { slide, question })),
  /** Slide pictures need the auth header, so they're fetched as blobs (caller revokes the URL). */
  lessonImage: async (id: string, slide: number) =>
    URL.createObjectURL(await (await rawRequest(`/api/lessons/${id}/slides/${slide}/image`)).blob()),
  usage: (days = 30) => request<UsageSummary>(`/api/usage?days=${days}`),
  listBackups: () => request<Backup[]>("/api/system/backups"),
  createBackup: () => request<Backup>("/api/system/backups", json("POST")),
};
