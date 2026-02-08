# Majel v0.2 — Assignment Brief

**Workspace:** `/srv/majel`  
**Date:** 2026-02-07  
**From:** Opie (previous session)  
**To:** Agent in Majel workspace

---

## Mission

Evolve Majel from a Python CLI prototype to a TypeScript/Node.js application with:
1. **Lex integration** — Episodic memory for conversation history
2. **Web frontend** — Local browser UI (same stack as lex-mcp)
3. **Gemini backend** — Keep the brute-force context injection architecture

---

## Current State (v0.1)

```
/srv/majel/
├── majel.py              # Python CLI (working prototype)
├── requirements.txt      # Python deps
├── .venv/                # Python venv
├── credentials.json      # Google OAuth (user provides)
├── token.json            # Cached OAuth token
├── docs/ADR-001-architecture.md
└── README.md
```

**What works:**
- OAuth flow for Google Sheets
- CSV fetch and context injection
- Gemini 2.5 Flash-Lite chat loop
- Strict system prompt (no hallucinations)

**What's missing:**
- Persistent chat history (currently lost on restart)
- Web UI (currently terminal-only)
- Lex memory integration

---

## Target State (v0.2)

```
/srv/majel/
├── src/
│   ├── server/
│   │   ├── index.ts          # Express/Fastify server
│   │   ├── sheets.ts         # Google Sheets OAuth + fetch
│   │   ├── gemini.ts         # Gemini API wrapper
│   │   └── memory.ts         # Lex integration
│   └── client/
│       ├── index.html        # Simple SPA
│       ├── app.ts            # Frontend logic
│       └── styles.css
├── package.json
├── tsconfig.json
├── .env.example
└── [keep existing docs/]
```

---

## Requirements

### 1. Lex Integration

**Import Lex:**
```typescript
import { MemoryStore } from '@smartergpt/lex';
// or
import { remember, recall } from '@smartergpt/lex';
```

**Use cases:**
- Store each conversation turn as a frame
- Recall relevant past conversations for context
- Timeline queries ("What did we discuss about Kirk?")

**Reference:**
- Lex is at `/srv/lex-mcp/lex`
- MCP wrapper at `/srv/lex-mcp/lex-mcp`
- See `lex/src/memory/store/` for store API

### 2. Frontend

**Stack:** Vanilla TypeScript + HTML (keep it simple)

**MVP features:**
- Chat interface (messages in/out)
- Roster data indicator (loaded/error)
- Connection status

**No frameworks required.** This is a local tool, not a production app. Plain HTML + fetch is fine.

### 3. Backend

**Stack:** Node.js + TypeScript + Express (or Fastify)

**Endpoints:**
```
GET  /api/health          # Status check
GET  /api/roster          # Fetch current roster (from Sheets)
POST /api/chat            # Send message, get response
GET  /api/history         # Get conversation history (from Lex)
```

**Environment variables:**
```
GEMINI_API_KEY=xxx
MAJEL_SPREADSHEET_ID=xxx
MAJEL_SHEET_RANGE=Sheet1!A1:Z1000
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
```

### 4. Google Auth (Server-Side)

The Python version uses desktop OAuth. For a web server:
- Option A: Keep desktop flow, run OAuth on first startup (simpler)
- Option B: Use service account (no browser needed, but more setup)

**Recommendation:** Start with Option A, same as Python prototype.

---

## Dependencies to Add

```json
{
  "dependencies": {
    "@smartergpt/lex": "^2.1.2",
    "@google/generative-ai": "^0.21.0",
    "googleapis": "^140.0.0",
    "express": "^4.18.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@types/express": "^4.17.0",
    "tsx": "^4.7.0"
  }
}
```

---

## Migration Path

1. **Init Node.js project** (keep Python as reference)
   ```bash
   cd /srv/majel
   npm init -y
   npm install @smartergpt/lex @google/generative-ai googleapis express dotenv
   npm install -D typescript @types/node @types/express tsx
   npx tsc --init
   ```

2. **Port sheets.ts** — Copy OAuth logic from `majel.py`

3. **Port gemini.ts** — Same system prompt, different SDK

4. **Add memory.ts** — Wire up Lex store

5. **Add server** — Express with the 4 endpoints

6. **Add frontend** — Static HTML served by Express

7. **Test end-to-end**

---

## Key Files to Reference

| What | Where |
|------|-------|
| Lex memory store | `/srv/lex-mcp/lex/src/memory/store/` |
| Lex MCP wrapper | `/srv/lex-mcp/lex-mcp/index.mjs` |
| Python prototype | `/srv/majel/majel.py` |
| Architecture ADR | `/srv/majel/docs/ADR-001-architecture.md` |

---

## Constraints

- **Local-only** — No cloud hosting, runs on Guff's machine
- **Privacy** — Gemini paid tier (no training), Lex stores locally
- **Low cost** — Target <$2/month API costs
- **Named for Majel Barrett-Roddenberry** — Keep the tribute in README/docstrings

---

## Definition of Done

- [ ] `npm start` launches server on localhost:3000
- [ ] Browser UI shows chat interface
- [ ] Can query roster data ("Who has the highest attack?")
- [ ] Conversation history persists via Lex
- [ ] `lex recall "topic"` returns relevant past conversations
- [ ] Python prototype can be archived (not deleted)

---

## Questions for Guff

Before starting:
1. Port preference? (3000? 8080? Something else?)
2. Keep Python version as `/srv/majel/legacy/majel.py` or separate?
3. Any specific Lex frame schema you want for chat history?

---

*End of assignment. Good luck, Agent.* 🖖

---

## CRITICAL: Database Isolation

**Your global Lex database will NOT be polluted.**

Lex supports workspace isolation via environment variables:

```bash
# Set this BEFORE running Majel
export LEX_WORKSPACE_ROOT=/srv/majel
```

This makes Lex use:
```
/srv/majel/.smartergpt/lex/memory.db  ← Majel's isolated DB
```

Instead of:
```
~/.smartergpt/lex/memory.db           ← Your global DB (untouched)
```

### Setup

```bash
# Copy and edit .env
cp /srv/majel/.env.example /srv/majel/.env
# Edit .env with your API keys

# The .env file sets LEX_WORKSPACE_ROOT=/srv/majel
# Node.js with dotenv will pick this up automatically
```

### Verification

After running Majel once, confirm isolation:
```bash
ls -la /srv/majel/.smartergpt/lex/
# Should see: memory.db (Majel's DB)

ls -la ~/.smartergpt/lex/
# Your global DB should be unchanged
```
