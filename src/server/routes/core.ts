/**
 * routes/core.ts — Core infrastructure routes.
 *
 * Health, API discovery, and diagnostic.
 */

import type { Application, Router } from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, createTimeoutMiddleware } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireVisitor } from "../services/auth.js";
import { collectApiRoutes } from "../route-introspection.js";

// Read version from package.json once at module load
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
})();

interface HealthStoreStatus extends Record<string, unknown> {
  active: boolean;
  error?: "unavailable";
}

export interface HealthResponse {
  status: "online" | "initializing";
  retryAfterMs?: number;
  gemini: "connected" | "not configured";
  memory: "active" | "not configured";
  sessions: "active" | "not configured";
  crewStore: HealthStoreStatus;
  referenceStore: HealthStoreStatus;
  overlayStore: HealthStoreStatus;
}

interface DiscoveryEndpoint {
  method: string;
  path: string;
  auth: string;
  description: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
}

function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function buildDiscoveryEndpoints(app: Application, documentedEndpoints: DiscoveryEndpoint[]): DiscoveryEndpoint[] {
  const documentedByKey = new Map(
    documentedEndpoints.map((endpoint) => [endpointKey(endpoint.method, endpoint.path), endpoint] as const),
  );

  return collectApiRoutes(app).map((route) => {
    const documented = documentedByKey.get(endpointKey(route.method, route.path));
    return documented ?? {
      method: route.method,
      path: route.path,
      auth: "unknown",
      description: "Undocumented endpoint",
    };
  });
}

export function createCoreRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // ─── Health ─────────────────────────────────────────────────

  router.get("/api/health", createTimeoutMiddleware(2000), async (_req, res) => {
    const status = appState.startupComplete ? "online" : "initializing";
    if (!appState.startupComplete) {
      res.setHeader("Retry-After", "2");
    }

    const safeCounts = async (
      store: { counts(): Promise<unknown> } | null | undefined,
      label: string,
    ): Promise<HealthStoreStatus> => {
      if (!store) return { active: false };
      try { return { active: true, ...await store.counts() as Record<string, unknown> }; }
      catch (err) { log.root.warn({ err, store: label }, "Health check: store counts failed"); return { active: true, error: "unavailable" as const }; }
    };

    const health: HealthResponse = {
      status,
      ...(!appState.startupComplete ? { retryAfterMs: 2000 } : {}),
      gemini: appState.geminiEngine ? "connected" : "not configured",
      memory: appState.memoryService ? "active" : "not configured",
      sessions: appState.sessionStore ? "active" : "not configured",
      crewStore: await safeCounts(appState.crewStore, "crewStore"),
      referenceStore: await safeCounts(appState.referenceStore, "referenceStore"),
      overlayStore: await safeCounts(appState.overlayStore, "overlayStore"),
    };

    sendOk(res, health);
  });

  // ─── API Discovery ──────────────────────────────────────────
  // CANONICAL ROUTE LIST — update this when adding/removing routes.
  // See docs/AX-SCHEMA.md for the API envelope specification.

  router.get("/api", (req, res) => {
    const documentedEndpoints: DiscoveryEndpoint[] = [
      { method: "GET", path: "/api", auth: "none", description: "API discovery (this endpoint)" },
      { method: "GET", path: "/api/health", auth: "none", description: "Fast health check (returns retryAfterMs when initializing)" },
      { method: "GET", path: "/api/diagnostic", auth: "lieutenant", description: "Deep subsystem status" },
      { method: "POST", path: "/api/chat", auth: "admiral", description: "Send a message, get a Gemini response", body: { message: "string (required)" } },
      { method: "GET", path: "/api/history", auth: "lieutenant", description: "Conversation history (session + Lex)", params: { source: "session|lex|both", limit: "1-100", sessionId: "string" } },
      { method: "GET", path: "/api/recall", auth: "lieutenant", description: "Search Lex memory by meaning", params: { q: "string (required)", limit: "1-100" } },
      { method: "GET", path: "/api/settings", auth: "lieutenant", description: "All settings with resolved values" },
      { method: "PATCH", path: "/api/settings", auth: "admiral", description: "Update one or more settings" },
      { method: "DELETE", path: "/api/settings/:key", auth: "admiral", description: "Reset a setting to its default" },
      // ── Per-User Settings (#86) ──
      { method: "GET", path: "/api/user-settings", auth: "visitor", description: "All user-overridable settings (merged with defaults)" },
      { method: "PUT", path: "/api/user-settings/:key", auth: "visitor", description: "Set a per-user preference override" },
      { method: "DELETE", path: "/api/user-settings/:key", auth: "visitor", description: "Remove per-user override (revert to default)" },
      { method: "GET", path: "/api/sessions", auth: "lieutenant", description: "List saved chat sessions" },
      { method: "GET", path: "/api/sessions/:id", auth: "lieutenant", description: "Get a session with all messages" },
      { method: "PATCH", path: "/api/sessions/:id", auth: "lieutenant", description: "Update session title" },
      { method: "DELETE", path: "/api/sessions/:id", auth: "lieutenant", description: "Delete a session" },
      // ── Crew Composition (ADR-025) ──
      { method: "GET", path: "/api/bridge-cores", auth: "lieutenant", description: "List all bridge cores" },
      { method: "GET", path: "/api/bridge-cores/:id", auth: "lieutenant", description: "Get a bridge core" },
      { method: "POST", path: "/api/bridge-cores", auth: "admiral", description: "Create a bridge core" },
      { method: "PATCH", path: "/api/bridge-cores/:id", auth: "admiral", description: "Update bridge core name/notes" },
      { method: "DELETE", path: "/api/bridge-cores/:id", auth: "admiral", description: "Delete a bridge core" },
      { method: "PUT", path: "/api/bridge-cores/:id/members", auth: "admiral", description: "Set bridge core crew members" },
      { method: "GET", path: "/api/below-deck-policies", auth: "lieutenant", description: "List below-deck policies" },
      { method: "GET", path: "/api/below-deck-policies/:id", auth: "lieutenant", description: "Get a below-deck policy" },
      { method: "POST", path: "/api/below-deck-policies", auth: "admiral", description: "Create a below-deck policy" },
      { method: "PATCH", path: "/api/below-deck-policies/:id", auth: "admiral", description: "Update a below-deck policy" },
      { method: "DELETE", path: "/api/below-deck-policies/:id", auth: "admiral", description: "Delete a below-deck policy" },
      { method: "GET", path: "/api/crew/loadouts", auth: "lieutenant", description: "List loadouts (filter by shipId)" },
      { method: "GET", path: "/api/crew/loadouts/:id", auth: "lieutenant", description: "Get a loadout" },
      { method: "POST", path: "/api/crew/loadouts", auth: "admiral", description: "Create a loadout" },
      { method: "PATCH", path: "/api/crew/loadouts/:id", auth: "admiral", description: "Update a loadout" },
      { method: "DELETE", path: "/api/crew/loadouts/:id", auth: "admiral", description: "Delete a loadout" },
      { method: "GET", path: "/api/crew/loadouts/:loadoutId/variants", auth: "lieutenant", description: "List variants for a loadout" },
      { method: "POST", path: "/api/crew/loadouts/:loadoutId/variants", auth: "admiral", description: "Create a variant" },
      { method: "PATCH", path: "/api/crew/loadouts/variants/:id", auth: "admiral", description: "Update a variant" },
      { method: "DELETE", path: "/api/crew/loadouts/variants/:id", auth: "admiral", description: "Delete a variant" },
      { method: "GET", path: "/api/crew/loadouts/:loadoutId/variants/:variantId/resolve", auth: "lieutenant", description: "Resolve effective crew for a variant" },
      { method: "GET", path: "/api/crew/docks", auth: "lieutenant", description: "List all docks" },
      { method: "GET", path: "/api/crew/docks/:num", auth: "lieutenant", description: "Get a single dock" },
      { method: "PUT", path: "/api/crew/docks/:num", auth: "admiral", description: "Create or update a dock" },
      { method: "DELETE", path: "/api/crew/docks/:num", auth: "admiral", description: "Clear a dock" },
      { method: "GET", path: "/api/fleet-presets", auth: "lieutenant", description: "List fleet presets" },
      { method: "GET", path: "/api/fleet-presets/:id", auth: "lieutenant", description: "Get a fleet preset" },
      { method: "POST", path: "/api/fleet-presets", auth: "admiral", description: "Create a fleet preset" },
      { method: "PATCH", path: "/api/fleet-presets/:id", auth: "admiral", description: "Update a fleet preset" },
      { method: "DELETE", path: "/api/fleet-presets/:id", auth: "admiral", description: "Delete a fleet preset" },
      { method: "PUT", path: "/api/fleet-presets/:id/slots", auth: "admiral", description: "Set preset dock slots" },
      { method: "POST", path: "/api/fleet-presets/:id/activate", auth: "admiral", description: "Activate a fleet preset" },
      { method: "GET", path: "/api/crew/plan", auth: "lieutenant", description: "List plan items" },
      { method: "GET", path: "/api/crew/plan/:id", auth: "lieutenant", description: "Get a plan item" },
      { method: "POST", path: "/api/crew/plan", auth: "admiral", description: "Create a plan item" },
      { method: "PATCH", path: "/api/crew/plan/:id", auth: "admiral", description: "Update a plan item" },
      { method: "DELETE", path: "/api/crew/plan/:id", auth: "admiral", description: "Delete a plan item" },
      { method: "GET", path: "/api/officer-reservations", auth: "lieutenant", description: "List officer reservations" },
      { method: "PUT", path: "/api/officer-reservations/:officerId", auth: "admiral", description: "Reserve an officer" },
      { method: "DELETE", path: "/api/officer-reservations/:officerId", auth: "admiral", description: "Release an officer reservation" },
      { method: "GET", path: "/api/effective-state", auth: "lieutenant", description: "Computed effective fleet state" },
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
      { method: "POST", path: "/api/catalog/sync", auth: "admiral", description: "Sync reference data from game data" },
      // ── Targets (ADR-026) ──
      { method: "GET", path: "/api/targets", auth: "lieutenant", description: "List targets (filter by type, status, priority)" },
      { method: "GET", path: "/api/targets/counts", auth: "lieutenant", description: "Target counts by status" },
      { method: "GET", path: "/api/targets/conflicts", auth: "lieutenant", description: "Officer conflict report across targets" },
      { method: "GET", path: "/api/targets/:id", auth: "lieutenant", description: "Get a target" },
      { method: "POST", path: "/api/targets", auth: "admiral", description: "Create a target" },
      { method: "PATCH", path: "/api/targets/:id", auth: "admiral", description: "Update a target" },
      { method: "DELETE", path: "/api/targets/:id", auth: "admiral", description: "Delete a target" },
      { method: "POST", path: "/api/targets/:id/achieve", auth: "admiral", description: "Mark a target as achieved" },
      // ── Import Receipts (ADR-026) ──
      { method: "GET", path: "/api/import/receipts", auth: "lieutenant", description: "List import receipts (filter by layer)" },
      { method: "GET", path: "/api/import/receipts/:id", auth: "lieutenant", description: "Get an import receipt" },
      { method: "POST", path: "/api/import/receipts/:id/undo", auth: "admiral", description: "Undo an import receipt" },
      { method: "POST", path: "/api/import/receipts/:id/resolve", auth: "admiral", description: "Resolve import conflicts" },
      { method: "POST", path: "/api/import/analyze", auth: "lieutenant", description: "Analyze CSV and suggest column mappings with sample rows" },
      { method: "POST", path: "/api/import/parse", auth: "lieutenant", description: "Parse CSV into headers and rows" },
      { method: "POST", path: "/api/import/map", auth: "lieutenant", description: "Apply column mapping to parsed rows" },
      { method: "POST", path: "/api/import/resolve", auth: "lieutenant", description: "Resolve mapped rows to reference officers/ships" },
      { method: "POST", path: "/api/import/commit", auth: "lieutenant", description: "Commit resolved ownership rows and create import receipt" },
      // ── Model Selector (Admiral only) ──
      { method: "GET", path: "/api/models", auth: "admiral", description: "List available AI models + current selection" },
      { method: "POST", path: "/api/models/select", auth: "admiral", description: "Hot-swap the active Gemini model", body: { model: "string (required) — model ID from GET /api/models" } },
      // ── Diagnostic Query (AI Tool) ──
      { method: "GET", path: "/api/diagnostic/schema", auth: "admiral", description: "DB schema introspection (tables, columns, indexes)" },
      { method: "GET", path: "/api/diagnostic/query", auth: "admiral", description: "Execute read-only SQL (AI consumption)", params: { sql: "string (required)" } },
      { method: "GET", path: "/api/diagnostic/summary", auth: "admiral", description: "Pre-built reference + overlay summary" },
    ];

    const endpoints = buildDiscoveryEndpoints(req.app, documentedEndpoints);

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
      endpoints,
    });
  });

  // ─── Diagnostic ─────────────────────────────────────────────

  router.get("/api/diagnostic", requireVisitor(appState), async (req, res) => {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    const isAdmiral = res.locals.isAdmiral;

    sendOk(res, {
      system: {
        version: APP_VERSION,
        uptime,
        uptimeSeconds: Math.round(uptimeSeconds),
        ...(isAdmiral ? { nodeVersion: process.version } : {}),
        timestamp: new Date().toISOString(),
        startupComplete: appState.startupComplete,
      },
      gemini: appState.geminiEngine
        ? { status: "connected", model: appState.geminiEngine.getModel(), activeSessions: appState.geminiEngine.getSessionCount() }
        : { status: "not configured" },
      memory: await (async () => {
        if (!appState.memoryService) return { status: "not configured" };
        const info: Record<string, unknown> = { status: "active", frameCount: await appState.memoryService.getFrameCount() };
        if (isAdmiral) info.dbPath = appState.memoryService.getDbPath();
        return info;
      })(),
      settings: await (async () => {
        if (!appState.settingsStore) return { status: "not configured" };
        return { status: "active", userOverrides: await appState.settingsStore.countUserOverrides() };
      })(),
      sessions: await (async () => {
        if (!appState.sessionStore) return { status: "not configured" };
        return { status: "active", count: await appState.sessionStore.count() };
      })(),
      crewStore: await (async () => {
        if (!appState.crewStore) return { status: "not configured" };
        return { status: "active", ...await appState.crewStore.counts() };
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
