/**
 * crew-store.ts — ADR-025 Crew Composition Data Layer (barrel)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed composition model: BridgeCores, BelowDeckPolicies,
 * Loadouts (with variants), Docks, FleetPresets, PlanItems,
 * OfficerReservations.
 *
 * Replaces dock-store.ts (ADR-010) and loadout-store.ts (ADR-022).
 * See ADR-025 for schema rationale and normative merge semantics.
 *
 * Security (#94):
 * - user_id column on every user-scoped table
 * - RLS policies enforce isolation at the database level
 * - Application-level user_id included in all INSERTs (belt-and-suspenders)
 * - CrewStoreFactory produces user-scoped stores via forUser(userId)
 * - intent_catalog stays global (vocabulary layer, shared by design)
 *
 * Pattern: CrewStoreFactory.forUser(userId) → CrewStore.
 *
 * Decomposed into domain modules (#191):
 *   crew-store-schema.ts   — Schema DDL + SQL column fragments
 *   crew-store-helpers.ts  — Shared query helpers (attachMembers, resolveLoadout, …)
 *   crew-store-bridge.ts   — Bridge Core + Below Deck Policy mixin
 *   crew-store-loadout.ts  — Loadout + Variant mixin
 *   crew-store-fleet.ts    — Dock + Preset + Plan Item + Reservation mixin
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";
import type { RequestContext, ScopeProvider } from "../request-context.js";
import { scopeFromContext, scopeFromPool } from "../request-context.js";

import type {
  BridgeSlot,
  BridgeCore,
  BridgeCoreMember,
  BridgeCoreWithMembers,
  BelowDeckMode,
  BelowDeckPolicy,
  BelowDeckPolicySpec,
  Loadout,
  LoadoutWithRefs,
  VariantPatch,
  LoadoutVariant,
  Dock,
  FleetPreset,
  FleetPresetSlot,
  FleetPresetWithSlots,
  PlanItem,
  PlanSource,
  OfficerReservation,
  ResolvedLoadout,
  OfficerConflict,
  EffectiveDockEntry,
  EffectiveAwayTeam,
  EffectiveDockState,
} from "../types/crew-types.js";

import { SCHEMA_STATEMENTS, BDP_COLS, VARIANT_COLS } from "./crew-store-schema.js";
import { resolveLoadout, validatePatch } from "./crew-store-helpers.js";
import { createBridgeMixin } from "./crew-store-bridge.js";
import { createLoadoutMixin } from "./crew-store-loadout.js";
import { createFleetMixin } from "./crew-store-fleet.js";

export type {
  BridgeCore, BridgeCoreMember, BridgeCoreWithMembers,
  BelowDeckPolicy, BelowDeckPolicySpec,
  Loadout, LoadoutWithRefs, LoadoutVariant, VariantPatch,
  Dock, FleetPreset, FleetPresetSlot, FleetPresetWithSlots,
  PlanItem, OfficerReservation,
  ResolvedLoadout, OfficerConflict, EffectiveDockState,
  CrewStore, CrewStoreFactory,
};

// ═══════════════════════════════════════════════════════════
// Store Interface
// ═══════════════════════════════════════════════════════════

interface CrewStore {
  // ── Bridge Cores ──────────────────────────────────────
  listBridgeCores(): Promise<BridgeCoreWithMembers[]>;
  getBridgeCore(id: number): Promise<BridgeCoreWithMembers | null>;
  createBridgeCore(name: string, members: Array<{ officerId: string; slot: BridgeSlot }>, notes?: string): Promise<BridgeCoreWithMembers>;
  updateBridgeCore(id: number, fields: { name?: string; notes?: string }): Promise<BridgeCore | null>;
  deleteBridgeCore(id: number): Promise<boolean>;
  setBridgeCoreMembers(bridgeCoreId: number, members: Array<{ officerId: string; slot: BridgeSlot }>): Promise<BridgeCoreMember[]>;

  // ── Below Deck Policies ───────────────────────────────
  listBelowDeckPolicies(): Promise<BelowDeckPolicy[]>;
  getBelowDeckPolicy(id: number): Promise<BelowDeckPolicy | null>;
  createBelowDeckPolicy(name: string, mode: BelowDeckMode, spec: BelowDeckPolicySpec, notes?: string): Promise<BelowDeckPolicy>;
  updateBelowDeckPolicy(id: number, fields: { name?: string; mode?: BelowDeckMode; spec?: BelowDeckPolicySpec; notes?: string }): Promise<BelowDeckPolicy | null>;
  deleteBelowDeckPolicy(id: number): Promise<boolean>;

  // ── Loadouts ──────────────────────────────────────────
  listLoadouts(filters?: { shipId?: string; intentKey?: string; tag?: string; active?: boolean }): Promise<Loadout[]>;
  getLoadout(id: number): Promise<LoadoutWithRefs | null>;
  getLoadoutsByIds(ids: number[]): Promise<Map<number, LoadoutWithRefs>>;
  createLoadout(fields: {
    shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
    priority?: number; isActive?: boolean; intentKeys?: string[]; tags?: string[]; notes?: string;
  }): Promise<Loadout>;
  updateLoadout(id: number, fields: {
    name?: string; bridgeCoreId?: number | null; belowDeckPolicyId?: number | null;
    priority?: number; isActive?: boolean; intentKeys?: string[]; tags?: string[]; notes?: string;
  }): Promise<Loadout | null>;
  deleteLoadout(id: number): Promise<boolean>;

  // ── Loadout Variants ──────────────────────────────────
  listVariants(baseLoadoutId: number): Promise<LoadoutVariant[]>;
  getVariant(id: number): Promise<LoadoutVariant | null>;
  createVariant(baseLoadoutId: number, name: string, patch: VariantPatch, notes?: string): Promise<LoadoutVariant>;
  updateVariant(id: number, fields: { name?: string; patch?: VariantPatch; notes?: string }): Promise<LoadoutVariant | null>;
  deleteVariant(id: number): Promise<boolean>;

  // ── Docks ─────────────────────────────────────────────
  listDocks(): Promise<Dock[]>;
  getDock(dockNumber: number): Promise<Dock | null>;
  upsertDock(dockNumber: number, fields: { label?: string; unlocked?: boolean; notes?: string }): Promise<Dock>;
  deleteDock(dockNumber: number): Promise<boolean>;

  // ── Fleet Presets ─────────────────────────────────────
  listFleetPresets(): Promise<FleetPresetWithSlots[]>;
  getFleetPreset(id: number): Promise<FleetPresetWithSlots | null>;
  createFleetPreset(name: string, notes?: string): Promise<FleetPreset>;
  updateFleetPreset(id: number, fields: { name?: string; isActive?: boolean; notes?: string }): Promise<FleetPreset | null>;
  deleteFleetPreset(id: number): Promise<boolean>;
  setFleetPresetSlots(presetId: number, slots: Array<{
    dockNumber?: number; loadoutId?: number; variantId?: number;
    awayOfficers?: string[]; label?: string; priority?: number; notes?: string;
  }>): Promise<FleetPresetSlot[]>;

  // ── Plan Items ────────────────────────────────────────
  listPlanItems(filters?: { active?: boolean; dockNumber?: number }): Promise<PlanItem[]>;
  getPlanItem(id: number): Promise<PlanItem | null>;
  createPlanItem(fields: {
    intentKey?: string; label?: string; loadoutId?: number; variantId?: number;
    dockNumber?: number; awayOfficers?: string[]; priority?: number;
    isActive?: boolean; source?: PlanSource; notes?: string;
  }): Promise<PlanItem>;
  updatePlanItem(id: number, fields: {
    intentKey?: string | null; label?: string; loadoutId?: number | null;
    variantId?: number | null; dockNumber?: number | null; awayOfficers?: string[] | null;
    priority?: number; isActive?: boolean; source?: PlanSource; notes?: string;
  }): Promise<PlanItem | null>;
  deletePlanItem(id: number): Promise<boolean>;

  // ── Officer Reservations ──────────────────────────────
  listReservations(): Promise<OfficerReservation[]>;
  getReservation(officerId: string): Promise<OfficerReservation | null>;
  setReservation(officerId: string, reservedFor: string, locked?: boolean, notes?: string): Promise<OfficerReservation>;
  deleteReservation(officerId: string): Promise<boolean>;

  // ── Composition Functions (D6) ────────────────────────
  resolveVariant(baseLoadoutId: number, variantId: number): Promise<ResolvedLoadout>;
  getEffectiveDockState(): Promise<EffectiveDockState>;

  // ── Counts ────────────────────────────────────────────
  counts(): Promise<{ bridgeCores: number; loadouts: number; planItems: number; docks: number }>;

  // ── Lifecycle ─────────────────────────────────────────
  close(): void;
}

// ═══════════════════════════════════════════════════════════
// Implementation — compose domain mixins + composition fns
// ═══════════════════════════════════════════════════════════

function createScopedCrewStore(scope: ScopeProvider, userId: string): CrewStore {
  // Self-scoping wrapper for resolveLoadout (used by getEffectiveDockState)
  function resolveLoadoutScoped(loadoutId: number): Promise<ResolvedLoadout | null> {
    return scope.read(async (client) => resolveLoadout(client, loadoutId));
  }

  const store: CrewStore = {
    // ── Domain mixins ───────────────────────────────────
    ...createBridgeMixin(scope, userId),
    ...createLoadoutMixin(scope, userId),
    ...createFleetMixin(scope, userId),

    // ═══════════════════════════════════════════════════════
    // Composition Functions (ADR-025 § D6)
    // ═══════════════════════════════════════════════════════

    async resolveVariant(baseLoadoutId, variantId) {
      return scope.read(async (client) => {
        const base = await resolveLoadout(client, baseLoadoutId);
        if (!base) throw new Error(`Base loadout ${baseLoadoutId} not found`);

        const variantResult = await client.query(
          `SELECT ${VARIANT_COLS} FROM loadout_variants WHERE id = $1`, [variantId],
        );
        const variant = variantResult.rows[0] as LoadoutVariant | undefined;
        if (!variant) throw new Error(`Variant ${variantId} not found`);
        if (variant.baseLoadoutId !== baseLoadoutId) {
          throw new Error(`Variant ${variantId} does not belong to loadout ${baseLoadoutId}`);
        }

        const patch = variant.patch;
        validatePatch(patch);

        const effective = { ...base };

        // 2a. bridge overrides
        if (patch.bridge) {
          effective.bridge = { ...base.bridge };
          for (const [slot, officerId] of Object.entries(patch.bridge)) {
            if (officerId !== undefined) {
              effective.bridge[slot as BridgeSlot] = officerId;
            }
          }
        }

        // 2b. below_deck_policy_id — full replacement
        if (patch.below_deck_policy_id !== undefined) {
          const bdpResult = await client.query(
            `SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`, [patch.below_deck_policy_id],
          );
          const bdp = (bdpResult.rows[0] as BelowDeckPolicy) ?? null;
          if (!bdp) throw new Error(`Below deck policy ${patch.below_deck_policy_id} not found`);
          effective.belowDeckPolicy = bdp;
        }

        // 2c. below_deck_patch — set-diff on pinned array
        if (patch.below_deck_patch && effective.belowDeckPolicy) {
          const currentPinned = new Set(effective.belowDeckPolicy.spec.pinned ?? []);
          if (patch.below_deck_patch.pinned_add) {
            for (const id of patch.below_deck_patch.pinned_add) currentPinned.add(id);
          }
          if (patch.below_deck_patch.pinned_remove) {
            for (const id of patch.below_deck_patch.pinned_remove) currentPinned.delete(id);
          }
          effective.belowDeckPolicy = {
            ...effective.belowDeckPolicy,
            spec: { ...effective.belowDeckPolicy.spec, pinned: [...currentPinned] },
          };
        }

        // 2d. intent_keys — full replacement
        if (patch.intent_keys) {
          effective.intentKeys = patch.intent_keys;
        }

        return effective;
      });
    },

    async getEffectiveDockState() {
      // 1. Get all active plan items, ordered by priority
      const planItems = await store.listPlanItems({ active: true });

      // 2. Build dock entries and away teams
      const dockEntries: EffectiveDockEntry[] = [];
      const awayTeams: EffectiveAwayTeam[] = [];

      for (const item of planItems) {
        if (item.awayOfficers) {
          // Away team plan item
          awayTeams.push({
            label: item.label,
            officers: item.awayOfficers,
            source: item.source as PlanSource,
          });
          continue;
        }

        if (item.dockNumber === null) continue;

        // Resolve the loadout (with optional variant)
        let loadout: ResolvedLoadout | null = null;
        let variantPatch: VariantPatch | null = null;

        if (item.variantId) {
          const variant = await store.getVariant(item.variantId);
          if (variant) {
            loadout = await store.resolveVariant(variant.baseLoadoutId, item.variantId);
            variantPatch = variant.patch;
          }
        } else if (item.loadoutId) {
          loadout = await resolveLoadoutScoped(item.loadoutId);
        }

        dockEntries.push({
          dockNumber: item.dockNumber,
          loadout,
          variantPatch,
          intentKeys: item.intentKey ? [item.intentKey] : (loadout?.intentKeys ?? []),
          source: item.source as PlanSource,
        });
      }

      // 3. Detect officer conflicts
      const officerLocations = new Map<string, OfficerConflict["locations"]>();

      for (const entry of dockEntries) {
        if (!entry.loadout) continue;
        const bridge = entry.loadout.bridge;
        for (const [slot, officerId] of Object.entries(bridge)) {
          if (!officerId) continue;
          const locs = officerLocations.get(officerId) ?? [];
          locs.push({
            type: "bridge",
            entityId: entry.loadout.loadoutId,
            entityName: entry.loadout.name,
            slot,
          });
          officerLocations.set(officerId, locs);
        }
      }

      for (const team of awayTeams) {
        for (const officerId of team.officers) {
          const locs = officerLocations.get(officerId) ?? [];
          locs.push({
            type: "plan_item",
            entityId: 0,
            entityName: team.label ?? "Away Team",
          });
          officerLocations.set(officerId, locs);
        }
      }

      const conflicts: OfficerConflict[] = [];
      for (const [officerId, locations] of officerLocations) {
        if (locations.length > 1) {
          conflicts.push({ officerId, locations });
        }
      }

      return { docks: dockEntries, awayTeams, conflicts };
    },

    // ── Counts ──────────────────────────────────────────────
    async counts() {
      return scope.read(async (client) => {
        const result = await client.query(
          `SELECT
             (SELECT COUNT(*) FROM bridge_cores)::int AS "bridgeCores",
             (SELECT COUNT(*) FROM loadouts)::int AS "loadouts",
             (SELECT COUNT(*) FROM plan_items)::int AS "planItems",
             (SELECT COUNT(*) FROM docks)::int AS "docks"`,
        );
        return result.rows[0] as { bridgeCores: number; loadouts: number; planItems: number; docks: number };
      });
    },

    // ── Lifecycle ───────────────────────────────────────────
    close() {
      // Pool lifecycle managed by caller
    },
  };

  return store;
}

// ═══════════════════════════════════════════════════════════
// Factory (ADR-025 + #94)
// ═══════════════════════════════════════════════════════════

class CrewStoreFactory {
  constructor(private pool: Pool) {}
  forUser(userId: string): CrewStore {
    return createScopedCrewStore(scopeFromPool(this.pool, userId), userId);
  }
  forContext(ctx: RequestContext): CrewStore {
    return createScopedCrewStore(scopeFromContext(ctx), ctx.identity.userId);
  }
}

/** Initialise schema and return a factory that produces user-scoped stores. */
export async function createCrewStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<CrewStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  log.boot.debug("crew store initialized (ADR-025, user-scoped)");
  return new CrewStoreFactory(runtimePool ?? adminPool);
}

/** Backward-compatible helper — creates a factory and returns a "local" user store. */
export async function createCrewStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<CrewStore> {
  const factory = await createCrewStoreFactory(adminPool, runtimePool);
  return factory.forUser("local");
}
