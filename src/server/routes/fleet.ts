/**
 * routes/fleet.ts — Fleet management routes.
 *
 * Ships CRUD, Officers CRUD, Crew assignments, Fleet log, Import, Counts.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
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
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const status = req.query.status as ShipStatus | undefined;
    const role = req.query.role as string | undefined;
    if (status && !VALID_SHIP_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${VALID_SHIP_STATUSES.join(", ")}` });
    }
    const ships = appState.fleetStore.listShips({ status, role });
    res.json({ ships, count: ships.length });
  });

  router.post("/api/fleet/ships", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { id, name, tier, shipClass, status, role, roleDetail, notes } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing required fields: id, name" });
    }
    try {
      const ship = appState.fleetStore.createShip({
        id,
        name,
        tier: tier ?? null,
        shipClass: shipClass ?? null,
        status: status || "ready",
        role: role ?? null,
        roleDetail: roleDetail ?? null,
        notes: notes ?? null,
        importedFrom: null,
      });
      res.status(201).json(ship);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const ship = appState.fleetStore.getShip(req.params.id);
    if (!ship) {
      return res.status(404).json({ error: "Ship not found" });
    }
    res.json(ship);
  });

  router.patch("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    try {
      const ship = appState.fleetStore.updateShip(req.params.id, req.body);
      if (!ship) {
        return res.status(404).json({ error: "Ship not found" });
      }
      res.json(ship);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/ships/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const deleted = appState.fleetStore.deleteShip(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Ship not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  // ─── Officers CRUD ──────────────────────────────────────────

  router.get("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const groupName = req.query.groupName as string | undefined;
    const unassigned = req.query.unassigned === "true";
    const officers = appState.fleetStore.listOfficers({ groupName, unassigned });
    res.json({ officers, count: officers.length });
  });

  router.post("/api/fleet/officers", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { id, name, rarity, level, rank, groupName } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing required fields: id, name" });
    }
    try {
      const officer = appState.fleetStore.createOfficer({
        id,
        name,
        rarity: rarity ?? null,
        level: level ?? null,
        rank: rank ?? null,
        groupName: groupName ?? null,
        importedFrom: null,
      });
      res.status(201).json(officer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const officer = appState.fleetStore.getOfficer(req.params.id);
    if (!officer) {
      return res.status(404).json({ error: "Officer not found" });
    }
    res.json(officer);
  });

  router.patch("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    try {
      const officer = appState.fleetStore.updateOfficer(req.params.id, req.body);
      if (!officer) {
        return res.status(404).json({ error: "Officer not found" });
      }
      res.json(officer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/officers/:id", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const deleted = appState.fleetStore.deleteOfficer(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Officer not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  // ─── Crew Assignments ──────────────────────────────────────

  router.post("/api/fleet/ships/:id/crew", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const { officerId, roleType, slot, activeForRole } = req.body;
    if (!officerId || !roleType) {
      return res.status(400).json({ error: "Missing required fields: officerId, roleType" });
    }
    if (!["bridge", "specialist"].includes(roleType)) {
      return res.status(400).json({ error: "roleType must be 'bridge' or 'specialist'" });
    }
    try {
      const assignment = appState.fleetStore.assignCrew(req.params.id, officerId, roleType, slot, activeForRole);
      res.status(201).json(assignment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/fleet/ships/:shipId/crew/:officerId", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    const removed = appState.fleetStore.unassignCrew(req.params.shipId, req.params.officerId);
    if (!removed) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    res.json({ shipId: req.params.shipId, officerId: req.params.officerId, status: "unassigned" });
  });

  // ─── Fleet Log ──────────────────────────────────────────────

  router.get("/api/fleet/log", (req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
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
    res.json({ entries, count: entries.length });
  });

  // ─── Fleet Import ──────────────────────────────────────────

  router.post("/api/fleet/import", (_req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    if (!appState.fleetData) {
      return res.status(400).json({ error: "No fleet data loaded from Sheets. Hit /api/roster first." });
    }
    try {
      const result = appState.fleetStore.importFromFleetData(appState.fleetData);
      res.json({ status: "imported", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Fleet Counts ──────────────────────────────────────────

  router.get("/api/fleet/counts", (_req, res) => {
    if (!appState.fleetStore) {
      return res.status(503).json({ error: "Fleet store not available" });
    }
    res.json(appState.fleetStore.counts());
  });

  return router;
}
