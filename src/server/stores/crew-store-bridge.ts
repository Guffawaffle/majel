/**
 * crew-store-bridge.ts — Bridge Core + Below Deck Policy query families
 *
 * Extracted from crew-store.ts (ADR-025) for #191 store decomposition.
 */

import { log } from "../logger.js";
import type { ScopeProvider } from "../request-context.js";
import type {
  BridgeSlot,
  BridgeCore,
  BridgeCoreMember,
  BridgeCoreWithMembers,
  BelowDeckMode,
  BelowDeckPolicy,
  BelowDeckPolicySpec,
} from "../types/crew-types.js";
import { BC_COLS, BCM_COLS, BDP_COLS } from "./crew-store-schema.js";
import { attachMembers } from "./crew-store-helpers.js";

export function createBridgeMixin(scope: ScopeProvider, userId: string) {
  return {
    // ═══════════════════════════════════════════════════════
    // Bridge Cores
    // ═══════════════════════════════════════════════════════

    async listBridgeCores(): Promise<BridgeCoreWithMembers[]> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${BC_COLS} FROM bridge_cores ORDER BY name LIMIT 500`);
        return attachMembers(client, result.rows as BridgeCore[]);
      });
    },

    async getBridgeCore(id: number): Promise<BridgeCoreWithMembers | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${BC_COLS} FROM bridge_cores WHERE id = $1`, [id]);
        const cores = await attachMembers(client, result.rows as BridgeCore[]);
        return cores[0] ?? null;
      });
    },

    async createBridgeCore(name: string, members: Array<{ officerId: string; slot: BridgeSlot }>, notes?: string): Promise<BridgeCoreWithMembers> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const coreResult = await client.query(
          `INSERT INTO bridge_cores (user_id, name, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING ${BC_COLS}`,
          [userId, name, notes ?? null, now, now],
        );
        const core = coreResult.rows[0] as BridgeCore;

        const memberRows: BridgeCoreMember[] = [];
        for (const m of members) {
          const memberResult = await client.query(
            `INSERT INTO bridge_core_members (user_id, bridge_core_id, officer_id, slot) VALUES ($1, $2, $3, $4) RETURNING ${BCM_COLS}`,
            [userId, core.id, m.officerId, m.slot],
          );
          memberRows.push(memberResult.rows[0] as BridgeCoreMember);
        }

        log.fleet.debug({ id: core.id, name }, "bridge core created");
        return { ...core, members: memberRows };
      });
    },

    async updateBridgeCore(id: number, fields: { name?: string; notes?: string }): Promise<BridgeCore | null> {
      return scope.write(async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(fields.name); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) {
          const r = await client.query(`SELECT ${BC_COLS} FROM bridge_cores WHERE id = $1`, [id]);
          return (r.rows[0] as BridgeCore) ?? null;
        }
        setClauses.push(`updated_at = $${idx++}`);
        params.push(new Date().toISOString());
        params.push(id);
        const result = await client.query(
          `UPDATE bridge_cores SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${BC_COLS}`,
          params,
        );
        return (result.rows[0] as BridgeCore) ?? null;
      });
    },

    async deleteBridgeCore(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM bridge_cores WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async setBridgeCoreMembers(bridgeCoreId: number, members: Array<{ officerId: string; slot: BridgeSlot }>): Promise<BridgeCoreMember[]> {
      return scope.write(async (client) => {
        await client.query(`DELETE FROM bridge_core_members WHERE bridge_core_id = $1`, [bridgeCoreId]);
        const rows: BridgeCoreMember[] = [];
        for (const m of members) {
          const result = await client.query(
            `INSERT INTO bridge_core_members (user_id, bridge_core_id, officer_id, slot) VALUES ($1, $2, $3, $4) RETURNING ${BCM_COLS}`,
            [userId, bridgeCoreId, m.officerId, m.slot],
          );
          rows.push(result.rows[0] as BridgeCoreMember);
        }
        await client.query(
          `UPDATE bridge_cores SET updated_at = $1 WHERE id = $2`,
          [new Date().toISOString(), bridgeCoreId],
        );
        return rows;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Below Deck Policies
    // ═══════════════════════════════════════════════════════

    async listBelowDeckPolicies(): Promise<BelowDeckPolicy[]> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies ORDER BY name LIMIT 500`);
        return result.rows as BelowDeckPolicy[];
      });
    },

    async getBelowDeckPolicy(id: number): Promise<BelowDeckPolicy | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`, [id]);
        return (result.rows[0] as BelowDeckPolicy) ?? null;
      });
    },

    async createBelowDeckPolicy(name: string, mode: BelowDeckMode, spec: BelowDeckPolicySpec, notes?: string): Promise<BelowDeckPolicy> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO below_deck_policies (user_id, name, mode, spec, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${BDP_COLS}`,
          [userId, name, mode, JSON.stringify(spec), notes ?? null, now, now],
        );
        log.fleet.debug({ id: result.rows[0].id, name }, "below deck policy created");
        return result.rows[0] as BelowDeckPolicy;
      });
    },

    async updateBelowDeckPolicy(id: number, fields: { name?: string; mode?: BelowDeckMode; spec?: BelowDeckPolicySpec; notes?: string }): Promise<BelowDeckPolicy | null> {
      return scope.write(async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(fields.name); }
        if (fields.mode !== undefined) { setClauses.push(`mode = $${idx++}`); params.push(fields.mode); }
        if (fields.spec !== undefined) { setClauses.push(`spec = $${idx++}`); params.push(JSON.stringify(fields.spec)); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) {
          const r = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`, [id]);
          return (r.rows[0] as BelowDeckPolicy) ?? null;
        }
        setClauses.push(`updated_at = $${idx++}`);
        params.push(new Date().toISOString());
        params.push(id);
        const result = await client.query(
          `UPDATE below_deck_policies SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${BDP_COLS}`,
          params,
        );
        return (result.rows[0] as BelowDeckPolicy) ?? null;
      });
    },

    async deleteBelowDeckPolicy(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM below_deck_policies WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
