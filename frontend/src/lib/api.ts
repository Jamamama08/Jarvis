import { readSSE } from "./sse";
import type {
  AuthStatus,
  Backup,
  ConversationDetail,
  ConversationSummary,
  LoginResponse,
  Preferences,
  SettingsResponse,
  StreamEvent,
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
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
  listBackups: () => request<Backup[]>("/api/system/backups"),
  createBackup: () => request<Backup>("/api/system/backups", json("POST")),
};
