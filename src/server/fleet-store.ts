/**
 * fleet-store.ts — Fleet Management Data Layer
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed operational fleet database. Ships and officers are
 * imported from Google Sheets as baseline data, then extended with
 * assignments, statuses, and crew configurations locally.
 *
 * See ADR-007 for the full design rationale.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";
import type { FleetData, FleetSection } from "./fleet-data.js";

// ─── Types ──────────────────────────────────────────────────

export type ShipStatus =
  | "deployed"
  | "ready"
  | "maintenance"
  | "training"
  | "reserve"
  | "awaiting-crew";

export const VALID_SHIP_STATUSES: ShipStatus[] = [
  "deployed",
  "ready",
  "maintenance",
  "training",
  "reserve",
  "awaiting-crew",
];

export interface Ship {
  id: string;
  name: string;
  tier: number | null;
  shipClass: string | null;
  status: ShipStatus;
  role: string | null;
  roleDetail: string | null;
  notes: string | null;
  importedFrom: string | null;
  statusChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Officer {
  id: string;
  name: string;
  rarity: string | null;
  level: number | null;
  rank: string | null;
  groupName: string | null;
  importedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CrewRoleType = "bridge" | "specialist";

export interface CrewAssignment {
  id: number;
  shipId: string;
  officerId: string;
  roleType: CrewRoleType;
  slot: string | null;
  activeForRole: string | null;
  createdAt: string;
  /** Joined fields (populated in queries) */
  officerName?: string;
  shipName?: string;
}

export type LogAction =
  | "assigned"
  | "unassigned"
  | "status_change"
  | "role_change"
  | "imported"
  | "created"
  | "updated"
  | "deleted";

export interface AssignmentLogEntry {
  id: number;
  shipId: string | null;
  officerId: string | null;
  action: LogAction;
  detail: string | null;
  timestamp: string;
}

// ─── Store Interface ────────────────────────────────────────

export interface FleetStore {
  // ── Ships ─────────────────────────────────────────────
  createShip(ship: Omit<Ship, "createdAt" | "updatedAt" | "statusChangedAt">): Ship;
  getShip(id: string): (Ship & { crew: CrewAssignment[] }) | null;
  listShips(filters?: { status?: ShipStatus; role?: string }): Ship[];
  updateShip(id: string, fields: Partial<Pick<Ship, "name" | "status" | "role" | "roleDetail" | "notes" | "tier" | "shipClass">>): Ship | null;
  deleteShip(id: string): boolean;

  // ── Officers ──────────────────────────────────────────
  createOfficer(officer: Omit<Officer, "createdAt" | "updatedAt">): Officer;
  getOfficer(id: string): (Officer & { assignments: CrewAssignment[] }) | null;
  listOfficers(filters?: { groupName?: string; unassigned?: boolean }): Officer[];
  updateOfficer(id: string, fields: Partial<Pick<Officer, "name" | "rarity" | "level" | "rank" | "groupName">>): Officer | null;
  deleteOfficer(id: string): boolean;

  // ── Crew Assignments ──────────────────────────────────
  assignCrew(shipId: string, officerId: string, roleType: CrewRoleType, slot?: string, activeForRole?: string): CrewAssignment;
  unassignCrew(shipId: string, officerId: string): boolean;
  getShipCrew(shipId: string, activeForRole?: string): CrewAssignment[];

  // ── Assignment Log ────────────────────────────────────
  getLog(filters?: { shipId?: string; officerId?: string; action?: LogAction; limit?: number }): AssignmentLogEntry[];

  // ── Import ────────────────────────────────────────────
  importFromFleetData(fleetData: FleetData): { ships: number; officers: number; skipped: number };

  // ── Diagnostics ───────────────────────────────────────
  getDbPath(): string;
  counts(): { ships: number; officers: number; assignments: number; logEntries: number };
  close(): void;
}

// ─── Helpers ────────────────────────────────────────────────

/** Slugify a name into an ID: "USS Saladin" → "uss-saladin" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Implementation ─────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "fleet.db");

export function createFleetStore(dbPath?: string): FleetStore {
  const resolvedPath = dbPath || DB_FILE;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS ships (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier INTEGER,
      ship_class TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      role TEXT,
      role_detail TEXT,
      notes TEXT,
      imported_from TEXT,
      status_changed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS officers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rarity TEXT,
      level INTEGER,
      rank TEXT,
      group_name TEXT,
      imported_from TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crew_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ship_id TEXT NOT NULL REFERENCES ships(id) ON DELETE CASCADE,
      officer_id TEXT NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
      role_type TEXT NOT NULL CHECK (role_type IN ('bridge', 'specialist')),
      slot TEXT,
      active_for_role TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(ship_id, officer_id, role_type, active_for_role)
    );

    CREATE TABLE IF NOT EXISTS assignment_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ship_id TEXT,
      officer_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crew_ship ON crew_assignments(ship_id);
    CREATE INDEX IF NOT EXISTS idx_crew_officer ON crew_assignments(officer_id);
    CREATE INDEX IF NOT EXISTS idx_log_ship ON assignment_log(ship_id);
    CREATE INDEX IF NOT EXISTS idx_log_officer ON assignment_log(officer_id);
    CREATE INDEX IF NOT EXISTS idx_log_timestamp ON assignment_log(timestamp);
  `);

  log.fleet.debug({ dbPath: resolvedPath }, "fleet store initialized");

  // ── Prepared Statements ─────────────────────────────────

  const stmts = {
    // Ships
    insertShip: db.prepare(
      `INSERT INTO ships (id, name, tier, ship_class, status, role, role_detail, notes, imported_from, status_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getShip: db.prepare(
      `SELECT id, name, tier, ship_class AS shipClass, status, role, role_detail AS roleDetail,
              notes, imported_from AS importedFrom, status_changed_at AS statusChangedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ships WHERE id = ?`,
    ),
    listShips: db.prepare(
      `SELECT id, name, tier, ship_class AS shipClass, status, role, role_detail AS roleDetail,
              notes, imported_from AS importedFrom, status_changed_at AS statusChangedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ships ORDER BY name ASC`,
    ),
    listShipsByStatus: db.prepare(
      `SELECT id, name, tier, ship_class AS shipClass, status, role, role_detail AS roleDetail,
              notes, imported_from AS importedFrom, status_changed_at AS statusChangedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ships WHERE status = ? ORDER BY name ASC`,
    ),
    listShipsByRole: db.prepare(
      `SELECT id, name, tier, ship_class AS shipClass, status, role, role_detail AS roleDetail,
              notes, imported_from AS importedFrom, status_changed_at AS statusChangedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ships WHERE role = ? ORDER BY name ASC`,
    ),
    listShipsByStatusAndRole: db.prepare(
      `SELECT id, name, tier, ship_class AS shipClass, status, role, role_detail AS roleDetail,
              notes, imported_from AS importedFrom, status_changed_at AS statusChangedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ships WHERE status = ? AND role = ? ORDER BY name ASC`,
    ),
    deleteShip: db.prepare(`DELETE FROM ships WHERE id = ?`),
    shipExists: db.prepare(`SELECT 1 FROM ships WHERE id = ?`),

    // Officers
    insertOfficer: db.prepare(
      `INSERT INTO officers (id, name, rarity, level, rank, group_name, imported_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getOfficer: db.prepare(
      `SELECT id, name, rarity, level, rank, group_name AS groupName,
              imported_from AS importedFrom, created_at AS createdAt, updated_at AS updatedAt
       FROM officers WHERE id = ?`,
    ),
    listOfficers: db.prepare(
      `SELECT id, name, rarity, level, rank, group_name AS groupName,
              imported_from AS importedFrom, created_at AS createdAt, updated_at AS updatedAt
       FROM officers ORDER BY name ASC`,
    ),
    listOfficersByGroup: db.prepare(
      `SELECT id, name, rarity, level, rank, group_name AS groupName,
              imported_from AS importedFrom, created_at AS createdAt, updated_at AS updatedAt
       FROM officers WHERE group_name = ? ORDER BY name ASC`,
    ),
    listUnassignedOfficers: db.prepare(
      `SELECT o.id, o.name, o.rarity, o.level, o.rank, o.group_name AS groupName,
              o.imported_from AS importedFrom, o.created_at AS createdAt, o.updated_at AS updatedAt
       FROM officers o
       WHERE NOT EXISTS (SELECT 1 FROM crew_assignments ca WHERE ca.officer_id = o.id)
       ORDER BY o.name ASC`,
    ),
    deleteOfficer: db.prepare(`DELETE FROM officers WHERE id = ?`),
    officerExists: db.prepare(`SELECT 1 FROM officers WHERE id = ?`),

    // Crew Assignments
    insertAssignment: db.prepare(
      `INSERT INTO crew_assignments (ship_id, officer_id, role_type, slot, active_for_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    deleteAssignment: db.prepare(
      `DELETE FROM crew_assignments WHERE ship_id = ? AND officer_id = ?`,
    ),
    getShipCrew: db.prepare(
      `SELECT ca.id, ca.ship_id AS shipId, ca.officer_id AS officerId, ca.role_type AS roleType,
              ca.slot, ca.active_for_role AS activeForRole, ca.created_at AS createdAt,
              o.name AS officerName
       FROM crew_assignments ca
       JOIN officers o ON o.id = ca.officer_id
       WHERE ca.ship_id = ?
       ORDER BY ca.role_type, ca.slot`,
    ),
    getShipCrewForRole: db.prepare(
      `SELECT ca.id, ca.ship_id AS shipId, ca.officer_id AS officerId, ca.role_type AS roleType,
              ca.slot, ca.active_for_role AS activeForRole, ca.created_at AS createdAt,
              o.name AS officerName
       FROM crew_assignments ca
       JOIN officers o ON o.id = ca.officer_id
       WHERE ca.ship_id = ? AND (ca.active_for_role IS NULL OR ca.active_for_role = ?)
       ORDER BY ca.role_type, ca.slot`,
    ),
    getOfficerAssignments: db.prepare(
      `SELECT ca.id, ca.ship_id AS shipId, ca.officer_id AS officerId, ca.role_type AS roleType,
              ca.slot, ca.active_for_role AS activeForRole, ca.created_at AS createdAt,
              s.name AS shipName
       FROM crew_assignments ca
       JOIN ships s ON s.id = ca.ship_id
       WHERE ca.officer_id = ?
       ORDER BY s.name`,
    ),

    // Assignment Log
    insertLog: db.prepare(
      `INSERT INTO assignment_log (ship_id, officer_id, action, detail, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getLog: db.prepare(
      `SELECT id, ship_id AS shipId, officer_id AS officerId, action, detail, timestamp
       FROM assignment_log ORDER BY timestamp DESC LIMIT ?`,
    ),
    getLogByShip: db.prepare(
      `SELECT id, ship_id AS shipId, officer_id AS officerId, action, detail, timestamp
       FROM assignment_log WHERE ship_id = ? ORDER BY timestamp DESC LIMIT ?`,
    ),
    getLogByOfficer: db.prepare(
      `SELECT id, ship_id AS shipId, officer_id AS officerId, action, detail, timestamp
       FROM assignment_log WHERE officer_id = ? ORDER BY timestamp DESC LIMIT ?`,
    ),
    getLogByAction: db.prepare(
      `SELECT id, ship_id AS shipId, officer_id AS officerId, action, detail, timestamp
       FROM assignment_log WHERE action = ? ORDER BY timestamp DESC LIMIT ?`,
    ),

    // Counts
    countShips: db.prepare(`SELECT COUNT(*) AS count FROM ships`),
    countOfficers: db.prepare(`SELECT COUNT(*) AS count FROM officers`),
    countAssignments: db.prepare(`SELECT COUNT(*) AS count FROM crew_assignments`),
    countLog: db.prepare(`SELECT COUNT(*) AS count FROM assignment_log`),
  };

  // ── Internal helpers ────────────────────────────────────

  function logAction(shipId: string | null, officerId: string | null, action: LogAction, detail?: Record<string, unknown>) {
    const now = new Date().toISOString();
    stmts.insertLog.run(shipId, officerId, action, detail ? JSON.stringify(detail) : null, now);
  }

  // ── Store object ────────────────────────────────────────

  const store: FleetStore = {
    // ── Ships ─────────────────────────────────────────────

    createShip(input) {
      const now = new Date().toISOString();
      const status = input.status || "ready";
      if (!VALID_SHIP_STATUSES.includes(status)) {
        throw new Error(`Invalid ship status: ${status}. Valid: ${VALID_SHIP_STATUSES.join(", ")}`);
      }
      stmts.insertShip.run(
        input.id, input.name, input.tier ?? null, input.shipClass ?? null,
        status, input.role ?? null, input.roleDetail ?? null,
        input.notes ?? null, input.importedFrom ?? null, now, now, now,
      );
      logAction(input.id, null, "created", { name: input.name, status });
      log.fleet.debug({ id: input.id, name: input.name }, "ship created");
      return { ...input, status, statusChangedAt: now, createdAt: now, updatedAt: now } as Ship;
    },

    getShip(id) {
      const ship = stmts.getShip.get(id) as Ship | undefined;
      if (!ship) return null;
      const crew = stmts.getShipCrew.all(id) as CrewAssignment[];
      return { ...ship, crew };
    },

    listShips(filters) {
      if (filters?.status && filters?.role) {
        return stmts.listShipsByStatusAndRole.all(filters.status, filters.role) as Ship[];
      }
      if (filters?.status) {
        return stmts.listShipsByStatus.all(filters.status) as Ship[];
      }
      if (filters?.role) {
        return stmts.listShipsByRole.all(filters.role) as Ship[];
      }
      return stmts.listShips.all() as Ship[];
    },

    updateShip(id, fields) {
      const existing = stmts.getShip.get(id) as Ship | undefined;
      if (!existing) return null;

      const now = new Date().toISOString();
      const updates: string[] = [];
      const params: unknown[] = [];
      const changes: Record<string, unknown> = {};

      if (fields.name !== undefined) { updates.push("name = ?"); params.push(fields.name); changes.name = fields.name; }
      if (fields.tier !== undefined) { updates.push("tier = ?"); params.push(fields.tier); changes.tier = fields.tier; }
      if (fields.shipClass !== undefined) { updates.push("ship_class = ?"); params.push(fields.shipClass); changes.shipClass = fields.shipClass; }
      if (fields.role !== undefined) { updates.push("role = ?"); params.push(fields.role); changes.role = fields.role; }
      if (fields.roleDetail !== undefined) { updates.push("role_detail = ?"); params.push(fields.roleDetail); changes.roleDetail = fields.roleDetail; }
      if (fields.notes !== undefined) { updates.push("notes = ?"); params.push(fields.notes); changes.notes = fields.notes; }

      if (fields.status !== undefined && fields.status !== existing.status) {
        if (!VALID_SHIP_STATUSES.includes(fields.status)) {
          throw new Error(`Invalid ship status: ${fields.status}. Valid: ${VALID_SHIP_STATUSES.join(", ")}`);
        }
        updates.push("status = ?", "status_changed_at = ?");
        params.push(fields.status, now);
        changes.status = { from: existing.status, to: fields.status };
        logAction(id, null, "status_change", changes);
      }

      if (fields.role !== undefined && fields.role !== existing.role) {
        logAction(id, null, "role_change", { from: existing.role, to: fields.role });
      }

      if (updates.length === 0) return existing;

      updates.push("updated_at = ?");
      params.push(now, id);

      db.prepare(`UPDATE ships SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      log.fleet.debug({ id, changes }, "ship updated");

      return stmts.getShip.get(id) as Ship;
    },

    deleteShip(id) {
      const existing = stmts.getShip.get(id) as Ship | undefined;
      if (!existing) return false;
      stmts.deleteShip.run(id);
      logAction(id, null, "deleted", { name: existing.name });
      return true;
    },

    // ── Officers ──────────────────────────────────────────

    createOfficer(input) {
      const now = new Date().toISOString();
      stmts.insertOfficer.run(
        input.id, input.name, input.rarity ?? null, input.level ?? null,
        input.rank ?? null, input.groupName ?? null, input.importedFrom ?? null,
        now, now,
      );
      logAction(null, input.id, "created", { name: input.name });
      log.fleet.debug({ id: input.id, name: input.name }, "officer created");
      return { ...input, createdAt: now, updatedAt: now } as Officer;
    },

    getOfficer(id) {
      const officer = stmts.getOfficer.get(id) as Officer | undefined;
      if (!officer) return null;
      const assignments = stmts.getOfficerAssignments.all(id) as CrewAssignment[];
      return { ...officer, assignments };
    },

    listOfficers(filters) {
      if (filters?.unassigned) {
        return stmts.listUnassignedOfficers.all() as Officer[];
      }
      if (filters?.groupName) {
        return stmts.listOfficersByGroup.all(filters.groupName) as Officer[];
      }
      return stmts.listOfficers.all() as Officer[];
    },

    updateOfficer(id, fields) {
      const existing = stmts.getOfficer.get(id) as Officer | undefined;
      if (!existing) return null;

      const now = new Date().toISOString();
      const updates: string[] = [];
      const params: unknown[] = [];

      if (fields.name !== undefined) { updates.push("name = ?"); params.push(fields.name); }
      if (fields.rarity !== undefined) { updates.push("rarity = ?"); params.push(fields.rarity); }
      if (fields.level !== undefined) { updates.push("level = ?"); params.push(fields.level); }
      if (fields.rank !== undefined) { updates.push("rank = ?"); params.push(fields.rank); }
      if (fields.groupName !== undefined) { updates.push("group_name = ?"); params.push(fields.groupName); }

      if (updates.length === 0) return existing;

      updates.push("updated_at = ?");
      params.push(now, id);

      db.prepare(`UPDATE officers SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      logAction(null, id, "updated", fields);
      log.fleet.debug({ id, fields }, "officer updated");

      return stmts.getOfficer.get(id) as Officer;
    },

    deleteOfficer(id) {
      const existing = stmts.getOfficer.get(id) as Officer | undefined;
      if (!existing) return false;
      stmts.deleteOfficer.run(id);
      logAction(null, id, "deleted", { name: existing.name });
      return true;
    },

    // ── Crew Assignments ──────────────────────────────────

    assignCrew(shipId, officerId, roleType, slot, activeForRole) {
      // Validate ship and officer exist
      if (!stmts.shipExists.get(shipId)) {
        throw new Error(`Ship not found: ${shipId}`);
      }
      if (!stmts.officerExists.get(officerId)) {
        throw new Error(`Officer not found: ${officerId}`);
      }

      const now = new Date().toISOString();
      const result = stmts.insertAssignment.run(
        shipId, officerId, roleType, slot ?? null, activeForRole ?? null, now,
      );
      logAction(shipId, officerId, "assigned", { roleType, slot, activeForRole });
      log.fleet.debug({ shipId, officerId, roleType }, "crew assigned");

      return {
        id: Number(result.lastInsertRowid),
        shipId, officerId, roleType,
        slot: slot ?? null,
        activeForRole: activeForRole ?? null,
        createdAt: now,
      };
    },

    unassignCrew(shipId, officerId) {
      const result = stmts.deleteAssignment.run(shipId, officerId);
      if (result.changes > 0) {
        logAction(shipId, officerId, "unassigned", {});
        log.fleet.debug({ shipId, officerId }, "crew unassigned");
        return true;
      }
      return false;
    },

    getShipCrew(shipId, activeForRole) {
      if (activeForRole) {
        return stmts.getShipCrewForRole.all(shipId, activeForRole) as CrewAssignment[];
      }
      return stmts.getShipCrew.all(shipId) as CrewAssignment[];
    },

    // ── Assignment Log ────────────────────────────────────

    getLog(filters) {
      const limit = filters?.limit ?? 50;
      if (filters?.shipId) {
        return stmts.getLogByShip.all(filters.shipId, limit) as AssignmentLogEntry[];
      }
      if (filters?.officerId) {
        return stmts.getLogByOfficer.all(filters.officerId, limit) as AssignmentLogEntry[];
      }
      if (filters?.action) {
        return stmts.getLogByAction.all(filters.action, limit) as AssignmentLogEntry[];
      }
      return stmts.getLog.all(limit) as AssignmentLogEntry[];
    },

    // ── Import ────────────────────────────────────────────

    importFromFleetData(fleetData: FleetData) {
      let shipsImported = 0;
      let officersImported = 0;
      let skipped = 0;

      const importSection = (section: FleetSection) => {
        if (section.rows.length < 2) return; // Need header + at least 1 data row

        const headers = section.headers.map((h) => h.toLowerCase().trim());
        const nameCol = headers.findIndex((h) => h === "name" || h === "officer" || h === "ship");
        if (nameCol === -1) {
          log.fleet.debug({ label: section.label, headers }, "no name column found, skipping section");
          return;
        }

        // Try to find common columns
        const tierCol = headers.findIndex((h) => h === "tier" || h === "level" || h === "stars");
        const classCol = headers.findIndex((h) => h === "class" || h === "type" || h === "ship class");
        const rarityCol = headers.findIndex((h) => h === "rarity" || h === "quality");
        const levelCol = headers.findIndex((h) => h === "level" || h === "lvl");
        const rankCol = headers.findIndex((h) => h === "rank");
        const groupCol = headers.findIndex((h) => h === "group" || h === "division" || h === "department");

        for (let i = 1; i < section.rows.length; i++) {
          const row = section.rows[i];
          const name = (row[nameCol] || "").trim();
          if (!name) continue;

          const id = slugify(name);

          if (section.type === "ships") {
            // Check if already exists
            if (stmts.shipExists.get(id)) {
              // Update imported fields only, preserve operational state
              const now = new Date().toISOString();
              const tier = tierCol >= 0 ? parseInt(row[tierCol], 10) || null : null;
              const shipClass = classCol >= 0 ? (row[classCol] || "").trim() || null : null;
              db.prepare(
                `UPDATE ships SET name = ?, tier = COALESCE(?, tier), ship_class = COALESCE(?, ship_class),
                 imported_from = ?, updated_at = ? WHERE id = ?`,
              ).run(name, tier, shipClass, section.label, now, id);
              skipped++;
            } else {
              store.createShip({
                id,
                name,
                tier: tierCol >= 0 ? parseInt(row[tierCol], 10) || null : null,
                shipClass: classCol >= 0 ? (row[classCol] || "").trim() || null : null,
                status: "ready",
                role: null,
                roleDetail: null,
                notes: null,
                importedFrom: section.label,
              });
              shipsImported++;
            }
          } else if (section.type === "officers") {
            if (stmts.officerExists.get(id)) {
              const now = new Date().toISOString();
              const rarity = rarityCol >= 0 ? (row[rarityCol] || "").trim() || null : null;
              const level = levelCol >= 0 ? parseInt(row[levelCol], 10) || null : null;
              const rank = rankCol >= 0 ? (row[rankCol] || "").trim() || null : null;
              const group = groupCol >= 0 ? (row[groupCol] || "").trim() || null : null;
              db.prepare(
                `UPDATE officers SET name = ?, rarity = COALESCE(?, rarity), level = COALESCE(?, level),
                 rank = COALESCE(?, rank), group_name = COALESCE(?, group_name),
                 imported_from = ?, updated_at = ? WHERE id = ?`,
              ).run(name, rarity, level, rank, group, section.label, now, id);
              skipped++;
            } else {
              store.createOfficer({
                id,
                name,
                rarity: rarityCol >= 0 ? (row[rarityCol] || "").trim() || null : null,
                level: levelCol >= 0 ? parseInt(row[levelCol], 10) || null : null,
                rank: rankCol >= 0 ? (row[rankCol] || "").trim() || null : null,
                groupName: groupCol >= 0 ? (row[groupCol] || "").trim() || null : null,
                importedFrom: section.label,
              });
              officersImported++;
            }
          }
        }
      };

      const txn = db.transaction(() => {
        for (const section of fleetData.sections) {
          importSection(section);
        }
      });
      txn();

      log.fleet.info(
        { shipsImported, officersImported, skipped },
        "fleet data imported from sheets",
      );

      return { ships: shipsImported, officers: officersImported, skipped };
    },

    // ── Diagnostics ───────────────────────────────────────

    getDbPath() {
      return resolvedPath;
    },

    counts() {
      return {
        ships: (stmts.countShips.get() as { count: number }).count,
        officers: (stmts.countOfficers.get() as { count: number }).count,
        assignments: (stmts.countAssignments.get() as { count: number }).count,
        logEntries: (stmts.countLog.get() as { count: number }).count,
      };
    },

    close() {
      db.close();
    },
  };

  return store;
}
