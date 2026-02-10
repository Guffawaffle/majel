/**
 * routes/docks.ts — Drydock loadout management routes (ADR-010 Phases 1 & 2).
 *
 * Intent catalog CRUD, dock loadout management, dock ship rotation,
 * crew preset CRUD, conflict detection, and dock briefing.
 *
 * All handlers async for @libsql/client (ADR-018 Phase 1).
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { VALID_INTENT_CATEGORIES } from "../dock-store.js";

export function createDockRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Intents ────────────────────────────────────────────

  router.get("/api/dock/intents", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const category = req.query.category as string | undefined;
    if (category && !VALID_INTENT_CATEGORIES.includes(category as never)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid category. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}`);
    }
    const intents = await appState.dockStore.listIntents(category ? { category } : undefined);
    sendOk(res, { intents, count: intents.length });
  });

  router.post("/api/dock/intents", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const { key, label, category, description, icon } = req.body;
    if (!key || !label || !category) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: key, label, category");
    }
    try {
      const intent = await appState.dockStore.createIntent({ key, label, category, description: description ?? null, icon: icon ?? null });
      sendOk(res, intent, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/dock/intents/:key", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const deleted = await appState.dockStore.deleteIntent(req.params.key);
    if (!deleted) {
      // Could be builtin or not found
      const intent = await appState.dockStore.getIntent(req.params.key);
      if (intent?.isBuiltin) {
        return sendFail(res, ErrorCode.BUILTIN_IMMUTABLE, "Cannot delete built-in intents");
      }
      return sendFail(res, ErrorCode.NOT_FOUND, "Intent not found", 404);
    }
    sendOk(res, { key: req.params.key, status: "deleted" });
  });

  // ─── Docks ──────────────────────────────────────────────

  router.get("/api/dock/docks", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const docks = await appState.dockStore.listDocks();
    sendOk(res, { docks, count: docks.length });
  });

  // ─── Computed Endpoints (must be before :num to avoid param matching) ──

  router.get("/api/dock/docks/next-number", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    sendOk(res, { nextDockNumber: await appState.dockStore.nextDockNumber() });
  });

  router.get("/api/dock/docks/summary", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const briefing = await appState.dockStore.buildBriefing();
    sendOk(res, briefing);
  });

  router.get("/api/dock/docks/conflicts", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const conflicts = await appState.dockStore.getOfficerConflicts();
    sendOk(res, { conflicts, count: conflicts.length });
  });

  router.get("/api/dock/docks/:num", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const dock = await appState.dockStore.getDock(num);
    if (!dock) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Dock not found", 404);
    }
    sendOk(res, dock);
  });

  router.put("/api/dock/docks/:num", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    try {
      const { label, notes, priority } = req.body;
      const dock = await appState.dockStore.upsertDock(num, { label, notes, priority });
      sendOk(res, dock);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/dock/docks/:num", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const deleted = await appState.dockStore.deleteDock(num);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Dock not found", 404);
    }
    sendOk(res, { dockNumber: num, status: "deleted" });
  });

  // ─── Cascade Previews ──────────────────────────────────

  router.get("/api/dock/docks/:num/cascade-preview", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const preview = await appState.dockStore.previewDeleteDock(num);
    sendOk(res, { dockNumber: num, ...preview });
  });

  router.get("/api/dock/ships/:id/cascade-preview", async (req, res) => {
    const dockStore = appState.dockStore;
    if (!dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = req.params.id;
    const dockPreview = await dockStore.previewDeleteShip(id);
    sendOk(res, {
      shipId: id,
      dockAssignments: dockPreview.dockAssignments,
      crewPresets: dockPreview.presets,
    });
  });

  router.get("/api/dock/officers/:id/cascade-preview", async (req, res) => {
    const dockStore = appState.dockStore;
    if (!dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = req.params.id;
    const dockPreview = await dockStore.previewDeleteOfficer(id);
    sendOk(res, {
      officerId: id,
      presetMemberships: dockPreview.presetMemberships,
    });
  });

  // ─── Dock Intents ───────────────────────────────────────

  router.put("/api/dock/docks/:num/intents", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const { intents } = req.body;
    if (!Array.isArray(intents)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Body must contain 'intents' array of intent keys");
    }
    try {
      await appState.dockStore.setDockIntents(num, intents);
      const resolved = await appState.dockStore.getDockIntents(num);
      sendOk(res, { dockNumber: num, intents: resolved, count: resolved.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  // ─── Dock Ships ─────────────────────────────────────────

  router.post("/api/dock/docks/:num/ships", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const { shipId, notes } = req.body;
    if (!shipId) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required field: shipId");
    }
    try {
      const dockShip = await appState.dockStore.addDockShip(num, shipId, { notes });
      sendOk(res, dockShip, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/dock/docks/:num/ships/:shipId", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const removed = await appState.dockStore.removeDockShip(num, req.params.shipId);
    if (!removed) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Ship not assigned to this dock", 404);
    }
    sendOk(res, { dockNumber: num, shipId: req.params.shipId, status: "removed" });
  });

  router.patch("/api/dock/docks/:num/ships/:shipId", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    try {
      const { isActive, sortOrder, notes } = req.body;
      const updated = await appState.dockStore.updateDockShip(num, req.params.shipId, { isActive, sortOrder, notes });
      if (!updated) {
        return sendFail(res, ErrorCode.NOT_FOUND, "Ship not assigned to this dock", 404);
      }
      sendOk(res, updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  // ─── Crew Presets ───────────────────────────────────────

  router.get("/api/dock/presets", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const shipId = req.query.shipId as string | undefined;
    const intentKey = req.query.intentKey as string | undefined;
    const tag = req.query.tag as string | undefined;
    const officerId = req.query.officerId as string | undefined;
    const hasFilters = shipId || intentKey || tag || officerId;
    const presets = await appState.dockStore.listPresets(
      hasFilters ? { shipId, intentKey, tag, officerId } : undefined,
    );
    sendOk(res, { presets, count: presets.length });
  });

  router.get("/api/dock/presets/:id", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID");
    }
    const preset = await appState.dockStore.getPreset(id);
    if (!preset) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Preset not found", 404);
    }
    sendOk(res, preset);
  });

  router.post("/api/dock/presets", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const { shipId, intentKey, presetName, isDefault } = req.body;
    if (!shipId || !intentKey || !presetName) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: shipId, intentKey, presetName");
    }
    try {
      const preset = await appState.dockStore.createPreset({ shipId, intentKey, presetName, isDefault });
      sendOk(res, preset, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.patch("/api/dock/presets/:id", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID");
    }
    try {
      const { presetName, isDefault } = req.body;
      const updated = await appState.dockStore.updatePreset(id, { presetName, isDefault });
      if (!updated) {
        return sendFail(res, ErrorCode.NOT_FOUND, "Preset not found", 404);
      }
      sendOk(res, updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/dock/presets/:id", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID");
    }
    const deleted = await appState.dockStore.deletePreset(id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Preset not found", 404);
    }
    sendOk(res, { id, status: "deleted" });
  });

  router.put("/api/dock/presets/:id/members", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID");
    }
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Body must contain 'members' array");
    }
    try {
      const result = await appState.dockStore.setPresetMembers(id, members);
      sendOk(res, { presetId: id, members: result, count: result.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  // ─── Tags & Discovery ─────────────────────────────────────

  router.get("/api/dock/tags", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const tags = await appState.dockStore.listAllTags();
    sendOk(res, { tags, count: tags.length });
  });

  router.put("/api/dock/presets/:id/tags", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID");
    }
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Body must contain 'tags' array");
    }
    try {
      const result = await appState.dockStore.setPresetTags(id, tags);
      sendOk(res, { presetId: id, tags: result, count: result.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.get("/api/dock/docks/:num/presets", async (req, res) => {
    if (!appState.dockStore) {
      return sendFail(res, ErrorCode.DOCK_STORE_NOT_AVAILABLE, "Dock store not available", 503);
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be a positive integer");
    }
    const presets = await appState.dockStore.findPresetsForDock(num);
    sendOk(res, { dockNumber: num, presets, count: presets.length });
  });


  return router;
}
