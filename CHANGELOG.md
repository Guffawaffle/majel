# Changelog

All notable changes to Majel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Alpha versioning (v0.x):** Breaking changes may occur between minor versions. Migration paths are not guaranteed.

---

## [0.4.0] - 2026-02-08

### Added

#### Fleet Management (ADR-007)
- **Fleet store** — SQLite-backed officer and ship management
  - CRUD endpoints for officers: `GET/POST/PATCH/DELETE /api/fleet/officers`
  - CRUD endpoints for ships: `GET/POST/PATCH/DELETE /api/fleet/ships`
  - Crew assignment: `POST /api/fleet/ships/:id/crew`, `DELETE /api/fleet/ships/:shipId/crew/:officerId`
  - Activity log: `GET /api/fleet/log` for tracking all mutations
  - Entity counts: `GET /api/fleet/counts`
- **Drydock loadouts** — dry dock configuration with intent-driven crew management
  - CRUD endpoints for docks: `GET/PUT/DELETE /api/fleet/docks/:num`
  - Intent system: `GET/POST/DELETE /api/fleet/intents`, `PUT /api/fleet/docks/:num/intents`
  - Ship assignment to docks: `POST/PATCH/DELETE /api/fleet/docks/:num/ships/:shipId`
  - Computed briefing: `GET /api/fleet/docks/summary`
  - Conflict detection: `GET /api/fleet/docks/conflicts` (officer double-assignment checks)
- **Crew presets** — reusable crew configurations with tagging
  - CRUD endpoints: `GET/POST/PATCH/DELETE /api/fleet/presets`
  - Preset members: `PUT /api/fleet/presets/:id/members`
  - Preset tags: `PUT /api/fleet/presets/:id/tags`, `GET /api/fleet/tags`
  - Dock preset finder: `GET /api/fleet/docks/:num/presets`
- **Fleet import** — bulk import from Google Sheets into fleet store
  - `POST /api/fleet/import` — auto-detect officer/ship tabs, create entities
  - Deduplication by name + tier (officers) or name + tier (ships)

#### Session Management (ADR-009)
- **Chat session store** — SQLite-backed session persistence
  - `GET /api/sessions` — list all saved sessions
  - `GET /api/sessions/:id` — retrieve session with messages
  - `PATCH /api/sessions/:id` — update session title
  - `DELETE /api/sessions/:id` — delete session
- **Session isolation** — each browser tab gets independent Gemini chat session
  - Session IDs generated client-side, persisted server-side
  - Multi-tab safety: no cross-contamination of conversation history

#### Configuration
- **Settings schema expansion** — 49 configurable settings across 5 categories
  - Fleet defaults: `fleet.defaultShipTier`, `fleet.defaultOfficerTier`, `fleet.autoAssignOfficers`
  - Model tuning: `model.temperature`, `model.topP`, `model.topK`, `model.maxOutputTokens`
  - System: `system.requestTimeoutMs`, `system.logLevel`, `system.logPretty`
- **Unified config resolver** — priority chain: user setting > env var > schema default
  - `GET /api/settings` — all settings with resolved values
  - `PATCH /api/settings` — bulk update settings
  - `DELETE /api/settings/:key` — reset to default

#### Documentation
- **ADR-007** — Fleet Management (drydock, crew, intents)
- **ADR-008** — Image Interpretation (screenshot-to-data pipeline) — planned for v0.6
- **ADR-009** — Session Isolation (multi-tab safety)
- **ADR-010** — Multimodal Chat (image uploads) — planned for v0.5

### Changed

#### Route Reorganization (ADR-005 Phase 4)
- **Modular route system** — split monolithic routes into 5 focused modules:
  - `routes/core.ts` — health, diagnostic, roster refresh, API discovery
  - `routes/chat.ts` — chat, history, recall
  - `routes/fleet.ts` — officers, ships, crew, docks, presets, intents, import
  - `routes/sessions.ts` — session CRUD
  - `routes/settings.ts` — settings CRUD
- **Timeout middleware** — per-route timeouts via `createTimeoutMiddleware()`
  - `/api/health` → 2s
  - `/api/chat` → 60s
  - `/api/roster` → 60s
  - All others → 30s default
- **API discovery** — `GET /api` now lists all 50+ endpoints with descriptions

#### Multi-Tab Sheet Import (ADR-007)
- **Tab mapping** — `MAJEL_TAB_MAPPING="Officers:officers,Ships:ships,Custom:custom"`
  - Auto-detect data type per tab (officers, ships, custom)
  - Merge all tabs into unified `FleetData` structure
  - Backward-compatible with single-tab `MAJEL_SHEET_RANGE`

#### Gemini Engine Enhancement
- **Drydock briefing injection** — system prompt now includes computed dock summary
  - Lists all 10 docks with assigned ships, crew, intents
  - Updates on every chat turn (live data)
- **Fleet config awareness** — Gemini receives tier defaults, auto-assign preferences
- **Session tracking** — `getSessionCount()` for diagnostics

### Improved
- **Error handling** — consistent `ErrorCode` enum across all endpoints
- **Logging** — structured JSON logs via Pino (`MAJEL_LOG_PRETTY=true` for dev readability)
- **Test coverage** — 11 test files covering 60%+ of codebase
  - `fleet-store.test.ts`, `dock-store.test.ts` for data layer
  - `api.test.ts` expanded for new endpoints
- **Diagnostic depth** — `/api/diagnostic` now shows frame counts, DB paths, uptime

### Security
- Dependency audit: `npm audit` clean (no high/critical vulnerabilities)
- SQLite DBs in `.smartergpt/` excluded from Git
- Sensitive settings marked for future masking

---

## [0.3.0] - 2026-02-05

### Added

#### Middleware Layer (ADR-005 Phase 2)
- **Request/response envelope** — all API responses wrapped in `{ ok, data, meta }` / `{ ok, error, meta }`
  - `sendOk(res, data)` and `sendFail(res, code, message, status)` helpers
  - Eliminates raw `res.json()` usage in routes
  - Consistent error codes via `ErrorCode` enum
- **HTTP request logging** — Pino HTTP middleware (`pino-http`)
  - Logs all requests/responses with timing, status, user agent
  - Configurable via `MAJEL_LOG_LEVEL` (debug, info, warn, error)

#### Settings Store (ADR-005 Phase 3)
- **SQLite-backed settings** — user preferences persisted in `.smartergpt/lex/settings.db`
  - Priority chain: user override > env var > default
  - Type-safe schema with validation (string, number, boolean, JSON)
  - Sensitive fields marked for future masking
- **Settings API** — read/write via REST
  - `GET /api/settings` — all settings with resolved values
  - `PATCH /api/settings` — update multiple settings atomically
  - `DELETE /api/settings/:key` — reset to default

#### Configuration Unification (ADR-005 Phase 3)
- **Resolved config object** — single source of truth for runtime config
  - Reads from settings store → env vars → defaults
  - No more scattered `process.env` checks in route handlers
  - Injected into app context at boot

### Changed
- **Session history source** — `GET /api/history` now supports `?source=lex|session|both` (default: `both`)
  - Lex frames for long-term memory
  - Session store for current conversation
- **Gemini client cleanup** — removed `GoogleGenerativeAI` wrapper, using SDK directly
- **Port config** — `MAJEL_PORT` now respected via settings resolution

### Improved
- **Startup robustness** — app boots even if Sheets fails
  - Roster errors logged, `/api/health` reports `fleet.error`
  - Graceful degradation: chat works without fleet data
- **Test stability** — Vitest config tuned (10s timeout, fork pool for isolation)

### Fixed
- Env var precedence in config resolution
- Memory service initialization race condition
- HTTP logging interfering with test output

### Security
- Settings DB location configurable (defaults to workspace isolation)
- API key sensitivity markers added (not yet enforced)

---

## [0.2.0] - 2026-02-01

### Added

#### Lex Memory Integration (ADR-001)
- **Frame-based memory** — every chat turn persisted as Lex frame
  - Stores: user message, Gemini response, timestamp, metadata
  - Workspace-isolated: `LEX_WORKSPACE_ROOT` ensures separate DB
- **Semantic recall** — `GET /api/recall?q=kirk` searches by meaning
  - Lex embedding-based search (not keyword matching)
  - Returns relevant past conversations with context
- **Timeline history** — `GET /api/history` shows chronological conversation log
  - Powered by Lex frame timestamps
  - Persists across server restarts

#### Modern Chat UI
- **LCARS-inspired dark theme** — Star Trek: TNG computer aesthetic
  - High-contrast orange/blue palette
  - Responsive layout (mobile-friendly)
- **Markdown rendering** — Gemini responses formatted with headers, lists, code blocks
- **Copy buttons** — click-to-copy for code blocks and full responses
- **Sidebar toggle** — collapsible history/recall panel

#### API Endpoints
- `POST /api/chat` — send message, get Gemini response
- `GET /api/history` — conversation timeline from Lex
- `GET /api/recall?q=query` — semantic search of past conversations
- `GET /api/health` — system status (Gemini, Lex, Sheets)
- `GET /api/roster` — fetch/refresh fleet data from Sheets

### Changed
- **Gemini model** — upgraded to `gemini-2.5-flash-lite` (preview)
  - 1M token context window (up from 32K in 1.5-flash)
  - Allows full roster injection (~30K tokens)
- **System prompt** — epistemic framework integrated
  - Source attribution: "According to your roster..."
  - Confidence signaling: "Based on available data..." vs. "I'm uncertain..."
  - No fabrication: refuse to answer if data unavailable

### Improved
- **Multi-tab Sheets parsing** — handles officer/ship/custom tabs automatically
  - `MAJEL_TAB_MAPPING` env var for tab configuration
- **Error reporting** — structured error messages in API responses
- **Logging** — Pino logger with debug/info/warn/error levels

---

## [0.1.0] - 2026-01-25

### Added
- **Initial MVP** — proof-of-concept Python CLI
  - Google Sheets OAuth integration
  - Gemini API chat via `google-generativeai` SDK
  - CSV roster parsing and injection into system prompt
  - Basic conversation loop (no memory, no UI)

#### Core Features
- **Roster ingestion** — fetch STFC officer data from Google Sheets
  - OAuth 2.0 flow with `credentials.json` + `token.json`
  - CSV export and parsing
- **Brute-force context** — entire roster dumped into Gemini system prompt
  - No RAG, no vector DB — deterministic and simple
- **Gemini 1.5 Flash** — fast, cost-effective LLM
  - ~$0.10/1M input tokens (paid tier)
  - Content filters disabled (`BLOCK_NONE`)

#### Documentation
- **ADR-001** — Architecture (local-first, privacy-focused)
- **ADR-002** — Framework (SvelteKit deferred to v1.0)
- **ADR-003** — Epistemic Framework (source attribution, confidence)
- **ADR-004** — AX-First API (envelope pattern)
- **docs/SETUP.md** — OAuth walkthrough for Google Sheets
- **docs/PROMPT_GUIDE.md** — how Majel is trained

### Technical Decisions
- **Language:** Python → Node.js (ADR-001, v0.2 rewrite)
- **Framework:** Express (alpha) → SvelteKit (v1.0, ADR-002)
- **License:** MIT
- **Deployment:** Local-only (no cloud, ADR-001)

---

## Legend

- **Added** — new features, endpoints, capabilities
- **Changed** — modifications to existing behavior (may break compatibility)
- **Improved** — enhancements without breaking changes
- **Fixed** — bug fixes
- **Security** — vulnerability patches, security improvements
- **Deprecated** — features marked for removal (none yet in alpha)

---

*For detailed technical context, see [ADRs](docs/) and [CONTRIBUTING.md](CONTRIBUTING.md).*
