# JARVIS

A personal AI assistant powered by Claude. It runs as a **web app** in your browser and as a **Windows desktop app** (Tauri 2). Both use the same local backend, database and (from Phase 2 on) AI engine.

> **Status: Phase 2 of 8 (Claude integration) is complete.** JARVIS chats with Claude: streamed replies rendered as Markdown, conversation context, model/effort/length settings, cancellation, and usage and cost tracking. Without an `ANTHROPIC_API_KEY`, messages are saved and answered with a clear "Claude is not connected" notice. See the [roadmap](#roadmap).

---

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop app (Windows)](#desktop-app-windows)
- [Configuration](#configuration)
- [Testing](#testing)
- [Security model](#security-model)
- [Data, migrations and backups](#data-migrations-and-backups)
- [Costs](#costs)
- [Roadmap](#roadmap)

## Architecture

```
┌──────────────────────┐   ┌──────────────────────┐
│ Browser (web app)    │   │ Tauri 2 desktop app  │
│ React + TS + Vite    │   │ same React frontend  │
└──────────┬───────────┘   └──────────┬───────────┘
           │  HTTPS/HTTP + bearer token, SSE streaming
           ▼                          ▼
┌─────────────────────────────────────────────────┐
│ FastAPI backend (127.0.0.1:8765)                 │
│  api/        auth · conversations · settings     │
│  services/   chat streaming · ClaudeProvider ·   │
│              prompts · usage · backups           │
│  core/       config · db · security · logging    │
└──────────┬────────────────────────┬─────────────┘
           ▼                        ▼  official anthropic SDK (streaming)
   SQLite (WAL) via           Anthropic Messages API
   SQLAlchemy + Alembic       (the API key never leaves the backend)
```

```
Jarvis/
├── backend/                 FastAPI app (Python 3.11+)
│   ├── app/
│   │   ├── api/             HTTP routers + auth dependencies
│   │   ├── core/            config, database, password/token security, redacting logger
│   │   ├── services/        chat turns, Claude provider, prompts, model catalog/pricing, backups
│   │   ├── models.py        every table in the spec (users … api_usage)
│   │   ├── schemas.py       Pydantic request/response models
│   │   ├── migrations.py    runs Alembic at startup
│   │   ├── cli.py           migrate / backup / reset-password
│   │   └── main.py          app factory; also serves the built frontend
│   ├── alembic/             migrations
│   └── tests/               pytest suite
├── frontend/                React + TypeScript + Vite + Tailwind CSS 4
│   ├── src/
│   │   ├── components/      Sidebar, Composer, MessageBubble, Markdown, VoiceOrb, StatusPill
│   │   ├── views/           Auth, Chat, Settings, Roadmap (Memory/Tasks placeholders)
│   │   ├── hooks/           useAuth, useRoute
│   │   └── lib/             API client, SSE parser, types, formatting
│   ├── e2e/                 Playwright end-to-end tests + a local mock of the Anthropic API
│   └── src-tauri/           Tauri 2 desktop shell (Rust)
├── scripts/                 setup / dev / test (bash + PowerShell)
├── .env.example
└── CLAUDE.md                instructions for AI coding agents working on this repo
```

**Key decisions**

| Decision | Why |
| --- | --- |
| One backend for web and desktop | A single source of truth for memory, history and permissions. The desktop app is a thin webview shell. |
| Server-Sent Events over `fetch` | Streaming replies with POST bodies and an `Authorization` header (which `EventSource` can't send), and simpler than WebSockets. |
| Bearer tokens, only their hash stored | Works the same in the browser and in the Tauri webview (no cross-site cookies). A leaked database doesn't reveal live tokens. |
| `ChatProvider` interface | Claude sits behind a small interface, so streaming, persistence and cancellation are tested independently of the API. |
| Official `anthropic` SDK, streaming | Replies stream token by token; the SDK handles retries and the wire format. Closing the stream on cancel stops generation, so you aren't billed for tokens you didn't want. |
| Automatic prompt caching | Each request marks the conversation for caching, so on the next turn the earlier history is re-read at about 10% of the normal input price. The system prompt only changes once a day (it contains the date). |
| Thinking and effort left at model defaults | Current models think adaptively. Effort is only sent when you pick one in Settings, so older models that reject it still work. |
| Server-side refusal fallback | Current Claude models can decline a request via safety classifiers. With `fallbacks: "default"` the API retries it on Anthropic's recommended fallback model in the same call. On by default; `JARVIS_REFUSAL_FALLBACK=false` turns it off. |
| Full schema in migration `0001` | Later phases add behaviour without risky table rebuilds. A test asserts the migrations match the models. |
| Stdlib `scrypt` for passwords | Strong and memory-hard, with no extra native dependency (helps Windows packaging). |
| Alembic runs on startup | The app always opens on an up-to-date schema. |

## Requirements

| Tool | Version | Needed for |
| --- | --- | --- |
| Python | 3.11+ (tested 3.13) | backend |
| Node.js | 20+ (tested 22) | frontend |
| npm | 10+ | frontend |
| Rust | 1.77+ (tested 1.97) | desktop app only |
| Git | any | |
| **Windows desktop only** | Microsoft C++ Build Tools ("Desktop development with C++"), WebView2 runtime (preinstalled on Windows 10/11) | Tauri build |

## Quick start

**Linux/macOS**

```bash
./scripts/setup.sh
```

```bash
./scripts/dev.sh
```

**Windows (PowerShell)**

```powershell
.\scripts\setup.ps1
```

```powershell
.\scripts\dev.ps1
```

Open http://localhost:5173. On first launch you create the owner account.

**Connect Claude:** put your key in `.env` in the repo root, then restart the backend:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Create a key at https://console.anthropic.com/ (API keys). Usage is billed to that Anthropic account.

**Single-process web mode** (no Vite): build the frontend once and FastAPI serves it.

```bash
cd frontend && npm run build
```

```bash
cd backend && .venv/bin/python -m app.main
```

Then open http://127.0.0.1:8765.

## Desktop app (Windows)

The desktop app shows the same UI and connects to the backend at `http://127.0.0.1:8765`. **In Phase 1 the backend must already be running.** Phase 8 will bundle it as a sidecar that starts automatically.

```powershell
cd frontend
npx tauri dev      # dev window with hot reload (also starts Vite)
npx tauri build    # produces NSIS/MSI installers in src-tauri/target/release/bundle
```

## Configuration

Copy `.env.example` to `.env` in the repo root. All settings use the `JARVIS_` prefix, except `ANTHROPIC_API_KEY`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Claude access. Read only by the backend, never sent to the browser, logs or database. |
| `JARVIS_DEFAULT_MODEL` | `claude-opus-5-5` | Default Claude model. Each user can override it in Settings. |
| `JARVIS_MAX_OUTPUT_TOKENS` | `16000` | Default cap on each reply's length |
| `JARVIS_MAX_CONTEXT_TOKENS` | `150000` | Approximate cap on history sent per message; oldest turns are dropped first |
| `JARVIS_REQUEST_TIMEOUT_SECONDS` | `300` | Timeout for each Claude request |
| `JARVIS_MAX_RETRIES` | `2` | SDK retries for rate limits, overload and network errors |
| `JARVIS_REFUSAL_FALLBACK` | `true` | Retry safety-classifier refusals on Anthropic's recommended fallback model |
| `JARVIS_HOST` / `JARVIS_PORT` | `127.0.0.1` / `8765` | Bind address |
| `JARVIS_SETUP_TOKEN` | – | Required to create the first account if the host is not loopback |
| `JARVIS_CORS_ORIGINS` | Vite + Tauri origins | JSON list of allowed browser origins |
| `JARVIS_DATA_DIR` | `./data` | Database and backups |
| `JARVIS_SESSION_TTL_HOURS` | `336` | Login session lifetime |

User preferences (assistant name, model, effort, reply length cap, voice options, Enter-to-send) are stored per user in the database and edited on the Settings page. Settings also shows API usage (requests, tokens, cached tokens) with an estimated cost.

## Testing

```bash
./scripts/test.sh
```

That runs, in order:
- **pytest** (`backend/tests`): auth, rate limiting, setup-token rule, conversation CRUD, ownership isolation, streaming, cancellation, persistence across restarts, backups, a migration/model drift check, log redaction, SPA serving, and the Claude provider. The Claude tests run the real SDK against a mocked HTTP transport that replays the API's streaming format: request shape, history, preferences, prompt caching, refusals, mid-stream fallback, token-limit truncation, every error class, usage and cost recording, and that cancelling closes the upstream stream.
- **tsc + vitest** (`frontend/src/**/*.test.ts(x)`): SSE parser, routing, formatting, Composer, MessageBubble, and Markdown safety (no raw HTML, no `javascript:` links, images shown as links).
- **Playwright** (`frontend/e2e`): two real backends serving the production build. One has no API key (setup, persistence, rename/pin/search/delete, settings, backups, sign-out). The other points `ANTHROPIC_BASE_URL` at `e2e/mock-anthropic.mjs`, a local stand-in for the streaming API (Markdown replies, multi-turn context, stop button, model/effort settings, usage).

No suite calls the real Anthropic API, so tests are free and need no key.

## Security model

- The backend binds to **127.0.0.1** by default. If you bind it to another address, you need `JARVIS_SETUP_TOKEN` to create the first account. Every endpoint except `/api/health` and the login/setup routes requires authentication.
- Passwords are hashed with **scrypt**. Session tokens are random 256-bit values, and only their SHA-256 hash is stored. Changing your password revokes your other sessions. Failed logins are rate-limited per IP (5 per 5 minutes).
- The API key stays on the backend. The settings API only reports whether AI is configured. API error messages shown to users are rewritten from the SDK's exception types and never include credentials; unexpected errors show a generic message and are logged.
- Assistant replies are rendered as Markdown **without raw HTML**. Links open in a new tab with `noopener`, unsafe URL schemes are dropped, and Markdown images are shown as links rather than loaded (so a reply can't make your browser fetch a tracking URL).
- The system prompt tells Claude to treat content inside shared documents or pages as data, not instructions.
- Logs pass through a **redaction filter** that removes API keys, bearer tokens and password/secret fields.
- Responses include `nosniff`, `X-Frame-Options: DENY` and `no-referrer` headers. CORS is an explicit allow-list. The Tauri CSP only allows connections to the local backend.
- Every query is scoped to the authenticated user, and tests check that users can't see each other's data.
- The permission system for tools (automatic / restricted / sensitive, with approval prompts) arrives in Phase 5. Its tables (`permissions`, `tool_executions`) already exist.
- **Don't expose JARVIS to the internet directly.** For remote access, put it behind a VPN (e.g. Tailscale) or a TLS reverse proxy.

## Data, migrations and backups

- Database: `data/jarvis.db` (SQLite, WAL mode, foreign keys enforced). It survives restarts; a test checks this.
- Migrations: applied automatically at startup. To add one:
  ```bash
  cd backend && .venv/bin/alembic revision --autogenerate -m "describe change"
  ```
- Backups: **Settings → Data & backups → Back up now**, or:
  ```bash
  cd backend && .venv/bin/python -m app.cli backup
  ```
  Both use SQLite's online backup API, so snapshots are consistent while the app runs. They are written to `data/backups/`, and the 20 most recent are kept.
- Forgotten password (local recovery):
  ```bash
  cd backend && .venv/bin/python -m app.cli reset-password <username>
  ```

## Costs

| Item | Cost |
| --- | --- |
| JARVIS itself | Free (open-source stack, runs locally) |
| Claude API | **Paid, pay-per-token** on your Anthropic account. List prices per million input / output tokens: Opus 5.5 $4 / $20 (default), Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50, Fable 5.1 $10 / $50. Cached history is re-read at ~10% of the input price. Settings → API usage shows your tokens and an estimated cost. |
| Voice (Phase 4) | Free: browser speech recognition and synthesis. Local engines can be added later. |
| Web research (Phase 5) | A free option will be the default. Paid search APIs are optional, and their pricing will be stated before they are added. |
| Windows code-signing certificate (Phase 8, optional) | Paid, from a third-party CA. Only needed to avoid SmartScreen warnings when you distribute the app. |

## Roadmap

- [x] **Phase 1: Foundation.** Backend, database schema and migrations, auth, conversations with persistent history, SSE streaming pipeline, settings, backups, polished UI, Tauri shell, tests.
- [x] **Phase 2: Claude integration.** `ClaudeProvider` (official SDK, streaming), context building and trimming, prompt caching, refusal fallback, friendly error handling, usage and cost tracking, cancellation that stops generation, model/effort/length settings, safe Markdown rendering.
- [ ] **Phase 3: Persistent memory.** Memory CRUD, FTS5 search, relevant-context retrieval, duplicate prevention, history, approval flow, Memory UI.
- [ ] **Phase 4: Voice.** Microphone, speech-to-text, text-to-speech, interruption, mute, voice settings, pluggable `VoiceProvider`.
- [ ] **Phase 5: Tool system.** Registry, schemas, permission engine and approvals, execution log. First tools: calculator, date/time, files, summarizer, web research, memory, task manager, sandboxed Python.
- [ ] **Phase 6: Browser and desktop automation.** Playwright browsing, approved desktop app control through Tauri commands.
- [ ] **Phase 7: Autonomous tasks.** Planner, sequential and parallel execution, retries, verification, cancellation, task dashboard.
- [ ] **Phase 8: Integrations and deployment.** External services, backend sidecar in the desktop installer, packaging, remote-access guidance.
