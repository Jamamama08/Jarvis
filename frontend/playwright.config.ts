import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const dataDir = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
const python = process.platform === "win32" ? "..\\backend\\.venv\\Scripts\\python.exe" : "../backend/.venv/bin/python";

/** E2E runs the real backend (fresh temp database) serving the production build in ./dist. */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } },
  ],
  webServer: {
    command: `${python} -m app.main`,
    cwd: "../backend",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { JARVIS_PORT: String(PORT), JARVIS_DATA_DIR: dataDir, JARVIS_FRONTEND_DIST: join(process.cwd(), "dist") },
  },
});
