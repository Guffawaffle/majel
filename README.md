# Majel — STFC Fleet Intelligence System

*Named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of Starfleet computers across four decades of Star Trek.*

A fleet intelligence and AI advisor for **Star Trek Fleet Command**, powered by **Gemini 2.5** and **[Lex](https://github.com/Guffawaffle/lex)** episodic memory. The in-character assistant, **Ariadne** ("Aria"), combines CDN-sourced reference data (530+ ships, 278+ officers), your personal fleet overlays, an effect-taxonomy-based crew recommender, and full game/lore knowledge into a conversational interface that actually knows your fleet.

> **Status:** v0.6.0 alpha — functional, cloud-deployed, actively developed.  
> **Tests:** 1,930 (1,361 server + 174 frontend + 395 effects/data) via Vitest  
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

Majel is an **eight-view single-page application** with an LCARS-inspired UI, 42 AI fleet tools, and realtime async operations:

| View | Purpose |
|------|---------|
| **Chat** | Conversational AI advisor with persistent memory, image upload, and async streaming. Ask about officers, crews, strategy, lore — anything. |
| **Catalog** | Browse 530+ ships and 278+ officers from the CDN data pipeline. Filter by ownership, target status, class, hull type. Bulk ownership toggles with undo. |
| **Fleet** | Inline-editable fleet roster. Track power, rank, tier, level, and priority. Cross-references to loadouts, docks, and reservations. |
| **Workshop** | Crew composition workshop — bridge cores, loadouts, below-deck policies, variants, officer reservations. Quick Crew and advanced modes. |
| **Plan** | Fleet planning — dock assignments, fleet presets, plan items, effective state views. |
| **Start/Sync** | Onboarding — guided setup templates by activity type, ops level config, import history, Aria introduction. |
| **Diagnostics** | Admin — system health, data summary, SQL query console with presets, schema browser, cache metrics. |
| **Admiral** | Admin — user management (roles, lock/unlock/delete), invite code generation, session management, audit log. |

### Key Features

- **42 AI fleet tools** — Aria can search officers/ships, suggest crews, analyze battles, simulate removals, plan upgrades, manage targets, create loadouts, and sync fleet data — all via Gemini function calling
- **Effect-taxonomy crew recommender** — 49+ effect types, intent-based scoring with synergy multipliers, CM hard gate, per-officer "why this crew" evidence
- **CDN-sourced reference data** — officer and ship catalogs synced from community game data, with canonical entity IDs (`cdn:officer:<gameId>`, `cdn:ship:<gameId>`)
- **Personal overlays** — your levels, tiers, notes, and target priorities stored separately from reference data. Never lost on re-sync.
- **MicroRunner pipeline** — classifies each message, gates context injection by task type, validates responses against the authority ladder
- **Conversation memory** — every turn stored via Lex with per-user RLS isolation. Persists across restarts, supports semantic recall.
- **Realtime async operations** — long-running AI calls stream progress via SSE. Survives refresh/reconnect with replay and snapshot recovery.
- **Local-first cache** — IndexedDB with stale-while-revalidate, ETag/304 conditional revalidation, multi-tab sync via BroadcastChannel. Zero network calls on tab switch.
- **Multi-timer overlay** — 10 concurrent timers with Web Audio alerts for mining cycles, research, ship travel
- **CSV/XLSX/JSON import** — bulk fleet data import with receipt tracking, undo, and translator configs
- **In-character** — Aria is the ship's computer. Configurable personality (humor, lore, verbosity, confirmation, proactive, formality). Dry wit, quiet authority, Trek references.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser SPA                                  │
│  8 views: Chat │ Catalog │ Fleet │ Workshop │ Plan │ Start/Sync      │
│                Diagnostics │ Admiral                                  │
│  LCARS dark theme │ Svelte 5 + Vite │ IndexedDB local-first cache    │
│  Multi-timer overlay │ BroadcastChannel multi-tab sync               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTP/JSON (56+ endpoints) + SSE streaming
┌──────────────────────────▼───────────────────────────────────────────┐
│                    Express Server (:3000)                              │
│                                                                       │
│  Auth:  4-tier RBAC (Ensign → Admiral) + Bearer tokens + invite codes │
│  API:   Envelope pattern { ok, data|error, meta, hints }              │
│  Rate:  Per-endpoint rate limiting (auth, chat, import, email)        │
│  Log:   Pino structured JSON logging                                  │
│                                                                       │
│  /api/catalog/*     530+ ships, 278+ officers + user overlays         │
│  /api/crew/*        Crew composition CRUD (ADR-025)                   │
│  /api/targets/*     Fleet goals + correction loops                    │
│  /api/chat          Gemini via MicroRunner (sync + async)             │
│  /api/events/*      SSE streaming + snapshot replay                   │
│  /api/effects/*     Effect taxonomy + runtime bundles                 │
│  /api/sessions/*    Multi-session management                          │
│  /api/settings/*    System + per-user preferences                     │
│  /api/import/*      CSV/XLSX/JSON pipeline + receipts                 │
│  /api/mutations/*   AI mutation proposals (propose/apply/decline)     │
│  /api/diagnostic/*  SQL query console (admiral-gated)                 │
│  /api/admiral/*     User/invite/session admin + audit log             │
│  /api/health        Status + version + subsystem checks               │
└──┬──────────────┬──────────────┬──────────────────────────────────────┘
   │              │              │
   ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌────────────┐
│ Gemini │  │PostgreSQL│  │    Lex     │
│  2.5   │  │   16     │  │ Memory     │
│        │  │          │  │            │
│5 model │  │19 stores │  │PostgreSQL  │
│ tiers  │  │27 canon. │  │frame store │
│42 fleet│  │ tables   │  │per-user    │
│ tools  │  │15 effect │  │RLS         │
│        │  │ tables   │  │isolation   │
└────────┘  └──────────┘  └────────────┘
```

### Data Model

Majel uses a **reference + overlay** architecture (ADR-016):

- **Reference store** — immutable CDN-sourced data (stats, abilities, faction, rarity). Bulk-synced from game data snapshot.
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
npm run cloud:deploy             # Full pipeline: local-ci → build → deploy → health → post-deploy checklist
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
│   │   ├── routes/              # 18 route files (auth, chat, catalog, crews, targets, events, ...)
│   │   ├── stores/              # 19 data stores (user, crew, reference, overlay, effect, ...)
│   │   └── services/
│   │       ├── gemini/          # Model registry, system prompt, Gemini integration
│   │       ├── fleet-tools/     # 42 AI fleet tools (declarations, read, mutate, dispatch)
│   │       ├── translator/      # External data translation
│   │       └── ...              # Auth, email, import mapping, plan solver, etc.
│   ├── shared/                  # Shared types between server + CLI (AX contracts)
│   └── landing/                 # Public landing page (pre-auth)
├── web/                         # Svelte 5 + Vite SPA
│   ├── src/
│   │   ├── views/               # 8 Svelte views
│   │   ├── components/          # 17+ components (chat, crew, timer, ...)
│   │   └── lib/                 # API layer, cache, game enums, crew logic, ...
│   └── vite.config.ts
├── scripts/
│   ├── ax/                      # AX toolkit (10 modular command files)
│   ├── ax.ts                    # AX router
│   └── cloud.ts                 # Cloud operations CLI (20 commands)
├── data/
│   ├── seed/                    # Effect taxonomy + fixtures
│   └── translators/             # External data translator configs
├── schemas/                     # 6 JSON schemas (intent, loadout, officer, ship, research, translator)
├── migrations/canonical/        # 27-table canonical schema (officers, ships, research, buildings, systems)
├── test/                        # 75+ test files, 1,930 tests (Vitest)
├── docs/
│   ├── ADR-001 through ADR-038  # Architecture Decision Records
│   ├── SETUP.md                 # Developer setup guide
│   ├── RUNBOOK.md               # Operations runbook
│   ├── PROMPT_GUIDE.md          # Prompt engineering reference
│   └── GAP_ANALYSIS_*.md        # Strategic feature gap tracking
├── BACKLOG.md                   # Sprint tracking + tech debt
├── CHANGELOG.md                 # Release history
├── CONTRIBUTING.md              # Contributor guidelines
└── package.json
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini Gen AI SDK — 5 model tiers (flash-lite → pro-preview) |
| `@smartergpt/lex` | Episodic memory — PostgreSQL frame store with per-user RLS |
| `pg` | PostgreSQL 16 driver (Cloud SQL / local Docker) |
| `exceljs` | XLSX import (replaced `xlsx` for security — zero CVEs) |
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
