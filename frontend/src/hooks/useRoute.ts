import { useCallback, useEffect, useState } from "react";

export type Route =
  | { view: "chat"; conversationId: string | null }
  | { view: "memory" }
  | { view: "tasks" }
  | { view: "tools" }
  | { view: "settings" };

export function parseRoute(path: string): Route {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  switch (parts[0]) {
    case "c":
      return { view: "chat", conversationId: parts[1] || null };
    case "memory":
      return { view: "memory" };
    case "tasks":
      return { view: "tasks" };
    case "tools":
      return { view: "tools" };
    case "settings":
      return { view: "settings" };
    default:
      return { view: "chat", conversationId: null };
  }
}

export function routePath(route: Route): string {
  if (route.view === "chat") return route.conversationId ? `/c/${route.conversationId}` : "/";
  return `/${route.view}`;
}

/** Minimal History-API router; avoids a routing dependency for four views. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route, { replace = false } = {}) => {
    const path = routePath(next);
    if (path !== window.location.pathname) {
      if (replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
