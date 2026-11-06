import { greeting, relativeTime } from "./format";
import { parseRoute, routePath } from "../hooks/useRoute";

describe("format", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("relativeTime", () => {
    expect(relativeTime("2026-11-06T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-11-06T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-11-06T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2026-11-03T12:00:00Z", now)).toBe("3d ago");
  });
  it("greeting", () => {
    expect(greeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
  });
});

describe("routes", () => {
  it("round-trips", () => {
    for (const path of ["/", "/c/abc123", "/memory", "/tasks", "/settings"]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(parseRoute("/unknown")).toEqual({ view: "chat", conversationId: null });
  });
});
