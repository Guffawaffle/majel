/**
 * crew-store-loadout.ts — Loadout + Variant query families
 *
 * Extracted from crew-store.ts (ADR-025) for #191 store decomposition.
 */

import { log } from "../logger.js";
import type { ScopeProvider } from "../request-context.js";
import type {
  BridgeCore,
  BelowDeckPolicy,
  Loadout,
  LoadoutWithRefs,
  LoadoutVariant,
  VariantPatch,
  BridgeCoreWithMembers,
} from "../types/crew-types.js";
import { BC_COLS, BDP_COLS, LOADOUT_COLS, VARIANT_COLS } from "./crew-store-schema.js";
import { attachMembers, validatePatch } from "./crew-store-helpers.js";

export function createLoadoutMixin(scope: ScopeProvider, userId: string) {
  return {
    // ═══════════════════════════════════════════════════════
    // Loadouts
    // ═══════════════════════════════════════════════════════

    async listLoadouts(filters?: { shipId?: string; intentKey?: string; tag?: string; active?: boolean }): Promise<Loadout[]> {
      return scope.read(async (client) => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (filters?.shipId) { clauses.push(`ship_id = $${idx++}`); params.push(filters.shipId); }
        if (filters?.active !== undefined) { clauses.push(`is_active = $${idx++}`); params.push(filters.active); }
        if (filters?.intentKey) { clauses.push(`intent_keys @> $${idx++}::jsonb`); params.push(JSON.stringify([filters.intentKey])); }
        if (filters?.tag) { clauses.push(`tags @> $${idx++}::jsonb`); params.push(JSON.stringify([filters.tag])); }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const result = await client.query(
          `SELECT ${LOADOUT_COLS} FROM loadouts ${where} ORDER BY priority DESC, name`,
          params,
        );
        return result.rows as Loadout[];
      });
    },

    async getLoadout(id: number): Promise<LoadoutWithRefs | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${LOADOUT_COLS} FROM loadouts WHERE id = $1`, [id]);
        const loadout = result.rows[0] as Loadout | undefined;
        if (!loadout) return null;

        let bridgeCore: BridgeCoreWithMembers | null = null;
        if (loadout.bridgeCoreId) {
          const bcResult = await client.query(`SELECT ${BC_COLS} FROM bridge_cores WHERE id = $1`, [loadout.bridgeCoreId]);
          const bcs = await attachMembers(client, bcResult.rows as BridgeCore[]);
          bridgeCore = bcs[0] ?? null;
        }

        let belowDeckPolicy: BelowDeckPolicy | null = null;
        if (loadout.belowDeckPolicyId) {
          const bdpResult = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`, [loadout.belowDeckPolicyId]);
          belowDeckPolicy = (bdpResult.rows[0] as BelowDeckPolicy) ?? null;
        }

        return { ...loadout, bridgeCore, belowDeckPolicy };
      });
    },

    async getLoadoutsByIds(ids: number[]): Promise<Map<number, LoadoutWithRefs>> {
      if (ids.length === 0) return new Map();
      return scope.read(async (client) => {
        const result = await client.query(
          `SELECT ${LOADOUT_COLS} FROM loadouts WHERE id = ANY($1)`, [ids],
        );
        const loadouts = result.rows as Loadout[];
        if (loadouts.length === 0) return new Map<number, LoadoutWithRefs>();

        // Batch-fetch bridge cores
        const bcIds = [...new Set(loadouts.map(l => l.bridgeCoreId).filter((id): id is number => id != null))];
        const bcMap = new Map<number, BridgeCoreWithMembers>();
        if (bcIds.length > 0) {
          const bcResult = await client.query(`SELECT ${BC_COLS} FROM bridge_cores WHERE id = ANY($1)`, [bcIds]);
          const withMembers = await attachMembers(client, bcResult.rows as BridgeCore[]);
          for (const bc of withMembers) bcMap.set(bc.id, bc);
        }

        // Batch-fetch below deck policies
        const bdpIds = [...new Set(loadouts.map(l => l.belowDeckPolicyId).filter((id): id is number => id != null))];
        const bdpMap = new Map<number, BelowDeckPolicy>();
        if (bdpIds.length > 0) {
          const bdpResult = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = ANY($1)`, [bdpIds]);
          for (const bdp of bdpResult.rows as BelowDeckPolicy[]) bdpMap.set(bdp.id, bdp);
        }

        const out = new Map<number, LoadoutWithRefs>();
        for (const l of loadouts) {
          out.set(l.id, {
            ...l,
            bridgeCore: l.bridgeCoreId ? bcMap.get(l.bridgeCoreId) ?? null : null,
            belowDeckPolicy: l.belowDeckPolicyId ? bdpMap.get(l.belowDeckPolicyId) ?? null : null,
          });
        }
        return out;
      });
    },

    async createLoadout(fields: {
      shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
      priority?: number; isActive?: boolean; intentKeys?: string[]; tags?: string[]; notes?: string;
    }): Promise<Loadout> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO loadouts (user_id, ship_id, bridge_core_id, below_deck_policy_id, name, priority, is_active, intent_keys, tags, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${LOADOUT_COLS}`,
          [
            userId, fields.shipId, fields.bridgeCoreId ?? null, fields.belowDeckPolicyId ?? null,
            fields.name, fields.priority ?? 0, fields.isActive ?? true,
            JSON.stringify(fields.intentKeys ?? []), JSON.stringify(fields.tags ?? []),
            fields.notes ?? null, now, now,
          ],
        );
        log.fleet.debug({ id: result.rows[0].id, name: fields.name }, "loadout created");
        return result.rows[0] as Loadout;
      });
    },

    async updateLoadout(id: number, fields: {
      name?: string; bridgeCoreId?: number | null; belowDeckPolicyId?: number | null;
      priority?: number; isActive?: boolean; intentKeys?: string[]; tags?: string[]; notes?: string;
    }): Promise<Loadout | null> {
      return scope.write(async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(fields.name); }
        if (fields.bridgeCoreId !== undefined) { setClauses.push(`bridge_core_id = $${idx++}`); params.push(fields.bridgeCoreId); }
        if (fields.belowDeckPolicyId !== undefined) { setClauses.push(`below_deck_policy_id = $${idx++}`); params.push(fields.belowDeckPolicyId); }
        if (fields.priority !== undefined) { setClauses.push(`priority = $${idx++}`); params.push(fields.priority); }
        if (fields.isActive !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(fields.isActive); }
        if (fields.intentKeys !== undefined) { setClauses.push(`intent_keys = $${idx++}`); params.push(JSON.stringify(fields.intentKeys)); }
        if (fields.tags !== undefined) { setClauses.push(`tags = $${idx++}`); params.push(JSON.stringify(fields.tags)); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) {
          const r = await client.query(`SELECT ${LOADOUT_COLS} FROM loadouts WHERE id = $1`, [id]);
          return (r.rows[0] as Loadout) ?? null;
        }
        setClauses.push(`updated_at = $${idx++}`);
        params.push(new Date().toISOString());
        params.push(id);
        const result = await client.query(
          `UPDATE loadouts SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${LOADOUT_COLS}`,
          params,
        );
        return (result.rows[0] as Loadout) ?? null;
      });
    },

    async deleteLoadout(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM loadouts WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Loadout Variants
    // ═══════════════════════════════════════════════════════

    async listVariants(baseLoadoutId: number): Promise<LoadoutVariant[]> {
      return scope.read(async (client) => {
        const result = await client.query(
          `SELECT ${VARIANT_COLS} FROM loadout_variants WHERE base_loadout_id = $1 ORDER BY name`,
          [baseLoadoutId],
        );
        return result.rows as LoadoutVariant[];
      });
    },

    async getVariant(id: number): Promise<LoadoutVariant | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${VARIANT_COLS} FROM loadout_variants WHERE id = $1`, [id]);
        return (result.rows[0] as LoadoutVariant) ?? null;
      });
    },

    async createVariant(baseLoadoutId: number, name: string, patch: VariantPatch, notes?: string): Promise<LoadoutVariant> {
      validatePatch(patch);
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO loadout_variants (user_id, base_loadout_id, name, patch, notes, created_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${VARIANT_COLS}`,
          [userId, baseLoadoutId, name, JSON.stringify(patch), notes ?? null, now],
        );
        log.fleet.debug({ id: result.rows[0].id, name }, "variant created");
        return result.rows[0] as LoadoutVariant;
      });
    },

    async updateVariant(id: number, fields: { name?: string; patch?: VariantPatch; notes?: string }): Promise<LoadoutVariant | null> {
      return scope.write(async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(fields.name); }
        if (fields.patch !== undefined) { validatePatch(fields.patch); setClauses.push(`patch = $${idx++}`); params.push(JSON.stringify(fields.patch)); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) {
          const r = await client.query(`SELECT ${VARIANT_COLS} FROM loadout_variants WHERE id = $1`, [id]);
          return (r.rows[0] as LoadoutVariant) ?? null;
        }
        params.push(id);
        const result = await client.query(
          `UPDATE loadout_variants SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${VARIANT_COLS}`,
          params,
        );
        return (result.rows[0] as LoadoutVariant) ?? null;
      });
    },

    async deleteVariant(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM loadout_variants WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
