/**
 * index.ts — Majel Express Server
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Endpoints:
 *   GET  /api/health   — Status check
 *   GET  /api/roster   — Fetch/refresh roster from Sheets
 *   POST /api/chat     — Send message, get Gemini response
 *   GET  /api/history  — Conversation history from Lex
 *   GET  /api/recall   — Search Lex memory (query param: q)
 *
 * Static files served from src/client/ (dev) or dist/client/ (prod).
 */

import express from "express";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchRoster,
  fetchFleetData,
  hasCredentials,
  parseTabMapping,
  type SheetsConfig,
  type MultiTabConfig,
} from "./sheets.js";
import { createGeminiEngine, type GeminiEngine } from "./gemini.js";
import { createMemoryService, type MemoryService } from "./memory.js";
import {
  type FleetData,
  hasFleetData,
  fleetDataSummary,
} from "./fleet-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.MAJEL_PORT || "3000", 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SPREADSHEET_ID = process.env.MAJEL_SPREADSHEET_ID || "";
const SHEET_RANGE = process.env.MAJEL_SHEET_RANGE || "Sheet1!A1:Z1000";
const TAB_MAPPING_ENV = process.env.MAJEL_TAB_MAPPING;

// ─── State ──────────────────────────────────────────────────────
export interface AppState {
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  fleetData: FleetData | null;
  rosterError: string | null;
  startupComplete: boolean;
}

const state: AppState = {
  geminiEngine: null,
  memoryService: null,
  fleetData: null,
  rosterError: null,
  startupComplete: false,
};

// ─── App Factory ────────────────────────────────────────────────
/**
 * Create the Express app with all routes.
 * Exported for test access — tests inject their own state.
 */
export function createApp(appState: AppState = state): express.Express {
  const app = express();
  app.use(express.json());

  // Serve static frontend files
  const clientDir =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "../client")
      : path.resolve(__dirname, "../../src/client");
  app.use(express.static(clientDir));

  // ─── API Routes ─────────────────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({
      status: appState.startupComplete ? "online" : "initializing",
      fleet: hasFleetData(appState.fleetData)
        ? { loaded: true, ...fleetDataSummary(appState.fleetData!) }
        : { loaded: false, error: appState.rosterError },
      gemini: appState.geminiEngine ? "connected" : "not configured",
      memory: appState.memoryService ? "active" : "not configured",
      credentials: hasCredentials(),
    });
  });

  app.get("/api/roster", async (_req, res) => {
    if (!SPREADSHEET_ID) {
      return res
        .status(400)
        .json({ error: "MAJEL_SPREADSHEET_ID not configured" });
    }

    try {
      const tabMapping = parseTabMapping(TAB_MAPPING_ENV);
      const config: MultiTabConfig = {
        spreadsheetId: SPREADSHEET_ID,
        tabMapping,
      };
      appState.fleetData = await fetchFleetData(config);
      appState.rosterError = null;

      if (GEMINI_API_KEY) {
        appState.geminiEngine = createGeminiEngine(
          GEMINI_API_KEY,
          appState.fleetData
        );
      }

      res.json({
        loaded: true,
        ...fleetDataSummary(appState.fleetData),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      appState.rosterError = message;
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'message' in request body" });
    }

    if (!appState.geminiEngine) {
      return res.status(503).json({
        error: "Gemini not ready. Check /api/health for status.",
      });
    }

    try {
      const answer = await appState.geminiEngine.chat(message);

      // Persist to Lex memory (fire-and-forget, don't block the response)
      if (appState.memoryService) {
        appState.memoryService
          .remember({ question: message, answer })
          .catch((err) => {
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

  app.get("/api/history", async (req, res) => {
    const source = (req.query.source as string) || "both";
    const limit = parseInt((req.query.limit as string) || "20", 10);

    const result: {
      session?: Array<{ role: string; text: string }>;
      lex?: Array<{ id: string; timestamp: string; summary: string }>;
    } = {};

    if (source === "session" || source === "both") {
      result.session = appState.geminiEngine?.getHistory() || [];
    }

    if (
      (source === "lex" || source === "both") &&
      appState.memoryService
    ) {
      try {
        const frames = await appState.memoryService.timeline(limit);
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

  app.get("/api/recall", async (req, res) => {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }

    if (!appState.memoryService) {
      return res.status(503).json({ error: "Memory service not available" });
    }

    try {
      const limit = parseInt((req.query.limit as string) || "10", 10);
      const frames = await appState.memoryService.recall(query, limit);
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

  // ─── SPA Fallback ───────────────────────────────────────────
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  return app;
}

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  console.log("⚡ Majel initializing...");

  // 1. Initialize Lex memory (always — it's local)
  try {
    state.memoryService = createMemoryService();
    console.log("✅ Lex memory service online");
  } catch (err) {
    console.error("⚠️  Lex memory init failed:", err);
  }

  // 2. Initialize Gemini (doesn't need roster yet)
  if (GEMINI_API_KEY) {
    const csv = "No roster data loaded yet.";
    state.geminiEngine = createGeminiEngine(GEMINI_API_KEY, csv);
    console.log("✅ Gemini engine online (model: gemini-2.5-flash-lite)");
  } else {
    console.warn("⚠️  GEMINI_API_KEY not set — chat disabled");
  }

  state.startupComplete = true;

  // 3. Start HTTP server FIRST — always be reachable
  const app = createApp(state);
  app.listen(PORT, () => {
    console.log(`\n🖖 Majel online — http://localhost:${PORT}`);
    console.log("   Awaiting input, Admiral.\n");
  });

  // 4. Load fleet data AFTER server is up (OAuth may be interactive)
  if (SPREADSHEET_ID && hasCredentials()) {
    try {
      console.log("   Connecting to Starfleet Database (Google Sheets)...");
      console.log(
        "   ⏳ If OAuth is needed, a URL will appear below. You have 3 minutes.\n"
      );
      const tabMapping = parseTabMapping(TAB_MAPPING_ENV);
      const config: MultiTabConfig = {
        spreadsheetId: SPREADSHEET_ID,
        tabMapping,
      };
      state.fleetData = await fetchFleetData(config);
      state.rosterError = null;
      console.log(
        `✅ Fleet data loaded (${state.fleetData.totalChars.toLocaleString()} chars, ${state.fleetData.sections.length} sections)`
      );

      // Re-create Gemini engine with fleet data
      if (GEMINI_API_KEY) {
        state.geminiEngine = createGeminiEngine(
          GEMINI_API_KEY,
          state.fleetData
        );
        console.log("✅ Gemini engine refreshed with fleet data");
      }
    } catch (err: unknown) {
      state.rosterError = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  Fleet data load deferred: ${state.rosterError}`);
      console.warn("   Fleet data can be loaded later via GET /api/roster");
    }
  } else {
    if (!SPREADSHEET_ID) {
      console.warn("⚠️  MAJEL_SPREADSHEET_ID not set — roster disabled");
    }
    if (!hasCredentials()) {
      console.warn(
        "⚠️  credentials.json not found — Google Sheets OAuth disabled"
      );
    }
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────
async function shutdown(): Promise<void> {
  console.log("\n   Majel offline. Live long and prosper. 🖖");
  if (state.memoryService) {
    await state.memoryService.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Launch (guarded for test imports) ──────────────────────────
const isTestEnv =
  process.env.NODE_ENV === "test" || process.env.VITEST === "true";

if (!isTestEnv) {
  boot().catch((err) => {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
  });
}
