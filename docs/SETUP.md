# Majel — Developer Setup Guide

Step-by-step setup for Majel. You'll need about 2 minutes.

---

## 1. Gemini API Key (Required — 60 seconds)

The AI engine. Free tier works fine for personal use.

### Steps

1. Go to **[Google AI Studio → API Keys](https://aistudio.google.com/apikey)**
2. Sign in with your Google account
3. Click **"Create API key"**
4. If prompted, select your existing project (e.g., "Majel") or create one
5. Copy the key (starts with `AIzaSy...`)
6. Open `/srv/majel/.env` and paste it:

```env
GEMINI_API_KEY=AIzaSy...your-key-here
```

### Verify

```bash
# Quick test (replace with your key)
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY" | head -5
```

If you see JSON with model names, the key works.

### Cost

Gemini 2.5 Flash: ~$0.075 per million input tokens. A typical session uses ~30K tokens = **less than $0.01 per session**.

---

## 2. Configure .env

```bash
cp .env.example .env
```

Your `.env` should look like:

```env
# === Gemini (Required) ===
GEMINI_API_KEY=AIzaSy...your-actual-key

# === Server (Optional) ===
MAJEL_PORT=3000

# === Isolation (Lex uses its own DB, not your global one) ===
LEX_WORKSPACE_ROOT=/srv/majel
```

That's it — only `GEMINI_API_KEY` is required.

---

## 3. Install & Run

```bash
cd /srv/majel
npm install
npm run dev
```

Open http://localhost:3000 — you should see the LCARS-themed UI with five tabs: Chat, Catalog, Fleet, Drydock, and Diagnostics.

### First-Time Data

The Catalog starts empty. Click **"Sync from Wiki"** in the Catalog view to import officers and ships from the STFC Fandom wiki. This populates the reference store that all other views draw from.

---

## 4. Scripts Reference

```bash
npm run dev          # Development server with hot reload
npm run build        # Compile TypeScript + copy static assets
npm start            # Production server (from dist/)
npm test             # Run 512 tests via Vitest
npm run local-ci     # Full CI: typecheck + coverage + build
npm run health       # Curl the health endpoint
npm run dev:bg       # Run in background (logs to logs/dev.log)
npm run dev:stop     # Stop background server
npm run dev:wipe     # Wipe reference.db (forces full re-sync)
```

---

## Troubleshooting

### "GEMINI_API_KEY is not set"
Create a `.env` file from the example and add your API key (see Step 1).

### SQLite build errors on install
Majel uses `better-sqlite3`, which requires a native build step. Ensure you have build tools:
```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# macOS
xcode-select --install
```

If tests fail with SQLite errors after a Node.js upgrade, try:
```bash
npm run rebuild-sqlite   # or: npm rebuild better-sqlite3
```

### Port already in use
```bash
npm run kill    # Frees port 3000 (or whatever MAJEL_PORT is set to)
npm run dev
```

### Wiki sync fails
The sync scrapes the STFC Fandom wiki. If it fails, check your network connection. The sync is idempotent — safe to retry.
