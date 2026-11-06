import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, tokenStore } from "../lib/api";
import type { AuthStatus, LoginResponse, User } from "../lib/types";

type AuthState =
  | { phase: "loading" }
  | { phase: "offline"; error: string }
  | { phase: "anonymous"; status: AuthStatus }
  | { phase: "authenticated"; user: User };

interface AuthContextValue {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  setup: (body: { username: string; password: string; display_name?: string; setup_token?: string }) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: "loading" });

  const resolve = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      if (tokenStore.get()) {
        try {
          setState({ phase: "authenticated", user: await api.me() });
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 401) throw err;
        }
      }
      setState({ phase: "anonymous", status: await api.authStatus() });
    } catch (err) {
      setState({ phase: "offline", error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void resolve();
    return tokenStore.onUnauthorized(() => void resolve());
  }, [resolve]);

  const accept = (res: LoginResponse) => {
    tokenStore.set(res.token);
    setState({ phase: "authenticated", user: res.user });
  };

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      login: async (u, p) => accept(await api.login(u, p)),
      setup: async (body) => accept(await api.setup(body)),
      logout: async () => {
        try {
          await api.logout();
        } catch {
          /* token may already be invalid */
        }
        tokenStore.set(null);
        await resolve();
      },
      setUser: (user) => setState({ phase: "authenticated", user }),
      retry: () => void resolve(),
    }),
    [state, resolve],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
