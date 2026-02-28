import type pg from "pg";
import type { UpsertOutcome } from "./cdn-ingest-pipeline.ts";
import {
  mapCdnResearchToReferenceInput,
  mapCdnBuildingToReferenceInput,
  mapCdnHostileToReferenceInput,
  mapCdnConsumableToReferenceInput,
  mapCdnSystemToReferenceInput,
  type CdnResearchSummary,
  type CdnBuildingSummary,
  type CdnHostileSummary,
  type CdnConsumableSummary,
  type CdnSystemSummary,
} from "../../src/server/services/cdn-mappers.js";
import { serializeNormalizedJson } from "../../src/server/services/json-number-normalize.js";

// ─── Research Upsert Service ───────────────────────────────

interface ResearchUpsertOptions {
  pool: pg.Pool;
  nameMap: Map<number, string>;
  treeNameMap: Map<number, string>;
}

export class ResearchCdnUpsertService {
  constructor(private readonly options: ResearchUpsertOptions) {}

  async upsertOne(research: CdnResearchSummary): Promise<UpsertOutcome> {
    const { pool, nameMap, treeNameMap } = this.options;
    const mapped = mapCdnResearchToReferenceInput({ research, nameMap, treeNameMap });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_research (id, name, research_tree, unlock_level, max_level,
        buffs, requirements, row, col, game_id, source, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        research_tree = EXCLUDED.research_tree,
        unlock_level = EXCLUDED.unlock_level,
        max_level = EXCLUDED.max_level,
        buffs = EXCLUDED.buffs,
        requirements = EXCLUDED.requirements,
        row = EXCLUDED.row,
        col = EXCLUDED.col,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id, mapped.name, mapped.researchTree,
      mapped.unlockLevel, mapped.maxLevel,
      serializeNormalizedJson(mapped.buffs, "reference_research.buffs"),
      serializeNormalizedJson(mapped.requirements, "reference_research.requirements"),
      mapped.row, mapped.col, mapped.gameId,
      mapped.source, mapped.license,
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }
}

// ─── Building Upsert Service ──────────────────────────────

interface BuildingUpsertOptions {
  pool: pg.Pool;
  nameMap: Map<number, string>;
}

export class BuildingCdnUpsertService {
  constructor(private readonly options: BuildingUpsertOptions) {}

  async upsertOne(building: CdnBuildingSummary): Promise<UpsertOutcome> {
    const { pool, nameMap } = this.options;
    const mapped = mapCdnBuildingToReferenceInput({ building, nameMap });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_buildings (id, name, max_level, unlock_level,
        buffs, requirements, game_id, source, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        max_level = EXCLUDED.max_level,
        unlock_level = EXCLUDED.unlock_level,
        buffs = EXCLUDED.buffs,
        requirements = EXCLUDED.requirements,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id, mapped.name, mapped.maxLevel, mapped.unlockLevel,
      serializeNormalizedJson(mapped.buffs, "reference_buildings.buffs"),
      serializeNormalizedJson(mapped.requirements, "reference_buildings.requirements"),
      mapped.gameId, mapped.source, mapped.license,
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }
}

// ─── Hostile Upsert Service ───────────────────────────────

interface HostileUpsertOptions {
  pool: pg.Pool;
  nameMap: Map<number, string>;
  factionLabels: Record<number, string>;
}

export class HostileCdnUpsertService {
  constructor(private readonly options: HostileUpsertOptions) {}

  async upsertOne(hostile: CdnHostileSummary): Promise<UpsertOutcome> {
    const { pool, nameMap, factionLabels } = this.options;
    const mapped = mapCdnHostileToReferenceInput({ hostile, nameMap, factionLabels });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_hostiles (id, name, faction, level, ship_type, hull_type,
        rarity, strength, systems, warp, resources, game_id, source, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        faction = EXCLUDED.faction,
        level = EXCLUDED.level,
        ship_type = EXCLUDED.ship_type,
        hull_type = EXCLUDED.hull_type,
        rarity = EXCLUDED.rarity,
        strength = EXCLUDED.strength,
        systems = EXCLUDED.systems,
        warp = EXCLUDED.warp,
        resources = EXCLUDED.resources,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id, mapped.name, mapped.faction, mapped.level,
      mapped.shipType, mapped.hullType, mapped.rarity,
      mapped.strength, mapped.systems, mapped.warp,
      serializeNormalizedJson(mapped.resources, "reference_hostiles.resources"),
      mapped.gameId, mapped.source, mapped.license,
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }
}

// ─── Consumable Upsert Service ────────────────────────────

interface ConsumableUpsertOptions {
  pool: pg.Pool;
  nameMap: Map<number, string>;
}

export class ConsumableCdnUpsertService {
  constructor(private readonly options: ConsumableUpsertOptions) {}

  async upsertOne(consumable: CdnConsumableSummary): Promise<UpsertOutcome> {
    const { pool, nameMap } = this.options;
    const mapped = mapCdnConsumableToReferenceInput({ consumable, nameMap });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_consumables (id, name, rarity, grade, requires_slot,
        buff, duration_seconds, category, game_id, source, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        rarity = EXCLUDED.rarity,
        grade = EXCLUDED.grade,
        requires_slot = EXCLUDED.requires_slot,
        buff = EXCLUDED.buff,
        duration_seconds = EXCLUDED.duration_seconds,
        category = EXCLUDED.category,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id, mapped.name, mapped.rarity, mapped.grade,
      mapped.requiresSlot,
      serializeNormalizedJson(mapped.buff, "reference_consumables.buff"),
      mapped.durationSeconds, mapped.category,
      mapped.gameId, mapped.source, mapped.license,
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }
}

// ─── System Upsert Service ────────────────────────────────

interface SystemUpsertOptions {
  pool: pg.Pool;
  nameMap: Map<number, string>;
  factionLabels: Record<number, string>;
}

export class SystemCdnUpsertService {
  constructor(private readonly options: SystemUpsertOptions) {}

  async upsertOne(system: CdnSystemSummary): Promise<UpsertOutcome> {
    const { pool, nameMap, factionLabels } = this.options;
    const mapped = mapCdnSystemToReferenceInput({ system, nameMap, factionLabels });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_systems (id, name, est_warp, is_deep_space, factions, level,
        coords_x, coords_y, has_mines, has_planets, has_missions,
        mine_resources, hostile_count, node_sizes, hazard_level, game_id, source, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        est_warp = EXCLUDED.est_warp,
        is_deep_space = EXCLUDED.is_deep_space,
        factions = EXCLUDED.factions,
        level = EXCLUDED.level,
        coords_x = EXCLUDED.coords_x,
        coords_y = EXCLUDED.coords_y,
        has_mines = EXCLUDED.has_mines,
        has_planets = EXCLUDED.has_planets,
        has_missions = EXCLUDED.has_missions,
        mine_resources = EXCLUDED.mine_resources,
        hostile_count = EXCLUDED.hostile_count,
        node_sizes = EXCLUDED.node_sizes,
        hazard_level = EXCLUDED.hazard_level,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id, mapped.name, mapped.estWarp, mapped.isDeepSpace,
      mapped.factions, mapped.level, mapped.coordsX, mapped.coordsY,
      mapped.hasMines, mapped.hasPlanets, mapped.hasMissions,
      serializeNormalizedJson(mapped.mineResources, "reference_systems.mine_resources"),
      mapped.hostileCount,
      serializeNormalizedJson(mapped.nodeSizes, "reference_systems.node_sizes"),
      mapped.hazardLevel, mapped.gameId, mapped.source, mapped.license,
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }
}
