/**
 * routes/catalog.ts — Reference Catalog + Overlay API (ADR-016 Phase 2)
 *
 * Endpoints for browsing the reference catalog (officers, ships) and
 * managing the user's overlay state (ownership, targeting).
 *
 * Reference data is read-only via these routes (populated by wiki ingest).
 * Overlay data is full CRUD — the user's personal relationship to each entity.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { VALID_OWNERSHIP_STATES, type OwnershipState } from "../overlay-store.js";
import { syncWikiData } from "../wiki-ingest.js";

export function createCatalogRoutes(appState: AppState): Router {
  const router = Router();

  // ── Helpers ─────────────────────────────────────────────

  function requireReferenceStore(res: import("express").Response): boolean {
    if (!appState.referenceStore) {
      sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      return false;
    }
    return true;
  }

  function requireOverlayStore(res: import("express").Response): boolean {
    if (!appState.overlayStore) {
      sendFail(res, ErrorCode.OVERLAY_STORE_NOT_AVAILABLE, "Overlay store not available", 503);
      return false;
    }
    return true;
  }

  function isValidOwnership(v: unknown): v is OwnershipState {
    return typeof v === "string" && VALID_OWNERSHIP_STATES.includes(v as OwnershipState);
  }

  // ═══════════════════════════════════════════════════════════
  // Reference Catalog — Officers (read-only)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/catalog/officers
   * List all reference officers, optionally filtered.
   * Query: ?q=search&rarity=epic&group=Command
   */
  router.get("/api/catalog/officers", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const store = appState.referenceStore!;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const group = typeof req.query.group === "string" ? req.query.group : undefined;

    let officers;
    if (q) {
      officers = store.searchOfficers(q);
      // Apply additional filters if present
      if (rarity) officers = officers.filter(o => o.rarity === rarity);
      if (group) officers = officers.filter(o => o.groupName === group);
    } else {
      officers = store.listOfficers({ rarity, groupName: group });
    }

    sendOk(res, { officers, count: officers.length });
  });

  /**
   * GET /api/catalog/officers/merged
   * Officers with their overlay state joined.
   * Query: ?q=search&rarity=epic&group=Command&ownership=owned&target=true
   * NOTE: Must be registered BEFORE /api/catalog/officers/:id to avoid param capture.
   */
  router.get("/api/catalog/officers/merged", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const refStore = appState.referenceStore!;
    const overlayStore = appState.overlayStore;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const group = typeof req.query.group === "string" ? req.query.group : undefined;
    const ownership = typeof req.query.ownership === "string" ? req.query.ownership : undefined;
    const targetFilter = typeof req.query.target === "string" ? req.query.target : undefined;

    // Get reference officers
    let officers;
    if (q) {
      officers = refStore.searchOfficers(q);
      if (rarity) officers = officers.filter(o => o.rarity === rarity);
      if (group) officers = officers.filter(o => o.groupName === group);
    } else {
      officers = refStore.listOfficers({ rarity, groupName: group });
    }

    // Build overlay map
    const overlayMap = new Map<string, ReturnType<NonNullable<typeof overlayStore>["getOfficerOverlay"]>>();
    if (overlayStore) {
      const overlays = overlayStore.listOfficerOverlays();
      for (const ov of overlays) {
        overlayMap.set(ov.refId, ov);
      }
    }

    // Merge
    let merged = officers.map(officer => {
      const ov = overlayMap.get(officer.id);
      return {
        ...officer,
        ownershipState: ov?.ownershipState ?? "unowned" as OwnershipState,
        target: ov?.target ?? false,
        userLevel: ov?.level ?? null,
        userRank: ov?.rank ?? null,
        targetNote: ov?.targetNote ?? null,
        targetPriority: ov?.targetPriority ?? null,
      };
    });

    // Apply overlay filters
    // When both ownership AND target filters are active, use OR (union)
    // so "Owned + Targeted" shows officers matching either condition.
    // When only one is active, apply it as a simple filter.
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

  /**
   * GET /api/catalog/officers/:id
   * Get a single reference officer by ID.
   */
  router.get("/api/catalog/officers/:id", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const officer = appState.referenceStore!.getOfficer(req.params.id);
    if (!officer) return sendFail(res, ErrorCode.NOT_FOUND, `Officer not found: ${req.params.id}`, 404);
    sendOk(res, officer);
  });

  // ═══════════════════════════════════════════════════════════
  // Reference Catalog — Ships (read-only)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/catalog/ships
   * List all reference ships, optionally filtered.
   * Query: ?q=search&rarity=epic&faction=Federation&class=Explorer
   */
  router.get("/api/catalog/ships", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const store = appState.referenceStore!;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const faction = typeof req.query.faction === "string" ? req.query.faction : undefined;
    const shipClass = typeof req.query.class === "string" ? req.query.class : undefined;

    let ships;
    if (q) {
      ships = store.searchShips(q);
      if (rarity) ships = ships.filter(s => s.rarity === rarity);
      if (faction) ships = ships.filter(s => s.faction === faction);
      if (shipClass) ships = ships.filter(s => s.shipClass === shipClass);
    } else {
      ships = store.listShips({ rarity, faction, shipClass });
    }

    sendOk(res, { ships, count: ships.length });
  });

  /**
   * GET /api/catalog/ships/merged
   * Ships with their overlay state joined.
   * Query: ?q=search&rarity=epic&faction=Federation&class=Explorer&ownership=owned&target=true
   * NOTE: Must be registered BEFORE /api/catalog/ships/:id to avoid param capture.
   */
  router.get("/api/catalog/ships/merged", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const refStore = appState.referenceStore!;
    const overlayStore = appState.overlayStore;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rarity = typeof req.query.rarity === "string" ? req.query.rarity : undefined;
    const faction = typeof req.query.faction === "string" ? req.query.faction : undefined;
    const shipClass = typeof req.query.class === "string" ? req.query.class : undefined;
    const ownership = typeof req.query.ownership === "string" ? req.query.ownership : undefined;
    const targetFilter = typeof req.query.target === "string" ? req.query.target : undefined;

    let ships;
    if (q) {
      ships = refStore.searchShips(q);
      if (rarity) ships = ships.filter(s => s.rarity === rarity);
      if (faction) ships = ships.filter(s => s.faction === faction);
      if (shipClass) ships = ships.filter(s => s.shipClass === shipClass);
    } else {
      ships = refStore.listShips({ rarity, faction, shipClass });
    }

    const overlayMap = new Map<string, ReturnType<NonNullable<typeof overlayStore>["getShipOverlay"]>>();
    if (overlayStore) {
      const overlays = overlayStore.listShipOverlays();
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
        targetNote: ov?.targetNote ?? null,
        targetPriority: ov?.targetPriority ?? null,
      };
    });

    // Apply overlay filters (OR when both active, same as officers/merged)
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

  /**
   * GET /api/catalog/ships/:id
   * Get a single reference ship by ID.
   */
  router.get("/api/catalog/ships/:id", (req, res) => {
    if (!requireReferenceStore(res)) return;
    const ship = appState.referenceStore!.getShip(req.params.id);
    if (!ship) return sendFail(res, ErrorCode.NOT_FOUND, `Ship not found: ${req.params.id}`, 404);
    sendOk(res, ship);
  });

  // ═══════════════════════════════════════════════════════════
  // Wiki Sync — user-initiated reference data import
  // Fetches from Fandom Special:Export, parses wikitables,
  // and bulk-upserts into the reference store. Single request
  // per entity type — NOT a crawler or scraper.
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/catalog/sync
   * Sync reference data from the STFC Fandom Wiki.
   * Body: { consent: true, officers?: boolean, ships?: boolean }
   * Response: { officers: {created,updated,total,parsed}, ships: {...}, provenance: {...} }
   */
  router.post("/api/catalog/sync", async (req, res) => {
    if (!requireReferenceStore(res)) return;
    const store = appState.referenceStore!;

    const { consent, officers, ships } = req.body;
    if (!consent) {
      return sendFail(
        res,
        ErrorCode.MISSING_PARAM,
        "consent:true required — acknowledges Fandom wiki data is CC BY-SA 3.0 licensed",
        400,
      );
    }

    try {
      const result = await syncWikiData(store, {
        officers: officers !== false,
        ships: ships !== false,
      });
      sendOk(res, result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INTERNAL_ERROR, `Wiki sync failed: ${msg}`, 502);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Catalog Counts & Facets
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /api/catalog/counts
   * Reference + overlay counts summary.
   */
  router.get("/api/catalog/counts", (req, res) => {
    const refCounts = appState.referenceStore?.counts() ?? { officers: 0, ships: 0 };
    const overlayCounts = appState.overlayStore?.counts() ?? {
      officers: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
      ships: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
    };
    sendOk(res, { reference: refCounts, overlay: overlayCounts });
  });

  // ═══════════════════════════════════════════════════════════
  // Overlay — Officer CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * PATCH /api/catalog/officers/:id/overlay
   * Set/update overlay for a single officer.
   * Body: { ownershipState?, target?, level?, rank?, targetNote?, targetPriority? }
   */
  router.patch("/api/catalog/officers/:id/overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = appState.overlayStore!;
    const refId = req.params.id;

    // Validate ref exists
    if (appState.referenceStore && !appState.referenceStore.getOfficer(refId)) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Reference officer not found: ${refId}`, 404);
    }

    const { ownershipState, target, level, rank, targetNote, targetPriority } = req.body;

    // Validate ownership state if provided
    if (ownershipState !== undefined && !isValidOwnership(ownershipState)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`, 400);
    }

    const result = overlay.setOfficerOverlay({
      refId,
      ...(ownershipState !== undefined && { ownershipState }),
      ...(target !== undefined && { target: !!target }),
      ...(level !== undefined && { level }),
      ...(rank !== undefined && { rank }),
      ...(targetNote !== undefined && { targetNote }),
      ...(targetPriority !== undefined && { targetPriority }),
    });

    sendOk(res, result);
  });

  /**
   * DELETE /api/catalog/officers/:id/overlay
   * Remove overlay for a single officer (resets to unknown/no target).
   */
  router.delete("/api/catalog/officers/:id/overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const deleted = appState.overlayStore!.deleteOfficerOverlay(req.params.id);
    sendOk(res, { deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Overlay — Ship CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * PATCH /api/catalog/ships/:id/overlay
   * Set/update overlay for a single ship.
   * Body: { ownershipState?, target?, tier?, level?, targetNote?, targetPriority? }
   */
  router.patch("/api/catalog/ships/:id/overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = appState.overlayStore!;
    const refId = req.params.id;

    if (appState.referenceStore && !appState.referenceStore.getShip(refId)) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Reference ship not found: ${refId}`, 404);
    }

    const { ownershipState, target, tier, level, targetNote, targetPriority } = req.body;

    if (ownershipState !== undefined && !isValidOwnership(ownershipState)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`, 400);
    }

    const result = overlay.setShipOverlay({
      refId,
      ...(ownershipState !== undefined && { ownershipState }),
      ...(target !== undefined && { target: !!target }),
      ...(tier !== undefined && { tier }),
      ...(level !== undefined && { level }),
      ...(targetNote !== undefined && { targetNote }),
      ...(targetPriority !== undefined && { targetPriority }),
    });

    sendOk(res, result);
  });

  /**
   * DELETE /api/catalog/ships/:id/overlay
   * Remove overlay for a single ship.
   */
  router.delete("/api/catalog/ships/:id/overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const deleted = appState.overlayStore!.deleteShipOverlay(req.params.id);
    sendOk(res, { deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Bulk Overlay Operations
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/catalog/officers/bulk-overlay
   * Bulk set ownership or target for multiple officers.
   * Body: { refIds: string[], ownershipState?: OwnershipState, target?: boolean }
   */
  router.post("/api/catalog/officers/bulk-overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = appState.overlayStore!;
    const { refIds, ownershipState, target } = req.body;

    if (!Array.isArray(refIds) || refIds.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "refIds must be a non-empty array", 400);
    }

    let updated = 0;
    if (ownershipState !== undefined) {
      if (!isValidOwnership(ownershipState)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}`, 400);
      }
      updated += overlay.bulkSetOfficerOwnership(refIds, ownershipState);
    }
    if (target !== undefined) {
      updated += overlay.bulkSetOfficerTarget(refIds, !!target);
    }

    sendOk(res, { updated, refIds: refIds.length });
  });

  /**
   * POST /api/catalog/ships/bulk-overlay
   * Bulk set ownership or target for multiple ships.
   * Body: { refIds: string[], ownershipState?: OwnershipState, target?: boolean }
   */
  router.post("/api/catalog/ships/bulk-overlay", (req, res) => {
    if (!requireOverlayStore(res)) return;
    const overlay = appState.overlayStore!;
    const { refIds, ownershipState, target } = req.body;

    if (!Array.isArray(refIds) || refIds.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "refIds must be a non-empty array", 400);
    }

    let updated = 0;
    if (ownershipState !== undefined) {
      if (!isValidOwnership(ownershipState)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid ownershipState: ${ownershipState}`, 400);
      }
      updated += overlay.bulkSetShipOwnership(refIds, ownershipState);
    }
    if (target !== undefined) {
      updated += overlay.bulkSetShipTarget(refIds, !!target);
    }

    sendOk(res, { updated, refIds: refIds.length });
  });

  return router;
}
