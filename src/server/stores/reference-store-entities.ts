/**
 * reference-store-entities.ts — Extended entity getters + system mining (#191)
 */

import type { Pool } from "../db.js";
import type {
  ReferenceResearch,
  ReferenceBuilding,
  ReferenceHostile,
  ReferenceConsumable,
  ReferenceSystem,
} from "./reference-store.js";
import { SQL, SYSTEM_COLS } from "./reference-store-schema.js";

export function createEntitiesMixin(pool: Pool) {
  return {
    async getResearch(id: string): Promise<ReferenceResearch | null> {
      const result = await pool.query(SQL.getResearch, [id]);
      return (result.rows[0] as ReferenceResearch) ?? null;
    },

    async searchResearch(query: string): Promise<ReferenceResearch[]> {
      const result = await pool.query(SQL.searchResearch, [`%${query}%`]);
      return result.rows as ReferenceResearch[];
    },

    async getBuilding(id: string): Promise<ReferenceBuilding | null> {
      const result = await pool.query(SQL.getBuilding, [id]);
      return (result.rows[0] as ReferenceBuilding) ?? null;
    },

    async searchBuildings(query: string): Promise<ReferenceBuilding[]> {
      const result = await pool.query(SQL.searchBuildings, [`%${query}%`]);
      return result.rows as ReferenceBuilding[];
    },

    async listBuildingsAtOps(opts: { exactLevel?: number; aboveLevel?: number; limit?: number }): Promise<ReferenceBuilding[]> {
      const cap = Math.min(Math.max(1, opts.limit ?? 50), 200);
      if (opts.exactLevel != null) {
        const result = await pool.query(SQL.listBuildingsAtExactLevel, [opts.exactLevel, cap]);
        return result.rows as ReferenceBuilding[];
      }
      if (opts.aboveLevel != null) {
        const result = await pool.query(SQL.listBuildingsAboveLevel, [opts.aboveLevel, cap]);
        return result.rows as ReferenceBuilding[];
      }
      return [];
    },

    async getHostile(id: string): Promise<ReferenceHostile | null> {
      const result = await pool.query(SQL.getHostile, [id]);
      return (result.rows[0] as ReferenceHostile) ?? null;
    },

    async searchHostiles(query: string): Promise<ReferenceHostile[]> {
      const result = await pool.query(SQL.searchHostiles, [`%${query}%`]);
      return result.rows as ReferenceHostile[];
    },

    async getConsumable(id: string): Promise<ReferenceConsumable | null> {
      const result = await pool.query(SQL.getConsumable, [id]);
      return (result.rows[0] as ReferenceConsumable) ?? null;
    },

    async searchConsumables(query: string): Promise<ReferenceConsumable[]> {
      const result = await pool.query(SQL.searchConsumables, [`%${query}%`]);
      return result.rows as ReferenceConsumable[];
    },

    async getSystem(id: string): Promise<ReferenceSystem | null> {
      const result = await pool.query(SQL.getSystem, [id]);
      return (result.rows[0] as ReferenceSystem) ?? null;
    },

    async searchSystems(query: string): Promise<ReferenceSystem[]> {
      const result = await pool.query(SQL.searchSystems, [`%${query}%`]);
      return result.rows as ReferenceSystem[];
    },

    async listSystemsByResource(resourceGameId: number): Promise<ReferenceSystem[]> {
      if (!Number.isFinite(resourceGameId)) return [];
      const containment = JSON.stringify([{ id: resourceGameId }]);
      const result = await pool.query(SQL.listSystemsByResource, [containment]);
      return result.rows as ReferenceSystem[];
    },

    async searchSystemsByMining(opts: {
      resourceGameId: number;
      maxWarp?: number;
      minLevel?: number;
      maxLevel?: number;
    }): Promise<ReferenceSystem[]> {
      if (!Number.isFinite(opts.resourceGameId)) return [];
      const containment = JSON.stringify([{ id: opts.resourceGameId }]);
      const clauses: string[] = [`mine_resources @> $1::jsonb`];
      const params: (string | number)[] = [containment];
      let paramIdx = 2;

      if (opts.maxWarp != null) {
        clauses.push(`est_warp <= $${paramIdx++}`);
        params.push(opts.maxWarp);
      }
      if (opts.minLevel != null) {
        clauses.push(`level >= $${paramIdx++}`);
        params.push(opts.minLevel);
      }
      if (opts.maxLevel != null) {
        clauses.push(`level <= $${paramIdx++}`);
        params.push(opts.maxLevel);
      }

      const where = clauses.join(" AND ");
      const sql = `SELECT ${SYSTEM_COLS} FROM reference_systems WHERE ${where} ORDER BY est_warp ASC NULLS LAST, name`;
      const result = await pool.query(sql, params);
      return result.rows as ReferenceSystem[];
    },
  };
}
