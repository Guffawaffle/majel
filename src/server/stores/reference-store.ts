/**
 * reference-store.ts — Canonical Reference Data Store (ADR-015 / ADR-016)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed store for reference entities (officers, ships).
 * Officers are sourced from structured game data (raw-officers.json).
 * Ships table retained for future data sourcing.
 *
 * User state (ownership, targeting, level) lives in overlay-store.ts.
 * This module is the T2 reference tier in the MicroRunner authority ladder.
 *
 * Migrated from better-sqlite3 → @libsql/client (ADR-018 Phase 1),
 * then to PostgreSQL / pg (ADR-018 Phase 3).
 */

import { initSchema, withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

export interface ReferenceOfficer {
  id: string;
  name: string;
  rarity: string | null;
  groupName: string | null;
  captainManeuver: string | null;
  officerAbility: string | null;
  belowDeckAbility: string | null;
  /** Structured ability data from game data (JSONB) */
  abilities: Record<string, unknown> | null;
  /** Activity suitability tags from game data (JSONB) */
  tags: Record<string, unknown> | null;
  /** Stable numeric game ID from game data */
  officerGameId: number | null;
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

export type CreateReferenceOfficerInput = Omit<ReferenceOfficer, "createdAt" | "updatedAt" | "license" | "attribution" | "abilities" | "tags" | "officerGameId"> & {
  license?: string;
  attribution?: string;
  abilities?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  officerGameId?: number | null;
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
  close(): void;
}

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_LICENSE = "Community Data";
const DEFAULT_ATTRIBUTION = "STFC community data";

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
    abilities JSONB,
    tags JSONB,
    officer_game_id BIGINT,
    source TEXT NOT NULL,
    source_url TEXT,
    source_page_id TEXT,
    source_revision_id TEXT,
    source_revision_timestamp TEXT,
    license TEXT NOT NULL DEFAULT 'Community Data',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'abilities') THEN
      ALTER TABLE reference_officers ADD COLUMN abilities JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'tags') THEN
      ALTER TABLE reference_officers ADD COLUMN tags JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'officer_game_id') THEN
      ALTER TABLE reference_officers ADD COLUMN officer_game_id BIGINT;
    END IF;
  END $$`,
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
    license TEXT NOT NULL DEFAULT 'Community Data',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_name ON reference_ships(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_class ON reference_ships(ship_class)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_faction ON reference_ships(faction)`,
];

const OFFICER_COLS = `id, name, rarity, group_name AS "groupName", captain_maneuver AS "captainManeuver",
  officer_ability AS "officerAbility", below_deck_ability AS "belowDeckAbility",
  abilities, tags, officer_game_id AS "officerGameId",
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

const SHIP_COLS = `id, name, ship_class AS "shipClass", grade, rarity, faction, tier,
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

const SQL = {
  // Officers
  insertOfficer: `INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability,
    abilities, tags, officer_game_id,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
  updateOfficer: `UPDATE reference_officers SET name = $1, rarity = $2, group_name = $3, captain_maneuver = $4, officer_ability = $5,
    below_deck_ability = $6, abilities = $7, tags = $8, officer_game_id = $9,
    source = $10, source_url = $11, source_page_id = $12, source_revision_id = $13,
    source_revision_timestamp = $14, license = $15, attribution = $16, updated_at = $17 WHERE id = $18`,
  getOfficer: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE id = $1`,
  findOfficerByName: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE LOWER(name) = LOWER($1)`,
  listOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers ORDER BY name`,
  searchOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE name ILIKE $1 ORDER BY name`,
  deleteOfficer: `DELETE FROM reference_officers WHERE id = $1`,
  officerExists: `SELECT 1 FROM reference_officers WHERE id = $1`,
  countOfficers: `SELECT COUNT(*) AS count FROM reference_officers`,

  // Ships
  insertShip: `INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, tier,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
  updateShip: `UPDATE reference_ships SET name = $1, ship_class = $2, grade = $3, rarity = $4, faction = $5, tier = $6,
    source = $7, source_url = $8, source_page_id = $9, source_revision_id = $10,
    source_revision_timestamp = $11, license = $12, attribution = $13, updated_at = $14 WHERE id = $15`,
  getShip: `SELECT ${SHIP_COLS} FROM reference_ships WHERE id = $1`,
  findShipByName: `SELECT ${SHIP_COLS} FROM reference_ships WHERE LOWER(name) = LOWER($1)`,
  listShips: `SELECT ${SHIP_COLS} FROM reference_ships ORDER BY name`,
  searchShips: `SELECT ${SHIP_COLS} FROM reference_ships WHERE name ILIKE $1 ORDER BY name`,
  deleteShip: `DELETE FROM reference_ships WHERE id = $1`,
  shipExists: `SELECT 1 FROM reference_ships WHERE id = $1`,
  countShips: `SELECT COUNT(*) AS count FROM reference_ships`,
};

// ─── Implementation ─────────────────────────────────────────

export async function createReferenceStore(adminPool: Pool, runtimePool?: Pool): Promise<ReferenceStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.boot.debug("reference store initialized");

  // Dynamic filtered list helpers
  async function listOfficersFiltered(filters: { rarity?: string; groupName?: string }): Promise<ReferenceOfficer[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;
    if (filters.rarity) { clauses.push(`rarity = $${paramIdx++}`); params.push(filters.rarity); }
    if (filters.groupName) { clauses.push(`group_name = $${paramIdx++}`); params.push(filters.groupName); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT ${OFFICER_COLS} FROM reference_officers ${where} ORDER BY name`,
      params,
    );
    return result.rows as ReferenceOfficer[];
  }

  async function listShipsFiltered(filters: { rarity?: string; faction?: string; shipClass?: string }): Promise<ReferenceShip[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;
    if (filters.rarity) { clauses.push(`rarity = $${paramIdx++}`); params.push(filters.rarity); }
    if (filters.faction) { clauses.push(`faction = $${paramIdx++}`); params.push(filters.faction); }
    if (filters.shipClass) { clauses.push(`ship_class = $${paramIdx++}`); params.push(filters.shipClass); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT ${SHIP_COLS} FROM reference_ships ${where} ORDER BY name`,
      params,
    );
    return result.rows as ReferenceShip[];
  }

  const store: ReferenceStore = {
    // ── Officers ──────────────────────────────────────────

    async createOfficer(input) {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      await pool.query(SQL.insertOfficer, [
        input.id, input.name, input.rarity, input.groupName,
        input.captainManeuver, input.officerAbility, input.belowDeckAbility,
        input.abilities ? JSON.stringify(input.abilities) : null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.officerGameId ?? null,
        input.source, input.sourceUrl, input.sourcePageId,
        input.sourceRevisionId, input.sourceRevisionTimestamp,
        license, attribution, now, now,
      ]);
      log.fleet.debug({ id: input.id, name: input.name }, "reference officer created");
      const result = await pool.query(SQL.getOfficer, [input.id]);
      return result.rows[0] as ReferenceOfficer;
    },

    async getOfficer(id) {
      const result = await pool.query(SQL.getOfficer, [id]);
      return (result.rows[0] as ReferenceOfficer) ?? null;
    },

    async findOfficerByName(name) {
      const result = await pool.query(SQL.findOfficerByName, [name]);
      return (result.rows[0] as ReferenceOfficer) ?? null;
    },

    async listOfficers(filters?) {
      if (filters && (filters.rarity || filters.groupName)) {
        return listOfficersFiltered(filters);
      }
      const result = await pool.query(SQL.listOfficers);
      return result.rows as ReferenceOfficer[];
    },

    async searchOfficers(query) {
      const result = await pool.query(SQL.searchOfficers, [`%${query}%`]);
      return result.rows as ReferenceOfficer[];
    },

    async upsertOfficer(input) {
      const existsRes = await pool.query(SQL.officerExists, [input.id]);
      if (existsRes.rows.length > 0) {
        const now = new Date().toISOString();
        await pool.query(SQL.updateOfficer, [
          input.name, input.rarity, input.groupName,
          input.captainManeuver, input.officerAbility, input.belowDeckAbility,
          input.abilities ? JSON.stringify(input.abilities) : null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.officerGameId ?? null,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
          now, input.id,
        ]);
        log.fleet.debug({ id: input.id, name: input.name }, "reference officer updated");
        const result = await pool.query(SQL.getOfficer, [input.id]);
        return result.rows[0] as ReferenceOfficer;
      }
      return store.createOfficer(input);
    },

    async deleteOfficer(id) {
      const result = await pool.query(SQL.deleteOfficer, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    // ── Ships ─────────────────────────────────────────────

    async createShip(input) {
      const now = new Date().toISOString();
      const license = input.license ?? DEFAULT_LICENSE;
      const attribution = input.attribution ?? DEFAULT_ATTRIBUTION;
      await pool.query(SQL.insertShip, [
        input.id, input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
        input.source, input.sourceUrl, input.sourcePageId,
        input.sourceRevisionId, input.sourceRevisionTimestamp,
        license, attribution, now, now,
      ]);
      log.fleet.debug({ id: input.id, name: input.name }, "reference ship created");
      const result = await pool.query(SQL.getShip, [input.id]);
      return result.rows[0] as ReferenceShip;
    },

    async getShip(id) {
      const result = await pool.query(SQL.getShip, [id]);
      return (result.rows[0] as ReferenceShip) ?? null;
    },

    async findShipByName(name) {
      const result = await pool.query(SQL.findShipByName, [name]);
      return (result.rows[0] as ReferenceShip) ?? null;
    },

    async listShips(filters?) {
      if (filters && (filters.rarity || filters.faction || filters.shipClass)) {
        return listShipsFiltered(filters);
      }
      const result = await pool.query(SQL.listShips);
      return result.rows as ReferenceShip[];
    },

    async searchShips(query) {
      const result = await pool.query(SQL.searchShips, [`%${query}%`]);
      return result.rows as ReferenceShip[];
    },

    async upsertShip(input) {
      const existsRes = await pool.query(SQL.shipExists, [input.id]);
      if (existsRes.rows.length > 0) {
        const now = new Date().toISOString();
        await pool.query(SQL.updateShip, [
          input.name, input.shipClass, input.grade, input.rarity, input.faction, input.tier,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
          now, input.id,
        ]);
        log.fleet.debug({ id: input.id, name: input.name }, "reference ship updated");
        const result = await pool.query(SQL.getShip, [input.id]);
        return result.rows[0] as ReferenceShip;
      }
      return store.createShip(input);
    },

    async deleteShip(id) {
      const result = await pool.query(SQL.deleteShip, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    async bulkUpsertOfficers(officers) {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const officer of officers) {
          const existsRes = await client.query(SQL.officerExists, [officer.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateOfficer, [
              officer.name, officer.rarity, officer.groupName,
              officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
              officer.abilities ? JSON.stringify(officer.abilities) : null,
              officer.tags ? JSON.stringify(officer.tags) : null,
              officer.officerGameId ?? null,
              officer.source, officer.sourceUrl, officer.sourcePageId,
              officer.sourceRevisionId, officer.sourceRevisionTimestamp,
              officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
              now, officer.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertOfficer, [
              officer.id, officer.name, officer.rarity, officer.groupName,
              officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility,
              officer.abilities ? JSON.stringify(officer.abilities) : null,
              officer.tags ? JSON.stringify(officer.tags) : null,
              officer.officerGameId ?? null,
              officer.source, officer.sourceUrl, officer.sourcePageId,
              officer.sourceRevisionId, officer.sourceRevisionTimestamp,
              officer.license ?? DEFAULT_LICENSE, officer.attribution ?? DEFAULT_ATTRIBUTION,
              now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: officers.length }, "bulk upsert reference officers");
      return { created, updated };
    },

    async bulkUpsertShips(ships) {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const ship of ships) {
          const existsRes = await client.query(SQL.shipExists, [ship.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateShip, [
              ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
              ship.source, ship.sourceUrl, ship.sourcePageId,
              ship.sourceRevisionId, ship.sourceRevisionTimestamp,
              ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
              now, ship.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertShip, [
              ship.id, ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
              ship.source, ship.sourceUrl, ship.sourcePageId,
              ship.sourceRevisionId, ship.sourceRevisionTimestamp,
              ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
              now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: ships.length }, "bulk upsert reference ships");
      return { created, updated };
    },

    // ── Diagnostics ─────────────────────────────────────────

    async counts() {
      const offResult = await pool.query(SQL.countOfficers);
      const shipResult = await pool.query(SQL.countShips);
      return {
        officers: Number((offResult.rows[0] as { count: string }).count),
        ships: Number((shipResult.rows[0] as { count: string }).count),
      };
    },

    close() {
      /* pool managed externally */
    },
  };

  return store;
}
