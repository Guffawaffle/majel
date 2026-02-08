# Majel — STFC Fleet Intelligence System

*Named in honor of Majel Barrett-Roddenberry (1932–2008), the voice of Starfleet computers across four decades of Star Trek.*

A local web assistant for Star Trek Fleet Command, powered by **Gemini 2.5 Flash-Lite** and **[Lex](https://github.com/Guffawaffle/lex)** episodic memory.

Majel ingests your STFC officer roster from Google Sheets, injects it into a system prompt alongside full game/lore knowledge, and gives you a conversational AI that actually knows your fleet.

> **Status:** MVP (v0.2) — functional, local-only, actively developed.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Guffawaffle/majel.git
cd majel
npm install

# 2. Configure
cp .env.example .env
# Edit .env — GEMINI_API_KEY is required, Sheets is optional

# 3. Run
npm run dev

# 4. Open http://localhost:3000
```

See [docs/SETUP.md](docs/SETUP.md) for detailed setup including Google Sheets OAuth walkthrough.

## What It Does

- **Roster intelligence** — dumps your full STFC roster into Gemini's context window. Ask about specific officers, crew compositions, stats.
- **Full training knowledge** — Majel isn't limited to your roster. She knows STFC meta, Star Trek lore, and general topics.
- **Conversation memory** — every turn is stored via Lex. Persists across restarts, supports semantic recall.
- **In-character** — Majel is the ship's computer. Dry wit, quiet authority, occasional Trek references.

## Architecture

```
┌──────────────────────────────────────────────┐
│                Browser UI                     │
│    LCARS-inspired dark theme chat interface   │
└──────────────┬───────────────────────────────┘
               │ HTTP/JSON
┌──────────────▼───────────────────────────────┐
│              Express Server (:3000)           │
│                                               │
│  GET  /api/health    Status check             │
│  GET  /api/roster    Fetch from Sheets        │
│  POST /api/chat      Send message → Gemini    │
│  GET  /api/history   Conversation timeline    │
│  GET  /api/recall    Search Lex memory        │
└──┬───────────┬──────────────┬────────────────┘
   │           │              │
   ▼           ▼              ▼
┌──────┐  ┌────────┐  ┌────────────┐
│Sheets│  │ Gemini │  │    Lex     │
│ API  │  │2.5-Lite│  │ Memory DB  │
│(OAuth│  │(Brute  │  │(SQLite,    │
│ flow)│  │ force  │  │ workspace- │
│      │  │context)│  │ isolated)  │
└──────┘  └────────┘  └────────────┘
```

### Brute-Force Context Injection

Majel dumps the entire roster spreadsheet (CSV) into Gemini's system prompt every session. With a 1M token context window and a ~30K token roster, this is deterministic and simple — no RAG, no vector DB, no retrieval errors.

### Lex Memory Integration

Every conversation turn is stored as a Lex frame. This gives you:
- **Persistent history** across server restarts
- **Semantic search** ("What did we discuss about Kirk?")
- **Timeline queries** (last 20 conversations)

Memory is workspace-isolated: `LEX_WORKSPACE_ROOT=/srv/majel` ensures Majel's DB lives at `/srv/majel/.smartergpt/lex/memory.db` — your global Lex DB is never touched.

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | API key from [AI Studio](https://aistudio.google.com/apikey) |

### Optional (Google Sheets)

| Variable | Description |
|----------|-------------|
| `MAJEL_SPREADSHEET_ID` | Spreadsheet ID from the URL |
| `MAJEL_SHEET_RANGE` | Cell range (default: `Sheet1!A1:Z1000`) |

To use Google Sheets:

1. Enable the **Google Sheets API** in [Google Cloud Console](https://console.cloud.google.com/)
2. Create an **OAuth 2.0 Client ID** (Desktop app type)
3. Download the JSON as `credentials.json` in the project root
4. Set `MAJEL_SPREADSHEET_ID` in `.env`
5. First run opens a browser for OAuth consent; token is cached in `token.json`

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `MAJEL_PORT` | Server port | `3000` |
| `LEX_WORKSPACE_ROOT` | Lex database location | `/srv/majel` |

## Scripts

```bash
npm run dev        # Development server with hot reload (tsx watch)
npm run build      # Compile TypeScript + copy static assets
npm start          # Production server (from dist/)
npm run typecheck  # Type-check without emitting
```

## Project Structure

```
/srv/majel/
├── src/
│   ├── server/
│   │   ├── index.ts      # Express server + routes
│   │   ├── sheets.ts     # Google Sheets OAuth + CSV fetch
│   │   ├── gemini.ts     # Gemini API wrapper + system prompt
│   │   └── memory.ts     # Lex memory integration
│   └── client/
│       ├── index.html     # Chat UI
│       ├── app.js         # Frontend logic
│       └── styles.css     # LCARS-inspired dark theme
├── legacy/
│   ├── majel.py           # Original Python CLI prototype
│   └── requirements.txt   # Python deps
├── docs/
│   ├── ADR-001-architecture.md
│   ├── ADR-002-framework.md
│   ├── PROMPT_GUIDE.md    # How we tune Majel's behavior
│   └── SETUP.md           # DX setup walkthrough
├── package.json
├── tsconfig.json
├── .env.example
└── ASSIGNMENT.md
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@smartergpt/lex` | Episodic memory (conversation persistence + recall) |
| `@google/generative-ai` | Gemini 2.5 Flash-Lite SDK |
| `googleapis` | Google Sheets API + OAuth |
| `express` | HTTP server |
| `dotenv` | Environment configuration |

## Privacy & Cost

- **Privacy**: Gemini paid tier — no training on prompts/responses. Lex stores locally in SQLite.
- **Cost**: Target <$2/month. Gemini 2.5 Flash-Lite is ~$0.075/1M input tokens.
- **Local-only**: Nothing leaves your machine except Gemini API calls.

## Lex Proof of Concept

Majel serves as a public proof-of-concept for [Lex](https://github.com/Guffawaffle/lex), an episodic memory framework for AI agents. The integration demonstrates:

- **Frame-based memory** — each conversation turn becomes a Lex frame with structured metadata
- **Semantic recall** — search past conversations by meaning, not just keywords
- **Workspace isolation** — Majel's memory DB is separate from any global Lex installation
- **Zero configuration** — `createFrameStore()` handles all SQLite setup automatically

## License

MIT — see [LICENSE](LICENSE).

---

*Live long and prosper.* 🖖
