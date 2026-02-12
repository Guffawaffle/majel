/**
 * routes/core.ts — Core infrastructure routes.
 *
 * Health, API discovery, and diagnostic.
 */

import { Router } from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, createTimeoutMiddleware } from "../envelope.js";
import { requireVisitor } from "../auth.js";

// Read version from package.json once at module load
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
})();

export function createCoreRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Health ─────────────────────────────────────────────────

  router.get("/api/health", createTimeoutMiddleware(2000), async (_req, res) => {
    const status = appState.startupComplete ? "online" : "initializing";
    if (!appState.startupComplete) {
      res.setHeader("Retry-After", "2");
    }

    const safeCounts = async (store: { counts(): Promise<unknown> } | null | undefined, label: string) => {
      if (!store) return { active: false };
      try { return { active: true, ...await store.counts() as Record<string, unknown> }; }
      catch (err) { log.root.warn({ err, store: label }, "Health check: store counts failed"); return { active: true, error: "unavailable" }; }
    };

    sendOk(res, {
      status,
      ...(!appState.startupComplete ? { retryAfterMs: 2000 } : {}),
      gemini: appState.geminiEngine ? "connected" : "not configured",
      memory: appState.memoryService ? "active" : "not configured",
      sessions: appState.sessionStore ? "active" : "not configured",
      dockStore: await safeCounts(appState.dockStore, "dockStore"),
      referenceStore: await safeCounts(appState.referenceStore, "referenceStore"),
      overlayStore: await safeCounts(appState.overlayStore, "overlayStore"),
    });
  });

  // ─── API Discovery ──────────────────────────────────────────
  // CANONICAL ROUTE LIST — update this when adding/removing routes.
  // See docs/AX-SCHEMA.md for the API envelope specification.

  router.get("/api", (_req, res) => {
    sendOk(res, {
      name: "Majel",
      version: APP_VERSION,
      description: "STFC Fleet Intelligence System API",
      envelope: "All responses wrapped in { ok, data, meta } / { ok, error: { code, message, detail?, hints? }, meta } (ADR-004)",
      auth: {
        none: "No authentication required",
        lieutenant: "Requires session cookie or Bearer token (visitor-level)",
        admiral: "Requires Admiral-level Bearer token or session",
      },
      endpoints: [
        { method: "GET", path: "/api", auth: "none", description: "API discovery (this endpoint)" },
        { method: "GET", path: "/api/health", auth: "none", description: "Fast health check (returns retryAfterMs when initializing)" },
        { method: "GET", path: "/api/diagnostic", auth: "lieutenant", description: "Deep subsystem status" },
        { method: "POST", path: "/api/chat", auth: "admiral", description: "Send a message, get a Gemini response", body: { message: "string (required)" } },
        { method: "GET", path: "/api/history", auth: "lieutenant", description: "Conversation history (session + Lex)", params: { source: "session|lex|both", limit: "1-100", sessionId: "string" } },
        { method: "GET", path: "/api/recall", auth: "lieutenant", description: "Search Lex memory by meaning", params: { q: "string (required)", limit: "1-100" } },
        { method: "GET", path: "/api/settings", auth: "lieutenant", description: "All settings with resolved values" },
        { method: "PATCH", path: "/api/settings", auth: "admiral", description: "Update one or more settings" },
        { method: "DELETE", path: "/api/settings/:key", auth: "admiral", description: "Reset a setting to its default" },
        { method: "GET", path: "/api/sessions", auth: "lieutenant", description: "List saved chat sessions" },
        { method: "GET", path: "/api/sessions/:id", auth: "lieutenant", description: "Get a session with all messages" },
        { method: "PATCH", path: "/api/sessions/:id", auth: "lieutenant", description: "Update session title" },
        { method: "DELETE", path: "/api/sessions/:id", auth: "lieutenant", description: "Delete a session" },
        { method: "GET", path: "/api/dock/intents", auth: "lieutenant", description: "List intent catalog" },
        { method: "POST", path: "/api/dock/intents", auth: "admiral", description: "Create a custom intent" },
        { method: "DELETE", path: "/api/dock/intents/:key", auth: "admiral", description: "Delete a custom intent" },
        { method: "GET", path: "/api/dock/docks", auth: "lieutenant", description: "List all dock loadouts" },
        { method: "GET", path: "/api/dock/docks/:num", auth: "lieutenant", description: "Get a single dock" },
        { method: "PUT", path: "/api/dock/docks/:num", auth: "admiral", description: "Create or update a dock" },
        { method: "DELETE", path: "/api/dock/docks/:num", auth: "admiral", description: "Clear a dock" },
        { method: "PUT", path: "/api/dock/docks/:num/intents", auth: "admiral", description: "Set dock intents" },
        { method: "POST", path: "/api/dock/docks/:num/ships", auth: "admiral", description: "Add ship to dock" },
        { method: "DELETE", path: "/api/dock/docks/:num/ships/:shipId", auth: "admiral", description: "Remove ship from dock" },
        { method: "PATCH", path: "/api/dock/docks/:num/ships/:shipId", auth: "admiral", description: "Update dock ship" },
        { method: "GET", path: "/api/dock/presets", auth: "lieutenant", description: "List crew presets" },
        { method: "GET", path: "/api/dock/presets/:id", auth: "lieutenant", description: "Get a crew preset" },
        { method: "POST", path: "/api/dock/presets", auth: "admiral", description: "Create a crew preset" },
        { method: "PATCH", path: "/api/dock/presets/:id", auth: "admiral", description: "Update preset" },
        { method: "DELETE", path: "/api/dock/presets/:id", auth: "admiral", description: "Delete a crew preset" },
        { method: "PUT", path: "/api/dock/presets/:id/members", auth: "admiral", description: "Set preset crew members" },
        { method: "PUT", path: "/api/dock/presets/:id/tags", auth: "admiral", description: "Set preset tags" },
        { method: "GET", path: "/api/dock/tags", auth: "lieutenant", description: "List all unique preset tags" },
        { method: "GET", path: "/api/dock/docks/:num/presets", auth: "lieutenant", description: "Find presets for a dock" },
        { method: "GET", path: "/api/dock/docks/summary", auth: "lieutenant", description: "Computed dock briefing" },
        { method: "GET", path: "/api/dock/docks/conflicts", auth: "lieutenant", description: "Officer conflict report" },
        // ── Catalog (ADR-016) ──
        { method: "GET", path: "/api/catalog/officers", auth: "lieutenant", description: "List reference officers" },
        { method: "GET", path: "/api/catalog/officers/:id", auth: "lieutenant", description: "Get a reference officer" },
        { method: "GET", path: "/api/catalog/officers/merged", auth: "lieutenant", description: "Officers with overlay state" },
        { method: "GET", path: "/api/catalog/ships", auth: "lieutenant", description: "List reference ships" },
        { method: "GET", path: "/api/catalog/ships/:id", auth: "lieutenant", description: "Get a reference ship" },
        { method: "GET", path: "/api/catalog/ships/merged", auth: "lieutenant", description: "Ships with overlay state" },
        { method: "GET", path: "/api/catalog/counts", auth: "lieutenant", description: "Reference + overlay counts" },
        { method: "PATCH", path: "/api/catalog/officers/:id/overlay", auth: "admiral", description: "Set officer overlay" },
        { method: "DELETE", path: "/api/catalog/officers/:id/overlay", auth: "admiral", description: "Reset officer overlay" },
        { method: "PATCH", path: "/api/catalog/ships/:id/overlay", auth: "admiral", description: "Set ship overlay" },
        { method: "DELETE", path: "/api/catalog/ships/:id/overlay", auth: "admiral", description: "Reset ship overlay" },
        { method: "POST", path: "/api/catalog/officers/bulk-overlay", auth: "admiral", description: "Bulk set officer overlays" },
        { method: "POST", path: "/api/catalog/ships/bulk-overlay", auth: "admiral", description: "Bulk set ship overlays" },
        { method: "POST", path: "/api/catalog/sync", auth: "admiral", description: "Sync reference data from STFC wiki" },
        // ── Model Selector (Admiral only) ──
        { method: "GET", path: "/api/models", auth: "admiral", description: "List available AI models + current selection" },
        { method: "POST", path: "/api/models/select", auth: "admiral", description: "Hot-swap the active Gemini model", body: { model: "string (required) — model ID from GET /api/models" } },
        // ── Diagnostic Query (AI Tool) ──
        { method: "GET", path: "/api/diagnostic/schema", auth: "admiral", description: "DB schema introspection (tables, columns, indexes)" },
        { method: "GET", path: "/api/diagnostic/query", auth: "admiral", description: "Execute read-only SQL (AI consumption)", params: { sql: "string (required)" } },
        { method: "GET", path: "/api/diagnostic/summary", auth: "admiral", description: "Pre-built reference + overlay summary" },
      ],
    });
  });

  // ─── Diagnostic ─────────────────────────────────────────────

  router.get("/api/diagnostic", requireVisitor(appState), async (_req, res) => {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    sendOk(res, {
      system: {
        version: APP_VERSION,
        uptime,
        uptimeSeconds: Math.round(uptimeSeconds),
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
        startupComplete: appState.startupComplete,
      },
      gemini: appState.geminiEngine
        ? { status: "connected", model: appState.geminiEngine.getModel(), activeSessions: appState.geminiEngine.getSessionCount() }
        : { status: "not configured" },
      memory: await (async () => {
        if (!appState.memoryService) return { status: "not configured" };
        return { status: "active", frameCount: await appState.memoryService.getFrameCount(), dbPath: appState.memoryService.getDbPath() };
      })(),
      settings: await (async () => {
        if (!appState.settingsStore) return { status: "not configured" };
        return { status: "active", userOverrides: await appState.settingsStore.countUserOverrides() };
      })(),
      sessions: await (async () => {
        if (!appState.sessionStore) return { status: "not configured" };
        return { status: "active", count: await appState.sessionStore.count() };
      })(),
      dockStore: await (async () => {
        if (!appState.dockStore) return { status: "not configured" };
        return { status: "active", ...await appState.dockStore.counts() };
      })(),
      referenceStore: await (async () => {
        if (!appState.referenceStore) return { status: "not configured" };
        return { status: "active", ...await appState.referenceStore.counts() };
      })(),
      overlayStore: await (async () => {
        if (!appState.overlayStore) return { status: "not configured" };
        return { status: "active", ...await appState.overlayStore.counts() };
      })(),
    });
  });

  return router;
}
