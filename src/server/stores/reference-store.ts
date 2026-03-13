/**
 * reference-store.ts — Canonical Reference Data Store (barrel) (ADR-015 / ADR-016 / ADR-028)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed store for reference entities (officers, ships, research,
 * buildings, hostiles, consumables, systems).
 * Data is sourced from local game data snapshot (ADR-028).
 *
 * User state (ownership, targeting, level) lives in overlay-store.ts.
 * This module is the T2 reference tier in the MicroRunner authority ladder.
 *
 * Decomposed into domain modules (#191):
 *   reference-store-schema.ts    — Schema DDL + SQL fragments
 *   reference-store-core.ts      — Officer + Ship CRUD
 *   reference-store-bulk.ts      — Bulk upserts + legacy purge
 *   reference-store-entities.ts  — Extended entity getters + system mining
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";
import type {
  CreateReferenceResearchInput,
  CreateReferenceBuildingInput,
  CreateReferenceHostileInput,
  CreateReferenceConsumableInput,
  CreateReferenceSystemInput,
} from "../services/cdn-mappers.js";

import { SCHEMA_STATEMENTS, SQL } from "./reference-store-schema.js";
import { createCoreMixin } from "./reference-store-core.js";
import { createBulkMixin } from "./reference-store-bulk.js";
import { createEntitiesMixin } from "./reference-store-entities.js";

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

export interface ReferenceResearch {
  id: string;
  name: string;
  researchTree: string | null;
  unlockLevel: number | null;
  maxLevel: number | null;
  buffs: Record<string, unknown>[] | null;
  requirements: Record<string, unknown>[] | null;
  row: number | null;
  col: number | null;
  gameId: number | null;
  source: string;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceBuilding {
  id: string;
  name: string;
  maxLevel: number | null;
  unlockLevel: number | null;
  buffs: Record<string, unknown>[] | null;
  requirements: Record<string, unknown>[] | null;
  gameId: number | null;
  source: string;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceHostile {
  id: string;
  name: string;
  faction: string | null;
  level: number | null;
  shipType: number | null;
  hullType: number | null;
  rarity: number | null;
  strength: number | null;
  systems: string[] | null;
  warp: number | null;
  resources: Record<string, unknown>[] | null;
  gameId: number | null;
  source: string;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceConsumable {
  id: string;
  name: string;
  rarity: string | null;
  grade: number | null;
  requiresSlot: boolean | null;
  buff: Record<string, unknown> | null;
  durationSeconds: number | null;
  category: string | null;
  gameId: number | null;
  source: string;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceSystem {
  id: string;
  name: string;
  estWarp: number | null;
  isDeepSpace: boolean | null;
  factions: string[] | null;
  level: number | null;
  coordsX: number | null;
  coordsY: number | null;
  hasMines: boolean | null;
  hasPlanets: boolean | null;
  hasMissions: boolean | null;
  mineResources: Record<string, unknown>[] | null;
  hostileCount: number | null;
  nodeSizes: unknown[] | null;
  hazardLevel: number | null;
  gameId: number | null;
  source: string;
  license: string;
  attribution: string;
  createdAt: string;
  updatedAt: string;
}

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
  bulkUpsertResearch(items: CreateReferenceResearchInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertBuildings(items: CreateReferenceBuildingInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertHostiles(items: CreateReferenceHostileInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertConsumables(items: CreateReferenceConsumableInput[]): Promise<{ created: number; updated: number }>;
  bulkUpsertSystems(items: CreateReferenceSystemInput[]): Promise<{ created: number; updated: number }>;

  /** Delete legacy `raw:*` / `wiki:*` ship and officer entries superseded by CDN data. */
  purgeLegacyEntries(): Promise<{ ships: number; officers: number }>;

  // ── Extended Reference Types ────────────────────────────
  getResearch(id: string): Promise<ReferenceResearch | null>;
  searchResearch(query: string): Promise<ReferenceResearch[]>;
  getBuilding(id: string): Promise<ReferenceBuilding | null>;
  searchBuildings(query: string): Promise<ReferenceBuilding[]>;
  getHostile(id: string): Promise<ReferenceHostile | null>;
  searchHostiles(query: string): Promise<ReferenceHostile[]>;
  getConsumable(id: string): Promise<ReferenceConsumable | null>;
  searchConsumables(query: string): Promise<ReferenceConsumable[]>;
  getSystem(id: string): Promise<ReferenceSystem | null>;
  searchSystems(query: string): Promise<ReferenceSystem[]>;
  /** Find systems whose mine_resources JSONB contains a given resource game ID. */
  listSystemsByResource(resourceGameId: number): Promise<ReferenceSystem[]>;
  /** Composite mining query: filter by resource + optional warp/level/deepSpace constraints. */
  searchSystemsByMining(opts: {
    resourceGameId: number;
    maxWarp?: number;
    minLevel?: number;
    maxLevel?: number;
  }): Promise<ReferenceSystem[]>;
  /** List buildings at a specific ops unlock level, or above a given level (ADR-044). */
  listBuildingsAtOps(opts: { exactLevel?: number; aboveLevel?: number; limit?: number }): Promise<ReferenceBuilding[]>;

  counts(): Promise<ReferenceCounts>;
  close(): void;
}

export interface ReferenceCounts {
  officers: number;
  ships: number;
  research: number;
  buildings: number;
  hostiles: number;
  consumables: number;
  systems: number;
}

// ─── Implementation — compose domain mixins ────────────────

export async function createReferenceStore(adminPool: Pool, runtimePool?: Pool): Promise<ReferenceStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.boot.debug("reference store initialized");

  const store: ReferenceStore = {
    ...createCoreMixin(pool),
    ...createBulkMixin(pool),
    ...createEntitiesMixin(pool),

    async counts() {
      const offResult = await pool.query(SQL.countOfficers);
      const shipResult = await pool.query(SQL.countShips);
      const researchResult = await pool.query(SQL.countResearch);
      const buildingResult = await pool.query(SQL.countBuildings);
      const hostileResult = await pool.query(SQL.countHostiles);
      const consumableResult = await pool.query(SQL.countConsumables);
      const systemResult = await pool.query(SQL.countSystems);
      return {
        officers: Number((offResult.rows[0] as { count: string }).count),
        ships: Number((shipResult.rows[0] as { count: string }).count),
        research: Number((researchResult.rows[0] as { count: string }).count),
        buildings: Number((buildingResult.rows[0] as { count: string }).count),
        hostiles: Number((hostileResult.rows[0] as { count: string }).count),
        consumables: Number((consumableResult.rows[0] as { count: string }).count),
        systems: Number((systemResult.rows[0] as { count: string }).count),
      };
    },

    close() {
      /* pool managed externally */
    },
  };

  return store;
}
