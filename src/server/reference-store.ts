/**
 * reference-store.ts — Canonical Reference Data Store (ADR-015 / ADR-016)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed store for wiki-imported reference entities (officers, ships).
 * These are canonical game data with full provenance — not user-specific state.
 *
 * User state (ownership, targeting, level) lives in overlay-store.ts.
 * This module is the T2 reference tier in the MicroRunner authority ladder.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export interface ReferenceOfficer {
  id: string;                              // 'wiki:officer:<pageId>'
  name: string;
  rarity: string | null;
  groupName: string | null;
  captainManeuver: string | null;
  officerAbility: string | null;
  belowDeckAbility: string | null;
  source: string;                          // 'stfc-fandom-wiki'
  sourceUrl: string | null;
  sourcePageId: string | null;
  sourceRevisionId: string | null;
  sourceRevisionTimestamp: string | null;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceShip {
  id: string;                              // 'wiki:ship:<pageId>'
  name: string;
  shipClass: string | null;
  grade: number | null;
  rarity: string | null;
  faction: string | null;
  tier: number | null;
  source: string;
  sourceUrl: string | null;
  sourcePageId: string | null;
  sourceRevisionId: string | null;
  sourceRevisionTimestamp: string | null;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateReferenceOfficerInput = Omit<ReferenceOfficer, "createdAt" | "updatedAt" | "license" | "attribution"> & {
  license?: string;
  attribution?: string;
};

export type CreateReferenceShipInput = Omit<ReferenceShip, "createdAt" | "updatedAt" | "license" | "attribution"> & {
  license?: string;
  attribution?: string;
};

// ─── Store Interface ────────────────────────────────────────

export interface ReferenceStore {
  // ── Officers ──────────────────────────────────────────
  createOfficer(officer: CreateReferenceOfficerInput): ReferenceOfficer;
  getOfficer(id: string): ReferenceOfficer | null;
  findOfficerByName(name: string): ReferenceOfficer | null;
  listOfficers(filters?: { rarity?: string; groupName?: string }): ReferenceOfficer[];
  searchOfficers(query: string): ReferenceOfficer[];
  upsertOfficer(officer: CreateReferenceOfficerInput): ReferenceOfficer;
  deleteOfficer(id: string): boolean;

  // ── Ships ─────────────────────────────────────────────
  createShip(ship: CreateReferenceShipInput): ReferenceShip;
  getShip(id: string): ReferenceShip | null;
  findShipByName(name: string): ReferenceShip | null;
  listShips(filters?: { rarity?: string; faction?: string; shipClass?: string }): ReferenceShip[];
  searchShips(query: string): ReferenceShip[];
  upsertShip(ship: CreateReferenceShipInput): ReferenceShip;
  deleteShip(id: string): boolean;

  // ── Bulk ──────────────────────────────────────────────
  bulkUpsertOfficers(officers: CreateReferenceOfficerInput[]): { created: number; updated: number };
  bulkUpsertShips(ships: CreateReferenceShipInput[]): { created: number; updated: number };

  // ── Diagnostics ───────────────────────────────────────
  counts(): { officers: number; ships: number };
  getDbPath(): string;
  close(): void;
}

// ─── Helpers ────────────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "reference.db");

const DEFAULT_LICENSE = "CC BY-SA 3.0";
const DEFAULT_ATTRIBUTION = "Community contributors to the Star Trek: Fleet Command Wiki";

// ─── Implementation ─────────────────────────────────────────

export function createReferenceStore(dbPath?: string): ReferenceStore {
  const resolvedPath = dbPath ?? DB_FILE;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS reference_officers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rarity TEXT,
      group_name TEXT,
      captain_maneuver TEXT,
      officer_ability TEXT,
      below_deck_ability TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      source_page_id TEXT,
      source_revision_id TEXT,
      source_revision_timestamp TEXT,
      license TEXT NOT NULL DEFAULT '${DEFAULT_LICENSE}',
      attribution TEXT NOT NULL DEFAULT '${DEFAULT_ATTRIBUTION}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ref_officers_name ON reference_officers(name);
    CREATE INDEX IF NOT EXISTS idx_ref_officers_group ON reference_officers(group_name);
    CREATE INDEX IF NOT EXISTS idx_ref_officers_rarity ON reference_officers(rarity);

    CREATE TABLE IF NOT EXISTS reference_ships (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ship_class TEXT,
      grade INTEGER,
      rarity TEXT,
      faction TEXT,
      tier INTEGER,
      source TEXT NOT NULL,
      source_url TEXT,
      source_page_id TEXT,
      source_revision_id TEXT,
      source_revision_timestamp TEXT,
      license TEXT NOT NULL DEFAULT '${DEFAULT_LICENSE}',
      attribution TEXT NOT NULL DEFAULT '${DEFAULT_ATTRIBUTION}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ref_ships_name ON reference_ships(name);
    CREATE INDEX IF NOT EXISTS idx_ref_ships_class ON reference_ships(ship_class);
    CREATE INDEX IF NOT EXISTS idx_ref_ships_faction ON reference_ships(faction);
  `);

  // ── Prepared Statements ───────────────────────────────────
  const stmts = {
    // Officers
    insertOfficer: db.prepare(
      `INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability,
        source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateOfficer: db.prepare(
      `UPDATE reference_officers SET name = ?, rarity = ?, group_name = ?, captain_maneuver = ?, officer_ability = ?,
        below_deck_ability = ?, source = ?, source_url = ?, source_page_id = ?, source_revision_id = ?,
        source_revision_timestamp = ?, license = ?, attribution = ?, updated_at = ? WHERE id = ?`
    ),
    getOfficer: db.prepare(
      `SELECT id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
        officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_officers WHERE id = ?`
    ),
    findOfficerByName: db.prepare(
      `SELECT id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
        officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_officers WHERE LOWER(name) = LOWER(?)`
    ),
    listOfficers: db.prepare(
      `SELECT id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
        officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_officers ORDER BY name`
    ),
    searchOfficers: db.prepare(
      `SELECT id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
        officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_officers WHERE name LIKE ? ORDER BY name`
    ),
    deleteOfficer: db.prepare(`DELETE FROM reference_officers WHERE id = ?`),
    officerExists: db.prepare(`SELECT 1 FROM reference_officers WHERE id = ?`),

    // Ships
    insertShip: db.prepare(
      `INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, tier,
        source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateShip: db.prepare(
      `UPDATE reference_ships SET name = ?, ship_class = ?, grade = ?, rarity = ?, faction = ?, tier = ?,
        source = ?, source_url = ?, source_page_id = ?, source_revision_id = ?,
        source_revision_timestamp = ?, license = ?, attribution = ?, updated_at = ? WHERE id = ?`
    ),
    getShip: db.prepare(
      `SELECT id, name, ship_class AS shipClass, grade, rarity, faction, tier,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_ships WHERE id = ?`
    ),
    findShipByName: db.prepare(
      `SELECT id, name, ship_class AS shipClass, grade, rarity, faction, tier,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_ships WHERE LOWER(name) = LOWER(?)`
    ),
    listShips: db.prepare(
      `SELECT id, name, ship_class AS shipClass, grade, rarity, faction, tier,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_ships ORDER BY name`
    ),
    searchShips: db.prepare(
      `SELECT id, name, ship_class AS shipClass, grade, rarity, faction, tier,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_ships WHERE name LIKE ? ORDER BY name`
    ),
    deleteShip: db.prepare(`DELETE FROM reference_ships WHERE id = ?`),
    shipExists: db.prepare(`SELECT 1 FROM reference_ships WHERE id = ?`),

    // Counts
    countOfficers: db.prepare(`SELECT COUNT(*) AS count FROM reference_officers`),
    countShips: db.prepare(`SELECT COUNT(*) AS count FROM reference_ships`),
  };

  // Filtered list helpers
  const listOfficersFiltered = (filters: { rarity?: string; groupName?: string }) => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.rarity) { clauses.push("rarity = ?"); params.push(filters.rarity); }
    if (filters.groupName) { clauses.push("group_name = ?"); params.push(filters.groupName); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(
      `SELECT id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
        officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_officers ${where} ORDER BY name`
    ).all(...params) as ReferenceOfficer[];
  };

  const listShipsFiltered = (filters: { rarity?: string; faction?: string; shipClass?: string }) => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.rarity) { clauses.push("rarity = ?"); params.push(filters.rarity); }
    if (filters.faction) { clauses.push("faction = ?"); params.push(filters.faction); }
    if (filters.shipClass) { clauses.push("ship_class = ?"); params.push(filters.shipClass); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(
      `SELECT id, name, ship_class AS shipClass, grade, rarity, faction, tier,
        source, source_url AS sourceUrl, source_page_id AS sourcePageId,
        source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
        license, attribution, created_at AS createdAt, updated_at AS updatedAt
       FROM reference_ships ${where} ORDER BY name`
    ).all(...params) as ReferenceShip[];
  };

  const store: ReferenceStore = {
    // ── Officers ──────────────────────────────────────────

    createOfficer(input: CreateReferenceOfficerInput): ReferenceOfficer {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      stmts.insertOfficer.run(
        input.id, input.name, input.rarity, input.groupName,
        input.captainManeuver, input.officerAbility, input.belowDeckAbility,
        input.source, input.sourceUrl, input.sourcePageId,
        input.sourceRevisionId, input.sourceRevisionTimestamp,
        license, attribution, now, now,
      );
      log.fleet.debug({ id: input.id, name: input.name }, "reference officer created");
      return stmts.getOfficer.get(input.id) as ReferenceOfficer;
    },

    getOfficer(id: string): ReferenceOfficer | null {
      return (stmts.getOfficer.get(id) as ReferenceOfficer) ?? null;
    },

    findOfficerByName(name: string): ReferenceOfficer | null {
      return (stmts.findOfficerByName.get(name) as ReferenceOfficer) ?? null;
    },

    listOfficers(filters?: { rarity?: string; groupName?: string }): ReferenceOfficer[] {
      if (filters && (filters.rarity || filters.groupName)) {
        return listOfficersFiltered(filters);
      }
      return stmts.listOfficers.all() as ReferenceOfficer[];
    },

    searchOfficers(query: string): ReferenceOfficer[] {
      return stmts.searchOfficers.all(`%${query}%`) as ReferenceOfficer[];
    },

    upsertOfficer(input: CreateReferenceOfficerInput): ReferenceOfficer {
      const exists = stmts.officerExists.get(input.id);
      if (exists) {
        const now = new Date().toISOString();
        stmts.updateOfficer.run(
          input.name, input.rarity, input.groupName,
          input.captainManeuver, input.officerAbility, input.belowDeckAbility,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
          now, input.id,
        );
        log.fleet.debug({ id: input.id, name: input.name }, "reference officer updated");
      } else {
        return store.createOfficer(input);
      }
      return stmts.getOfficer.get(input.id) as ReferenceOfficer;
    },

    deleteOfficer(id: string): boolean {
      const result = stmts.deleteOfficer.run(id);
      return result.changes > 0;
    },

    // ── Ships ─────────────────────────────────────────────

    createShip(input: CreateReferenceShipInput): ReferenceShip {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      stmts.insertShip.run(
        input.id, input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
        input.source, input.sourceUrl, input.sourcePageId,
        input.sourceRevisionId, input.sourceRevisionTimestamp,
        license, attribution, now, now,
      );
      log.fleet.debug({ id: input.id, name: input.name }, "reference ship created");
      return stmts.getShip.get(input.id) as ReferenceShip;
    },

    getShip(id: string): ReferenceShip | null {
      return (stmts.getShip.get(id) as ReferenceShip) ?? null;
    },

    findShipByName(name: string): ReferenceShip | null {
      return (stmts.findShipByName.get(name) as ReferenceShip) ?? null;
    },

    listShips(filters?: { rarity?: string; faction?: string; shipClass?: string }): ReferenceShip[] {
      if (filters && (filters.rarity || filters.faction || filters.shipClass)) {
        return listShipsFiltered(filters);
      }
      return stmts.listShips.all() as ReferenceShip[];
    },

    searchShips(query: string): ReferenceShip[] {
      return stmts.searchShips.all(`%${query}%`) as ReferenceShip[];
    },

    upsertShip(input: CreateReferenceShipInput): ReferenceShip {
      const exists = stmts.shipExists.get(input.id);
      if (exists) {
        const now = new Date().toISOString();
        stmts.updateShip.run(
          input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
          now, input.id,
        );
        log.fleet.debug({ id: input.id, name: input.name }, "reference ship updated");
      } else {
        return store.createShip(input);
      }
      return stmts.getShip.get(input.id) as ReferenceShip;
    },

    deleteShip(id: string): boolean {
      const result = stmts.deleteShip.run(id);
      return result.changes > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    bulkUpsertOfficers(officers: CreateReferenceOfficerInput[]): { created: number; updated: number } {
      let created = 0;
      let updated = 0;
      const txn = db.transaction(() => {
        for (const officer of officers) {
          const exists = stmts.officerExists.get(officer.id);
          if (exists) {
            const now = new Date().toISOString();
            stmts.updateOfficer.run(
              officer.name, officer.rarity, officer.groupName,
              officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
              officer.source, officer.sourceUrl, officer.sourcePageId,
              officer.sourceRevisionId, officer.sourceRevisionTimestamp,
              officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
              now, officer.id,
            );
            updated++;
          } else {
            const now = new Date().toISOString();
            stmts.insertOfficer.run(
              officer.id, officer.name, officer.rarity, officer.groupName,
              officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
              officer.source, officer.sourceUrl, officer.sourcePageId,
              officer.sourceRevisionId, officer.sourceRevisionTimestamp,
              officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
              now, now,
            );
            created++;
          }
        }
      });
      txn();
      log.fleet.info({ created, updated, total: officers.length }, "bulk upsert reference officers");
      return { created, updated };
    },

    bulkUpsertShips(ships: CreateReferenceShipInput[]): { created: number; updated: number } {
      let created = 0;
      let updated = 0;
      const txn = db.transaction(() => {
        for (const ship of ships) {
          const exists = stmts.shipExists.get(ship.id);
          if (exists) {
            const now = new Date().toISOString();
            stmts.updateShip.run(
              ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
              ship.source, ship.sourceUrl, ship.sourcePageId,
              ship.sourceRevisionId, ship.sourceRevisionTimestamp,
              ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
              now, ship.id,
            );
            updated++;
          } else {
            const now = new Date().toISOString();
            stmts.insertShip.run(
              ship.id, ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
              ship.source, ship.sourceUrl, ship.sourcePageId,
              ship.sourceRevisionId, ship.sourceRevisionTimestamp,
              ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
              now, now,
            );
            created++;
          }
        }
      });
      txn();
      log.fleet.info({ created, updated, total: ships.length }, "bulk upsert reference ships");
      return { created, updated };
    },

    // ── Diagnostics ─────────────────────────────────────────

    counts() {
      return {
        officers: (stmts.countOfficers.get() as { count: number }).count,
        ships: (stmts.countShips.get() as { count: number }).count,
      };
    },

    getDbPath(): string {
      return resolvedPath;
    },

    close(): void {
      db.close();
    },
  };

  return store;
}
