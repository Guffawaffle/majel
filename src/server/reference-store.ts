/**
 * reference-store.ts — Canonical Reference Data Store (ADR-015 / ADR-016)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * libSQL-backed store for wiki-imported reference entities (officers, ships).
 * These are canonical game data with full provenance — not user-specific state.
 *
 * User state (ownership, targeting, level) lives in overlay-store.ts.
 * This module is the T2 reference tier in the MicroRunner authority ladder.
 *
 * Migrated from better-sqlite3 to @libsql/client in ADR-018 Phase 1.
 */

import { openDatabase, initSchema, type Client } from "./db.js";
import * as path from "node:path";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export interface ReferenceOfficer {
  id: string;
  name: string;
  rarity: string | null;
  groupName: string | null;
  captainManeuver: string | null;
  officerAbility: string | null;
  belowDeckAbility: string | null;
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

export interface ReferenceShip {
  id: string;
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
  createOfficer(officer: CreateReferenceOfficerInput): Promise<ReferenceOfficer>;
  getOfficer(id: string): Promise<ReferenceOfficer | null>;
  findOfficerByName(name: string): Promise<ReferenceOfficer | null>;
  listOfficers(filters?: { rarity?: string; groupName?: string }): Promise<ReferenceOfficer[]>;
  searchOfficers(query: string): Promise<ReferenceOfficer[]>;
  upsertOfficer(officer: CreateReferenceOfficerInput): Promise<ReferenceOfficer>;
  deleteOfficer(id: string): Promise<boolean>;

  createShip(ship: CreateReferenceShipInput): Promise<ReferenceShip>;
  getShip(id: string): Promise<ReferenceShip | null>;
  findShipByName(name: string): Promise<ReferenceShip | null>;
  listShips(filters?: { rarity?: string; faction?: string; shipClass?: string }): Promise<ReferenceShip[]>;
  searchShips(query: string): Promise<ReferenceShip[]>;
  upsertShip(ship: CreateReferenceShipInput): Promise<ReferenceShip>;
  deleteShip(id: string): Promise<boolean>;

  bulkUpsertOfficers(officers: CreateReferenceOfficerInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertShips(ships: CreateReferenceShipInput[]): Promise<{ created: number; updated: number }>;

  counts(): Promise<{ officers: number; ships: number }>;
  getDbPath(): string;
  close(): void;
}

// ─── Constants ──────────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "reference.db");

const DEFAULT_LICENSE = "CC BY-SA 3.0";
const DEFAULT_ATTRIBUTION = "Community contributors to the Star Trek: Fleet Command Wiki";

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS reference_officers (
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
    license TEXT NOT NULL DEFAULT 'CC BY-SA 3.0',
    attribution TEXT NOT NULL DEFAULT 'Community contributors to the Star Trek: Fleet Command Wiki',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_name ON reference_officers(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_group ON reference_officers(group_name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_rarity ON reference_officers(rarity)`,
  `CREATE TABLE IF NOT EXISTS reference_ships (
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
    license TEXT NOT NULL DEFAULT 'CC BY-SA 3.0',
    attribution TEXT NOT NULL DEFAULT 'Community contributors to the Star Trek: Fleet Command Wiki',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_name ON reference_ships(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_class ON reference_ships(ship_class)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_faction ON reference_ships(faction)`,
];

const OFFICER_COLS = `id, name, rarity, group_name AS groupName, captain_maneuver AS captainManeuver,
  officer_ability AS officerAbility, below_deck_ability AS belowDeckAbility,
  source, source_url AS sourceUrl, source_page_id AS sourcePageId,
  source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
  license, attribution, created_at AS createdAt, updated_at AS updatedAt`;

const SHIP_COLS = `id, name, ship_class AS shipClass, grade, rarity, faction, tier,
  source, source_url AS sourceUrl, source_page_id AS sourcePageId,
  source_revision_id AS sourceRevisionId, source_revision_timestamp AS sourceRevisionTimestamp,
  license, attribution, created_at AS createdAt, updated_at AS updatedAt`;

const SQL = {
  // Officers
  insertOfficer: `INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateOfficer: `UPDATE reference_officers SET name = ?, rarity = ?, group_name = ?, captain_maneuver = ?, officer_ability = ?,
    below_deck_ability = ?, source = ?, source_url = ?, source_page_id = ?, source_revision_id = ?,
    source_revision_timestamp = ?, license = ?, attribution = ?, updated_at = ? WHERE id = ?`,
  getOfficer: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE id = ?`,
  findOfficerByName: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE LOWER(name) = LOWER(?)`,
  listOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers ORDER BY name`,
  searchOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE name LIKE ? ORDER BY name`,
  deleteOfficer: `DELETE FROM reference_officers WHERE id = ?`,
  officerExists: `SELECT 1 FROM reference_officers WHERE id = ?`,
  countOfficers: `SELECT COUNT(*) AS count FROM reference_officers`,

  // Ships
  insertShip: `INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, tier,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateShip: `UPDATE reference_ships SET name = ?, ship_class = ?, grade = ?, rarity = ?, faction = ?, tier = ?,
    source = ?, source_url = ?, source_page_id = ?, source_revision_id = ?,
    source_revision_timestamp = ?, license = ?, attribution = ?, updated_at = ? WHERE id = ?`,
  getShip: `SELECT ${SHIP_COLS} FROM reference_ships WHERE id = ?`,
  findShipByName: `SELECT ${SHIP_COLS} FROM reference_ships WHERE LOWER(name) = LOWER(?)`,
  listShips: `SELECT ${SHIP_COLS} FROM reference_ships ORDER BY name`,
  searchShips: `SELECT ${SHIP_COLS} FROM reference_ships WHERE name LIKE ? ORDER BY name`,
  deleteShip: `DELETE FROM reference_ships WHERE id = ?`,
  shipExists: `SELECT 1 FROM reference_ships WHERE id = ?`,
  countShips: `SELECT COUNT(*) AS count FROM reference_ships`,
};

// ─── Implementation ─────────────────────────────────────────

export async function createReferenceStore(dbPath?: string): Promise<ReferenceStore> {
  const resolvedPath = dbPath ?? DB_FILE;
  const client = openDatabase(resolvedPath);
  await initSchema(client, SCHEMA_STATEMENTS);

  log.boot.debug({ dbPath: resolvedPath }, "reference store initialized");

  // Dynamic filtered list helpers
  async function listOfficersFiltered(filters: { rarity?: string; groupName?: string }): Promise<ReferenceOfficer[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.rarity) { clauses.push("rarity = ?"); params.push(filters.rarity); }
    if (filters.groupName) { clauses.push("group_name = ?"); params.push(filters.groupName); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await client.execute({
      sql: `SELECT ${OFFICER_COLS} FROM reference_officers ${where} ORDER BY name`,
      args: params,
    });
    return result.rows as unknown as ReferenceOfficer[];
  }

  async function listShipsFiltered(filters: { rarity?: string; faction?: string; shipClass?: string }): Promise<ReferenceShip[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.rarity) { clauses.push("rarity = ?"); params.push(filters.rarity); }
    if (filters.faction) { clauses.push("faction = ?"); params.push(filters.faction); }
    if (filters.shipClass) { clauses.push("ship_class = ?"); params.push(filters.shipClass); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await client.execute({
      sql: `SELECT ${SHIP_COLS} FROM reference_ships ${where} ORDER BY name`,
      args: params,
    });
    return result.rows as unknown as ReferenceShip[];
  }

  const store: ReferenceStore = {
    // ── Officers ──────────────────────────────────────────

    async createOfficer(input) {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      await client.execute({
        sql: SQL.insertOfficer,
        args: [
          input.id, input.name, input.rarity, input.groupName,
          input.captainManeuver, input.officerAbility, input.belowDeckAbility,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          license, attribution, now, now,
        ],
      });
      log.fleet.debug({ id: input.id, name: input.name }, "reference officer created");
      const result = await client.execute({ sql: SQL.getOfficer, args: [input.id] });
      return result.rows[0] as unknown as ReferenceOfficer;
    },

    async getOfficer(id) {
      const result = await client.execute({ sql: SQL.getOfficer, args: [id] });
      return (result.rows[0] as unknown as ReferenceOfficer) ?? null;
    },

    async findOfficerByName(name) {
      const result = await client.execute({ sql: SQL.findOfficerByName, args: [name] });
      return (result.rows[0] as unknown as ReferenceOfficer) ?? null;
    },

    async listOfficers(filters?) {
      if (filters && (filters.rarity || filters.groupName)) {
        return listOfficersFiltered(filters);
      }
      const result = await client.execute(SQL.listOfficers);
      return result.rows as unknown as ReferenceOfficer[];
    },

    async searchOfficers(query) {
      const result = await client.execute({ sql: SQL.searchOfficers, args: [`%${query}%`] });
      return result.rows as unknown as ReferenceOfficer[];
    },

    async upsertOfficer(input) {
      const existsRes = await client.execute({ sql: SQL.officerExists, args: [input.id] });
      if (existsRes.rows.length > 0) {
        const now = new Date().toISOString();
        await client.execute({
          sql: SQL.updateOfficer,
          args: [
            input.name, input.rarity, input.groupName,
            input.captainManeuver, input.officerAbility, input.belowDeckAbility,
            input.source, input.sourceUrl, input.sourcePageId,
            input.sourceRevisionId, input.sourceRevisionTimestamp,
            input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
            now, input.id,
          ],
        });
        log.fleet.debug({ id: input.id, name: input.name }, "reference officer updated");
        const result = await client.execute({ sql: SQL.getOfficer, args: [input.id] });
        return result.rows[0] as unknown as ReferenceOfficer;
      }
      return store.createOfficer(input);
    },

    async deleteOfficer(id) {
      const result = await client.execute({ sql: SQL.deleteOfficer, args: [id] });
      return result.rowsAffected > 0;
    },

    // ── Ships ─────────────────────────────────────────────

    async createShip(input) {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      await client.execute({
        sql: SQL.insertShip,
        args: [
          input.id, input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          license, attribution, now, now,
        ],
      });
      log.fleet.debug({ id: input.id, name: input.name }, "reference ship created");
      const result = await client.execute({ sql: SQL.getShip, args: [input.id] });
      return result.rows[0] as unknown as ReferenceShip;
    },

    async getShip(id) {
      const result = await client.execute({ sql: SQL.getShip, args: [id] });
      return (result.rows[0] as unknown as ReferenceShip) ?? null;
    },

    async findShipByName(name) {
      const result = await client.execute({ sql: SQL.findShipByName, args: [name] });
      return (result.rows[0] as unknown as ReferenceShip) ?? null;
    },

    async listShips(filters?) {
      if (filters && (filters.rarity || filters.faction || filters.shipClass)) {
        return listShipsFiltered(filters);
      }
      const result = await client.execute(SQL.listShips);
      return result.rows as unknown as ReferenceShip[];
    },

    async searchShips(query) {
      const result = await client.execute({ sql: SQL.searchShips, args: [`%${query}%`] });
      return result.rows as unknown as ReferenceShip[];
    },

    async upsertShip(input) {
      const existsRes = await client.execute({ sql: SQL.shipExists, args: [input.id] });
      if (existsRes.rows.length > 0) {
        const now = new Date().toISOString();
        await client.execute({
          sql: SQL.updateShip,
          args: [
            input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
            input.source, input.sourceUrl, input.sourcePageId,
            input.sourceRevisionId, input.sourceRevisionTimestamp,
            input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
            now, input.id,
          ],
        });
        log.fleet.debug({ id: input.id, name: input.name }, "reference ship updated");
        const result = await client.execute({ sql: SQL.getShip, args: [input.id] });
        return result.rows[0] as unknown as ReferenceShip;
      }
      return store.createShip(input);
    },

    async deleteShip(id) {
      const result = await client.execute({ sql: SQL.deleteShip, args: [id] });
      return result.rowsAffected > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    async bulkUpsertOfficers(officers) {
      let created = 0;
      let updated = 0;
      const tx = await client.transaction("write");
      try {
        for (const officer of officers) {
          const existsRes = await tx.execute({ sql: SQL.officerExists, args: [officer.id] });
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await tx.execute({
              sql: SQL.updateOfficer,
              args: [
                officer.name, officer.rarity, officer.groupName,
                officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
                officer.source, officer.sourceUrl, officer.sourcePageId,
                officer.sourceRevisionId, officer.sourceRevisionTimestamp,
                officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
                now, officer.id,
              ],
            });
            updated++;
          } else {
            await tx.execute({
              sql: SQL.insertOfficer,
              args: [
                officer.id, officer.name, officer.rarity, officer.groupName,
                officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
                officer.source, officer.sourceUrl, officer.sourcePageId,
                officer.sourceRevisionId, officer.sourceRevisionTimestamp,
                officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
                now, now,
              ],
            });
            created++;
          }
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ created, updated, total: officers.length }, "bulk upsert reference officers");
      return { created, updated };
    },

    async bulkUpsertShips(ships) {
      let created = 0;
      let updated = 0;
      const tx = await client.transaction("write");
      try {
        for (const ship of ships) {
          const existsRes = await tx.execute({ sql: SQL.shipExists, args: [ship.id] });
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await tx.execute({
              sql: SQL.updateShip,
              args: [
                ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
                ship.source, ship.sourceUrl, ship.sourcePageId,
                ship.sourceRevisionId, ship.sourceRevisionTimestamp,
                ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
                now, ship.id,
              ],
            });
            updated++;
          } else {
            await tx.execute({
              sql: SQL.insertShip,
              args: [
                ship.id, ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
                ship.source, ship.sourceUrl, ship.sourcePageId,
                ship.sourceRevisionId, ship.sourceRevisionTimestamp,
                ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
                now, now,
              ],
            });
            created++;
          }
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ created, updated, total: ships.length }, "bulk upsert reference ships");
      return { created, updated };
    },

    // ── Diagnostics ─────────────────────────────────────────

    async counts() {
      const offResult = await client.execute(SQL.countOfficers);
      const shipResult = await client.execute(SQL.countShips);
      return {
        officers: (offResult.rows[0] as unknown as { count: number }).count,
        ships: (shipResult.rows[0] as unknown as { count: number }).count,
      };
    },

    getDbPath() {
      return resolvedPath;
    },

    close() {
      client.close();
    },
  };

  return store;
}
