# Majel — STFC Fleet Intelligence System

*Named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of Starfleet computers across four decades of Star Trek.*

A fleet management and AI advisor for **Star Trek Fleet Command**, powered by **Gemini** and **[Lex](https://github.com/Guffawaffle/lex)** episodic memory. The in-character assistant, **Ariadne** ("Aria"), combines CDN-sourced reference data, your personal fleet overlays, and full game/lore knowledge into a conversational interface that actually knows your fleet.

> **Status:** v0.5.0 alpha — functional, cloud-deployed, actively developed.
>
> **Production:** [majel-bbqfhcihga-uc.a.run.app](https://majel-bbqfhcihga-uc.a.run.app)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Guffawaffle/majel.git
cd majel
npm install

# 2. Configure
cp .env.example .env
# Edit .env — add your GEMINI_API_KEY (only required variable)

# 3. Run
npm run dev

# 4. Open http://localhost:3000
```

See [docs/SETUP.md](docs/SETUP.md) for detailed setup including PostgreSQL and cloud deployment.

---

## What It Does

Majel is a **five-view single-page application** with an LCARS-inspired UI:

| View | Purpose |
|------|---------|
| **Chat** | Conversational AI advisor with persistent memory. Ask about officers, crews, strategy, lore — anything. |
| **Catalog** | Browse 530+ ships and 278+ officers from the STFC CDN data pipeline. Overlay your own levels, tiers, and notes. |
| **Fleet** | Inline-editable fleet roster. Track power, rank, tier, level, and priority for every officer and ship you own. |
| **Drydock** | Build and manage ship loadouts. Assign officers to bridge seats, save presets, tag and search configurations. |
| **Diagnostics** | Natural-language query tool backed by AI. Ask questions about your data and get answers with SQL transparency. |

### Key Features

- **CDN-sourced reference data** — officer and ship catalogs synced from data.stfc.space, with canonical entity IDs (`cdn:officer:<gameId>`, `cdn:ship:<gameId>`)
- **Personal overlays** — your levels, tiers, notes, and target priorities stored separately from reference data. Never lost on re-sync.
- **Brute-force context injection** — reference data is injected directly into Gemini's system prompt. No RAG, no vector DB, no retrieval errors.
- **MicroRunner pipeline** — classifies each message, gates context injection by task type, and validates responses against the authority ladder
- **Conversation memory** — every turn is stored via Lex. Persists across restarts, supports semantic recall.
- **In-character** — Aria is the ship's computer. Dry wit, quiet authority, occasional Trek references.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Browser SPA                           │
│   5 views: Chat │ Catalog │ Fleet │ Drydock │ Diagnostics │
│              LCARS-inspired dark theme                    │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP/JSON (56+ endpoints)
┌──────────────────────▼───────────────────────────────────┐
│                Express Server (:3000)                      │
│                                                           │
│  Auth:  4-tier RBAC (Ensign → Admiral) + Bearer tokens    │
│  API:   Envelope pattern { ok, data|error, meta }         │
│                                                           │
│  /api/catalog/*    Officer & ship reference + overlays    │
│  /api/crew/*       Crew composition (ADR-025)             │
│  /api/targets/*    Fleet targets & goals                  │
│  /api/diagnostic/* AI-powered natural-language queries    │
│  /api/chat         Gemini conversation via MicroRunner    │
│  /api/sessions/*   Multi-session management               │
│  /api/settings/*   User preferences                       │
│  /api/models/*     Gemini model hot-swap (5 tiers)        │
│  /api/health       Status + version                       │
└──┬──────────────┬──────────────┬─────────────────────────┘
   │              │              │
   ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌────────────┐
│ Gemini │  │PostgreSQL│  │    Lex     │
│  2.5   │  │   16     │  │ Memory     │
│(5 model│  │reference │  │(PostgreSQL │
│ tiers, │  │overlays  │  │ frame      │
│ hot-   │  │docks     │  │ store,     │
│ swap)  │  │sessions  │  │ per-user   │
│        │  │settings  │  │ RLS)       │
└────────┘  └──────────┘  └────────────┘
```

### Data Model

Majel uses a **reference + overlay** architecture (ADR-016):

- **Reference store** — immutable CDN-sourced data (stats, abilities, faction, rarity). Bulk-synced from data.stfc.space.
- **Overlay store** — your personal data (level, tier, rank, power, notes, targets). Survives re-syncs. Stored as sparse deltas.
- **Dock store** — ship loadouts with officer assignments, presets, and tags.

### Lex Memory Integration

Every conversation turn is stored as a Lex frame:
- **Persistent history** across server restarts
- **Semantic search** ("What did we discuss about Kirk?")
- **Timeline queries** (last 20 conversations)

Memory is workspace-isolated — Majel's DB lives at `.smartergpt/lex/` and never touches a global Lex installation.

---

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | API key from [AI Studio](https://aistudio.google.com/apikey) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `MAJEL_PORT` | Server port | `3000` |
| `LEX_WORKSPACE_ROOT` | Lex database location | `/srv/majel` |

---

## Scripts

```bash
npm run dev:full     # Start PostgreSQL + API server + Vite dev server (all-in-one)
npm run dev          # API server only with hot reload (tsx watch)
npm run build        # Compile TypeScript + copy static assets
npm start            # Production server (from dist/)
npm test             # Run test suite (1,361 server + 174 frontend tests via Vitest)
npm run typecheck    # Type-check without emitting
npm run local-ci     # Full CI pipeline: typecheck + coverage + build
npm run health       # Curl the health endpoint
```

### Cloud Operations

```bash
npm run cloud                    # Show all commands, tiers, and usage
npm run cloud:status             # Service status, URL, revision, scaling
npm run cloud:deploy             # Full pipeline: local-ci → build → deploy → health
npm run cloud:logs               # Tail production logs
npm run cloud:metrics            # Log-based metrics (latency, errors, 1h window)
npm run cloud:costs              # Estimated monthly costs
npm run cloud:status -- --ax     # Structured JSON for AI agent consumption
```

See `npm run cloud` for the full 20-command reference with auth tiers.

---

## Project Structure

```
majel/
├── src/
│   ├── server/
│   │   ├── index.ts             # Express server bootstrap
│   │   ├── app-context.ts       # Dependency injection (AppState)
│   │   ├── config.ts            # Environment config resolver
│   │   ├── gemini.ts            # Gemini API + 5-tier model registry
│   │   ├── micro-runner.ts      # MicroRunner pipeline (classify → gate → validate)
│   │   ├── envelope.ts          # API response envelope (sendOk/sendFail + hints)
│   │   ├── auth.ts              # 4-tier RBAC middleware (ADR-019)
│   │   ├── user-store.ts        # User accounts + sessions
│   │   ├── memory.ts            # Lex memory integration
│   │   ├── memory-middleware.ts  # Per-user scoped memory (RLS)
│   │   ├── reference-store.ts   # CDN-sourced officer/ship data (read-only)
│   │   ├── overlay-store.ts     # User overlays (level, tier, notes)
│   │   ├── crew-store.ts         # Crew composition store (ADR-025)
│   │   ├── crew-types.ts        # Crew composition types (ADR-025)
│   │   ├── sessions.ts          # Multi-session management
│   │   ├── settings.ts          # User preferences store
│   │   ├── logger.ts            # Pino structured logging
│   │   └── routes/
│   │       ├── core.ts          # /api, /api/health, /api/diagnostic
│   │       ├── chat.ts          # /api/chat, /api/history, /api/recall, /api/models
│   │       ├── catalog.ts       # /api/catalog/* (officers, ships, overlays, sync)
│   │       ├── crews.ts         # /api/crew/* (ADR-025 composition CRUD)
│   │       ├── targets.ts       # /api/targets/* (fleet goals)
│   │       ├── receipts.ts      # /api/import/* (import receipts)
│   │       ├── diagnostic-query.ts  # /api/diagnostic/* (AI query tool)
│   │       ├── sessions.ts      # /api/sessions/*
│   │       └── settings.ts      # /api/settings/*
│   └── client/
│       ├── index.html           # SPA shell + LCARS theme
│       ├── app.js               # Router + tab management
│       ├── api.js               # Fetch wrapper
│       ├── chat.js, catalog.js, fleet.js, diagnostics.js
│       └── styles.css           # LCARS-inspired dark theme
├── scripts/
│   └── cloud.ts                 # Cloud operations CLI (20 commands, AX mode)
├── test/                        # 42 test files, 1,348 tests (Vitest)
├── docs/
│   ├── ADR-001 through ADR-022  # Architecture Decision Records
│   ├── AX-SCHEMA.md             # AI agent response format reference
│   ├── PROMPT_GUIDE.md          # Prompt engineering reference
│   └── SETUP.md                 # Developer setup guide
├── legacy/
│   └── majel.py                 # Original Python CLI prototype
├── BACKLOG.md                   # Issue tracker + tech debt
├── CHANGELOG.md                 # Release history
├── CONTRIBUTING.md              # Contributor guidelines
└── package.json
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini Gen AI SDK — 5 model tiers (flash-lite → 3-pro-preview) |
| `@smartergpt/lex` | Episodic memory — PostgreSQL frame store with per-user RLS |
| `pg` | PostgreSQL 16 driver (Cloud SQL) |
| `better-sqlite3` | Local SQLite for reference data caches |
| `cookie-parser` | Session cookie middleware |
| `express` | HTTP server |
| `pino` / `pino-http` | Structured JSON logging |
| `dotenv` | Environment configuration |

---

## Privacy & Cost

- **Privacy**: Gemini paid tier — no training on prompts/responses. Fleet data in Cloud SQL with per-user row-level security.
- **Cost**: Target <$5/month. Gemini 2.5 Flash ≈$0.075/1M input tokens. Cloud Run scales to zero. Cloud SQL f1-micro.
- **Data sovereignty**: Each user's memory and fleet data is isolated via PostgreSQL RLS. Admin queries are audited.

---

## Lex Proof of Concept

Majel serves as a public proof-of-concept for [Lex](https://github.com/Guffawaffle/lex), an episodic memory framework for AI agents. The integration demonstrates:

- **Frame-based memory** — each conversation turn becomes a Lex frame with structured metadata
- **Semantic recall** — search past conversations by meaning, not just keywords
- **Per-user isolation** — PostgreSQL row-level security scopes all memory by user_id
- **Production deployment** — `PostgresFrameStore` runs in Cloud SQL with connection pooling

---

## License

ISC — see [LICENSE](LICENSE).

---

*Live long and prosper.* 🖖
