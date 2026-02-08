/**
 * index.ts — Majel Express Server
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Endpoints:
 *   GET  /api/health       — Status check
 *   GET  /api/diagnostic   — Deep subsystem status
 *   GET  /api              — API discovery manifest
 *   GET  /api/roster       — Fetch/refresh roster from Sheets
 *   POST /api/chat         — Send message, get Gemini response
 *   GET  /api/history      — Conversation history from Lex
 *   GET  /api/recall       — Search Lex memory (query param: q)
 *   GET  /api/settings      — All settings with resolved values
 *   PATCH /api/settings     — Update one or more settings
 *   DELETE /api/settings/:key — Reset a setting to default
 *
 * Static files served from src/client/ (dev) or dist/client/ (prod).
 */

import express from "express";
import { IncomingMessage } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { log, rootLogger } from "./logger.js";
import {
  fetchRoster,
  fetchFleetData,
  hasCredentials,
  parseTabMapping,
  type SheetsConfig,
  type MultiTabConfig,
} from "./sheets.js";
import { createGeminiEngine, type GeminiEngine, type FleetConfig } from "./gemini.js";
import { createMemoryService, type MemoryService } from "./memory.js";
import {
  type FleetData,
  hasFleetData,
  fleetDataSummary,
} from "./fleet-data.js";
import {
  createSettingsStore,
  getCategories,
  type SettingsStore,
} from "./settings.js";
import {
  createSessionStore,
  type SessionStore,
} from "./sessions.js";
import {
  createFleetStore,
  VALID_SHIP_STATUSES,
  type FleetStore,
  type ShipStatus,
} from "./fleet-store.js";

/** Read fleet config from the settings store for model context injection. */
function readFleetConfig(store: SettingsStore | null): FleetConfig | null {
  if (!store) return null;
  return {
    opsLevel: store.getTyped("fleet.opsLevel") as number,
    drydockCount: store.getTyped("fleet.drydockCount") as number,
    shipHangarSlots: store.getTyped("fleet.shipHangarSlots") as number,
  };
}

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
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  fleetStore: FleetStore | null;
  fleetData: FleetData | null;
  rosterError: string | null;
  startupComplete: boolean;
}

const state: AppState = {
  geminiEngine: null,
  memoryService: null,
  settingsStore: null,
  sessionStore: null,
  fleetStore: null,
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

  // Request logging (pino-http)
  app.use(pinoHttp({
    logger: rootLogger.child({ subsystem: "http" }),
    autoLogging: {
      ignore: (req: IncomingMessage) => {
        // Don't log static file requests or health checks in production
        const url = req.url || "";
        return url.startsWith("/api/health") || !url.startsWith("/api");
      },
    },
  }));

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
      sessions: appState.sessionStore ? "active" : "not configured",
      fleetStore: appState.fleetStore ? { active: true, ...appState.fleetStore.counts() } : { active: false },
      credentials: hasCredentials(),
    });
  });

  // ─── API Discovery ───────────────────────────────────────────

  app.get("/api", (_req, res) => {
    res.json({
      name: "Majel",
      version: "0.4.0",
      description: "STFC Fleet Intelligence System API",
      endpoints: [
        { method: "GET", path: "/api", description: "API discovery (this endpoint)" },
        { method: "GET", path: "/api/health", description: "Fast health check — is the server up?" },
        { method: "GET", path: "/api/diagnostic", description: "Deep subsystem status — memory, settings, fleet, Gemini" },
        { method: "GET", path: "/api/roster", description: "Fetch/refresh fleet data from Google Sheets" },
        { method: "POST", path: "/api/chat", description: "Send a message, get a Gemini response", params: { body: { message: "string (required)" }, headers: { "X-Session-Id": "string (optional, default: 'default')" } } },
        { method: "GET", path: "/api/history", description: "Conversation history (session + Lex)", params: { query: { source: "session|lex|both", limit: "number", sessionId: "string (optional, default: 'default')" } } },
        { method: "GET", path: "/api/recall", description: "Search Lex memory by meaning", params: { query: { q: "string (required)", limit: "number" } } },
        { method: "GET", path: "/api/settings", description: "All settings with resolved values", params: { query: { category: "string (optional)" } } },
        { method: "PATCH", path: "/api/settings", description: "Update one or more settings", params: { body: "{ key: value, ... }" } },
        { method: "DELETE", path: "/api/settings/:key", description: "Reset a setting to its default" },
        { method: "GET", path: "/api/sessions", description: "List saved chat sessions", params: { query: { limit: "number (default: 50)" } } },
        { method: "GET", path: "/api/sessions/:id", description: "Get a session with all messages" },
        { method: "PATCH", path: "/api/sessions/:id", description: "Update session title", params: { body: { title: "string" } } },
        { method: "DELETE", path: "/api/sessions/:id", description: "Delete a session" },
        { method: "GET", path: "/api/fleet/ships", description: "List ships", params: { query: { status: "ShipStatus (optional)", role: "string (optional)" } } },
        { method: "POST", path: "/api/fleet/ships", description: "Create a ship", params: { body: { id: "string", name: "string", tier: "number?", shipClass: "string?", status: "ShipStatus?", role: "string?", roleDetail: "string?", notes: "string?" } } },
        { method: "GET", path: "/api/fleet/ships/:id", description: "Get a ship with crew" },
        { method: "PATCH", path: "/api/fleet/ships/:id", description: "Update ship fields" },
        { method: "DELETE", path: "/api/fleet/ships/:id", description: "Delete a ship" },
        { method: "GET", path: "/api/fleet/officers", description: "List officers", params: { query: { groupName: "string (optional)", unassigned: "boolean (optional)" } } },
        { method: "POST", path: "/api/fleet/officers", description: "Create an officer", params: { body: { id: "string", name: "string", rarity: "string?", level: "number?", rank: "string?", groupName: "string?" } } },
        { method: "GET", path: "/api/fleet/officers/:id", description: "Get an officer with assignments" },
        { method: "PATCH", path: "/api/fleet/officers/:id", description: "Update officer fields" },
        { method: "DELETE", path: "/api/fleet/officers/:id", description: "Delete an officer" },
        { method: "POST", path: "/api/fleet/ships/:id/crew", description: "Assign an officer to a ship", params: { body: { officerId: "string", roleType: "bridge|specialist", slot: "string?", activeForRole: "string?" } } },
        { method: "DELETE", path: "/api/fleet/ships/:shipId/crew/:officerId", description: "Unassign an officer from a ship" },
        { method: "GET", path: "/api/fleet/log", description: "Fleet activity log", params: { query: { shipId: "string?", officerId: "string?", action: "string?", limit: "number?" } } },
        { method: "POST", path: "/api/fleet/import", description: "Import fleet data from Sheets into fleet store" },
        { method: "GET", path: "/api/fleet/counts", description: "Fleet store entity counts" },
      ],
    });
  });

  // ─── Diagnostic ──────────────────────────────────────────────

  app.get("/api/diagnostic", (_req, res) => {
    const now = new Date();
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const diagnostic: Record<string, unknown> = {
      system: {
        version: "0.4.0",
        uptime,
        uptimeSeconds: Math.round(uptimeSeconds),
        nodeVersion: process.version,
        timestamp: now.toISOString(),
        startupComplete: appState.startupComplete,
      },
      gemini: appState.geminiEngine
        ? {
            status: "connected",
            model: "gemini-2.5-flash-lite",
            activeSessions: appState.geminiEngine.getSessionCount(),
          }
        : { status: "not configured" },
      memory: (() => {
        if (!appState.memoryService) return { status: "not configured" };
        return {
          status: "active",
          frameCount: appState.memoryService.getFrameCount(),
          dbPath: appState.memoryService.getDbPath(),
        };
      })(),
      settings: (() => {
        if (!appState.settingsStore) return { status: "not configured" };
        return {
          status: "active",
          userOverrides: appState.settingsStore.countUserOverrides(),
          dbPath: appState.settingsStore.getDbPath(),
        };
      })(),
      sessions: (() => {
        if (!appState.sessionStore) return { status: "not configured" };
        return {
          status: "active",
          count: appState.sessionStore.count(),
          dbPath: appState.sessionStore.getDbPath(),
        };
      })(),
      fleet: hasFleetData(appState.fleetData)
        ? {
            status: "loaded",
            ...fleetDataSummary(appState.fleetData!),
            fetchedAt: appState.fleetData!.fetchedAt,
            spreadsheetId: appState.fleetData!.spreadsheetId,
          }
        : {
            status: appState.rosterError ? "error" : "not loaded",
            error: appState.rosterError || undefined,
          },
      fleetStore: (() => {
        if (!appState.fleetStore) return { status: "not configured" };
        return {
          status: "active",
          ...appState.fleetStore.counts(),
          dbPath: appState.fleetStore.getDbPath(),
        };
      })(),
      sheets: {
        credentialsPresent: hasCredentials(),
      },
    };

    res.json(diagnostic);
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
          appState.fleetData,
          readFleetConfig(appState.settingsStore),
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
    const sessionId = (req.headers["x-session-id"] as string) || "default";

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
      const answer = await appState.geminiEngine.chat(message, sessionId);

      // Persist to Lex memory (fire-and-forget, don't block the response)
      if (appState.memoryService) {
        appState.memoryService
          .remember({ question: message, answer })
          .catch((err) => {
            log.lex.warn({ err: err instanceof Error ? err.message : String(err) }, "memory save failed");
          });
      }

      // Persist both messages to session store
      if (appState.sessionStore) {
        appState.sessionStore.addMessage(sessionId, "user", message);
        appState.sessionStore.addMessage(sessionId, "model", answer);
      }

      res.json({ answer });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ err: errMessage }, "chat request failed");
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
      const sessionId = (req.query.sessionId as string) || "default";
      result.session = appState.geminiEngine?.getHistory(sessionId) || [];
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
        log.lex.warn({ err: err instanceof Error ? err.message : String(err) }, "timeline error");
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

  // ─── Settings API ──────────────────────────────────────────

  app.get("/api/settings", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const category = req.query.category as string | undefined;
    const categories = getCategories();

    if (category) {
      if (!categories.includes(category)) {
        return res.status(400).json({
          error: `Unknown category: ${category}. Valid: ${categories.join(", ")}`,
        });
      }
      return res.json({
        category,
        settings: appState.settingsStore.getByCategory(category),
      });
    }

    res.json({
      categories,
      settings: appState.settingsStore.getAll(),
    });
  });

  app.patch("/api/settings", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res
        .status(400)
        .json({ error: "Request body must be an object of { key: value } pairs" });
    }

    const results: Array<{ key: string; status: string; error?: string }> = [];
    let fleetConfigChanged = false;
    for (const [key, value] of Object.entries(updates)) {
      try {
        appState.settingsStore.set(key, String(value));
        results.push({ key, status: "updated" });
        if (key.startsWith("fleet.")) fleetConfigChanged = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ key, status: "error", error: message });
      }
    }

    // Rebuild Gemini engine with updated fleet config so the model sees the new values
    if (fleetConfigChanged && GEMINI_API_KEY && appState.geminiEngine) {
      appState.geminiEngine = createGeminiEngine(
        GEMINI_API_KEY,
        appState.fleetData,
        readFleetConfig(appState.settingsStore),
      );
      log.boot.info("gemini engine refreshed with updated fleet config");
    }

    res.json({ results });
  });

  app.delete("/api/settings/:key(*)", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const key = req.params.key;
    const deleted = appState.settingsStore.delete(key);

    if (deleted) {
      // Return the new resolved value (env or default)
      const newValue = appState.settingsStore.get(key);
      res.json({ key, status: "reset", resolvedValue: newValue });
    } else {
      res.json({ key, status: "not_found", message: "No user override existed" });
    }
  });

  // ─── Sessions API ──────────────────────────────────────────

  app.get("/api/sessions", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const limit = parseInt((req.query.limit as string) || "50", 10);
    res.json({ sessions: appState.sessionStore.list(limit) });
  });

  app.get("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const session = appState.sessionStore.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  });

  app.patch("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "Missing 'title' in request body" });
    }
    const updated = appState.sessionStore.updateTitle(req.params.id, title.trim());
    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ id: req.params.id, title: title.trim(), status: "updated" });
  });

  app.delete("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const deleted = appState.sessionStore.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  // ─── Fleet API ────────────────────────────────────────────

  // Ships CRUD
  app.get("/api/fleet/ships", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const status = req.query.status as ShipStatus | undefined;
    const role = req.query.role as string | undefined;
    if (status && !VALID_SHIP_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${VALID_SHIP_STATUSES.join(", ")}` });
    }
    const ships = appState.fleetStore.listShips({ status, role });
    res.json({ ships, count: ships.length });
  });

  app.post("/api/fleet/ships", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { id, name, tier, shipClass, status, role, roleDetail, notes } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing required fields: id, name" });
    }
    try {
      const ship = appState.fleetStore.createShip({
        id,
        name,
        tier: tier ?? null,
        shipClass: shipClass ?? null,
        status: status || "ready",
        role: role ?? null,
        roleDetail: roleDetail ?? null,
        notes: notes ?? null,
        importedFrom: null,
      });
      res.status(201).json(ship);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const ship = appState.fleetStore.getShip(req.params.id);
    if (!ship) {
      return res.status(404).json({ error: "Ship not found" });
    }
    res.json(ship);
  });

  app.patch("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    try {
      const ship = appState.fleetStore.updateShip(req.params.id, req.body);
      if (!ship) {
        return res.status(404).json({ error: "Ship not found" });
      }
      res.json(ship);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const deleted = appState.fleetStore.deleteShip(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Ship not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  // Officers CRUD
  app.get("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const groupName = req.query.groupName as string | undefined;
    const unassigned = req.query.unassigned === "true";
    const officers = appState.fleetStore.listOfficers({ groupName, unassigned });
    res.json({ officers, count: officers.length });
  });

  app.post("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { id, name, rarity, level, rank, groupName } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing required fields: id, name" });
    }
    try {
      const officer = appState.fleetStore.createOfficer({
        id,
        name,
        rarity: rarity ?? null,
        level: level ?? null,
        rank: rank ?? null,
        groupName: groupName ?? null,
        importedFrom: null,
      });
      res.status(201).json(officer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const officer = appState.fleetStore.getOfficer(req.params.id);
    if (!officer) {
      return res.status(404).json({ error: "Officer not found" });
    }
    res.json(officer);
  });

  app.patch("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    try {
      const officer = appState.fleetStore.updateOfficer(req.params.id, req.body);
      if (!officer) {
        return res.status(404).json({ error: "Officer not found" });
      }
      res.json(officer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const deleted = appState.fleetStore.deleteOfficer(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Officer not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  // Crew Assignments
  app.post("/api/fleet/ships/:id/crew", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { officerId, roleType, slot, activeForRole } = req.body;
    if (!officerId || !roleType) {
      return res.status(400).json({ error: "Missing required fields: officerId, roleType" });
    }
    if (!["bridge", "specialist"].includes(roleType)) {
      return res.status(400).json({ error: "roleType must be 'bridge' or 'specialist'" });
    }
    try {
      const assignment = appState.fleetStore.assignCrew(req.params.id, officerId, roleType, slot, activeForRole);
      res.status(201).json(assignment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/fleet/ships/:shipId/crew/:officerId", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const removed = appState.fleetStore.unassignCrew(req.params.shipId, req.params.officerId);
    if (!removed) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    res.json({ shipId: req.params.shipId, officerId: req.params.officerId, status: "unassigned" });
  });

  // Fleet Log
  app.get("/api/fleet/log", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const shipId = req.query.shipId as string | undefined;
    const officerId = req.query.officerId as string | undefined;
    const action = req.query.action as string | undefined;
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const entries = appState.fleetStore.getLog({
      shipId,
      officerId,
      action: action as import("./fleet-store.js").LogAction | undefined,
      limit,
    });
    res.json({ entries, count: entries.length });
  });

  // Fleet Import
  app.post("/api/fleet/import", (_req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    if (!appState.fleetData) {
      return res.status(400).json({ error: "No fleet data loaded from Sheets. Hit /api/roster first." });
    }
    try {
      const result = appState.fleetStore.importFromFleetData(appState.fleetData);
      res.json({ status: "imported", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Fleet Counts
  app.get("/api/fleet/counts", (_req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    res.json(appState.fleetStore.counts());
  });

  // ─── SPA Fallback ───────────────────────────────────────────
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  return app;
}

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  log.boot.info("Majel initializing");

  // 1. Initialize settings store (always — it's local SQLite)
  try {
    state.settingsStore = createSettingsStore();
    log.boot.info("settings store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "settings store init failed");
  }

  // 2. Initialize Lex memory (always — it's local)
  try {
    state.memoryService = createMemoryService();
    log.boot.info("lex memory service online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "lex memory init failed");
  }

  // 2b. Initialize session store (always — it's local SQLite)
  try {
    state.sessionStore = createSessionStore();
    log.boot.info({ sessions: state.sessionStore.count() }, "session store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "session store init failed");
  }

  // 2c. Initialize fleet store (always — it's local SQLite)
  try {
    state.fleetStore = createFleetStore();
    const counts = state.fleetStore.counts();
    log.boot.info({ ships: counts.ships, officers: counts.officers }, "fleet store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "fleet store init failed");
  }

  // Resolve config: settings store → env → defaults
  const resolvedApiKey = GEMINI_API_KEY;
  const resolvedSpreadsheetId =
    state.settingsStore?.get("sheets.spreadsheetId") || SPREADSHEET_ID;
  const resolvedTabMapping =
    state.settingsStore?.get("sheets.tabMapping") || TAB_MAPPING_ENV;

  // 3. Initialize Gemini (doesn't need fleet data yet)
  if (resolvedApiKey) {
    const csv = "No roster data loaded yet.";
    state.geminiEngine = createGeminiEngine(
      resolvedApiKey,
      csv,
      readFleetConfig(state.settingsStore),
    );
    log.boot.info({ model: "gemini-2.5-flash-lite" }, "gemini engine online");
  } else {
    log.boot.warn("GEMINI_API_KEY not set — chat disabled");
  }

  state.startupComplete = true;

  // 3. Start HTTP server FIRST — always be reachable
  const app = createApp(state);
  app.listen(PORT, () => {
    log.boot.info({ port: PORT, url: `http://localhost:${PORT}` }, "Majel online");
  });

  // 5. Load fleet data AFTER server is up (OAuth may be interactive)
  if (resolvedSpreadsheetId && hasCredentials()) {
    try {
      log.boot.info("connecting to Google Sheets");
      log.boot.debug("OAuth may be required — URL will appear if interactive consent needed");
      const tabMapping = parseTabMapping(resolvedTabMapping);
      const config: MultiTabConfig = {
        spreadsheetId: resolvedSpreadsheetId,
        tabMapping,
      };
      state.fleetData = await fetchFleetData(config);
      state.rosterError = null;
      log.boot.info({
        totalChars: state.fleetData.totalChars,
        sections: state.fleetData.sections.length,
      }, "fleet data loaded");

      // Re-create Gemini engine with fleet data
      if (resolvedApiKey) {
        state.geminiEngine = createGeminiEngine(
          resolvedApiKey,
          state.fleetData,
          readFleetConfig(state.settingsStore),
        );
        log.boot.info("gemini engine refreshed with fleet data");
      }
    } catch (err: unknown) {
      state.rosterError = err instanceof Error ? err.message : String(err);
      log.boot.warn({ error: state.rosterError }, "fleet data load deferred");
    }
  } else {
    if (!resolvedSpreadsheetId) {
      log.boot.warn("MAJEL_SPREADSHEET_ID not set — roster disabled");
    }
    if (!hasCredentials()) {
      log.boot.warn("credentials.json not found — Google Sheets OAuth disabled");
    }
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────
async function shutdown(): Promise<void> {
  log.boot.info("Majel offline. Live long and prosper.");
  if (state.settingsStore) {
    state.settingsStore.close();
  }
  if (state.sessionStore) {
    state.sessionStore.close();
  }
  if (state.fleetStore) {
    state.fleetStore.close();
  }
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
    log.boot.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal startup error");
    process.exit(1);
  });
}
