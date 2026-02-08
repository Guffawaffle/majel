/**
 * routes/docks.ts — Drydock loadout management routes (ADR-010 Phases 1 & 2).
 *
 * Intent catalog CRUD, dock loadout management, dock ship rotation,
 * crew preset CRUD, conflict detection, and dock briefing.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { VALID_INTENT_CATEGORIES } from "../dock-store.js";

export function createDockRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Intents ────────────────────────────────────────────

  router.get("/api/fleet/intents", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const category = req.query.category as string | undefined;
    if (category && !VALID_INTENT_CATEGORIES.includes(category as never)) {
      return res.status(400).json({ error: `Invalid category. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}` });
    }
    const intents = appState.dockStore.listIntents(category ? { category } : undefined);
    res.json({ intents, count: intents.length });
  });

  router.post("/api/fleet/intents", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const { key, label, category, description, icon } = req.body;
    if (!key || !label || !category) {
      return res.status(400).json({ error: "Missing required fields: key, label, category" });
    }
    try {
      const intent = appState.dockStore.createIntent({ key, label, category, description: description ?? null, icon: icon ?? null });
      res.status(201).json(intent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/intents/:key", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const deleted = appState.dockStore.deleteIntent(req.params.key);
    if (!deleted) {
      // Could be builtin or not found
      const intent = appState.dockStore.getIntent(req.params.key);
      if (intent?.isBuiltin) {
        return res.status(400).json({ error: "Cannot delete built-in intents" });
      }
      return res.status(404).json({ error: "Intent not found" });
    }
    res.json({ key: req.params.key, status: "deleted" });
  });

  // ─── Docks ──────────────────────────────────────────────

  router.get("/api/fleet/docks", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const docks = appState.dockStore.listDocks();
    res.json({ docks, count: docks.length });
  });

  // ─── Computed Endpoints (must be before :num to avoid param matching) ──

  router.get("/api/fleet/docks/summary", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const briefing = appState.dockStore.buildBriefing();
    res.json(briefing);
  });

  router.get("/api/fleet/docks/conflicts", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const conflicts = appState.dockStore.getOfficerConflicts();
    res.json({ conflicts, count: conflicts.length });
  });

  router.get("/api/fleet/docks/:num", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    const dock = appState.dockStore.getDock(num);
    if (!dock) {
      return res.status(404).json({ error: "Dock not found" });
    }
    res.json(dock);
  });

  router.put("/api/fleet/docks/:num", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    try {
      const { label, notes, priority } = req.body;
      const dock = appState.dockStore.upsertDock(num, { label, notes, priority });
      res.json(dock);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/docks/:num", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    const deleted = appState.dockStore.deleteDock(num);
    if (!deleted) {
      return res.status(404).json({ error: "Dock not found" });
    }
    res.json({ dockNumber: num, status: "deleted" });
  });

  // ─── Dock Intents ───────────────────────────────────────

  router.put("/api/fleet/docks/:num/intents", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    const { intents } = req.body;
    if (!Array.isArray(intents)) {
      return res.status(400).json({ error: "Body must contain 'intents' array of intent keys" });
    }
    try {
      appState.dockStore.setDockIntents(num, intents);
      const resolved = appState.dockStore.getDockIntents(num);
      res.json({ dockNumber: num, intents: resolved, count: resolved.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ─── Dock Ships ─────────────────────────────────────────

  router.post("/api/fleet/docks/:num/ships", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    const { shipId, notes } = req.body;
    if (!shipId) {
      return res.status(400).json({ error: "Missing required field: shipId" });
    }
    try {
      const dockShip = appState.dockStore.addDockShip(num, shipId, { notes });
      res.status(201).json(dockShip);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/docks/:num/ships/:shipId", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    const removed = appState.dockStore.removeDockShip(num, req.params.shipId);
    if (!removed) {
      return res.status(404).json({ error: "Ship not assigned to this dock" });
    }
    res.json({ dockNumber: num, shipId: req.params.shipId, status: "removed" });
  });

  router.patch("/api/fleet/docks/:num/ships/:shipId", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 8) {
      return res.status(400).json({ error: "Dock number must be between 1 and 8" });
    }
    try {
      const { isActive, sortOrder, notes } = req.body;
      const updated = appState.dockStore.updateDockShip(num, req.params.shipId, { isActive, sortOrder, notes });
      if (!updated) {
        return res.status(404).json({ error: "Ship not assigned to this dock" });
      }
      res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ─── Crew Presets ───────────────────────────────────────

  router.get("/api/fleet/presets", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const shipId = req.query.shipId as string | undefined;
    const intentKey = req.query.intentKey as string | undefined;
    const presets = appState.dockStore.listPresets(
      (shipId || intentKey) ? { shipId, intentKey } : undefined,
    );
    res.json({ presets, count: presets.length });
  });

  router.get("/api/fleet/presets/:id", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid preset ID" });
    }
    const preset = appState.dockStore.getPreset(id);
    if (!preset) {
      return res.status(404).json({ error: "Preset not found" });
    }
    res.json(preset);
  });

  router.post("/api/fleet/presets", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const { shipId, intentKey, presetName, isDefault } = req.body;
    if (!shipId || !intentKey || !presetName) {
      return res.status(400).json({ error: "Missing required fields: shipId, intentKey, presetName" });
    }
    try {
      const preset = appState.dockStore.createPreset({ shipId, intentKey, presetName, isDefault });
      res.status(201).json(preset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.patch("/api/fleet/presets/:id", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid preset ID" });
    }
    try {
      const { presetName, isDefault } = req.body;
      const updated = appState.dockStore.updatePreset(id, { presetName, isDefault });
      if (!updated) {
        return res.status(404).json({ error: "Preset not found" });
      }
      res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/presets/:id", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid preset ID" });
    }
    const deleted = appState.dockStore.deletePreset(id);
    if (!deleted) {
      return res.status(404).json({ error: "Preset not found" });
    }
    res.json({ id, status: "deleted" });
  });

  router.put("/api/fleet/presets/:id/members", (req, res) => {
    if (!appState.dockStore) {
      return res.status(503).json({ error: "Dock store not available" });
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid preset ID" });
    }
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return res.status(400).json({ error: "Body must contain 'members' array" });
    }
    try {
      const result = appState.dockStore.setPresetMembers(id, members);
      res.json({ presetId: id, members: result, count: result.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });


  return router;
}
