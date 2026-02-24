/**
 * routes/catalog.ts — Reference Catalog + Overlay API (ADR-016 Phase 2)
 *
 * Endpoints for browsing the reference catalog (officers, ships) and
 * managing the user's overlay state (ownership, targeting).
 *
 * Reference data is sourced from local game data snapshot (ADR-028).
 * Legacy raw-*.json files are deprecated.
 *
 * Overlay data is full CRUD — the user's personal relationship to each entity.
 *
 * All handlers async for @libsql/client (ADR-018 Phase 1).
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireAdmiral, requireVisitor } from "../services/auth.js";
import { VALID_OWNERSHIP_STATES, type OwnershipState } from "../stores/overlay-store.js";

export function createCatalogRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const admiral = requireAdmiral(appState);

  // All catalog endpoints require authentication — overlay data is personal
  router.use("/api/catalog", requireVisitor(appState));

  // ── Helpers ─────────────────────────────────────────────

  function requireReferenceStore(res: import("express").Response): boolean {
    if (!appState.referenceStore) {
      sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      return false;
    }
    return true;
  }

  function requireOverlayStore(res: import("express").Response): boolean {
    if (!appState.overlayStoreFactory && !appState.overlayStore) {
      sendFail(res, ErrorCode.OVERLAY_STORE_NOT_AVAILABLE, "Overlay store not available", 503);
      return false;
    }
    return true;
  }

  /** #85: Get a user-scoped overlay store for the current request */
  function getOverlayStore(res: import("express").Response) {
    const userId = (res.locals.userId as string) || "local";
    return appState.overlayStoreFactory?.forUser(userId) ?? appState.overlayStore;
  }

  function isValidOwnership(v: unknown): v is OwnershipState {
    return typeof v === "string" && VALID_OWNERSHIP_STATES.includes(v as OwnershipState);
  }

  // ── Input validation helpers (ADR-017 hardening) ────────

  function validateInt(v: unknown, min: number, max: number): number | null | false {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") {
      if (!Number.isInteger(v) || v < min || v > max) return false;
      return v;
    }
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) return false;
      return n;
    }
    return false;
  }

  function validateString(v: unknown, maxLen: number): string | null | false {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return false;
    if (v.length > maxLen) return false;
    return v;
  }

  // ═══════════════════════════════════════════════════════════
  // Reference Catalog — Officers (read-only)
  // ═══════════════════════════════════════════════════════════

  router.get("/api/catalog/officers", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const store = appState.referenceStore!;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Search query must be 500 characters or fewer", 400);
    }
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const group = typeof req.query.group === "string" ? req.query.group : undefined;
    const officerClass = typeof req.query.officerClass === "string" ? parseInt(req.query.officerClass, 10) : undefined;
    const validOfficerClass = officerClass != null && !isNaN(officerClass) ? officerClass : undefined;

    let officers;
    if (q) {
      officers = await store.searchOfficers(q);
      if (rarity) officers = officers.filter(o => o.rarity === rarity);
      if (group) officers = officers.filter(o => o.groupName === group);
      if (validOfficerClass != null) officers = officers.filter(o => o.officerClass === validOfficerClass);
    } else {
      officers = await store.listOfficers({ rarity, groupName: group, officerClass: validOfficerClass });
    }

    sendOk(res, { officers, count: officers.length });
  });

  router.get("/api/catalog/officers/merged", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const refStore = appState.referenceStore!;
    const overlayStore = getOverlayStore(res);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Search query must be 500 characters or fewer", 400);
    }
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const group = typeof req.query.group === "string" ? req.query.group : undefined;
    const officerClass = typeof req.query.officerClass === "string" ? parseInt(req.query.officerClass, 10) : undefined;
    const validOfficerClass = officerClass != null && !isNaN(officerClass) ? officerClass : undefined;
    const ownership = typeof req.query.ownership === "string" ? req.query.ownership : undefined;
    const targetFilter = typeof req.query.target === "string" ? req.query.target : undefined;

    let officers;
    if (q) {
      officers = await refStore.searchOfficers(q);
      if (rarity) officers = officers.filter(o => o.rarity === rarity);
      if (group) officers = officers.filter(o => o.groupName === group);
      if (validOfficerClass != null) officers = officers.filter(o => o.officerClass === validOfficerClass);
    } else {
      officers = await refStore.listOfficers({ rarity, groupName: group, officerClass: validOfficerClass });
    }

    const overlayMap = new Map<string, Awaited<ReturnType<NonNullable<typeof overlayStore>["getOfficerOverlay"]>>>();
    if (overlayStore) {
      const overlays = await overlayStore.listOfficerOverlays();
      for (const ov of overlays) {
        overlayMap.set(ov.refId, ov);
      }
    }

    let merged = officers.map(officer => {
      const ov = overlayMap.get(officer.id);
      return {
        ...officer,
        ownershipState: ov?.ownershipState ?? "unowned" as OwnershipState,
        target: ov?.target ?? false,
        userLevel: ov?.level ?? null,
        userRank: ov?.rank ?? null,
        userPower: ov?.power ?? null,
        targetNote: ov?.targetNote ?? null,
        targetPriority: ov?.targetPriority ?? null,
      };
    });

    const hasOwnershipFilter = ownership && isValidOwnership(ownership);
    const hasTargetFilter = targetFilter === "true" || targetFilter === "false";

    if (hasOwnershipFilter && hasTargetFilter) {
      const ownershipMatch = (o: (typeof merged)[0]) => o.ownershipState === ownership;
      const targetMatch = targetFilter === "true"
        ? (o: (typeof merged)[0]) => o.target
        : (o: (typeof merged)[0]) => !o.target;
      merged = merged.filter(o => ownershipMatch(o) || targetMatch(o));
    } else {
      if (hasOwnershipFilter) {
        merged = merged.filter(o => o.ownershipState === ownership);
      }
      if (targetFilter === "true") {
        merged = merged.filter(o => o.target);
      } else if (targetFilter === "false") {
        merged = merged.filter(o => !o.target);
      }
    }

    sendOk(res, { officers: merged, count: merged.length });
  });

  router.get("/api/catalog/officers/:id", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const officer = await appState.referenceStore!.getOfficer(req.params.id as string);
    if (!officer) return sendFail(res, ErrorCode.NOT_FOUND, "Officer not found", 404);
    sendOk(res, officer);
  });

  // ═══════════════════════════════════════════════════════════
  // Reference Catalog — Ships (read-only)
  // ═══════════════════════════════════════════════════════════

  router.get("/api/catalog/ships", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const store = appState.referenceStore!;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Search query must be 500 characters or fewer", 400);
    }
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const faction = typeof req.query.faction === "string" ? req.query.faction : undefined;
    const shipClass = typeof req.query.class === "string" ? req.query.class : undefined;
    const hullType = typeof req.query.hullType === "string" ? parseInt(req.query.hullType, 10) : undefined;
    const validHullType = hullType != null && !isNaN(hullType) ? hullType : undefined;
    const grade = typeof req.query.grade === "string" ? parseInt(req.query.grade, 10) : undefined;
    const validGrade = grade != null && !isNaN(grade) ? grade : undefined;

    let ships;
    if (q) {
      ships = await store.searchShips(q);
      if (rarity) ships = ships.filter(s => s.rarity === rarity);
      if (faction) ships = ships.filter(s => s.faction === faction);
      if (shipClass) ships = ships.filter(s => s.shipClass === shipClass);
      if (validHullType != null) ships = ships.filter(s => s.hullType === validHullType);
      if (validGrade != null) ships = ships.filter(s => s.grade === validGrade);
    } else {
      ships = await store.listShips({ rarity, faction, shipClass, hullType: validHullType, grade: validGrade });
    }

    sendOk(res, { ships, count: ships.length });
  });

  router.get("/api/catalog/ships/merged", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const refStore = appState.referenceStore!;
    const overlayStore = getOverlayStore(res);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Search query must be 500 characters or fewer", 400);
    }
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const faction = typeof req.query.faction === "string" ? req.query.faction : undefined;
    const shipClass = typeof req.query.class === "string" ? req.query.class : undefined;
    const hullType = typeof req.query.hullType === "string" ? parseInt(req.query.hullType, 10) : undefined;
    const validHullType = hullType != null && !isNaN(hullType) ? hullType : undefined;
    const grade = typeof req.query.grade === "string" ? parseInt(req.query.grade, 10) : undefined;
    const validGrade = grade != null && !isNaN(grade) ? grade : undefined;
    const ownership = typeof req.query.ownership === "string" ? req.query.ownership : undefined;
    const targetFilter = typeof req.query.target === "string" ? req.query.target : undefined;

    let ships;
    if (q) {
      ships = await refStore.searchShips(q);
      if (rarity) ships = ships.filter(s => s.rarity === rarity);
      if (faction) ships = ships.filter(s => s.faction === faction);
      if (shipClass) ships = ships.filter(s => s.shipClass === shipClass);
      if (validHullType != null) ships = ships.filter(s => s.hullType === validHullType);
      if (validGrade != null) ships = ships.filter(s => s.grade === validGrade);
    } else {
      ships = await refStore.listShips({ rarity, faction, shipClass, hullType: validHullType, grade: validGrade });
    }

    const overlayMap = new Map<string, Awaited<ReturnType<NonNullable<typeof overlayStore>["getShipOverlay"]>>>();
    if (overlayStore) {
      const overlays = await overlayStore.listShipOverlays();
      for (const ov of overlays) {
        overlayMap.set(ov.refId, ov);
      }
    }

    let merged = ships.map(ship => {
      const ov = overlayMap.get(ship.id);
      return {
        ...ship,
        ownershipState: ov?.ownershipState ?? "unowned" as OwnershipState,
        target: ov?.target ?? false,
        userTier: ov?.tier ?? null,
        userLevel: ov?.level ?? null,
        userPower: ov?.power ?? null,
        targetNote: ov?.targetNote ?? null,
        targetPriority: ov?.targetPriority ?? null,
      };
    });

    const hasOwnershipFilter = ownership && isValidOwnership(ownership);
    const hasTargetFilter = targetFilter === "true" || targetFilter === "false";

    if (hasOwnershipFilter && hasTargetFilter) {
      const ownershipMatch = (s: (typeof merged)[0]) => s.ownershipState === ownership;
      const targetMatch = targetFilter === "true"
        ? (s: (typeof merged)[0]) => s.target
        : (s: (typeof merged)[0]) => !s.target;
      merged = merged.filter(s => ownershipMatch(s) || targetMatch(s));
    } else {
      if (hasOwnershipFilter) {
        merged = merged.filter(s => s.ownershipState === ownership);
      }
      if (targetFilter === "true") {
        merged = merged.filter(s => s.target);
      } else if (targetFilter === "false") {
        merged = merged.filter(s => !s.target);
      }
    }

    sendOk(res, { ships: merged, count: merged.length });
  });

  router.get("/api/catalog/ships/:id", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const ship = await appState.referenceStore!.getShip(req.params.id as string);
    if (!ship) return sendFail(res, ErrorCode.NOT_FOUND, "Ship not found", 404);
    sendOk(res, ship);
  });

  // ═══════════════════════════════════════════════════════════
  // Catalog Counts & Facets
  // ═══════════════════════════════════════════════════════════

  router.get("/api/catalog/counts", async (req, res) => {
    const refCounts = appState.referenceStore ? await appState.referenceStore.counts() : { officers: 0, ships: 0 };
    const overlayStore = getOverlayStore(res);
    const overlayCounts = overlayStore ? await overlayStore.counts() : {
      officers: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
      ships: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
    };
    sendOk(res, { reference: refCounts, overlay: overlayCounts });
  });

  // ═══════════════════════════════════════════════════════════
  // Overlay — Officer CRUD
  // ═══════════════════════════════════════════════════════════

  router.patch("/api/catalog/officers/:id/overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = getOverlayStore(res)!;
    const refId = req.params.id as string;

    if (appState.referenceStore && !(await appState.referenceStore.getOfficer(refId))) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Reference officer not found: ${refId}`, 404);
    }

    const { ownershipState, target, level, rank, power, targetNote, targetPriority } = req.body;

    if (ownershipState !== undefined && !isValidOwnership(ownershipState)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`, 400);
    }

    if (level !== undefined) {
      const v = validateInt(level, 1, 200);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "level must be an integer 1–200", 400);
    }
    if (rank !== undefined) {
      const v = validateString(rank, 50);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "rank must be a string (max 50 chars)", 400);
    }
    if (power !== undefined) {
      const v = validateInt(power, 0, 999_999_999);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "power must be an integer 0–999999999", 400);
    }
    if (targetNote !== undefined) {
      const v = validateString(targetNote, 500);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "targetNote must be a string (max 500 chars)", 400);
    }
    if (targetPriority !== undefined) {
      const v = validateInt(targetPriority, 1, 3);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "targetPriority must be 1, 2, or 3", 400);
    }

    const result = await overlay.setOfficerOverlay({
      refId,
      ...(ownershipState !== undefined && { ownershipState }),
      ...(target !== undefined && { target: !!target }),
      ...(level !== undefined && { level }),
      ...(rank !== undefined && { rank }),
      ...(power !== undefined && { power }),
      ...(targetNote !== undefined && { targetNote }),
      ...(targetPriority !== undefined && { targetPriority }),
    });

    sendOk(res, result);
  });

  router.delete("/api/catalog/officers/:id/overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const deleted = await getOverlayStore(res)!.deleteOfficerOverlay(req.params.id as string);
    sendOk(res, { deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Overlay — Ship CRUD
  // ═══════════════════════════════════════════════════════════

  router.patch("/api/catalog/ships/:id/overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = getOverlayStore(res)!;
    const refId = req.params.id as string;

    if (appState.referenceStore && !(await appState.referenceStore.getShip(refId))) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Reference ship not found: ${refId}`, 404);
    }

    const { ownershipState, target, tier, level, power, targetNote, targetPriority } = req.body;

    if (ownershipState !== undefined && !isValidOwnership(ownershipState)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`, 400);
    }

    if (tier !== undefined) {
      const v = validateInt(tier, 1, 10);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "tier must be an integer 1–10", 400);
    }
    if (level !== undefined) {
      const v = validateInt(level, 1, 200);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "level must be an integer 1–200", 400);
    }
    if (power !== undefined) {
      const v = validateInt(power, 0, 999_999_999);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "power must be an integer 0–999999999", 400);
    }
    if (targetNote !== undefined) {
      const v = validateString(targetNote, 500);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "targetNote must be a string (max 500 chars)", 400);
    }
    if (targetPriority !== undefined) {
      const v = validateInt(targetPriority, 1, 3);
      if (v === false) return sendFail(res, ErrorCode.INVALID_PARAM, "targetPriority must be 1, 2, or 3", 400);
    }

    const result = await overlay.setShipOverlay({
      refId,
      ...(ownershipState !== undefined && { ownershipState }),
      ...(target !== undefined && { target: !!target }),
      ...(tier !== undefined && { tier }),
      ...(level !== undefined && { level }),
      ...(power !== undefined && { power }),
      ...(targetNote !== undefined && { targetNote }),
      ...(targetPriority !== undefined && { targetPriority }),
    });

    sendOk(res, result);
  });

  router.delete("/api/catalog/ships/:id/overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const deleted = await getOverlayStore(res)!.deleteShipOverlay(req.params.id as string);
    sendOk(res, { deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Bulk Overlay Operations
  // ═══════════════════════════════════════════════════════════

  router.post("/api/catalog/officers/bulk-overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = getOverlayStore(res)!;
    const { refIds, ownershipState, target } = req.body;

    if (!Array.isArray(refIds) || refIds.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "refIds must be a non-empty array", 400);
    }
    if (refIds.length > 1000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "refIds array exceeds maximum of 1000 entries", 400);
    }
    if (refIds.some((id: unknown) => typeof id !== "string" || (id as string).length > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Each refId must be a string of 200 characters or fewer", 400);
    }

    let updated = 0;
    if (ownershipState !== undefined) {
      if (!isValidOwnership(ownershipState)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}`, 400);
      }
      updated += await overlay.bulkSetOfficerOwnership(refIds, ownershipState);
    }
    if (target !== undefined) {
      updated += await overlay.bulkSetOfficerTarget(refIds, !!target);
    }

    // ADR-026 D7: Create receipt for audit trail + undo
    let receiptId: number | null = null;
    if (appState.receiptStore && updated > 0) {
      const receipt = await appState.receiptStore.createReceipt({
        sourceType: "catalog_clicks",
        layer: "ownership",
        sourceMeta: { entity: "officers", count: refIds.length },
        changeset: { updated: refIds.map((id: string) => ({ id, ownershipState, target })) },
        inverse: { updated: refIds.map((id: string) => ({ id, revert: true })) },
      });
      receiptId = receipt.id;
    }

    sendOk(res, { updated, refIds: refIds.length, receiptId });
  });

  router.post("/api/catalog/ships/bulk-overlay", admiral, async (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = getOverlayStore(res)!;
    const { refIds, ownershipState, target } = req.body;

    if (!Array.isArray(refIds) || refIds.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "refIds must be a non-empty array", 400);
    }
    if (refIds.length > 1000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "refIds array exceeds maximum of 1000 entries", 400);
    }
    if (refIds.some((id: unknown) => typeof id !== "string" || (id as string).length > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Each refId must be a string of 200 characters or fewer", 400);
    }

    let updated = 0;
    if (ownershipState !== undefined) {
      if (!isValidOwnership(ownershipState)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}`, 400);
      }
      updated += await overlay.bulkSetShipOwnership(refIds, ownershipState);
    }
    if (target !== undefined) {
      updated += await overlay.bulkSetShipTarget(refIds, !!target);
    }

    // ADR-026 D7: Create receipt for audit trail + undo
    let receiptId: number | null = null;
    if (appState.receiptStore && updated > 0) {
      const receipt = await appState.receiptStore.createReceipt({
        sourceType: "catalog_clicks",
        layer: "ownership",
        sourceMeta: { entity: "ships", count: refIds.length },
        changeset: { updated: refIds.map((id: string) => ({ id, ownershipState, target })) },
        inverse: { updated: refIds.map((id: string) => ({ id, revert: true })) },
      });
      receiptId = receipt.id;
    }

    sendOk(res, { updated, refIds: refIds.length, receiptId });
  });

  return router;
}
