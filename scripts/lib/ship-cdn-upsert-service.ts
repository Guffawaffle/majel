import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { UpsertOutcome } from "./cdn-ingest-pipeline.ts";
import { mapCdnShipToReferenceInput } from "../../src/server/services/cdn-mappers.js";

export interface CdnShipSummary {
  id: number;
  loca_id: number;
  hull_type: number;
  grade: number | null;
  rarity: number | string;
  faction?: { id?: number | null } | null;
  max_tier?: number | null;
  build_requirements?: unknown;
  blueprints_required?: number | null;
}

interface ShipAbilityEntry {
  value_is_percentage?: boolean;
  values?: unknown;
}

interface ShipDetail {
  ability?: ShipAbilityEntry[];
  build_time_in_seconds?: number | null;
  max_tier?: number | null;
  max_level?: number | null;
  officer_bonus?: Record<string, unknown> | null;
  crew_slots?: Record<string, unknown>[] | null;
  build_cost?: Record<string, unknown>[] | null;
  levels?: Record<string, unknown>[] | null;
  tiers?: Record<string, unknown>[] | null;
  build_requirements?: Record<string, unknown>[] | null;
  blueprints_required?: number | null;
}

interface ShipCdnUpsertServiceOptions {
  pool: pg.Pool;
  snapshotDir: string;
  hullTypeLabels: Record<number, string>;
  rarityLabels: Record<number, string>;
  factionLabels: Record<number, string>;
  shipNameMap: Map<number, string>;
  shipAbilityNameMap: Map<number, string>;
  shipAbilityDescMap: Map<number, string>;
}

export class ShipCdnUpsertService {
  constructor(private readonly options: ShipCdnUpsertServiceOptions) {}

  async upsertOne(ship: CdnShipSummary): Promise<UpsertOutcome> {
    const { pool, snapshotDir, hullTypeLabels, rarityLabels, factionLabels, shipNameMap, shipAbilityNameMap, shipAbilityDescMap } = this.options;

    const detail = await this.loadShipDetail(ship.id, snapshotDir);

    const mapped = mapCdnShipToReferenceInput({
      ship,
      detail,
      shipNameMap,
      shipAbilityNameMap,
      shipAbilityDescMap,
      hullTypeLabels,
      rarityLabels,
      factionLabels,
    });

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, ability,
        hull_type, build_time_in_seconds, max_tier, max_level, officer_bonus, crew_slots,
        build_cost, levels, tiers, build_requirements, blueprints_required, game_id,
        link, source, source_url, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        ship_class = EXCLUDED.ship_class,
        grade = EXCLUDED.grade,
        rarity = EXCLUDED.rarity,
        faction = EXCLUDED.faction,
        ability = EXCLUDED.ability,
        hull_type = EXCLUDED.hull_type,
        build_time_in_seconds = EXCLUDED.build_time_in_seconds,
        max_tier = EXCLUDED.max_tier,
        max_level = EXCLUDED.max_level,
        officer_bonus = EXCLUDED.officer_bonus,
        crew_slots = EXCLUDED.crew_slots,
        build_cost = EXCLUDED.build_cost,
        levels = EXCLUDED.levels,
        tiers = EXCLUDED.tiers,
        build_requirements = EXCLUDED.build_requirements,
        blueprints_required = EXCLUDED.blueprints_required,
        game_id = EXCLUDED.game_id
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id,
      mapped.name,
      mapped.shipClass,
      mapped.grade,
      mapped.rarity,
      mapped.faction,
      mapped.ability ? JSON.stringify(mapped.ability) : null,
      mapped.hullType,
      mapped.buildTimeInSeconds,
      mapped.maxTier,
      mapped.maxLevel,
      mapped.officerBonus ? JSON.stringify(mapped.officerBonus) : null,
      mapped.crewSlots ? JSON.stringify(mapped.crewSlots) : null,
      mapped.buildCost ? JSON.stringify(mapped.buildCost) : null,
      mapped.levels ? JSON.stringify(mapped.levels) : null,
      mapped.tiers ? JSON.stringify(mapped.tiers) : null,
      mapped.buildRequirements ? JSON.stringify(mapped.buildRequirements) : null,
      mapped.blueprintsRequired,
      mapped.gameId,
      mapped.link,
      mapped.source,
      mapped.sourceUrl,
      "CC-BY-NC 4.0",
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }

  private async loadShipDetail(shipId: number, snapshotDir: string): Promise<ShipDetail | null> {
    try {
      const detailPath = join(snapshotDir, "ship", `${shipId}.json`);
      if (!existsSync(detailPath)) {
        return null;
      }
      const detailRaw = await readFile(detailPath, "utf-8");
      return JSON.parse(detailRaw) as ShipDetail;
    } catch {
      return null;
    }
  }
}
