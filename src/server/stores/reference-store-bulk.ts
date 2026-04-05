/**
 * reference-store-bulk.ts — Bulk upsert + legacy purge mixin (#191)
 */

import { withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";
import { serializeNormalizedJson } from "../services/json-number-normalize.js";
import type {
  CreateReferenceResearchInput,
  CreateReferenceBuildingInput,
  CreateReferenceHostileInput,
  CreateReferenceConsumableInput,
  CreateReferenceSystemInput,
} from "../services/cdn-mappers.js";
import type {
  CreateReferenceOfficerInput,
  CreateReferenceShipInput,
} from "./reference-store.js";
import { SQL, DEFAULT_LICENSE, DEFAULT_ATTRIBUTION } from "./reference-store-schema.js";

export function createBulkMixin(pool: Pool) {
  return {
    async bulkUpsertOfficers(officers: CreateReferenceOfficerInput[]): Promise<{ created: number; updated: number }> {
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

    async bulkUpsertShips(ships: CreateReferenceShipInput[]): Promise<{ created: number; updated: number }> {
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
              serializeNormalizedJson(ship.scrap, "reference_ships.scrap"),
              serializeNormalizedJson(ship.baseScrap, "reference_ships.base_scrap"),
              ship.scrapLevel ?? null,
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
              serializeNormalizedJson(ship.scrap, "reference_ships.scrap"),
              serializeNormalizedJson(ship.baseScrap, "reference_ships.base_scrap"),
              ship.scrapLevel ?? null,
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

    async bulkUpsertResearch(items: CreateReferenceResearchInput[]): Promise<{ created: number; updated: number }> {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const r of items) {
          const existsRes = await client.query(SQL.researchExists, [r.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateResearch, [
              r.name, r.researchTree, r.unlockLevel, r.maxLevel,
              serializeNormalizedJson(r.buffs, "reference_research.buffs"),
              serializeNormalizedJson(r.requirements, "reference_research.requirements"),
              r.row, r.col, r.gameId,
              r.source, r.license, r.attribution, now, r.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertResearch, [
              r.id, r.name, r.researchTree, r.unlockLevel, r.maxLevel,
              serializeNormalizedJson(r.buffs, "reference_research.buffs"),
              serializeNormalizedJson(r.requirements, "reference_research.requirements"),
              r.row, r.col, r.gameId,
              r.source, r.license, r.attribution, now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: items.length }, "bulk upsert reference research");
      return { created, updated };
    },

    async bulkUpsertBuildings(items: CreateReferenceBuildingInput[]): Promise<{ created: number; updated: number }> {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const b of items) {
          const existsRes = await client.query(SQL.buildingExists, [b.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateBuilding, [
              b.name, b.maxLevel, b.unlockLevel,
              serializeNormalizedJson(b.buffs, "reference_buildings.buffs"),
              serializeNormalizedJson(b.requirements, "reference_buildings.requirements"),
              b.gameId, b.source, b.license, b.attribution, now, b.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertBuilding, [
              b.id, b.name, b.maxLevel, b.unlockLevel,
              serializeNormalizedJson(b.buffs, "reference_buildings.buffs"),
              serializeNormalizedJson(b.requirements, "reference_buildings.requirements"),
              b.gameId, b.source, b.license, b.attribution, now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: items.length }, "bulk upsert reference buildings");
      return { created, updated };
    },

    async bulkUpsertHostiles(items: CreateReferenceHostileInput[]): Promise<{ created: number; updated: number }> {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const h of items) {
          const existsRes = await client.query(SQL.hostileExists, [h.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateHostile, [
              h.name, h.faction, h.level, h.shipType, h.hullType, h.rarity, h.strength,
              h.systems, h.warp,
              serializeNormalizedJson(h.resources, "reference_hostiles.resources"),
              h.gameId, h.source, h.license, h.attribution, now, h.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertHostile, [
              h.id, h.name, h.faction, h.level, h.shipType, h.hullType, h.rarity, h.strength,
              h.systems, h.warp,
              serializeNormalizedJson(h.resources, "reference_hostiles.resources"),
              h.gameId, h.source, h.license, h.attribution, now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: items.length }, "bulk upsert reference hostiles");
      return { created, updated };
    },

    async bulkUpsertConsumables(items: CreateReferenceConsumableInput[]): Promise<{ created: number; updated: number }> {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const c of items) {
          const existsRes = await client.query(SQL.consumableExists, [c.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateConsumable, [
              c.name, c.rarity, c.grade, c.requiresSlot,
              serializeNormalizedJson(c.buff, "reference_consumables.buff"),
              c.durationSeconds, c.category, c.gameId,
              c.source, c.license, c.attribution, now, c.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertConsumable, [
              c.id, c.name, c.rarity, c.grade, c.requiresSlot,
              serializeNormalizedJson(c.buff, "reference_consumables.buff"),
              c.durationSeconds, c.category, c.gameId,
              c.source, c.license, c.attribution, now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: items.length }, "bulk upsert reference consumables");
      return { created, updated };
    },

    async bulkUpsertSystems(items: CreateReferenceSystemInput[]): Promise<{ created: number; updated: number }> {
      let created = 0;
      let updated = 0;
      await withTransaction(pool, async (client) => {
        for (const s of items) {
          const existsRes = await client.query(SQL.systemExists, [s.id]);
          const now = new Date().toISOString();
          if (existsRes.rows.length > 0) {
            await client.query(SQL.updateSystem, [
              s.name, s.estWarp, s.isDeepSpace, s.factions, s.level,
              s.coordsX, s.coordsY, s.hasMines, s.hasPlanets, s.hasMissions,
              serializeNormalizedJson(s.mineResources, "reference_systems.mine_resources"),
              s.hostileCount,
              serializeNormalizedJson(s.nodeSizes, "reference_systems.node_sizes"),
              s.hazardLevel, s.gameId, s.source, s.license, s.attribution, now, s.id,
            ]);
            updated++;
          } else {
            await client.query(SQL.insertSystem, [
              s.id, s.name, s.estWarp, s.isDeepSpace, s.factions, s.level,
              s.coordsX, s.coordsY, s.hasMines, s.hasPlanets, s.hasMissions,
              serializeNormalizedJson(s.mineResources, "reference_systems.mine_resources"),
              s.hostileCount,
              serializeNormalizedJson(s.nodeSizes, "reference_systems.node_sizes"),
              s.hazardLevel, s.gameId, s.source, s.license, s.attribution, now, now,
            ]);
            created++;
          }
        }
      });
      log.fleet.info({ created, updated, total: items.length }, "bulk upsert reference systems");
      return { created, updated };
    },

    async purgeLegacyEntries(): Promise<{ ships: number; officers: number }> {
      // Cascade-clean related tables that lack FK constraints first.
      // Tolerates missing tables (42P01) — on a fresh DB, overlay/target tables
      // may not exist yet (created in Stage 2, purge runs in Stage 1).
      const safeDelete = async (sql: string): Promise<void> => {
        try {
          await pool.query(sql);
        } catch (err: unknown) {
          if (err && typeof err === "object" && "code" in err && err.code === "42P01") return;
          throw err;
        }
      };
      await safeDelete(`DELETE FROM ship_overlay WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%'`);
      await safeDelete(`DELETE FROM officer_overlay WHERE ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
      await safeDelete(`DELETE FROM targets WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%' OR ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
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
  };
}
