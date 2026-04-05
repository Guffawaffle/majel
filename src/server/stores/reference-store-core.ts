/**
 * reference-store-core.ts — Officer + Ship CRUD mixin (#191)
 */

import type { Pool } from "../db.js";
import { log } from "../logger.js";
import { serializeNormalizedJson } from "../services/json-number-normalize.js";
import type {
  ReferenceOfficer,
  ReferenceShip,
  CreateReferenceOfficerInput,
  CreateReferenceShipInput,
} from "./reference-store.js";
import {
  SQL,
  OFFICER_COLS,
  SHIP_COLS,
  DEFAULT_LICENSE,
  DEFAULT_ATTRIBUTION,
} from "./reference-store-schema.js";

export function createCoreMixin(pool: Pool) {
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

  return {
    // ── Officers ──────────────────────────────────────────

    async createOfficer(input: CreateReferenceOfficerInput): Promise<ReferenceOfficer> {
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

    async getOfficer(id: string): Promise<ReferenceOfficer | null> {
      const result = await pool.query(SQL.getOfficer, [id]);
      return (result.rows[0] as ReferenceOfficer) ?? null;
    },

    async findOfficerByName(name: string): Promise<ReferenceOfficer | null> {
      const result = await pool.query(SQL.findOfficerByName, [name]);
      return (result.rows[0] as ReferenceOfficer) ?? null;
    },

    async listOfficers(filters?: { rarity?: string; groupName?: string; officerClass?: number }): Promise<ReferenceOfficer[]> {
      if (filters && (filters.rarity || filters.groupName)) {
        return listOfficersFiltered(filters);
      }
      const result = await pool.query(SQL.listOfficers);
      return result.rows as ReferenceOfficer[];
    },

    async searchOfficers(query: string): Promise<ReferenceOfficer[]> {
      const result = await pool.query(SQL.searchOfficers, [`%${query}%`]);
      return result.rows as ReferenceOfficer[];
    },

    async upsertOfficer(input: CreateReferenceOfficerInput): Promise<ReferenceOfficer> {
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
      return this.createOfficer(input);
    },

    async deleteOfficer(id: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteOfficer, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    // ── Ships ─────────────────────────────────────────────

    async createShip(input: CreateReferenceShipInput): Promise<ReferenceShip> {
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
        serializeNormalizedJson(input.scrap, "reference_ships.scrap"),
        serializeNormalizedJson(input.baseScrap, "reference_ships.base_scrap"),
        input.scrapLevel ?? null,
        input.source, input.sourceUrl, input.sourcePageId,
        input.sourceRevisionId, input.sourceRevisionTimestamp,
        license, attribution, now, now,
      ]);
      log.fleet.debug({ id: input.id, name: input.name }, "reference ship created");
      const result = await pool.query(SQL.getShip, [input.id]);
      return result.rows[0] as ReferenceShip;
    },

    async getShip(id: string): Promise<ReferenceShip | null> {
      const result = await pool.query(SQL.getShip, [id]);
      return (result.rows[0] as ReferenceShip) ?? null;
    },

    async findShipByName(name: string): Promise<ReferenceShip | null> {
      const result = await pool.query(SQL.findShipByName, [name]);
      return (result.rows[0] as ReferenceShip) ?? null;
    },

    async listShips(filters?: { rarity?: string; faction?: string; shipClass?: string; hullType?: number; grade?: number }): Promise<ReferenceShip[]> {
      if (filters && (filters.rarity || filters.faction || filters.shipClass)) {
        return listShipsFiltered(filters);
      }
      const result = await pool.query(SQL.listShips);
      return result.rows as ReferenceShip[];
    },

    async searchShips(query: string): Promise<ReferenceShip[]> {
      const result = await pool.query(SQL.searchShips, [`%${query}%`]);
      return result.rows as ReferenceShip[];
    },

    async upsertShip(input: CreateReferenceShipInput): Promise<ReferenceShip> {
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
          serializeNormalizedJson(input.scrap, "reference_ships.scrap"),
          serializeNormalizedJson(input.baseScrap, "reference_ships.base_scrap"),
          input.scrapLevel ?? null,
          input.source, input.sourceUrl, input.sourcePageId,
          input.sourceRevisionId, input.sourceRevisionTimestamp,
          input.license ?? DEFAULT_LICENSE, input.attribution ?? DEFAULT_ATTRIBUTION,
          now, input.id,
        ]);
        log.fleet.debug({ id: input.id, name: input.name }, "reference ship updated");
        const result = await pool.query(SQL.getShip, [input.id]);
        return result.rows[0] as ReferenceShip;
      }
      return this.createShip(input);
    },

    async deleteShip(id: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteShip, [id]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
