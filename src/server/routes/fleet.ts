/**
 * routes/fleet.ts — Fleet management routes.
 *
 * Ships CRUD, Officers CRUD, Crew assignments, Fleet log, Import, Counts.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import {
  VALID_SHIP_STATUSES,
  type ShipStatus,
  type LogAction,
} from "../fleet-store.js";

export function createFleetRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Ships CRUD ─────────────────────────────────────────────

  router.get("/api/fleet/ships", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const status = req.query.status as ShipStatus | undefined;
    const role = req.query.role as string | undefined;
    if (status && !VALID_SHIP_STATUSES.includes(status)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid status. Valid: ${VALID_SHIP_STATUSES.join(", ")}`);
    }
    const ships = appState.fleetStore.listShips({ status, role });
    sendOk(res, { ships, count: ships.length });
  });

  router.post("/api/fleet/ships", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const { id, name, tier, shipClass, grade, rarity, faction, combatProfile, specialtyLoop, status, role, roleDetail, notes } = req.body;
    if (!id || !name) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: id, name");
    }
    try {
      const ship = appState.fleetStore.createShip({
        id,
        name,
        tier: tier ?? null,
        shipClass: shipClass ?? null,
        grade: grade ?? null,
        rarity: rarity ?? null,
        faction: faction ?? null,
        combatProfile: combatProfile ?? null,
        specialtyLoop: specialtyLoop ?? null,
        status: status || "ready",
        role: role ?? null,
        roleDetail: roleDetail ?? null,
        notes: notes ?? null,
        importedFrom: null,
      });
      sendOk(res, ship, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.get("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const ship = appState.fleetStore.getShip(req.params.id);
    if (!ship) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Ship not found", 404);
    }
    sendOk(res, ship);
  });

  router.patch("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    try {
      const ship = appState.fleetStore.updateShip(req.params.id, req.body);
      if (!ship) {
        return sendFail(res, ErrorCode.NOT_FOUND, "Ship not found", 404);
      }
      sendOk(res, ship);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const deleted = appState.fleetStore.deleteShip(req.params.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Ship not found", 404);
    }
    sendOk(res, { id: req.params.id, status: "deleted" });
  });

  // ─── Officers CRUD ──────────────────────────────────────────

  router.get("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const groupName = req.query.groupName as string | undefined;
    const unassigned = req.query.unassigned === "true";
    const officers = appState.fleetStore.listOfficers({ groupName, unassigned });
    sendOk(res, { officers, count: officers.length });
  });

  router.post("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const { id, name, rarity, level, rank, groupName, classPreference, activityAffinity, positionPreference } = req.body;
    if (!id || !name) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: id, name");
    }
    try {
      const officer = appState.fleetStore.createOfficer({
        id,
        name,
        rarity: rarity ?? null,
        level: level ?? null,
        rank: rank ?? null,
        groupName: groupName ?? null,
        classPreference: classPreference ?? null,
        activityAffinity: activityAffinity ?? null,
        positionPreference: positionPreference ?? null,
        importedFrom: null,
      });
      sendOk(res, officer, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.get("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const officer = appState.fleetStore.getOfficer(req.params.id);
    if (!officer) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Officer not found", 404);
    }
    sendOk(res, officer);
  });

  router.patch("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    try {
      const officer = appState.fleetStore.updateOfficer(req.params.id, req.body);
      if (!officer) {
        return sendFail(res, ErrorCode.NOT_FOUND, "Officer not found", 404);
      }
      sendOk(res, officer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const deleted = appState.fleetStore.deleteOfficer(req.params.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Officer not found", 404);
    }
    sendOk(res, { id: req.params.id, status: "deleted" });
  });

  // ─── Crew Assignments ──────────────────────────────────────

  router.post("/api/fleet/ships/:id/crew", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const { officerId, roleType, slot, activeForRole } = req.body;
    if (!officerId || !roleType) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required fields: officerId, roleType");
    }
    if (!["bridge", "specialist"].includes(roleType)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "roleType must be 'bridge' or 'specialist'");
    }
    try {
      const assignment = appState.fleetStore.assignCrew(req.params.id, officerId, roleType, slot, activeForRole);
      sendOk(res, assignment, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INVALID_PARAM, message);
    }
  });

  router.delete("/api/fleet/ships/:shipId/crew/:officerId", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const removed = appState.fleetStore.unassignCrew(req.params.shipId, req.params.officerId);
    if (!removed) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Assignment not found", 404);
    }
    sendOk(res, { shipId: req.params.shipId, officerId: req.params.officerId, status: "unassigned" });
  });

  // ─── Fleet Log ──────────────────────────────────────────────

  router.get("/api/fleet/log", (req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    const shipId = req.query.shipId as string | undefined;
    const officerId = req.query.officerId as string | undefined;
    const action = req.query.action as string | undefined;
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const entries = appState.fleetStore.getLog({
      shipId,
      officerId,
      action: action as LogAction | undefined,
      limit,
    });
    sendOk(res, { entries, count: entries.length });
  });

  // ─── Fleet Import ──────────────────────────────────────────

  router.post("/api/fleet/import", (_req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    if (!appState.fleetData) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "No fleet data loaded from Sheets. Hit /api/roster first.");
    }
    try {
      const result = appState.fleetStore.importFromFleetData(appState.fleetData);
      sendOk(res, { status: "imported", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.INTERNAL_ERROR, message, 500);
    }
  });

  // ─── Fleet Counts ──────────────────────────────────────────

  router.get("/api/fleet/counts", (_req, res) => {
    if (!appState.fleetStore) {
      return sendFail(res, ErrorCode.FLEET_STORE_NOT_AVAILABLE, "Fleet store not available", 503);
    }
    sendOk(res, appState.fleetStore.counts());
  });

  return router;
}
