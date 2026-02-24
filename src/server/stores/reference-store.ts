/**
 * reference-store.ts — Canonical Reference Data Store (ADR-015 / ADR-016 / ADR-028)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed store for reference entities (officers, ships).
 * Data is sourced from local game data snapshot (ADR-028).
 *
 * User state (ownership, targeting, level) lives in overlay-store.ts.
 * This module is the T2 reference tier in the MicroRunner authority ladder.
 *
 * Migrated from better-sqlite3 → @libsql/client (ADR-018 Phase 1),
 * then to PostgreSQL / pg (ADR-018 Phase 3).
 */

import { initSchema, withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";
import { serializeNormalizedJson } from "../services/json-number-normalize.js";

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
  /** Officer class: 1=Command, 2=Science, 3=Engineering */
  officerClass: number | null;
  /** Faction reference (JSONB: {id, name}) */
  faction: Record<string, unknown> | null;
  /** Synergy group ID from CDN */
  synergyId: number | null;
  /** Maximum rank (1-5) */
  maxRank: number | null;
  /** Trait configuration from CDN (JSONB) */
  traitConfig: Record<string, unknown> | null;
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
  ability: Record<string, unknown> | null;
  warpRange: number[] | null;
  link: string | null;
  /** Hull type: 0=Destroyer, 1=Survey, 2=Explorer, 3=Battleship, 4=Defense, 5=Armada */
  hullType: number | null;
  /** Build time in seconds */
  buildTimeInSeconds: number | null;
  /** Maximum tier from CDN */
  maxTier: number | null;
  /** Maximum level from CDN */
  maxLevel: number | null;
  /** Officer bonus curves (JSONB: {attack, defense, health}) */
  officerBonus: Record<string, unknown> | null;
  /** Crew slot unlock schedule (JSONB) */
  crewSlots: Record<string, unknown>[] | null;
  /** Build cost resources (JSONB) */
  buildCost: Record<string, unknown>[] | null;
  /** Per-level HP/shield curves (JSONB) */
  levels: Record<string, unknown>[] | null;
  /** Stable numeric game ID from CDN */
  gameId: number | null;
  /** Per-tier component stats from CDN (JSONB) */
  tiers: Record<string, unknown>[] | null;
  /** Build prerequisites: ops level + research requirements (JSONB) */
  buildRequirements: Record<string, unknown>[] | null;
  /** Number of blueprints required to unlock */
  blueprintsRequired: number | null;
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

export type CreateReferenceOfficerInput = Omit<ReferenceOfficer, "createdAt" | "updatedAt" | "license" | "attribution" | "abilities" | "tags" | "officerGameId" | "officerClass" | "faction" | "synergyId" | "maxRank" | "traitConfig"> & {
  license?: string;
  attribution?: string;
  abilities?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  officerGameId?: number | null;
  officerClass?: number | null;
  faction?: Record<string, unknown> | null;
  synergyId?: number | null;
  maxRank?: number | null;
  traitConfig?: Record<string, unknown> | null;
};

export type CreateReferenceShipInput = Omit<ReferenceShip, "createdAt" | "updatedAt" | "license" | "attribution" | "ability" | "warpRange" | "link" | "hullType" | "buildTimeInSeconds" | "maxTier" | "maxLevel" | "officerBonus" | "crewSlots" | "buildCost" | "levels" | "gameId" | "tiers" | "buildRequirements" | "blueprintsRequired"> & {
  license?: string;
  attribution?: string;
  ability?: Record<string, unknown> | null;
  warpRange?: number[] | null;
  link?: string | null;
  hullType?: number | null;
  buildTimeInSeconds?: number | null;
  maxTier?: number | null;
  maxLevel?: number | null;
  officerBonus?: Record<string, unknown> | null;
  crewSlots?: Record<string, unknown>[] | null;
  buildCost?: Record<string, unknown>[] | null;
  levels?: Record<string, unknown>[] | null;
  gameId?: number | null;
  tiers?: Record<string, unknown>[] | null;
  buildRequirements?: Record<string, unknown>[] | null;
  blueprintsRequired?: number | null;
};

// ─── Store Interface ────────────────────────────────────────

export interface ReferenceStore {
  createOfficer(officer: CreateReferenceOfficerInput): Promise<ReferenceOfficer>;
  getOfficer(id: string): Promise<ReferenceOfficer | null>;
  findOfficerByName(name: string): Promise<ReferenceOfficer | null>;
  listOfficers(filters?: { rarity?: string; groupName?: string; officerClass?: number }): Promise<ReferenceOfficer[]>;
  searchOfficers(query: string): Promise<ReferenceOfficer[]>;
  upsertOfficer(officer: CreateReferenceOfficerInput): Promise<ReferenceOfficer>;
  deleteOfficer(id: string): Promise<boolean>;

  createShip(ship: CreateReferenceShipInput): Promise<ReferenceShip>;
  getShip(id: string): Promise<ReferenceShip | null>;
  findShipByName(name: string): Promise<ReferenceShip | null>;
  listShips(filters?: { rarity?: string; faction?: string; shipClass?: string; hullType?: number; grade?: number }): Promise<ReferenceShip[]>;
  searchShips(query: string): Promise<ReferenceShip[]>;
  upsertShip(ship: CreateReferenceShipInput): Promise<ReferenceShip>;
  deleteShip(id: string): Promise<boolean>;

  bulkUpsertOfficers(officers: CreateReferenceOfficerInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertShips(ships: CreateReferenceShipInput[]): Promise<{ created: number; updated: number }>;

  /** Delete legacy `raw:*` / `wiki:*` ship and officer entries superseded by CDN data. */
  purgeLegacyEntries(): Promise<{ ships: number; officers: number }>;

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
    officer_class INTEGER,
    faction JSONB,
    synergy_id BIGINT,
    max_rank INTEGER,
    trait_config JSONB,
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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'officer_class') THEN
      ALTER TABLE reference_officers ADD COLUMN officer_class INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'faction') THEN
      ALTER TABLE reference_officers ADD COLUMN faction JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'synergy_id') THEN
      ALTER TABLE reference_officers ADD COLUMN synergy_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'max_rank') THEN
      ALTER TABLE reference_officers ADD COLUMN max_rank INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'trait_config') THEN
      ALTER TABLE reference_officers ADD COLUMN trait_config JSONB;
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
    hull_type INTEGER,
    build_time_in_seconds BIGINT,
    max_tier INTEGER,
    max_level INTEGER,
    officer_bonus JSONB,
    crew_slots JSONB,
    build_cost JSONB,
    levels JSONB,
    game_id BIGINT,
    tiers JSONB,
    build_requirements JSONB,
    blueprints_required INTEGER,
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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'ability') THEN
      ALTER TABLE reference_ships ADD COLUMN ability JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'warp_range') THEN
      ALTER TABLE reference_ships ADD COLUMN warp_range JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'link') THEN
      ALTER TABLE reference_ships ADD COLUMN link TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'hull_type') THEN
      ALTER TABLE reference_ships ADD COLUMN hull_type INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_time_in_seconds') THEN
      ALTER TABLE reference_ships ADD COLUMN build_time_in_seconds BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'max_tier') THEN
      ALTER TABLE reference_ships ADD COLUMN max_tier INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'max_level') THEN
      ALTER TABLE reference_ships ADD COLUMN max_level INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'officer_bonus') THEN
      ALTER TABLE reference_ships ADD COLUMN officer_bonus JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'crew_slots') THEN
      ALTER TABLE reference_ships ADD COLUMN crew_slots JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_cost') THEN
      ALTER TABLE reference_ships ADD COLUMN build_cost JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'levels') THEN
      ALTER TABLE reference_ships ADD COLUMN levels JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'game_id') THEN
      ALTER TABLE reference_ships ADD COLUMN game_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'tiers') THEN
      ALTER TABLE reference_ships ADD COLUMN tiers JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_requirements') THEN
      ALTER TABLE reference_ships ADD COLUMN build_requirements JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'blueprints_required') THEN
      ALTER TABLE reference_ships ADD COLUMN blueprints_required INTEGER;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_name ON reference_ships(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_class ON reference_ships(ship_class)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_faction ON reference_ships(faction)`,
];

const OFFICER_COLS = `id, name, rarity, group_name AS "groupName", captain_maneuver AS "captainManeuver",
  officer_ability AS "officerAbility", below_deck_ability AS "belowDeckAbility",
  abilities, tags, officer_game_id AS "officerGameId",
  officer_class AS "officerClass", faction, synergy_id AS "synergyId",
  max_rank AS "maxRank", trait_config AS "traitConfig",
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

const SHIP_COLS = `id, name, ship_class AS "shipClass", grade, rarity, faction, tier,
  ability, warp_range AS "warpRange", link,
  hull_type AS "hullType", build_time_in_seconds AS "buildTimeInSeconds",
  max_tier AS "maxTier", max_level AS "maxLevel",
  officer_bonus AS "officerBonus", crew_slots AS "crewSlots",
  build_cost AS "buildCost", levels, game_id AS "gameId",
  tiers, build_requirements AS "buildRequirements", blueprints_required AS "blueprintsRequired",
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

const SQL = {
  // Officers
  insertOfficer: `INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability,
    abilities, tags, officer_game_id, officer_class, faction, synergy_id, max_rank, trait_config,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
  updateOfficer: `UPDATE reference_officers SET name = $1, rarity = $2, group_name = $3, captain_maneuver = $4, officer_ability = $5,
    below_deck_ability = $6, abilities = $7, tags = $8, officer_game_id = $9,
    officer_class = $10, faction = $11, synergy_id = $12, max_rank = $13, trait_config = $14,
    source = $15, source_url = $16, source_page_id = $17, source_revision_id = $18,
    source_revision_timestamp = $19, license = $20, attribution = $21, updated_at = $22 WHERE id = $23`,
  getOfficer: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE id = $1`,
  findOfficerByName: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE LOWER(name) = LOWER($1)`,
  listOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers ORDER BY name`,
  searchOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE name ILIKE $1 ORDER BY name`,
  deleteOfficer: `DELETE FROM reference_officers WHERE id = $1`,
  officerExists: `SELECT 1 FROM reference_officers WHERE id = $1`,
  countOfficers: `SELECT COUNT(*) AS count FROM reference_officers`,

  // Ships
  insertShip: `INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, tier,
    ability, warp_range, link,
    hull_type, build_time_in_seconds, max_tier, max_level, officer_bonus, crew_slots, build_cost, levels, game_id,
    tiers, build_requirements, blueprints_required,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)`,
  updateShip: `UPDATE reference_ships SET name = $1, ship_class = $2, grade = $3, rarity = $4, faction = $5, tier = $6,
    ability = $7, warp_range = $8, link = $9,
    hull_type = $10, build_time_in_seconds = $11, max_tier = $12, max_level = $13,
    officer_bonus = $14, crew_slots = $15, build_cost = $16, levels = $17, game_id = $18,
    tiers = $19, build_requirements = $20, blueprints_required = $21,
    source = $22, source_url = $23, source_page_id = $24, source_revision_id = $25,
    source_revision_timestamp = $26, license = $27, attribution = $28, updated_at = $29 WHERE id = $30`,
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
  async function listOfficersFiltered(filters: { rarity?: string; groupName?: string; officerClass?: number }): Promise<ReferenceOfficer[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;
    if (filters.rarity) { clauses.push(`rarity = $${paramIdx++}`); params.push(filters.rarity); }
    if (filters.groupName) { clauses.push(`group_name = $${paramIdx++}`); params.push(filters.groupName); }
    if (filters.officerClass != null) { clauses.push(`officer_class = $${paramIdx++}`); params.push(filters.officerClass); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT ${OFFICER_COLS} FROM reference_officers ${where} ORDER BY name`,
      params,
    );
    return result.rows as ReferenceOfficer[];
  }

  async function listShipsFiltered(filters: { rarity?: string; faction?: string; shipClass?: string; hullType?: number; grade?: number }): Promise<ReferenceShip[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;
    if (filters.rarity) { clauses.push(`rarity = $${paramIdx++}`); params.push(filters.rarity); }
    if (filters.faction) { clauses.push(`faction = $${paramIdx++}`); params.push(filters.faction); }
    if (filters.shipClass) { clauses.push(`ship_class = $${paramIdx++}`); params.push(filters.shipClass); }
    if (filters.hullType != null) { clauses.push(`hull_type = $${paramIdx++}`); params.push(filters.hullType); }
    if (filters.grade != null) { clauses.push(`grade = $${paramIdx++}`); params.push(filters.grade); }
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
        serializeNormalizedJson(input.abilities, "reference_officers.abilities"),
        serializeNormalizedJson(input.tags, "reference_officers.tags"),
        input.officerGameId ?? null,
        input.officerClass ?? null,
        serializeNormalizedJson(input.faction, "reference_officers.faction"),
        input.synergyId ?? null,
        input.maxRank ?? null,
        serializeNormalizedJson(input.traitConfig, "reference_officers.trait_config"),
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
          serializeNormalizedJson(input.abilities, "reference_officers.abilities"),
          serializeNormalizedJson(input.tags, "reference_officers.tags"),
          input.officerGameId ?? null,
          input.officerClass ?? null,
          serializeNormalizedJson(input.faction, "reference_officers.faction"),
          input.synergyId ?? null,
          input.maxRank ?? null,
          serializeNormalizedJson(input.traitConfig, "reference_officers.trait_config"),
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
        serializeNormalizedJson(input.ability, "reference_ships.ability"),
        serializeNormalizedJson(input.warpRange, "reference_ships.warp_range"),
        input.link ?? null,
        input.hullType ?? null,
        input.buildTimeInSeconds ?? null,
        input.maxTier ?? null,
        input.maxLevel ?? null,
        serializeNormalizedJson(input.officerBonus, "reference_ships.officer_bonus"),
        serializeNormalizedJson(input.crewSlots, "reference_ships.crew_slots"),
        serializeNormalizedJson(input.buildCost, "reference_ships.build_cost"),
        serializeNormalizedJson(input.levels, "reference_ships.levels"),
        input.gameId ?? null,
        serializeNormalizedJson(input.tiers, "reference_ships.tiers"),
        serializeNormalizedJson(input.buildRequirements, "reference_ships.build_requirements"),
        input.blueprintsRequired ?? null,
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
          serializeNormalizedJson(input.ability, "reference_ships.ability"),
          serializeNormalizedJson(input.warpRange, "reference_ships.warp_range"),
          input.link ?? null,
          input.hullType ?? null,
          input.buildTimeInSeconds ?? null,
          input.maxTier ?? null,
          input.maxLevel ?? null,
          serializeNormalizedJson(input.officerBonus, "reference_ships.officer_bonus"),
          serializeNormalizedJson(input.crewSlots, "reference_ships.crew_slots"),
          serializeNormalizedJson(input.buildCost, "reference_ships.build_cost"),
          serializeNormalizedJson(input.levels, "reference_ships.levels"),
          input.gameId ?? null,
          serializeNormalizedJson(input.tiers, "reference_ships.tiers"),
          serializeNormalizedJson(input.buildRequirements, "reference_ships.build_requirements"),
          input.blueprintsRequired ?? null,
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
              serializeNormalizedJson(officer.abilities, "reference_officers.abilities"),
              serializeNormalizedJson(officer.tags, "reference_officers.tags"),
              officer.officerGameId ?? null,
              officer.officerClass ?? null,
              serializeNormalizedJson(officer.faction, "reference_officers.faction"),
              officer.synergyId ?? null,
              officer.maxRank ?? null,
              serializeNormalizedJson(officer.traitConfig, "reference_officers.trait_config"),
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
              serializeNormalizedJson(officer.abilities, "reference_officers.abilities"),
              serializeNormalizedJson(officer.tags, "reference_officers.tags"),
              officer.officerGameId ?? null,
              officer.officerClass ?? null,
              serializeNormalizedJson(officer.faction, "reference_officers.faction"),
              officer.synergyId ?? null,
              officer.maxRank ?? null,
              serializeNormalizedJson(officer.traitConfig, "reference_officers.trait_config"),
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
              serializeNormalizedJson(ship.ability, "reference_ships.ability"),
              serializeNormalizedJson(ship.warpRange, "reference_ships.warp_range"),
              ship.link ?? null,
              ship.hullType ?? null,
              ship.buildTimeInSeconds ?? null,
              ship.maxTier ?? null,
              ship.maxLevel ?? null,
              serializeNormalizedJson(ship.officerBonus, "reference_ships.officer_bonus"),
              serializeNormalizedJson(ship.crewSlots, "reference_ships.crew_slots"),
              serializeNormalizedJson(ship.buildCost, "reference_ships.build_cost"),
              serializeNormalizedJson(ship.levels, "reference_ships.levels"),
              ship.gameId ?? null,
              serializeNormalizedJson(ship.tiers, "reference_ships.tiers"),
              serializeNormalizedJson(ship.buildRequirements, "reference_ships.build_requirements"),
              ship.blueprintsRequired ?? null,
              ship.source, ship.sourceUrl, ship.sourcePageId,
              ship.sourceRevisionId, ship.sourceRevisionTimestamp,
              ship.license ?? DEFAULT_LICENSE, ship.attribution ?? DEFAULT_ATTRIBUTION,
              now, ship.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertShip, [
              ship.id, ship.name, ship.shipClass, ship.grade, ship.rarity, ship.faction, ship.tier,
              serializeNormalizedJson(ship.ability, "reference_ships.ability"),
              serializeNormalizedJson(ship.warpRange, "reference_ships.warp_range"),
              ship.link ?? null,
              ship.hullType ?? null,
              ship.buildTimeInSeconds ?? null,
              ship.maxTier ?? null,
              ship.maxLevel ?? null,
              serializeNormalizedJson(ship.officerBonus, "reference_ships.officer_bonus"),
              serializeNormalizedJson(ship.crewSlots, "reference_ships.crew_slots"),
              serializeNormalizedJson(ship.buildCost, "reference_ships.build_cost"),
              serializeNormalizedJson(ship.levels, "reference_ships.levels"),
              ship.gameId ?? null,
              serializeNormalizedJson(ship.tiers, "reference_ships.tiers"),
              serializeNormalizedJson(ship.buildRequirements, "reference_ships.build_requirements"),
              ship.blueprintsRequired ?? null,
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

    async purgeLegacyEntries() {
      // Cascade-clean related tables that lack FK constraints first
      await pool.query(`DELETE FROM ship_overlay WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%'`);
      await pool.query(`DELETE FROM officer_overlay WHERE ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
      await pool.query(`DELETE FROM targets WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%' OR ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
      // bridge_core_members and loadouts have ON DELETE CASCADE — auto-cleaned
      const shipResult = await pool.query(
        `DELETE FROM reference_ships WHERE id LIKE 'raw:ship:%' OR id LIKE 'wiki:ship:%'`,
      );
      const officerResult = await pool.query(
        `DELETE FROM reference_officers WHERE id LIKE 'raw:officer:%' OR id LIKE 'wiki:officer:%'`,
      );
      const shipCount = shipResult.rowCount ?? 0;
      const officerCount = officerResult.rowCount ?? 0;
      if (shipCount > 0 || officerCount > 0) {
        log.fleet.info({ ships: shipCount, officers: officerCount }, "purged legacy raw/wiki reference entries and related data");
      }
      return { ships: shipCount, officers: officerCount };
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
