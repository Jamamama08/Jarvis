import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E runs the real backend (fresh temp databases) serving the production build in ./dist:
 *  - "offline": no API key, so the "Claude not connected" path.
 *  - "claude":  API key set and ANTHROPIC_BASE_URL pointed at e2e/mock-anthropic.mjs, a local
 *               stand-in for the Messages streaming API (no network, no cost).
 */
const OFFLINE_PORT = 8799;
const CLAUDE_PORT = 8797;
const MOCK_PORT = 8798;
const python = process.platform === "win32" ? "..\\backend\\.venv\\Scripts\\python.exe" : "../backend/.venv/bin/python";
const dist = join(process.cwd(), "dist");
const backend = (port: number, extra: Record<string, string> = {}) => ({
  command: `${python} -m app.main`,
  cwd: "../backend",
  url: `http://127.0.0.1:${port}/api/health`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: {
    JARVIS_PORT: String(port),
    JARVIS_DATA_DIR: mkdtempSync(join(tmpdir(), "jarvis-e2e-")),
    JARVIS_FRONTEND_DIST: dist,
    ANTHROPIC_API_KEY: "",
    ...extra,
  },
});

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { trace: "off", ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } },
  projects: [
    { name: "offline", testMatch: "app.spec.ts", use: { baseURL: `http://127.0.0.1:${OFFLINE_PORT}` } },
    { name: "claude", testMatch: /(claude|memory|voice|tools|automation)\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${CLAUDE_PORT}` } },
  ],
  webServer: [
    {
      command: "node e2e/mock-anthropic.mjs",
      url: `http://127.0.0.1:${MOCK_PORT}/__requests`,
      reuseExistingServer: false,
      env: { MOCK_ANTHROPIC_PORT: String(MOCK_PORT) },
    },
    backend(OFFLINE_PORT),
    backend(CLAUDE_PORT, {
      ANTHROPIC_API_KEY: "sk-ant-e2e-mock-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      // The E2E test page is served on localhost, so allow private-network browsing for this server only.
      JARVIS_BROWSER_ALLOW_PRIVATE_NETWORK: "true",
    }),
  ],
});
