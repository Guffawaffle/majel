/**
 * routes/loadouts.ts — Loadout API routes (ADR-022 Phase 2).
 *
 * Loadout CRUD, dock management, plan items with away teams,
 * intent catalog, officer conflicts, plan validation, plan briefing,
 * and cascade previews.
 *
 * Replaces routes/docks.ts (ADR-010). All routes require visitor auth.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { VALID_INTENT_CATEGORIES } from "../stores/loadout-store.js";
import { requireVisitor } from "../services/auth.js";
import { buildPlanBriefing } from "../services/plan-briefing.js";

export function createLoadoutRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  router.use("/api/loadouts", visitor);
  router.use("/api/docks", visitor);
  router.use("/api/plan", visitor);
  router.use("/api/intents", visitor);

  /** Guard: return the store or 503 */
  function getStore() {
    return appState.loadoutStore;
  }

  // ─── Intents ────────────────────────────────────────────

  router.get("/api/intents", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const category = req.query.category as string | undefined;
    if (category && !VALID_INTENT_CATEGORIES.includes(category as never)) {
      return sendFail(res, ErrorCode.UNKNOWN_CATEGORY, `Unknown category: ${category}`, 400, {
        hints: [`Valid categories: ${VALID_INTENT_CATEGORIES.join(", ")}`],
      });
    }
    const intents = await store.listIntents(category ? { category } : undefined);
    sendOk(res, { intents, count: intents.length });
  });

  router.post("/api/intents", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const { key, label, category, description, icon } = req.body;
    if (!key || !label || !category) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: key, label, category", 400);
    }
    if (!VALID_INTENT_CATEGORIES.includes(category)) {
      return sendFail(res, ErrorCode.UNKNOWN_CATEGORY, `Unknown category: ${category}`, 400, {
        hints: [`Valid categories: ${VALID_INTENT_CATEGORIES.join(", ")}`],
      });
    }
    try {
      const intent = await store.createIntent({ key, label, category, description, icon });
      sendOk(res, { intent }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Intent '${key}' already exists`, 409);
      }
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to create intent", 500);
    }
  });

  router.delete("/api/intents/:key", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const existing = await store.getIntent(req.params.key);
    if (!existing) return sendFail(res, ErrorCode.NOT_FOUND, `Intent '${req.params.key}' not found`, 404);
    if (existing.isBuiltin) {
      return sendFail(res, ErrorCode.BUILTIN_IMMUTABLE, "Cannot delete built-in intents", 400);
    }
    await store.deleteIntent(req.params.key);
    sendOk(res, { deleted: true });
  });

  // ─── Loadouts ───────────────────────────────────────────

  router.get("/api/loadouts", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const filters: { shipId?: string; intentKey?: string; tag?: string; active?: boolean } = {};
    if (req.query.shipId) filters.shipId = req.query.shipId as string;
    if (req.query.intentKey) filters.intentKey = req.query.intentKey as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.active !== undefined) filters.active = req.query.active === "true";
    const loadouts = await store.listLoadouts(Object.keys(filters).length > 0 ? filters : undefined);
    sendOk(res, { loadouts, count: loadouts.length });
  });

  router.get("/api/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const loadout = await store.getLoadout(id);
    if (!loadout) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { loadout });
  });

  router.post("/api/loadouts", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const { shipId, name, priority, isActive, intentKeys, tags, notes } = req.body;
    if (!shipId || !name) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: shipId, name", 400);
    }
    if (typeof shipId !== "string" || typeof name !== "string") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "shipId and name must be strings", 400);
    }
    try {
      const loadout = await store.createLoadout({ shipId, name, priority, isActive, intentKeys, tags, notes });
      sendOk(res, { loadout }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates foreign key") || msg.includes("Ship not found")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Ship '${shipId}' not found in reference data`, 400, {
          hints: ["Use a valid ship ID from GET /api/catalog/ships"],
        });
      }
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to create loadout", 500);
    }
  });

  router.patch("/api/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const { name, priority, isActive, intentKeys, tags, notes } = req.body;
    const updated = await store.updateLoadout(id, { name, priority, isActive, intentKeys, tags, notes });
    if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { loadout: updated });
  });

  router.delete("/api/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const deleted = await store.deleteLoadout(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  router.get("/api/loadouts/:id/preview-delete", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const preview = await store.previewDeleteLoadout(id);
    sendOk(res, { preview });
  });

  // ─── Loadout Members ───────────────────────────────────

  router.put("/api/loadouts/:id/members", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'members' array in request body", 400, {
        hints: ['Send: { "members": [{ "officerId": "wiki:officer:123", "roleType": "bridge", "slot": "captain" }] }'],
      });
    }
    // Validate each member entry
    for (const m of members) {
      if (!m.officerId || typeof m.officerId !== "string") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Each member must have a string officerId", 400);
      }
      if (!["bridge", "below_deck"].includes(m.roleType)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `roleType must be 'bridge' or 'below_deck', got '${m.roleType}'`, 400);
      }
    }
    // Verify loadout exists
    const loadout = await store.getLoadout(id);
    if (!loadout) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    const result = await store.setLoadoutMembers(id, members);
    sendOk(res, { members: result });
  });

  // ─── Loadouts by Intent ─────────────────────────────────

  router.get("/api/loadouts/by-intent/:intentKey", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const loadouts = await store.findLoadoutsForIntent(req.params.intentKey);
    sendOk(res, { loadouts, count: loadouts.length });
  });

  // ─── Docks ──────────────────────────────────────────────

  router.get("/api/docks", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const docks = await store.listDocks();
    sendOk(res, { docks, count: docks.length });
  });

  router.get("/api/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const dock = await store.getDock(num);
    if (!dock) return sendFail(res, ErrorCode.NOT_FOUND, `Dock ${num} not found`, 404);
    sendOk(res, { dock });
  });

  router.put("/api/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const { label, notes } = req.body;
    const dock = await store.upsertDock(num, { label, notes });
    sendOk(res, { dock });
  });

  router.delete("/api/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const deleted = await store.deleteDock(num);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Dock ${num} not found`, 404);
    sendOk(res, { deleted: true });
  });

  router.get("/api/docks/:num/preview-delete", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const preview = await store.previewDeleteDock(num);
    sendOk(res, { preview });
  });

  // ─── Plan Items ─────────────────────────────────────────

  router.get("/api/plan", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const filters: { active?: boolean; dockNumber?: number; intentKey?: string } = {};
    if (req.query.active !== undefined) filters.active = req.query.active === "true";
    if (req.query.dockNumber) filters.dockNumber = parseInt(req.query.dockNumber as string, 10);
    if (req.query.intentKey) filters.intentKey = req.query.intentKey as string;
    const items = await store.listPlanItems(Object.keys(filters).length > 0 ? filters : undefined);
    sendOk(res, { planItems: items, count: items.length });
  });

  router.get("/api/plan/validate", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const validation = await store.validatePlan();
    sendOk(res, { validation });
  });

  router.get("/api/plan/conflicts", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const conflicts = await store.getOfficerConflicts();
    sendOk(res, { conflicts, count: conflicts.length });
  });

  router.get("/api/plan/briefing", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const tier = parseInt((req.query.tier as string) || "1", 10);
    if (![1, 2, 3].includes(tier)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "tier must be 1, 2, or 3", 400, {
        hints: ["Tier 1 = summary, Tier 2 = crew detail, Tier 3 = insights"],
      });
    }
    const briefing = await buildPlanBriefing(store, tier as 1 | 2 | 3);
    sendOk(res, { briefing });
  });

  router.get("/api/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const item = await store.getPlanItem(id);
    if (!item) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    sendOk(res, { planItem: item });
  });

  router.post("/api/plan", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const { intentKey, label, loadoutId, dockNumber, priority, isActive, notes } = req.body;
    try {
      const item = await store.createPlanItem({ intentKey, label, loadoutId, dockNumber, priority, isActive, notes });
      sendOk(res, { planItem: item }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates foreign key")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Referenced loadout or dock not found", 400, {
          hints: ["Ensure loadoutId and dockNumber reference existing entities"],
        });
      }
      sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to create plan item", 500);
    }
  });

  router.patch("/api/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const { intentKey, label, loadoutId, dockNumber, priority, isActive, notes } = req.body;
    const updated = await store.updatePlanItem(id, { intentKey, label, loadoutId, dockNumber, priority, isActive, notes });
    if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    sendOk(res, { planItem: updated });
  });

  router.delete("/api/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const deleted = await store.deletePlanItem(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ─── Plan Away Members ──────────────────────────────────

  router.put("/api/plan/:id/away-members", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const { officerIds } = req.body;
    if (!Array.isArray(officerIds)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'officerIds' array in request body", 400, {
        hints: ['Send: { "officerIds": ["wiki:officer:123", "wiki:officer:456"] }'],
      });
    }
    // Verify plan item exists
    const item = await store.getPlanItem(id);
    if (!item) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    const result = await store.setPlanAwayMembers(id, officerIds);
    sendOk(res, { awayMembers: result });
  });

  // ─── Cascade Previews (Officers) ───────────────────────

  router.get("/api/loadouts/officers/:id/preview-delete", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Loadout store not available", 503);
    const preview = await store.previewDeleteOfficer(req.params.id);
    sendOk(res, { preview });
  });

  return router;
}
