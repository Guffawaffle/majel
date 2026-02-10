# Majel — STFC Fleet Intelligence System

*Named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of Starfleet computers across four decades of Star Trek.*

A local fleet management and AI advisor for **Star Trek Fleet Command**, powered by **Gemini 2.5 Flash** and **[Lex](https://github.com/Guffawaffle/lex)** episodic memory. The in-character assistant, **Ariadne** ("Aria"), combines wiki-sourced reference data, your personal fleet overlays, and full game/lore knowledge into a conversational interface that actually knows your fleet.

> **Status:** v0.4.0 alpha — functional, local-only, actively developed.

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

See [docs/SETUP.md](docs/SETUP.md) for detailed setup.

---

## What It Does

Majel is a **five-view single-page application** with an LCARS-inspired UI:

| View | Purpose |
|------|---------|
| **Chat** | Conversational AI advisor with persistent memory. Ask about officers, crews, strategy, lore — anything. |
| **Catalog** | Browse 174 officers and 54 ships imported from the STFC Fandom wiki. Overlay your own levels, tiers, and notes. |
| **Fleet** | Inline-editable fleet roster. Track power, rank, tier, level, and priority for every officer and ship you own. |
| **Drydock** | Build and manage ship loadouts. Assign officers to bridge seats, save presets, tag and search configurations. |
| **Diagnostics** | Natural-language query tool backed by AI. Ask questions about your data and get answers with SQL transparency. |

### Key Features

- **Wiki-sourced reference data** — officer and ship catalogs imported from the STFC Fandom wiki, with canonical entity IDs (`wiki:officer:<pageId>`)
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
                       │ HTTP/JSON (56 endpoints)
┌──────────────────────▼───────────────────────────────────┐
│                Express Server (:3000)                     │
│                                                           │
│  /api/catalog/*    Officer & ship reference + overlays    │
│  /api/dock/*       Drydock loadouts, presets, tags        │
│  /api/diagnostic/* AI-powered natural-language queries    │
│  /api/chat         Gemini conversation via MicroRunner    │
│  /api/sessions/*   Multi-session management               │
│  /api/settings/*   User preferences                       │
│  /api/health       Status + version                       │
└──┬──────────────┬──────────────┬─────────────────────────┘
   │              │              │
   ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌────────────┐
│ Gemini │  │  SQLite   │  │    Lex     │
│  2.5   │  │ (4 DBs)  │  │ Memory DB  │
│ Flash  │  │reference │  │(workspace- │
│(brute  │  │settings  │  │ isolated,  │
│ force  │  │chat      │  │ semantic   │
│context)│  │behavior  │  │ recall)    │
└────────┘  └──────────┘  └────────────┘
```

### Data Model

Majel uses a **reference + overlay** architecture (ADR-016):

- **Reference store** — immutable wiki-sourced data (stats, abilities, faction, rarity). Bulk-synced from the STFC Fandom wiki.
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
npm run dev          # Development server with hot reload (tsx watch)
npm run build        # Compile TypeScript + copy static assets
npm start            # Production server (from dist/)
npm test             # Run test suite (512 tests via Vitest)
npm run typecheck    # Type-check without emitting
npm run local-ci     # Full CI pipeline: typecheck + coverage + build
npm run health       # Curl the health endpoint
```

---

## Project Structure

```
majel/
├── src/
│   ├── server/
│   │   ├── index.ts             # Express server bootstrap
│   │   ├── gemini.ts            # Gemini API + system prompt builder
│   │   ├── micro-runner.ts      # MicroRunner pipeline (classify → gate → validate)
│   │   ├── reference-store.ts   # Wiki-sourced officer/ship data (read-only)
│   │   ├── overlay-store.ts     # User overlays (level, tier, notes)
│   │   ├── dock-store.ts        # Drydock loadouts + presets
│   │   ├── wiki-ingest.ts       # STFC Fandom wiki scraper/importer
│   │   ├── memory.ts            # Lex memory integration
│   │   ├── behavior-store.ts    # Behavioral correction rules
│   │   ├── sessions.ts          # Multi-session management
│   │   ├── settings.ts          # User preferences store
│   │   ├── config.ts            # Environment config
│   │   ├── logger.ts            # Pino structured logging
│   │   ├── envelope.ts          # API response envelope
│   │   ├── app-context.ts       # Dependency injection context
│   │   └── routes/
│   │       ├── core.ts          # /api, /api/health, /api/chat, /api/history, /api/recall
│   │       ├── catalog.ts       # /api/catalog/* (officers, ships, overlays, sync)
│   │       ├── docks.ts         # /api/dock/* (loadouts, presets, tags)
│   │       ├── diagnostic-query.ts  # /api/diagnostic/* (AI query tool)
│   │       ├── chat.ts          # /api/chat (POST)
│   │       ├── sessions.ts      # /api/sessions/*
│   │       └── settings.ts      # /api/settings/*
│   └── client/
│       ├── index.html           # SPA shell + LCARS theme
│       ├── app.js               # Router + tab management
│       ├── api.js               # Fetch wrapper
│       ├── chat.js              # Chat view
│       ├── catalog.js           # Catalog browser view
│       ├── fleet.js             # Fleet roster view (inline editing)
│       ├── drydock.js           # Drydock loadout builder
│       ├── diagnostics.js       # AI diagnostic query view
│       ├── sessions.js          # Session management
│       ├── confirm-dialog.js    # Reusable confirmation modal
│       └── styles.css           # LCARS-inspired dark theme
├── test/                        # 13 test files, 512 tests (Vitest)
├── docs/
│   ├── ADR-001 through ADR-017  # Architecture Decision Records
│   ├── PROMPT_GUIDE.md          # Prompt engineering reference
│   └── SETUP.md                 # Developer setup guide
├── legacy/
│   ├── majel.py                 # Original Python CLI prototype
│   └── requirements.txt
├── package.json
├── tsconfig.json
├── .env.example
└── CHANGELOG.md
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/generative-ai` | Gemini 2.5 Flash SDK |
| `@smartergpt/lex` | Episodic memory (conversation persistence + recall) |
| `better-sqlite3` | SQLite driver for reference, overlay, dock, and settings stores |
| `express` | HTTP server |
| `pino` / `pino-http` | Structured JSON logging |
| `dotenv` | Environment configuration |

---

## Privacy & Cost

- **Privacy**: Gemini paid tier — no training on prompts/responses. All fleet data stored locally in SQLite.
- **Cost**: Target <$2/month. Gemini 2.5 Flash is ≈$0.075/1M input tokens.
- **Local-only**: Nothing leaves your machine except Gemini API calls.

---

## Lex Proof of Concept

Majel serves as a public proof-of-concept for [Lex](https://github.com/Guffawaffle/lex), an episodic memory framework for AI agents. The integration demonstrates:

- **Frame-based memory** — each conversation turn becomes a Lex frame with structured metadata
- **Semantic recall** — search past conversations by meaning, not just keywords
- **Workspace isolation** — Majel's memory DB is separate from any global Lex installation
- **Zero configuration** — `createFrameStore()` handles all SQLite setup automatically

---

## License

ISC — see [LICENSE](LICENSE).

---

*Live long and prosper.* 🖖
