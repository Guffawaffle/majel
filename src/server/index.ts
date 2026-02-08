/**
 * index.ts — Majel Express Server
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Endpoints:
 *   GET  /api/health   — Status check
 *   GET  /api/roster   — Fetch current roster from Sheets
 *   POST /api/chat     — Send message, get Gemini response
 *   GET  /api/history  — Conversation history from Lex
 *   GET  /api/recall   — Search Lex memory (query param: q)
 *
 * Static files served from src/client/ (dev) or dist/client/ (prod).
 */

import express from "express";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRoster, hasCredentials, type SheetsConfig } from "./sheets.js";
import { createGeminiEngine, type GeminiEngine } from "./gemini.js";
import { createMemoryService, type MemoryService } from "./memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.MAJEL_PORT || "3000", 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SPREADSHEET_ID = process.env.MAJEL_SPREADSHEET_ID || "";
const SHEET_RANGE = process.env.MAJEL_SHEET_RANGE || "Sheet1!A1:Z1000";

// ─── State ──────────────────────────────────────────────────────
let geminiEngine: GeminiEngine | null = null;
let memoryService: MemoryService | null = null;
let rosterCsv: string | null = null;
let rosterError: string | null = null;
let startupComplete = false;

// ─── App ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve static frontend files
// In dev (tsx): resolve from src/client relative to project root
// In prod (compiled): resolve from dist/client
const clientDir = process.env.NODE_ENV === "production"
  ? path.resolve(__dirname, "../client")
  : path.resolve(__dirname, "../../src/client");
app.use(express.static(clientDir));

// ─── API Routes ─────────────────────────────────────────────────

/**
 * GET /api/health — System status.
 */
app.get("/api/health", (_req, res) => {
  res.json({
    status: startupComplete ? "online" : "initializing",
    roster: rosterCsv ? { loaded: true, chars: rosterCsv.length } : { loaded: false, error: rosterError },
    gemini: geminiEngine ? "connected" : "not configured",
    memory: memoryService ? "active" : "not configured",
    credentials: hasCredentials(),
  });
});

/**
 * GET /api/roster — Fetch/refresh roster from Google Sheets.
 */
app.get("/api/roster", async (_req, res) => {
  if (!SPREADSHEET_ID) {
    return res.status(400).json({ error: "MAJEL_SPREADSHEET_ID not configured" });
  }

  try {
    const config: SheetsConfig = { spreadsheetId: SPREADSHEET_ID, range: SHEET_RANGE };
    rosterCsv = await fetchRoster(config);
    rosterError = null;

    // Re-create engine with fresh roster data
    if (GEMINI_API_KEY) {
      geminiEngine = createGeminiEngine(GEMINI_API_KEY, rosterCsv);
    }

    res.json({
      loaded: true,
      chars: rosterCsv.length,
      rows: rosterCsv.split("\n").length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    rosterError = message;
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/chat — Send message to Gemini, persist turn in Lex.
 * Body: { "message": "Who has the highest attack?" }
 */
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing 'message' in request body" });
  }

  if (!geminiEngine) {
    return res.status(503).json({
      error: "Gemini not ready. Check /api/health for status.",
    });
  }

  try {
    const answer = await geminiEngine.chat(message);

    // Persist to Lex memory (fire-and-forget, don't block the response)
    if (memoryService) {
      memoryService.remember({ question: message, answer }).catch((err) => {
        console.error("⚠️  Lex memory save failed:", err);
      });
    }

    res.json({ answer });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error("⚠️  Gemini error:", errMessage);
    res.status(500).json({ error: errMessage });
  }
});

/**
 * GET /api/history — Session conversation history + Lex timeline.
 * Query params: ?source=session|lex|both (default: both)
 *               &limit=20
 */
app.get("/api/history", async (req, res) => {
  const source = (req.query.source as string) || "both";
  const limit = parseInt((req.query.limit as string) || "20", 10);

  const result: {
    session?: Array<{ role: string; text: string }>;
    lex?: Array<{ id: string; timestamp: string; summary: string }>;
  } = {};

  if (source === "session" || source === "both") {
    result.session = geminiEngine?.getHistory() || [];
  }

  if ((source === "lex" || source === "both") && memoryService) {
    try {
      const frames = await memoryService.timeline(limit);
      result.lex = frames.map((f) => ({
        id: f.id,
        timestamp: f.timestamp,
        summary: f.summary_caption,
      }));
    } catch (err) {
      console.error("⚠️  Lex timeline error:", err);
      result.lex = [];
    }
  }

  res.json(result);
});

/**
 * GET /api/recall?q=Kirk — Search Lex memory.
 */
app.get("/api/recall", async (req, res) => {
  const query = req.query.q as string;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter 'q'" });
  }

  if (!memoryService) {
    return res.status(503).json({ error: "Memory service not available" });
  }

  try {
    const limit = parseInt((req.query.limit as string) || "10", 10);
    const frames = await memoryService.recall(query, limit);
    res.json({
      query,
      results: frames.map((f) => ({
        id: f.id,
        timestamp: f.timestamp,
        summary: f.summary_caption,
        reference: f.reference_point,
        keywords: f.keywords,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── SPA Fallback ───────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  console.log("⚡ Majel initializing...");

  // 1. Initialize Lex memory (always — it's local)
  try {
    memoryService = createMemoryService();
    console.log("✅ Lex memory service online");
  } catch (err) {
    console.error("⚠️  Lex memory init failed:", err);
  }

  // 2. Initialize Gemini (doesn't need roster yet)
  if (GEMINI_API_KEY) {
    const csv = "No roster data loaded yet.";
    geminiEngine = createGeminiEngine(GEMINI_API_KEY, csv);
    console.log("✅ Gemini engine online (model: gemini-2.5-flash-lite)");
  } else {
    console.warn("⚠️  GEMINI_API_KEY not set — chat disabled");
  }

  startupComplete = true;

  // 3. Start HTTP server FIRST — always be reachable
  app.listen(PORT, () => {
    console.log(`\n🖖 Majel online — http://localhost:${PORT}`);
    console.log("   Awaiting input, Admiral.\n");
  });

  // 4. Load roster AFTER server is up (OAuth may be interactive)
  if (SPREADSHEET_ID && hasCredentials()) {
    try {
      console.log("   Connecting to Starfleet Database (Google Sheets)...");
      console.log("   ⏳ If OAuth is needed, a URL will appear below. You have 3 minutes.\n");
      const config: SheetsConfig = { spreadsheetId: SPREADSHEET_ID, range: SHEET_RANGE };
      rosterCsv = await fetchRoster(config);
      rosterError = null;
      console.log(`✅ Roster loaded (${rosterCsv.length.toLocaleString()} chars)`);

      // Re-create Gemini engine with roster data
      if (GEMINI_API_KEY) {
        geminiEngine = createGeminiEngine(GEMINI_API_KEY, rosterCsv);
        console.log("✅ Gemini engine refreshed with roster data");
      }
    } catch (err: unknown) {
      rosterError = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  Roster load deferred: ${rosterError}`);
      console.warn("   Roster can be loaded later via GET /api/roster");
    }
  } else {
    if (!SPREADSHEET_ID) {
      console.warn("⚠️  MAJEL_SPREADSHEET_ID not set — roster disabled");
    }
    if (!hasCredentials()) {
      console.warn("⚠️  credentials.json not found — Google Sheets OAuth disabled");
    }
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────
async function shutdown(): Promise<void> {
  console.log("\n   Majel offline. Live long and prosper. 🖖");
  if (memoryService) {
    await memoryService.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Launch ─────────────────────────────────────────────────────
boot().catch((err) => {
  console.error("💥 Fatal startup error:", err);
  process.exit(1);
});
