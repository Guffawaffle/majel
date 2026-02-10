# Changelog

All notable changes to Majel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Alpha versioning (v0.x):** Breaking changes may occur between minor versions. Migration paths are not guaranteed.

---

## [0.4.0] - 2026-02-08

### Added

#### Catalog + Overlay Model (ADR-016)
- **Reference + overlay architecture** — immutable wiki data with personal overlay deltas
  - Reference store: `reference-store.ts` — read-only officer/ship data from wiki
  - Overlay store: `overlay-store.ts` — user levels, tiers, notes, priorities (survives re-syncs)
  - Merged views: `GET /api/catalog/officers/merged`, `GET /api/catalog/ships/merged`
  - Entity counts: `GET /api/catalog/counts`
- **Wiki sync** — bulk import from STFC Fandom wiki (174 officers, 54 ships)
  - `POST /api/catalog/sync` — scrape + parse + upsert
  - Canonical entity IDs: `wiki:officer:<pageId>`, `wiki:ship:<pageId>` (ADR-015)
  - Idempotent: safe to re-run without losing overlay data
- **Catalog API** — 8 endpoints for browsing and overlaying fleet data
  - `GET /api/catalog/officers`, `GET /api/catalog/ships` — reference data
  - `GET /api/catalog/officers/:id`, `GET /api/catalog/ships/:id` — individual records
  - `PATCH /api/catalog/officers/:id/overlay`, `PATCH /api/catalog/ships/:id/overlay` — set overlays
  - `DELETE /api/catalog/officers/:id/overlay`, `DELETE /api/catalog/ships/:id/overlay` — clear overlays
  - `POST /api/catalog/bulk-overlay` — batch overlay updates

#### Drydock System (ADR-010)
- **Drydock loadouts** — ship configurations with officer assignments
  - CRUD: `GET/PUT/DELETE /api/dock/docks/:num`
  - Summary: `GET /api/dock/docks/summary`
  - Conflict detection: `GET /api/dock/docks/conflicts`
  - Cascade preview: `GET /api/dock/docks/:num/cascade-preview`
- **Intent system** — declarative crew roles
  - `GET/POST/DELETE /api/dock/intents`
  - `PUT /api/dock/docks/:num/intents`
- **Crew presets** — reusable crew configurations with tagging
  - `GET/POST/PATCH/DELETE /api/dock/presets`
  - Dock-specific preset finder: `GET /api/dock/docks/:num/presets`
  - Tag management: `GET /api/dock/tags`

#### Fleet Tab (ADR-017)
- **Inline-editable fleet roster** — power, rank, tier, level, priority, notes
  - Debounced auto-save on field blur
  - Filter bar (owned, all, faction, rarity) with search
  - Stats bar with live aggregates (total power, officer/ship counts)
  - Power column with formatted display (e.g., "42.5M")

#### AI Diagnostics
- **Natural-language query tool** — AI-powered data exploration
  - `GET /api/diagnostic` — health check
  - `POST /api/diagnostic/schema` — describe database schema to AI
  - `POST /api/diagnostic/query` — AI generates + executes SQL from natural language
  - `POST /api/diagnostic/summary` — AI summarizes query results
- **Diagnostics tab** — browser UI with query input, SQL transparency, result display

#### SPA Routing
- **Hash-based routing** — 5 views: `#chat`, `#catalog`, `#fleet`, `#drydock`, `#diagnostics`
  - Tab state persisted in URL hash
  - Back/forward browser navigation support
  - Default view: `#chat`

#### Session Management (ADR-009)
- **Chat session store** — SQLite-backed session persistence
  - `GET/PATCH/DELETE /api/sessions(/:id)`
  - Multi-tab safety: session IDs generated client-side
- **Session isolation** — independent Gemini chat per browser tab

#### Configuration
- **Settings schema** — 49 configurable settings across 5 categories
  - Model tuning: temperature, topP, topK, maxOutputTokens
  - System: request timeout, log level, log format
- **Settings API** — `GET/PATCH /api/settings`, `DELETE /api/settings/:key`
- **Unified config resolver** — priority: user setting > env var > schema default

#### Documentation
- **17 ADRs** covering architecture, framework, epistemic model, API design,
  middleware, identity, fleet management, image interpretation (planned),
  session isolation, drydock loadouts, structured logging, Ariadne rebrand,
  LCARS v2, MicroRunner, canonical entity identity, catalog-overlay model,
  and fleet tab return.

### Changed

#### Route Reorganization
- **7 route modules** — modular routing across 56 endpoints:
  - `routes/core.ts` — health, API discovery
  - `routes/chat.ts` — chat, history, recall
  - `routes/catalog.ts` — officers, ships, overlays, sync
  - `routes/docks.ts` — loadouts, presets, tags, intents
  - `routes/diagnostic-query.ts` — AI data queries
  - `routes/sessions.ts` — session CRUD
  - `routes/settings.ts` — settings CRUD
- **API discovery** — `GET /api` lists all endpoints with descriptions

#### Google Sheets Removal (ADR-016 D7)
- **Fully removed** — no Sheets API, no OAuth, no `googleapis` dependency
- Replaced by wiki sync + overlay model
- All `credentials.json`, `token.json`, spreadsheet config obsoleted

#### Gemini Engine
- **MicroRunner pipeline** (ADR-014) — classify → context gate → validate
  - Task types: `reference_lookup`, `dock_planning`, `fleet_query`, `strategy_general`
  - T2 reference packs injected on demand (not always in prompt)
  - Output validation against authority ladder
- **Drydock briefing injection** — system prompt includes dock summary
- **Session tracking** — `getSessionCount()` for diagnostics

### Improved
- **Security hardening** — server-side input validation on all PATCH routes
  - Level 1–200, tier 1–10, power 0–999M, rank 50 chars, targetNote 500 chars
  - CSS.escape() for user-generated selectors
  - TOCTOU race fix (overlay writes wrapped in transactions)
  - Stale closure fix in tab management
  - Double-fire blur+debounce prevention
- **Error handling** — consistent `ErrorCode` enum, structured error responses
- **Logging** — Pino structured JSON logs (`MAJEL_LOG_PRETTY=true` for dev)
- **Test coverage** — 13 test files, 512 tests via Vitest
- **Diagnostic depth** — `/api/diagnostic` shows frame counts, DB paths, uptime

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
