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
import { hasCredentials, fetchFleetData, parseTabMapping, type MultiTabConfig } from "../sheets.js";
import { createGeminiEngine } from "../gemini.js";
import { hasFleetData, fleetDataSummary } from "../fleet-data.js";

export function createCoreRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Health ─────────────────────────────────────────────────

  router.get("/api/health", (_req, res) => {
    res.json({
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
        { method: "GET", path: "/api/fleet/intents", description: "List intent catalog (builtin + custom)", params: { query: { category: "string (optional)" } } },
        { method: "POST", path: "/api/fleet/intents", description: "Create a custom intent", params: { body: { key: "string", label: "string", category: "string", description: "string?", icon: "string?" } } },
        { method: "DELETE", path: "/api/fleet/intents/:key", description: "Delete a custom intent (builtin = error)" },
        { method: "GET", path: "/api/fleet/docks", description: "List all dock loadouts with intents + ships" },
        { method: "GET", path: "/api/fleet/docks/:num", description: "Get a single dock with full context" },
        { method: "PUT", path: "/api/fleet/docks/:num", description: "Create or update a dock loadout", params: { body: { label: "string?", notes: "string?", priority: "number?" } } },
        { method: "DELETE", path: "/api/fleet/docks/:num", description: "Clear a dock's loadout" },
        { method: "PUT", path: "/api/fleet/docks/:num/intents", description: "Set dock's intents (full replace)", params: { body: { intents: "string[] (intent keys)" } } },
        { method: "POST", path: "/api/fleet/docks/:num/ships", description: "Add ship to dock rotation", params: { body: { shipId: "string", notes: "string?" } } },
        { method: "DELETE", path: "/api/fleet/docks/:num/ships/:shipId", description: "Remove ship from dock" },
        { method: "PATCH", path: "/api/fleet/docks/:num/ships/:shipId", description: "Update dock ship (set active, reorder)", params: { body: { isActive: "boolean?", sortOrder: "number?", notes: "string?" } } },
        { method: "GET", path: "/api/fleet/presets", description: "List crew presets (filterable)", params: { query: { shipId: "string?", intentKey: "string?" } } },
        { method: "GET", path: "/api/fleet/presets/:id", description: "Get a single crew preset with members" },
        { method: "POST", path: "/api/fleet/presets", description: "Create a crew preset", params: { body: { shipId: "string", intentKey: "string", presetName: "string", isDefault: "boolean?" } } },
        { method: "PATCH", path: "/api/fleet/presets/:id", description: "Update preset (name, default)", params: { body: { presetName: "string?", isDefault: "boolean?" } } },
        { method: "DELETE", path: "/api/fleet/presets/:id", description: "Delete a crew preset" },
        { method: "PUT", path: "/api/fleet/presets/:id/members", description: "Set preset crew members (full replace)", params: { body: { members: "[{ officerId, roleType, slot? }]" } } },
        { method: "GET", path: "/api/fleet/docks/summary", description: "Computed dock briefing (what goes in the prompt)" },
        { method: "GET", path: "/api/fleet/docks/conflicts", description: "Officer conflict report across presets" },
      ],
    });
  });

  // ─── Diagnostic ─────────────────────────────────────────────

  router.get("/api/diagnostic", (_req, res) => {
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
      dockStore: (() => {
        if (!appState.dockStore) return { status: "not configured" };
        return {
          status: "active",
          ...appState.dockStore.counts(),
          dbPath: appState.dockStore.getDbPath(),
        };
      })(),
      sheets: {
        credentialsPresent: hasCredentials(),
      },
    };

    res.json(diagnostic);
  });

  // ─── Roster Refresh ─────────────────────────────────────────

  router.get("/api/roster", async (_req, res) => {
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
          readDockBriefing(appState.dockStore),
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

  return router;
}
