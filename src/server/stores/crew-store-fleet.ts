/**
 * crew-store-fleet.ts — Dock, Fleet Preset, Plan Item, Officer Reservation query families
 *
 * Extracted from crew-store.ts (ADR-025) for #191 store decomposition.
 */

import { log } from "../logger.js";
import type { ScopeProvider } from "../request-context.js";
import type {
  Dock,
  FleetPreset,
  FleetPresetSlot,
  FleetPresetWithSlots,
  PlanItem,
  PlanSource,
  OfficerReservation,
} from "../types/crew-types.js";
import { DOCK_COLS, FP_COLS, FPS_COLS, PI_COLS, RES_COLS } from "./crew-store-schema.js";
import { attachSlots } from "./crew-store-helpers.js";

export function createFleetMixin(scope: ScopeProvider, userId: string) {
  return {
    // ═══════════════════════════════════════════════════════
    // Docks
    // ═══════════════════════════════════════════════════════

    async listDocks(): Promise<Dock[]> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${DOCK_COLS} FROM docks ORDER BY dock_number`);
        return result.rows as Dock[];
      });
    },

    async getDock(dockNumber: number): Promise<Dock | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${DOCK_COLS} FROM docks WHERE dock_number = $1`, [dockNumber]);
        return (result.rows[0] as Dock) ?? null;
      });
    },

    async upsertDock(dockNumber: number, fields: { label?: string; unlocked?: boolean; notes?: string }): Promise<Dock> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO docks (user_id, dock_number, label, unlocked, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, dock_number) DO UPDATE SET
             label = COALESCE($3, docks.label),
             unlocked = COALESCE($4, docks.unlocked),
             notes = COALESCE($5, docks.notes),
             updated_at = $7
           RETURNING ${DOCK_COLS}`,
          [userId, dockNumber, fields.label ?? null, fields.unlocked ?? true, fields.notes ?? null, now, now],
        );
        return result.rows[0] as Dock;
      });
    },

    async deleteDock(dockNumber: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM docks WHERE dock_number = $1`, [dockNumber]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Fleet Presets
    // ═══════════════════════════════════════════════════════

    async listFleetPresets(): Promise<FleetPresetWithSlots[]> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${FP_COLS} FROM fleet_presets ORDER BY name`);
        return attachSlots(client, result.rows as FleetPreset[]);
      });
    },

    async getFleetPreset(id: number): Promise<FleetPresetWithSlots | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${FP_COLS} FROM fleet_presets WHERE id = $1`, [id]);
        const presets = await attachSlots(client, result.rows as FleetPreset[]);
        return presets[0] ?? null;
      });
    },

    async createFleetPreset(name: string, notes?: string): Promise<FleetPreset> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO fleet_presets (user_id, name, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING ${FP_COLS}`,
          [userId, name, notes ?? null, now, now],
        );
        log.fleet.debug({ id: result.rows[0].id, name }, "fleet preset created");
        return result.rows[0] as FleetPreset;
      });
    },

    async updateFleetPreset(id: number, fields: { name?: string; isActive?: boolean; notes?: string }): Promise<FleetPreset | null> {
      return scope.write(async (client) => {
        // If activating this preset, deactivate all others
        if (fields.isActive === true) {
          await client.query(`UPDATE fleet_presets SET is_active = FALSE WHERE is_active = TRUE AND id != $1`, [id]);
        }
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(fields.name); }
        if (fields.isActive !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(fields.isActive); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) return (await client.query(`SELECT ${FP_COLS} FROM fleet_presets WHERE id = $1`, [id])).rows[0] as FleetPreset ?? null;
        setClauses.push(`updated_at = $${idx++}`);
        params.push(new Date().toISOString());
        params.push(id);
        const result = await client.query(
          `UPDATE fleet_presets SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${FP_COLS}`,
          params,
        );
        return (result.rows[0] as FleetPreset) ?? null;
      });
    },

    async deleteFleetPreset(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM fleet_presets WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async setFleetPresetSlots(presetId: number, slots: Array<{
      dockNumber?: number; loadoutId?: number; variantId?: number;
      awayOfficers?: string[]; label?: string; priority?: number; notes?: string;
    }>): Promise<FleetPresetSlot[]> {
      return scope.write(async (client) => {
        await client.query(`DELETE FROM fleet_preset_slots WHERE preset_id = $1`, [presetId]);
        const rows: FleetPresetSlot[] = [];
        for (const s of slots) {
          const result = await client.query(
            `INSERT INTO fleet_preset_slots (user_id, preset_id, dock_number, loadout_id, variant_id, away_officers, label, priority, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${FPS_COLS}`,
            [
              userId, presetId, s.dockNumber ?? null, s.loadoutId ?? null, s.variantId ?? null,
              s.awayOfficers ? JSON.stringify(s.awayOfficers) : null,
              s.label ?? null, s.priority ?? 0, s.notes ?? null,
            ],
          );
          rows.push(result.rows[0] as FleetPresetSlot);
        }
        await client.query(
          `UPDATE fleet_presets SET updated_at = $1 WHERE id = $2`,
          [new Date().toISOString(), presetId],
        );
        return rows;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Plan Items
    // ═══════════════════════════════════════════════════════

    async listPlanItems(filters?: { active?: boolean; dockNumber?: number }): Promise<PlanItem[]> {
      return scope.read(async (client) => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (filters?.active !== undefined) { clauses.push(`is_active = $${idx++}`); params.push(filters.active); }
        if (filters?.dockNumber !== undefined) { clauses.push(`dock_number = $${idx++}`); params.push(filters.dockNumber); }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const result = await client.query(
          `SELECT ${PI_COLS} FROM plan_items ${where} ORDER BY priority, id`,
          params,
        );
        return result.rows as PlanItem[];
      });
    },

    async getPlanItem(id: number): Promise<PlanItem | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${PI_COLS} FROM plan_items WHERE id = $1`, [id]);
        return (result.rows[0] as PlanItem) ?? null;
      });
    },

    async createPlanItem(fields: {
      intentKey?: string; label?: string; loadoutId?: number; variantId?: number;
      dockNumber?: number; awayOfficers?: string[]; priority?: number;
      isActive?: boolean; source?: PlanSource; notes?: string;
    }): Promise<PlanItem> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO plan_items (user_id, intent_key, label, loadout_id, variant_id, dock_number, away_officers, priority, is_active, source, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PI_COLS}`,
          [
            userId,
            fields.intentKey ?? null, fields.label ?? null,
            fields.loadoutId ?? null, fields.variantId ?? null,
            fields.dockNumber ?? null,
            fields.awayOfficers ? JSON.stringify(fields.awayOfficers) : null,
            fields.priority ?? 0, fields.isActive ?? true,
            fields.source ?? "manual", fields.notes ?? null,
            now, now,
          ],
        );
        return result.rows[0] as PlanItem;
      });
    },

    async updatePlanItem(id: number, fields: {
      intentKey?: string | null; label?: string; loadoutId?: number | null;
      variantId?: number | null; dockNumber?: number | null; awayOfficers?: string[] | null;
      priority?: number; isActive?: boolean; source?: PlanSource; notes?: string;
    }): Promise<PlanItem | null> {
      return scope.write(async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (fields.intentKey !== undefined) { setClauses.push(`intent_key = $${idx++}`); params.push(fields.intentKey); }
        if (fields.label !== undefined) { setClauses.push(`label = $${idx++}`); params.push(fields.label); }
        if (fields.loadoutId !== undefined) { setClauses.push(`loadout_id = $${idx++}`); params.push(fields.loadoutId); }
        if (fields.variantId !== undefined) { setClauses.push(`variant_id = $${idx++}`); params.push(fields.variantId); }
        if (fields.dockNumber !== undefined) { setClauses.push(`dock_number = $${idx++}`); params.push(fields.dockNumber); }
        if (fields.awayOfficers !== undefined) {
          setClauses.push(`away_officers = $${idx++}`);
          params.push(fields.awayOfficers ? JSON.stringify(fields.awayOfficers) : null);
        }
        if (fields.priority !== undefined) { setClauses.push(`priority = $${idx++}`); params.push(fields.priority); }
        if (fields.isActive !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(fields.isActive); }
        if (fields.source !== undefined) { setClauses.push(`source = $${idx++}`); params.push(fields.source); }
        if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); params.push(fields.notes); }
        if (setClauses.length === 0) {
          const r = await client.query(`SELECT ${PI_COLS} FROM plan_items WHERE id = $1`, [id]);
          return (r.rows[0] as PlanItem) ?? null;
        }
        setClauses.push(`updated_at = $${idx++}`);
        params.push(new Date().toISOString());
        params.push(id);
        const result = await client.query(
          `UPDATE plan_items SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING ${PI_COLS}`,
          params,
        );
        return (result.rows[0] as PlanItem) ?? null;
      });
    },

    async deletePlanItem(id: number): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM plan_items WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Officer Reservations
    // ═══════════════════════════════════════════════════════

    async listReservations(): Promise<OfficerReservation[]> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${RES_COLS} FROM officer_reservations ORDER BY officer_id`);
        return result.rows as OfficerReservation[];
      });
    },

    async getReservation(officerId: string): Promise<OfficerReservation | null> {
      return scope.read(async (client) => {
        const result = await client.query(`SELECT ${RES_COLS} FROM officer_reservations WHERE officer_id = $1`, [officerId]);
        return (result.rows[0] as OfficerReservation) ?? null;
      });
    },

    async setReservation(officerId: string, reservedFor: string, locked?: boolean, notes?: string): Promise<OfficerReservation> {
      return scope.write(async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO officer_reservations (user_id, officer_id, reserved_for, locked, notes, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, officer_id) DO UPDATE SET
             reserved_for = $3, locked = $4, notes = $5
           RETURNING ${RES_COLS}`,
          [userId, officerId, reservedFor, locked ?? false, notes ?? null, now],
        );
        return result.rows[0] as OfficerReservation;
      });
    },

    async deleteReservation(officerId: string): Promise<boolean> {
      return scope.write(async (client) => {
        const result = await client.query(`DELETE FROM officer_reservations WHERE officer_id = $1`, [officerId]);
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
