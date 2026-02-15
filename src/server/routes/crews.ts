/**
 * crews.ts — ADR-025 Crew Composition API Routes
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides the API surface for BridgeCores, BelowDeckPolicies,
 * Loadout Variants, Fleet Presets, Officer Reservations,
 * and the EffectiveDockState endpoint.
 *
 * Pattern: factory function createCrewRoutes(appState) → Router
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";
import { VALID_BRIDGE_SLOTS, VALID_BELOW_DECK_MODES } from "../types/crew-types.js";
import type { BridgeSlot, BelowDeckMode, VariantPatch, PlanSource } from "../types/crew-types.js";

export function createCrewRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  router.use("/api/bridge-cores", visitor);
  router.use("/api/below-deck-policies", visitor);
  router.use("/api/crew/loadouts", visitor);
  router.use("/api/fleet-presets", visitor);
  router.use("/api/officer-reservations", visitor);
  router.use("/api/crew/docks", visitor);
  router.use("/api/crew/plan", visitor);
  router.use("/api/effective-state", visitor);

  /** Guard: return crew store or 503 */
  function getStore() {
    return appState.crewStore;
  }

  // ═══════════════════════════════════════════════════════
  // Bridge Cores
  // ═══════════════════════════════════════════════════════

  router.get("/api/bridge-cores", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const cores = await store.listBridgeCores();
    sendOk(res, { bridgeCores: cores, count: cores.length });
  });

  router.get("/api/bridge-cores/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid bridge core ID", 400);
    const core = await store.getBridgeCore(id);
    if (!core) return sendFail(res, ErrorCode.NOT_FOUND, `Bridge core ${id} not found`, 404);
    sendOk(res, { bridgeCore: core });
  });

  router.post("/api/bridge-cores", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { name, members, notes } = req.body;
    if (!name || typeof name !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "name is required", 400);
    }
    if (!Array.isArray(members) || members.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "members must be a non-empty array", 400);
    }
    // Validate member entries
    for (const m of members) {
      if (!m.officerId || typeof m.officerId !== "string") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Each member requires a string officerId", 400);
      }
      if (!VALID_BRIDGE_SLOTS.includes(m.slot)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid slot: ${m.slot}. Must be one of: ${VALID_BRIDGE_SLOTS.join(", ")}`, 400);
      }
    }
    try {
      const core = await store.createBridgeCore(name, members as Array<{ officerId: string; slot: BridgeSlot }>, notes);
      sendOk(res, { bridgeCore: core }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return sendFail(res, ErrorCode.CONFLICT, `Bridge core name "${name}" already exists`, 409);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/bridge-cores/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid bridge core ID", 400);
    const { name, notes } = req.body;
    const updated = await store.updateBridgeCore(id, { name, notes });
    if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Bridge core ${id} not found`, 404);
    sendOk(res, { bridgeCore: updated });
  });

  router.delete("/api/bridge-cores/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid bridge core ID", 400);
    const deleted = await store.deleteBridgeCore(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Bridge core ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  router.put("/api/bridge-cores/:id/members", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid bridge core ID", 400);
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "members must be an array", 400);
    }
    for (const m of members) {
      if (!m.officerId || typeof m.officerId !== "string") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Each member requires a string officerId", 400);
      }
      if (!VALID_BRIDGE_SLOTS.includes(m.slot)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid slot: ${m.slot}`, 400);
      }
    }
    try {
      const updated = await store.setBridgeCoreMembers(id, members as Array<{ officerId: string; slot: BridgeSlot }>);
      sendOk(res, { members: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  // ═══════════════════════════════════════════════════════
  // Below Deck Policies
  // ═══════════════════════════════════════════════════════

  router.get("/api/below-deck-policies", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const policies = await store.listBelowDeckPolicies();
    sendOk(res, { belowDeckPolicies: policies, count: policies.length });
  });

  router.get("/api/below-deck-policies/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid policy ID", 400);
    const policy = await store.getBelowDeckPolicy(id);
    if (!policy) return sendFail(res, ErrorCode.NOT_FOUND, `Below deck policy ${id} not found`, 404);
    sendOk(res, { belowDeckPolicy: policy });
  });

  router.post("/api/below-deck-policies", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { name, mode, spec, notes } = req.body;
    if (!name || typeof name !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "name is required", 400);
    }
    if (!mode || !VALID_BELOW_DECK_MODES.includes(mode)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid mode. Must be one of: ${VALID_BELOW_DECK_MODES.join(", ")}`, 400);
    }
    if (spec !== undefined && (typeof spec !== "object" || spec === null)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "spec must be an object", 400);
    }
    try {
      const policy = await store.createBelowDeckPolicy(name, mode as BelowDeckMode, spec ?? {}, notes);
      sendOk(res, { belowDeckPolicy: policy }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return sendFail(res, ErrorCode.CONFLICT, `Policy name "${name}" already exists`, 409);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/below-deck-policies/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid policy ID", 400);
    const { name, mode, spec, notes } = req.body;
    if (mode !== undefined && !VALID_BELOW_DECK_MODES.includes(mode)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid mode. Must be one of: ${VALID_BELOW_DECK_MODES.join(", ")}`, 400);
    }
    const updated = await store.updateBelowDeckPolicy(id, {
      name, mode: mode as BelowDeckMode | undefined, spec, notes,
    });
    if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Below deck policy ${id} not found`, 404);
    sendOk(res, { belowDeckPolicy: updated });
  });

  router.delete("/api/below-deck-policies/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid policy ID", 400);
    const deleted = await store.deleteBelowDeckPolicy(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Below deck policy ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ═══════════════════════════════════════════════════════
  // Crew Loadouts (via crew-store, /api/crew/loadouts prefix to avoid conflict)
  // ═══════════════════════════════════════════════════════

  router.get("/api/crew/loadouts", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const filters: { shipId?: string; intentKey?: string; tag?: string; active?: boolean } = {};
    if (req.query.shipId) filters.shipId = req.query.shipId as string;
    if (req.query.intentKey) filters.intentKey = req.query.intentKey as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.active !== undefined) filters.active = req.query.active === "true";
    const loadouts = await store.listLoadouts(filters);
    sendOk(res, { loadouts, count: loadouts.length });
  });

  router.get("/api/crew/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const loadout = await store.getLoadout(id);
    if (!loadout) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { loadout });
  });

  router.post("/api/crew/loadouts", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { shipId, name, bridgeCoreId, belowDeckPolicyId, priority, isActive, intentKeys, tags, notes } = req.body;
    if (!shipId || typeof shipId !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "shipId is required", 400, {
        hints: ["Use a valid ship ID from GET /api/catalog/ships"],
      });
    }
    if (!name || typeof name !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "name is required", 400);
    }
    try {
      const loadout = await store.createLoadout({
        shipId, name, bridgeCoreId, belowDeckPolicyId,
        priority, isActive, intentKeys, tags, notes,
      });
      sendOk(res, { loadout }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return sendFail(res, ErrorCode.CONFLICT, `Loadout "${name}" already exists for this ship`, 409);
      }
      if (msg.includes("violates foreign key")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Referenced entity not found (ship, bridge core, or policy)", 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/crew/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const { name, bridgeCoreId, belowDeckPolicyId, priority, isActive, intentKeys, tags, notes } = req.body;
    const updated = await store.updateLoadout(id, {
      name, bridgeCoreId, belowDeckPolicyId, priority, isActive, intentKeys, tags, notes,
    });
    if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { loadout: updated });
  });

  router.delete("/api/crew/loadouts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const deleted = await store.deleteLoadout(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Loadout ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ═══════════════════════════════════════════════════════
  // Loadout Variants (sub-resource under crew loadouts)
  // ═══════════════════════════════════════════════════════

  router.get("/api/crew/loadouts/:loadoutId/variants", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const loadoutId = parseInt(req.params.loadoutId, 10);
    if (isNaN(loadoutId)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const variants = await store.listVariants(loadoutId);
    sendOk(res, { variants, count: variants.length });
  });

  router.post("/api/crew/loadouts/:loadoutId/variants", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const loadoutId = parseInt(req.params.loadoutId, 10);
    if (isNaN(loadoutId)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout ID", 400);
    const { name, patch, notes } = req.body;
    if (!name || typeof name !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "name is required", 400);
    }
    if (!patch || typeof patch !== "object") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "patch is required and must be an object", 400);
    }
    try {
      const variant = await store.createVariant(loadoutId, name, patch as VariantPatch, notes);
      sendOk(res, { variant }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return sendFail(res, ErrorCode.CONFLICT, `Variant "${name}" already exists for this loadout`, 409);
      }
      if (msg.includes("Unknown patch key") || msg.includes("mutually exclusive") || msg.includes("Invalid bridge slot")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, msg, 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/crew/loadouts/variants/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid variant ID", 400);
    const { name, patch, notes } = req.body;
    try {
      const updated = await store.updateVariant(id, {
        name, patch: patch as VariantPatch | undefined, notes,
      });
      if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Variant ${id} not found`, 404);
      sendOk(res, { variant: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unknown patch key") || msg.includes("mutually exclusive") || msg.includes("Invalid bridge slot")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, msg, 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.delete("/api/crew/loadouts/variants/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid variant ID", 400);
    const deleted = await store.deleteVariant(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Variant ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ── Resolve Variant (composition function) ──────────

  router.get("/api/crew/loadouts/:loadoutId/variants/:variantId/resolve", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const loadoutId = parseInt(req.params.loadoutId, 10);
    const variantId = parseInt(req.params.variantId, 10);
    if (isNaN(loadoutId) || isNaN(variantId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid loadout or variant ID", 400);
    }
    try {
      const resolved = await store.resolveVariant(loadoutId, variantId);
      sendOk(res, { resolvedLoadout: resolved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.NOT_FOUND, msg, 404);
    }
  });

  // ═══════════════════════════════════════════════════════
  // Docks (via crew-store)
  // ═══════════════════════════════════════════════════════

  router.get("/api/crew/docks", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const docks = await store.listDocks();
    sendOk(res, { docks, count: docks.length });
  });

  router.get("/api/crew/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const dock = await store.getDock(num);
    if (!dock) return sendFail(res, ErrorCode.NOT_FOUND, `Dock ${num} not found`, 404);
    sendOk(res, { dock });
  });

  router.put("/api/crew/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Dock number must be >= 1", 400);
    const { label, unlocked, notes } = req.body;
    const dock = await store.upsertDock(num, { label, unlocked, notes });
    sendOk(res, { dock });
  });

  router.delete("/api/crew/docks/:num", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid dock number", 400);
    const deleted = await store.deleteDock(num);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Dock ${num} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ═══════════════════════════════════════════════════════
  // Fleet Presets
  // ═══════════════════════════════════════════════════════

  router.get("/api/fleet-presets", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const presets = await store.listFleetPresets();
    sendOk(res, { fleetPresets: presets, count: presets.length });
  });

  router.get("/api/fleet-presets/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID", 400);
    const preset = await store.getFleetPreset(id);
    if (!preset) return sendFail(res, ErrorCode.NOT_FOUND, `Fleet preset ${id} not found`, 404);
    sendOk(res, { fleetPreset: preset });
  });

  router.post("/api/fleet-presets", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { name, notes } = req.body;
    if (!name || typeof name !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "name is required", 400);
    }
    try {
      const preset = await store.createFleetPreset(name, notes);
      sendOk(res, { fleetPreset: preset }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return sendFail(res, ErrorCode.CONFLICT, `Fleet preset "${name}" already exists`, 409);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/fleet-presets/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID", 400);
    const { name, isActive, notes } = req.body;
    try {
      const updated = await store.updateFleetPreset(id, { name, isActive, notes });
      if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Fleet preset ${id} not found`, 404);
      sendOk(res, { fleetPreset: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.delete("/api/fleet-presets/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID", 400);
    const deleted = await store.deleteFleetPreset(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Fleet preset ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  router.put("/api/fleet-presets/:id/slots", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID", 400);
    const { slots } = req.body;
    if (!Array.isArray(slots)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "slots must be an array", 400);
    }
    try {
      const updated = await store.setFleetPresetSlots(id, slots);
      sendOk(res, { slots: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates check constraint")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Each slot must have exactly one of: loadoutId, variantId, or awayOfficers", 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.post("/api/fleet-presets/:id/activate", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid preset ID", 400);
    try {
      const updated = await store.updateFleetPreset(id, { isActive: true });
      if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Fleet preset ${id} not found`, 404);
      sendOk(res, { fleetPreset: updated, activated: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  // ═══════════════════════════════════════════════════════
  // Plan Items (via crew-store)
  // ═══════════════════════════════════════════════════════

  router.get("/api/crew/plan", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const filters: { active?: boolean; dockNumber?: number } = {};
    if (req.query.active !== undefined) filters.active = req.query.active === "true";
    if (req.query.dockNumber !== undefined) filters.dockNumber = parseInt(req.query.dockNumber as string, 10);
    const planItems = await store.listPlanItems(filters);
    sendOk(res, { planItems, count: planItems.length });
  });

  router.get("/api/crew/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const item = await store.getPlanItem(id);
    if (!item) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    sendOk(res, { planItem: item });
  });

  router.post("/api/crew/plan", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { intentKey, label, loadoutId, variantId, dockNumber, awayOfficers, priority, isActive, source, notes } = req.body;
    // XOR check: exactly one of loadoutId, variantId, awayOfficers must be set
    const setCount = [loadoutId, variantId, awayOfficers].filter(v => v != null).length;
    if (setCount !== 1) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Exactly one of loadoutId, variantId, or awayOfficers must be provided", 400);
    }
    if (source !== undefined && !["manual", "preset"].includes(source)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, 'source must be "manual" or "preset"', 400);
    }
    try {
      const item = await store.createPlanItem({
        intentKey, label, loadoutId, variantId, dockNumber, awayOfficers,
        priority, isActive, source: source as PlanSource | undefined, notes,
      });
      sendOk(res, { planItem: item }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates check constraint")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Plan item constraint violation: exactly one of loadoutId/variantId/awayOfficers required", 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.patch("/api/crew/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const { intentKey, label, loadoutId, variantId, dockNumber, awayOfficers, priority, isActive, source, notes } = req.body;
    try {
      const updated = await store.updatePlanItem(id, {
        intentKey, label, loadoutId, variantId, dockNumber, awayOfficers,
        priority, isActive, source: source as PlanSource | undefined, notes,
      });
      if (!updated) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
      sendOk(res, { planItem: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.delete("/api/crew/plan/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid plan item ID", 400);
    const deleted = await store.deletePlanItem(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Plan item ${id} not found`, 404);
    sendOk(res, { deleted: true });
  });

  // ═══════════════════════════════════════════════════════
  // Officer Reservations
  // ═══════════════════════════════════════════════════════

  router.get("/api/officer-reservations", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const reservations = await store.listReservations();
    sendOk(res, { reservations, count: reservations.length });
  });

  router.put("/api/officer-reservations/:officerId", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { officerId } = req.params;
    const { reservedFor, locked, notes } = req.body;
    if (!reservedFor || typeof reservedFor !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "reservedFor is required", 400);
    }
    try {
      const reservation = await store.setReservation(officerId, reservedFor, locked, notes);
      sendOk(res, { reservation });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates foreign key")) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Officer "${officerId}" not found in reference data`, 400);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  router.delete("/api/officer-reservations/:officerId", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const { officerId } = req.params;
    const deleted = await store.deleteReservation(officerId);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `No reservation for officer "${officerId}"`, 404);
    sendOk(res, { deleted: true });
  });

  // ═══════════════════════════════════════════════════════
  // Effective Dock State (ADR-025 § D6)
  // ═══════════════════════════════════════════════════════

  router.get("/api/effective-state", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const state = await store.getEffectiveDockState();
    sendOk(res, { effectiveState: state });
  });

  return router;
}
