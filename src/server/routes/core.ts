/**
 * routes/core.ts — Core infrastructure routes.
 *
 * Health, API discovery, and diagnostic.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, createTimeoutMiddleware } from "../envelope.js";

export function createCoreRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Health ─────────────────────────────────────────────────

  router.get("/api/health", createTimeoutMiddleware(2000), async (_req, res) => {
    sendOk(res, {
      status: appState.startupComplete ? "online" : "initializing",
      gemini: appState.geminiEngine ? "connected" : "not configured",
      memory: appState.memoryService ? "active" : "not configured",
      sessions: appState.sessionStore ? "active" : "not configured",
      dockStore: appState.dockStore ? { active: true, ...await appState.dockStore.counts() } : { active: false },
      referenceStore: appState.referenceStore ? { active: true, ...await appState.referenceStore.counts() } : { active: false },
      overlayStore: appState.overlayStore ? { active: true, ...await appState.overlayStore.counts() } : { active: false },
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
        { method: "GET", path: "/api/dock/intents", description: "List intent catalog" },
        { method: "POST", path: "/api/dock/intents", description: "Create a custom intent" },
        { method: "DELETE", path: "/api/dock/intents/:key", description: "Delete a custom intent" },
        { method: "GET", path: "/api/dock/docks", description: "List all dock loadouts" },
        { method: "GET", path: "/api/dock/docks/:num", description: "Get a single dock" },
        { method: "PUT", path: "/api/dock/docks/:num", description: "Create or update a dock" },
        { method: "DELETE", path: "/api/dock/docks/:num", description: "Clear a dock" },
        { method: "PUT", path: "/api/dock/docks/:num/intents", description: "Set dock intents" },
        { method: "POST", path: "/api/dock/docks/:num/ships", description: "Add ship to dock" },
        { method: "DELETE", path: "/api/dock/docks/:num/ships/:shipId", description: "Remove ship from dock" },
        { method: "PATCH", path: "/api/dock/docks/:num/ships/:shipId", description: "Update dock ship" },
        { method: "GET", path: "/api/dock/presets", description: "List crew presets" },
        { method: "GET", path: "/api/dock/presets/:id", description: "Get a crew preset" },
        { method: "POST", path: "/api/dock/presets", description: "Create a crew preset" },
        { method: "PATCH", path: "/api/dock/presets/:id", description: "Update preset" },
        { method: "DELETE", path: "/api/dock/presets/:id", description: "Delete a crew preset" },
        { method: "PUT", path: "/api/dock/presets/:id/members", description: "Set preset crew members" },
        { method: "PUT", path: "/api/dock/presets/:id/tags", description: "Set preset tags" },
        { method: "GET", path: "/api/dock/tags", description: "List all unique preset tags" },
        { method: "GET", path: "/api/dock/docks/:num/presets", description: "Find presets for a dock" },
        { method: "GET", path: "/api/dock/docks/summary", description: "Computed dock briefing" },
        { method: "GET", path: "/api/dock/docks/conflicts", description: "Officer conflict report" },
        // ── Catalog (ADR-016) ──
        { method: "GET", path: "/api/catalog/officers", description: "List reference officers" },
        { method: "GET", path: "/api/catalog/officers/:id", description: "Get a reference officer" },
        { method: "GET", path: "/api/catalog/officers/merged", description: "Officers with overlay state" },
        { method: "GET", path: "/api/catalog/ships", description: "List reference ships" },
        { method: "GET", path: "/api/catalog/ships/:id", description: "Get a reference ship" },
        { method: "GET", path: "/api/catalog/ships/merged", description: "Ships with overlay state" },
        { method: "GET", path: "/api/catalog/counts", description: "Reference + overlay counts" },
        { method: "PATCH", path: "/api/catalog/officers/:id/overlay", description: "Set officer overlay" },
        { method: "DELETE", path: "/api/catalog/officers/:id/overlay", description: "Reset officer overlay" },
        { method: "PATCH", path: "/api/catalog/ships/:id/overlay", description: "Set ship overlay" },
        { method: "DELETE", path: "/api/catalog/ships/:id/overlay", description: "Reset ship overlay" },
        { method: "POST", path: "/api/catalog/officers/bulk-overlay", description: "Bulk set officer overlays" },
        { method: "POST", path: "/api/catalog/ships/bulk-overlay", description: "Bulk set ship overlays" },
        { method: "POST", path: "/api/catalog/sync", description: "Sync reference data from STFC wiki" },
        // ── Diagnostic Query (AI Tool) ──
        { method: "GET", path: "/api/diagnostic/schema", description: "DB schema introspection (tables, columns, indexes)" },
        { method: "GET", path: "/api/diagnostic/query", description: "Execute read-only SQL (AI consumption)" },
        { method: "GET", path: "/api/diagnostic/summary", description: "Pre-built reference + overlay summary" },
      ],
    });
  });

  // ─── Diagnostic ─────────────────────────────────────────────

  router.get("/api/diagnostic", async (_req, res) => {
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
      settings: await (async () => {
        if (!appState.settingsStore) return { status: "not configured" };
        return { status: "active", userOverrides: await appState.settingsStore.countUserOverrides(), dbPath: appState.settingsStore.getDbPath() };
      })(),
      sessions: await (async () => {
        if (!appState.sessionStore) return { status: "not configured" };
        return { status: "active", count: await appState.sessionStore.count(), dbPath: appState.sessionStore.getDbPath() };
      })(),
      dockStore: await (async () => {
        if (!appState.dockStore) return { status: "not configured" };
        return { status: "active", ...await appState.dockStore.counts(), dbPath: appState.dockStore.getDbPath() };
      })(),
      referenceStore: await (async () => {
        if (!appState.referenceStore) return { status: "not configured" };
        return { status: "active", ...await appState.referenceStore.counts(), dbPath: appState.referenceStore.getDbPath() };
      })(),
      overlayStore: await (async () => {
        if (!appState.overlayStore) return { status: "not configured" };
        return { status: "active", ...await appState.overlayStore.counts(), dbPath: appState.overlayStore.getDbPath() };
      })(),
    });
  });

  return router;
}
