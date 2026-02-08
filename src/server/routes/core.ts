/**
 * routes/core.ts — Core infrastructure routes.
 *
 * Health, API discovery, diagnostic, and roster refresh.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import {
  GEMINI_API_KEY,
  SPREADSHEET_ID,
  TAB_MAPPING_ENV,
  readFleetConfig,
  readDockBriefing,
} from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { hasCredentials, fetchFleetData, parseTabMapping, type MultiTabConfig } from "../sheets.js";
import { createGeminiEngine } from "../gemini.js";
import { hasFleetData, fleetDataSummary } from "../fleet-data.js";

export function createCoreRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Health ─────────────────────────────────────────────────

  router.get("/api/health", (_req, res) => {
    sendOk(res, {
      status: appState.startupComplete ? "online" : "initializing",
      fleet: hasFleetData(appState.fleetData)
        ? { loaded: true, ...fleetDataSummary(appState.fleetData!) }
        : { loaded: false, error: appState.rosterError },
      gemini: appState.geminiEngine ? "connected" : "not configured",
      memory: appState.memoryService ? "active" : "not configured",
      sessions: appState.sessionStore ? "active" : "not configured",
      fleetStore: appState.fleetStore ? { active: true, ...appState.fleetStore.counts() } : { active: false },
      dockStore: appState.dockStore ? { active: true, ...appState.dockStore.counts() } : { active: false },
      credentials: hasCredentials(),
    });
  });

  // ─── API Discovery ──────────────────────────────────────────

  router.get("/api", (_req, res) => {
    sendOk(res, {
      name: "Majel",
      version: "0.4.0",
      description: "STFC Fleet Intelligence System API",
      envelope: "All responses wrapped in { ok, data, meta } / { ok, error, meta } (ADR-004)",
      endpoints: [
        { method: "GET", path: "/api", description: "API discovery (this endpoint)" },
        { method: "GET", path: "/api/health", description: "Fast health check" },
        { method: "GET", path: "/api/diagnostic", description: "Deep subsystem status" },
        { method: "GET", path: "/api/roster", description: "Fetch/refresh fleet data from Google Sheets" },
        { method: "POST", path: "/api/chat", description: "Send a message, get a Gemini response" },
        { method: "GET", path: "/api/history", description: "Conversation history (session + Lex)" },
        { method: "GET", path: "/api/recall", description: "Search Lex memory by meaning" },
        { method: "GET", path: "/api/settings", description: "All settings with resolved values" },
        { method: "PATCH", path: "/api/settings", description: "Update one or more settings" },
        { method: "DELETE", path: "/api/settings/:key", description: "Reset a setting to its default" },
        { method: "GET", path: "/api/sessions", description: "List saved chat sessions" },
        { method: "GET", path: "/api/sessions/:id", description: "Get a session with all messages" },
        { method: "PATCH", path: "/api/sessions/:id", description: "Update session title" },
        { method: "DELETE", path: "/api/sessions/:id", description: "Delete a session" },
        { method: "GET", path: "/api/fleet/ships", description: "List ships" },
        { method: "POST", path: "/api/fleet/ships", description: "Create a ship" },
        { method: "GET", path: "/api/fleet/ships/:id", description: "Get a ship with crew" },
        { method: "PATCH", path: "/api/fleet/ships/:id", description: "Update ship fields" },
        { method: "DELETE", path: "/api/fleet/ships/:id", description: "Delete a ship" },
        { method: "GET", path: "/api/fleet/officers", description: "List officers" },
        { method: "POST", path: "/api/fleet/officers", description: "Create an officer" },
        { method: "GET", path: "/api/fleet/officers/:id", description: "Get an officer" },
        { method: "PATCH", path: "/api/fleet/officers/:id", description: "Update officer fields" },
        { method: "DELETE", path: "/api/fleet/officers/:id", description: "Delete an officer" },
        { method: "POST", path: "/api/fleet/ships/:id/crew", description: "Assign an officer to a ship" },
        { method: "DELETE", path: "/api/fleet/ships/:shipId/crew/:officerId", description: "Unassign an officer" },
        { method: "GET", path: "/api/fleet/log", description: "Fleet activity log" },
        { method: "POST", path: "/api/fleet/import", description: "Import fleet data from Sheets" },
        { method: "GET", path: "/api/fleet/counts", description: "Fleet store entity counts" },
        { method: "GET", path: "/api/fleet/intents", description: "List intent catalog" },
        { method: "POST", path: "/api/fleet/intents", description: "Create a custom intent" },
        { method: "DELETE", path: "/api/fleet/intents/:key", description: "Delete a custom intent" },
        { method: "GET", path: "/api/fleet/docks", description: "List all dock loadouts" },
        { method: "GET", path: "/api/fleet/docks/:num", description: "Get a single dock" },
        { method: "PUT", path: "/api/fleet/docks/:num", description: "Create or update a dock" },
        { method: "DELETE", path: "/api/fleet/docks/:num", description: "Clear a dock" },
        { method: "PUT", path: "/api/fleet/docks/:num/intents", description: "Set dock intents" },
        { method: "POST", path: "/api/fleet/docks/:num/ships", description: "Add ship to dock" },
        { method: "DELETE", path: "/api/fleet/docks/:num/ships/:shipId", description: "Remove ship from dock" },
        { method: "PATCH", path: "/api/fleet/docks/:num/ships/:shipId", description: "Update dock ship" },
        { method: "GET", path: "/api/fleet/presets", description: "List crew presets" },
        { method: "GET", path: "/api/fleet/presets/:id", description: "Get a crew preset" },
        { method: "POST", path: "/api/fleet/presets", description: "Create a crew preset" },
        { method: "PATCH", path: "/api/fleet/presets/:id", description: "Update preset" },
        { method: "DELETE", path: "/api/fleet/presets/:id", description: "Delete a crew preset" },
        { method: "PUT", path: "/api/fleet/presets/:id/members", description: "Set preset crew members" },
        { method: "PUT", path: "/api/fleet/presets/:id/tags", description: "Set preset tags" },
        { method: "GET", path: "/api/fleet/tags", description: "List all unique preset tags" },
        { method: "GET", path: "/api/fleet/docks/:num/presets", description: "Find presets for a dock" },
        { method: "GET", path: "/api/fleet/docks/summary", description: "Computed dock briefing" },
        { method: "GET", path: "/api/fleet/docks/conflicts", description: "Officer conflict report" },
      ],
    });
  });

  // ─── Diagnostic ─────────────────────────────────────────────

  router.get("/api/diagnostic", (_req, res) => {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    sendOk(res, {
      system: {
        version: "0.4.0",
        uptime,
        uptimeSeconds: Math.round(uptimeSeconds),
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
        startupComplete: appState.startupComplete,
      },
      gemini: appState.geminiEngine
        ? { status: "connected", model: "gemini-2.5-flash-lite", activeSessions: appState.geminiEngine.getSessionCount() }
        : { status: "not configured" },
      memory: (() => {
        if (!appState.memoryService) return { status: "not configured" };
        return { status: "active", frameCount: appState.memoryService.getFrameCount(), dbPath: appState.memoryService.getDbPath() };
      })(),
      settings: (() => {
        if (!appState.settingsStore) return { status: "not configured" };
        return { status: "active", userOverrides: appState.settingsStore.countUserOverrides(), dbPath: appState.settingsStore.getDbPath() };
      })(),
      sessions: (() => {
        if (!appState.sessionStore) return { status: "not configured" };
        return { status: "active", count: appState.sessionStore.count(), dbPath: appState.sessionStore.getDbPath() };
      })(),
      fleet: hasFleetData(appState.fleetData)
        ? { status: "loaded", ...fleetDataSummary(appState.fleetData!), fetchedAt: appState.fleetData!.fetchedAt, spreadsheetId: appState.fleetData!.spreadsheetId }
        : { status: appState.rosterError ? "error" : "not loaded", error: appState.rosterError || undefined },
      fleetStore: (() => {
        if (!appState.fleetStore) return { status: "not configured" };
        return { status: "active", ...appState.fleetStore.counts(), dbPath: appState.fleetStore.getDbPath() };
      })(),
      dockStore: (() => {
        if (!appState.dockStore) return { status: "not configured" };
        return { status: "active", ...appState.dockStore.counts(), dbPath: appState.dockStore.getDbPath() };
      })(),
      sheets: { credentialsPresent: hasCredentials() },
    });
  });

  // ─── Roster Refresh ─────────────────────────────────────────

  router.get("/api/roster", async (_req, res) => {
    if (!SPREADSHEET_ID) {
      return sendFail(res, ErrorCode.SHEETS_NOT_CONFIGURED, "MAJEL_SPREADSHEET_ID not configured");
    }

    try {
      const tabMapping = parseTabMapping(TAB_MAPPING_ENV);
      const config: MultiTabConfig = { spreadsheetId: SPREADSHEET_ID, tabMapping };
      appState.fleetData = await fetchFleetData(config);
      appState.rosterError = null;

      if (GEMINI_API_KEY) {
        appState.geminiEngine = createGeminiEngine(
          GEMINI_API_KEY, appState.fleetData, readFleetConfig(appState.settingsStore), readDockBriefing(appState.dockStore),
        );
      }

      sendOk(res, { loaded: true, ...fleetDataSummary(appState.fleetData) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      appState.rosterError = message;
      sendFail(res, ErrorCode.SHEETS_ERROR, message, 500);
    }
  });

  return router;
}
