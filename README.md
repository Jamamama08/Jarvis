# JARVIS

A personal AI assistant powered by Claude. It runs as a **web app** in your browser and as a **Windows desktop app** (Tauri 2). Both use the same local backend, database and (from Phase 2 on) AI engine.

> **Status: Phase 6 of 8 (Browser and desktop automation) is complete.** JARVIS chats with Claude (streamed Markdown replies, context, model/effort/length settings, cancellation, usage and cost tracking), has long-term memory you control, supports voice, and uses tools under a permission system that asks before anything risky: calculator, date and time, workspace files, document summaries, your task list, memory, Python, optional web search, its own web browser, and the desktop apps you approve. Without an `ANTHROPIC_API_KEY`, messages are saved and answered with a clear "Claude is not connected" notice. See the [roadmap](#roadmap).

---

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop app (Windows)](#desktop-app-windows)
- [Memory](#memory)
- [Voice](#voice)
- [Tools and permissions](#tools-and-permissions)
- [Browser and desktop automation](#browser-and-desktop-automation)
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
│  api/        auth · conversations · memories ·   │
│              projects · settings · usage         │
│  services/   chat streaming · ClaudeProvider ·   │
│              memory (FTS5) · suggestions ·       │
│              prompts · backups                   │
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
│   │   ├── services/        agent loop (chat.py), Claude provider, memory engine + suggestions, prompts, pricing, backups
│   │   ├── tools/           registry, permissions, executor (approvals, timeouts, redacted logs), built-in tools
│   │   ├── automation/      Playwright browser manager + network guard, desktop app launcher
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
│   │   ├── voice/           VoiceProvider interface, Web Speech implementation, useVoice, speech text
│   │   ├── views/           Auth, Chat, Memory, Tasks, Tools, Settings
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
| Memories attached to the user turn, not the system prompt | Relevant memories are sent as a separate text block at the start of that user message and stored with it. Replayed history stays byte-identical, so prompt caching keeps working, and a memory already sent in a conversation isn't sent again. |
| Voice in the browser behind a `VoiceProvider` interface | The free Web Speech API needs no new dependency or service. The app only talks to the recognizer/synthesizer interfaces in `frontend/src/voice/types.ts`, so a local engine (e.g. Whisper and Piper through the backend or a Tauri command) can replace it later. |
| Manual agent loop inside the streaming turn | The SDK's tool runner can't pause an SSE stream to wait for your approval, so `services/chat.py` runs the loop itself: validate input, check permissions, ask you, run with a timeout, log, repeat. It enforces max steps, a time limit and a token budget per message. |
| Tool exchanges stored and replayed exactly | The full exchange (including thinking blocks and tool calls/results) is saved with the reply and replayed byte-identically, which the API needs for tool use and which keeps prompt caching working. |
| Desktop control runs in the backend, not as Tauri commands | The backend always runs on the same computer as the desktop app, so launching approved apps from the backend works from both the web and desktop apps, goes through the same permission system and log, and can be tested. Exposing native commands to the webview instead would let any script injected into the page reach them. Desktop control switches itself off when the server isn't on loopback. |
| Browser automation with an isolated profile | JARVIS's browser shares nothing with your own: no cookies, saved logins or downloads. Pages are given to Claude as text plus numbered elements, and every request is checked by a network guard. |
| Suggestions instead of automatic memory | Claude never saves memories itself. "Suggest memories" makes one explicit request that returns pending suggestions (structured JSON output) for you to approve, edit or reject. |
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

## Memory

Open **Memory** in the sidebar.

- **Saved:** memories you've added or approved. Add, edit, delete, search (full-text, with stemming and prefix matching), filter by category, and view each memory's change history. Categories: preference, personal, project, progress, knowledge, conversation. Importance 1-5; memories rated 4 or 5 are sent with every message, others only when they match what you wrote.
- **Suggestions:** in a conversation, click **Suggest memories** and Claude proposes up to 5 durable facts. They wait here until you approve, edit and approve, or reject them. Proposals that duplicate existing memories or look like secrets (passwords, keys, card numbers) are dropped.
- **Projects:** group memories by project, with a status and progress notes.
- **Activity:** every create, edit, approval, rejection and deletion.

How it reaches Claude: for each message, JARVIS picks approved memories that are high-importance or match your message (SQLite FTS5, BM25 ranking), up to 12 and about 6,000 characters, and sends them with that message. The chat shows "N memories used" under your message. Turn this off under **Settings → Use memories in replies**.

Duplicates: an exact duplicate (ignoring case, spacing and punctuation) is refused; a near-duplicate (80% of words in common) is refused unless you choose **Save anyway**.

Deleting a memory removes it immediately. Its history keeps the old text unless you tick **Also erase its change history**.

## Voice

- **Talk:** click the microphone (or enable voice in Settings first). Your words appear live in the message box; when you pause, the message is sent. Turn off **Send voice messages automatically** to review the text first. Esc cancels.
- **Listen:** turn on **Speak replies aloud** in Settings → Voice. Replies are read out sentence by sentence while they stream; Markdown is read naturally, and code blocks are announced as "code block omitted". Every reply also has a **Read aloud** button.
- **Interrupt:** start talking (click the mic), send a new message, press Esc, or click **Stop speaking**. The speaker icon in the chat header mutes spoken replies on this device.
- **Hands-free conversation:** after a spoken message, JARVIS listens again once its reply has been read out.
- **Settings → Voice:** voice, recognition language, speech rate, a **Test voice** button, and whether this browser supports voice input and spoken replies.

Browser support and privacy:

| | Voice input | Spoken replies |
| --- | --- | --- |
| Chrome | Yes. Audio is sent to **Google** for transcription. | Yes |
| Edge | Yes. Audio is sent to **Microsoft** for transcription. | Yes |
| Safari | Yes (may use Apple's servers) | Yes |
| Firefox | No | Yes |
| Desktop app (Windows WebView2) | **Not yet**: WebView2 has no speech recognition service. JARVIS says so and disables the mic. | Yes |

Voice is free; it adds no Claude cost beyond the messages themselves. Spoken replies use voices installed on your device (some browser voices are online). For fully local, offline voice input, a local engine can be added later behind the same `VoiceProvider` interface.

## Tools and permissions

JARVIS decides when to use a tool. Every call is validated against the tool's schema, checked against your permissions, run with a timeout, and logged with secrets redacted. Tool cards appear in the reply, and the header shows what's running or waiting for you.

| Tool | Level | What it does |
| --- | --- | --- |
| `calculator` | automatic | Exact arithmetic and math functions (no `eval`) |
| `current_datetime` | automatic | Current date and time, any time zone |
| `read_file`, `search_files` | automatic | Read and search text files in the workspace folder |
| `summarize_document` | automatic | Summarize a workspace document of any length (extra Claude requests) |
| `create_task`, `list_tasks`, `update_task` | automatic | Your task list (see **Tasks**) |
| `search_memories` | automatic | Search approved memories |
| `suggest_memory` | automatic | Propose a memory; it stays pending until you approve it |
| `write_file` | restricted | Create, overwrite or append to a workspace file |
| `delete_task` | restricted | Delete a task |
| `run_python` | restricted | Run a Python script in the workspace |
| `delete_file` | sensitive | Permanently delete a workspace file |
| `web_search`, `web_fetch` | automatic, opt-in | Anthropic-run web search and page fetch. **Paid**, so off by default |

**Permissions** (the **Tools** page):
- Defaults: automatic tools run immediately; restricted and sensitive tools ask you first. You can change each level or individual tools to *Run automatically*, *Ask me first* or *Never*.
- Sensitive actions can never be set to run automatically.
- When asked, you see exactly what will happen (for example the file path and content), and can **Allow**, **Deny**, or **Always allow** a restricted tool.
- Requests you don't answer within 5 minutes are declined.

**Workspace folder:** file tools and Python can only use `data/workspace` (`JARVIS_WORKSPACE_DIR`). Paths that leave it, including through `..` or symlinks, are refused. Put documents there for JARVIS to read.

**Python runner:** runs in a separate process with no inherited secrets (your API key isn't visible to it), the workspace as working directory, a timeout, and output limits. On Linux and macOS it also has CPU, memory and file-size limits. It is **not** a security sandbox: code runs with your user account's permissions, which is why it needs your approval. Turn it off with `JARVIS_PYTHON_TOOL_ENABLED=false`.

**Limits per message:** 10 model requests, 10 minutes, 400,000 tokens, 30 seconds per tool run (all configurable). When a limit is hit, JARVIS stops cleanly and says why.

**Untrusted content:** tool results, file contents and web pages are data, never instructions; the system prompt tells Claude this, and every action still goes through the permission check no matter what a document says. 

**Tasks page:** your task list. JARVIS adds and updates tasks with its task tools, or you can manage them yourself. Autonomous execution of multi-step tasks is Phase 7.

## Browser and desktop automation

**Browser** (Tools → *Browser & apps* shows its status):

| Tool | Level | What it does |
| --- | --- | --- |
| `browser_open`, `browser_read`, `browser_back`, `browser_close` | automatic | Open and read pages: text plus a numbered list of links, buttons and fields |
| `browser_click`, `browser_type`, `browser_select` | restricted | Interact with the page. The approval prompt names the element and site, e.g. *click [2] button "Send message" on example.com/contact* |

- JARVIS's browser is separate from yours (Chromium via Playwright): no cookies or saved logins, downloads blocked, closed after 10 idle minutes. It runs invisibly unless you set `JARVIS_BROWSER_HEADLESS=false`.
- **It never types into password fields.** Sign in yourself if a site needs it (with the visible browser).
- **Network guard:** every request, including redirects and page resources, must be `http(s)` to a public address. Your private network (router, NAS, `localhost`, cloud metadata addresses) is blocked unless you set `JARVIS_BROWSER_ALLOW_PRIVATE_NETWORK=true`. This stops a web page from using JARVIS to reach devices inside your network.
- Page text is labelled as untrusted for Claude, and the system prompt tells it to confirm in chat before submitting anything that sends, buys, books or deletes. The approval prompt is the final safeguard.
- The browser itself is a one-time ~150 MB download; `scripts/setup` runs `python -m playwright install chromium`.

**Desktop apps** (Tools → *Browser & apps*):
- You approve apps by name, full path and fixed arguments. **Only you can add apps; JARVIS can't.**
- If you allow it, JARVIS may pass one extra item: a web address or a file in the workspace. Anything starting with `-` (a command-line option) is refused.
- `open_desktop_app` and `open_workspace_file` are restricted: they ask first unless you change that.
- `open_workspace_file` opens documents with their default app, but refuses executables and scripts (`.exe`, `.bat`, `.ps1`, `.sh`, `.lnk`, …) and files marked executable.
- Launched apps don't inherit JARVIS's secrets (API keys, tokens).
- Don't approve shells or script interpreters (cmd, PowerShell, Terminal, python): they could run anything.
- Desktop control is on only when the server listens on your own machine (`JARVIS_HOST` = loopback); override with `JARVIS_DESKTOP_CONTROL_ENABLED`.

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
| `JARVIS_WORKSPACE_DIR` | `data/workspace` | The only folder file tools and Python can use |
| `JARVIS_MAX_TOOL_ITERATIONS` | `10` | Model requests per message |
| `JARVIS_TURN_TIMEOUT_SECONDS` | `600` | Time limit per message, including tool runs and approvals |
| `JARVIS_TURN_TOKEN_BUDGET` | `400000` | Input + output tokens per message |
| `JARVIS_TOOL_TIMEOUT_SECONDS` | `30` | One tool run |
| `JARVIS_APPROVAL_TIMEOUT_SECONDS` | `300` | How long an approval request waits |
| `JARVIS_PYTHON_TOOL_ENABLED` | `true` | Offer the Python runner |
| `JARVIS_BROWSER_ENABLED` | `true` | Offer the browser tools |
| `JARVIS_BROWSER_HEADLESS` | `true` | `false` shows the browser window |
| `JARVIS_BROWSER_ALLOW_PRIVATE_NETWORK` | `false` | Let the browser reach private/local addresses |
| `JARVIS_DESKTOP_CONTROL_ENABLED` | auto | Desktop app tools; auto = on only when the host is loopback |
| `JARVIS_HOST` / `JARVIS_PORT` | `127.0.0.1` / `8765` | Bind address |
| `JARVIS_SETUP_TOKEN` | – | Required to create the first account if the host is not loopback |
| `JARVIS_CORS_ORIGINS` | Vite + Tauri origins | JSON list of allowed browser origins |
| `JARVIS_DATA_DIR` | `./data` | Database and backups |
| `JARVIS_SESSION_TTL_HOURS` | `336` | Login session lifetime |

User preferences (assistant name, model, effort, reply length cap, memory on/off, tools on/off, web search on/off, voice options (input, spoken replies, voice, language, rate, auto-send, hands-free), Enter-to-send) are stored per user in the database and edited on the Settings page. Settings also shows API usage (requests, tokens, cached tokens) with an estimated cost.

## Testing

```bash
./scripts/test.sh
```

That runs, in order:
- **pytest** (`backend/tests`): auth, rate limiting, setup-token rule, conversation CRUD, ownership isolation, streaming, cancellation, persistence across restarts, backups, a migration/model drift check, log redaction, SPA serving, memory (CRUD, history, purge, exact and near duplicates, FTS search kept in sync by triggers, FTS query-injection safety, privacy between users, projects, persistence, retrieval into chat, no re-sending, pending and disabled memories never sent, suggestions with duplicate and secret filtering, approval/rejection, refusal and error handling, usage), the Claude provider, and tools: calculator safety, workspace confinement (`..`, absolute paths, symlinks), the Python runner (no inherited secrets, timeout kill), permission resolution (sensitive can't be auto-allowed), redaction, and the agent loop through the real SDK against a mocked API. Agent-loop tests cover automatic tools with byte-identical replay (thinking signatures included), approve with "always allow", deny, deny by policy, approval timeout, cancel while waiting (the stored exchange stays valid), invalid input and unknown tools, iteration and token limits, tools off, opt-in web search (definitions, logging, search cost, replay), memory/task tools, file tools and the summarizer, log redaction and privacy, and a regression test that cancels a turn at many points and checks the reply is always saved in a final state. Automation tests run a **real Chromium** against a local test website: page snapshots, untrusted-content labelling, typing and submitting, selecting, clicking a form submit, refusing password fields, isolated per-user sessions, idle cleanup, the network guard (private addresses, metadata IPs, `file:`/`javascript:`), the full agent loop with approval prompts that name the element, and desktop control (app validation, launching an approved app with a workspace file, refusing flag injection and unknown apps, scrubbed child environment, refusing executables, off when network-exposed). The Claude tests run the real SDK against a mocked HTTP transport that replays the API's streaming format: request shape, history, preferences, prompt caching, refusals, mid-stream fallback, token-limit truncation, every error class, usage and cost recording, and that cancelling closes the upstream stream.
- **tsc + vitest** (`frontend/src/**/*.test.ts(x)`): SSE parser, routing, formatting, Composer (including the mic), MessageBubble, Markdown safety (no raw HTML, no `javascript:` links, images shown as links), and voice: Markdown-to-speech, sentence streaming that never speaks inside an open code block, the browser recognizer against a fake Web Speech API (transcripts, error messages, unsupported browsers and the desktop WebView), and `useVoice` (final text, cancel discards, spoken replies with the chosen voice, barge-in, mute, settings).
- **Playwright** (`frontend/e2e`): two real backends serving the production build. One has no API key (setup, persistence, rename/pin/search/delete, settings, backups, sign-out). The other points `ANTHROPIC_BASE_URL` at `e2e/mock-anthropic.mjs`, a local stand-in for the API (Markdown replies, multi-turn context, stop button, model/effort settings, usage, and the memory flow: add, duplicate refusal, search, edit, history, memories sent with chat, suggestions approved and rejected, purge, projects).

The voice E2E tests (`e2e/voice.spec.ts`) replace the browser's speech API with a scripted fake, because headless Chromium has no microphone or speakers. Everything above that API is the real code: speak a message, hear the reply, stop speaking, Esc cancels, mute, read aloud, hands-free listening, auto-send off, and an unsupported browser.

The automation E2E tests (`e2e/automation.spec.ts`) have JARVIS open a page in its browser, then close it from the Tools page, and approve a desktop app, launch it after approval, and refuse an unapproved one.

The tools E2E tests (`e2e/tools.spec.ts`) use mock-API prompts that trigger tool calls: an automatic tool, approving a file write, declining a sensitive delete, blocking a tool on the Tools page, the activity log, and the task list.

No suite calls the real Anthropic API, so tests are free and need no key.

## Security model

- The backend binds to **127.0.0.1** by default. If you bind it to another address, you need `JARVIS_SETUP_TOKEN` to create the first account. Every endpoint except `/api/health` and the login/setup routes requires authentication.
- Passwords are hashed with **scrypt**. Session tokens are random 256-bit values, and only their SHA-256 hash is stored. Changing your password revokes your other sessions. Failed logins are rate-limited per IP (5 per 5 minutes).
- The API key stays on the backend. The settings API only reports whether AI is configured. API error messages shown to users are rewritten from the SDK's exception types and never include credentials; unexpected errors show a generic message and are logged.
- Assistant replies are rendered as Markdown **without raw HTML**. Links open in a new tab with `noopener`, unsafe URL schemes are dropped, and Markdown images are shown as links rather than loaded (so a reply can't make your browser fetch a tracking URL).
- The system prompt tells Claude to treat content inside shared documents or pages as data, not instructions. Memory context and the transcript used for suggestions are wrapped and labelled as data too.
- Only **approved** memories are ever sent to Claude. Memory search builds FTS5 queries from quoted tokens only, so user text can't inject FTS syntax. All memory and project queries are scoped to the signed-in user.
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
| Memory | Free to store and search (local SQLite). Memories sent with a message add input tokens to that request (at most ~6,000 characters, ~1,500 tokens). Each **Suggest memories** click is one Claude request. |
| Claude API | **Paid, pay-per-token** on your Anthropic account. List prices per million input / output tokens: Opus 5.5 $4 / $20 (default), Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50, Fable 5.1 $10 / $50. Cached history is re-read at ~10% of the input price. Settings → API usage shows your tokens and an estimated cost. |
| Voice (Phase 4) | Free: browser speech recognition and synthesis. Local engines can be added later. |
| Tools | Free, except where noted. Tool calls add Claude tokens (each step is one request, and tool results are input tokens). `summarize_document` makes extra Claude requests for long documents. |
| Web search (optional, off by default) | **$10 per 1,000 searches** plus tokens, billed by Anthropic; at most 5 per request. Web fetch is billed as tokens only. Included in the usage estimate. |
| Browser automation | Free (local Chromium). Pages read by JARVIS become input tokens. |
| Windows code-signing certificate (Phase 8, optional) | Paid, from a third-party CA. Only needed to avoid SmartScreen warnings when you distribute the app. |

## Roadmap

- [x] **Phase 1: Foundation.** Backend, database schema and migrations, auth, conversations with persistent history, SSE streaming pipeline, settings, backups, polished UI, Tauri shell, tests.
- [x] **Phase 2: Claude integration.** `ClaudeProvider` (official SDK, streaming), context building and trimming, prompt caching, refusal fallback, friendly error handling, usage and cost tracking, cancellation that stops generation, model/effort/length settings, safe Markdown rendering.
- [x] **Phase 3: Persistent memory.** Memory CRUD, FTS5 search, relevant-context retrieval, duplicate prevention, history, approval flow (Claude suggestions), projects, Memory UI.
- [x] **Phase 4: Voice.** Microphone with live transcript and level meter, speech-to-text, streamed text-to-speech, interruption (barge-in, Esc, stop), mute, hands-free conversation, voice settings, pluggable `VoiceProvider`.
- [x] **Phase 5: Tool system.** Tool registry with validated schemas, permission engine (automatic/restricted/sensitive) with in-chat approvals and per-tool rules, redacted execution log, agent loop with step/time/token limits, tools for calculator, date and time, workspace files, document summarizer, task list, memory, Python, and opt-in web search. Tools and Tasks pages.
- [x] **Phase 6: Browser and desktop automation.** Isolated Playwright browser (open/read/click/type/select) with a private-network guard and password refusal; approved desktop apps and opening workspace documents; Browser & apps settings.
- [ ] **Phase 7: Autonomous tasks.** Planner, sequential and parallel execution, retries, verification, cancellation, task dashboard.
- [ ] **Phase 8: Integrations and deployment.** External services, backend sidecar in the desktop installer, packaging, remote-access guidance.
