/**
 * crew-store.ts — ADR-025 Crew Composition Data Layer
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
 */

import { initSchema, withUserScope, withUserRead, type Pool, type PoolClient } from "../db.js";
import { log } from "../logger.js";

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

import { VALID_BRIDGE_SLOTS } from "../types/crew-types.js";

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
// Schema DDL
// ═══════════════════════════════════════════════════════════

const MIGRATION_STATEMENTS = [
  // Drop ADR-010 tables (dock-store.ts legacy)
  `DROP TABLE IF EXISTS preset_tags CASCADE`,
  `DROP TABLE IF EXISTS crew_preset_members CASCADE`,
  `DROP TABLE IF EXISTS crew_presets CASCADE`,
  `DROP TABLE IF EXISTS dock_ships CASCADE`,
  `DROP TABLE IF EXISTS dock_intents CASCADE`,
  `DROP TABLE IF EXISTS drydock_loadouts CASCADE`,

  // Drop ADR-022 tables (loadout-store.ts)
  `DROP TABLE IF EXISTS plan_away_members CASCADE`,
  `DROP TABLE IF EXISTS loadout_members CASCADE`,

  // Drop ADR-025 v1 tables (recreated with user_id + RLS in v2, #94)
  `DROP TABLE IF EXISTS fleet_preset_slots CASCADE`,
  `DROP TABLE IF EXISTS plan_items CASCADE`,
  `DROP TABLE IF EXISTS officer_reservations CASCADE`,
  `DROP TABLE IF EXISTS loadout_variants CASCADE`,
  `DROP TABLE IF EXISTS bridge_core_members CASCADE`,
  `DROP TABLE IF EXISTS loadouts CASCADE`,
  `DROP TABLE IF EXISTS fleet_presets CASCADE`,
  `DROP TABLE IF EXISTS docks CASCADE`,
  `DROP TABLE IF EXISTS below_deck_policies CASCADE`,
  `DROP TABLE IF EXISTS bridge_cores CASCADE`,
];

const SCHEMA_STATEMENTS = [
  // ── Intent Catalog (global vocabulary layer, no user_id) ──
  `CREATE TABLE IF NOT EXISTS intent_catalog (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    is_builtin BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── L2a: Bridge Cores ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS bridge_cores (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS bridge_core_members (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    bridge_core_id INTEGER NOT NULL REFERENCES bridge_cores(id) ON DELETE CASCADE,
    officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
    slot TEXT NOT NULL CHECK (slot IN ('captain', 'bridge_1', 'bridge_2')),
    UNIQUE(bridge_core_id, slot),
    UNIQUE(bridge_core_id, officer_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_bcm_officer ON bridge_core_members(officer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bcm_core ON bridge_core_members(bridge_core_id)`,

  // ── L2b: Below Deck Policies ──────────────────────────
  `CREATE TABLE IF NOT EXISTS below_deck_policies (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'stats_then_bda'
      CHECK (mode IN ('stats_then_bda', 'pinned_only', 'stat_fill_only')),
    spec_version INTEGER NOT NULL DEFAULT 1,
    spec JSONB NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`,

  // ── L2c: Loadouts ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS loadouts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    bridge_core_id INTEGER REFERENCES bridge_cores(id) ON DELETE SET NULL,
    below_deck_policy_id INTEGER REFERENCES below_deck_policies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    intent_keys JSONB NOT NULL DEFAULT '[]',
    tags JSONB NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, ship_id, name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_loadouts_ship ON loadouts(ship_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_bridge ON loadouts(bridge_core_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_bdp ON loadouts(below_deck_policy_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_intent ON loadouts USING GIN (intent_keys)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_tags ON loadouts USING GIN (tags)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_priority ON loadouts(priority DESC)`,

  // ── L2d: Loadout Variants ────────────────────────────
  `CREATE TABLE IF NOT EXISTS loadout_variants (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    base_loadout_id INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    patch JSONB NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, base_loadout_id, name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_variants_base ON loadout_variants(base_loadout_id)`,

  // ── L3a: Docks ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS docks (
    user_id TEXT NOT NULL DEFAULT 'local',
    dock_number INTEGER NOT NULL CHECK (dock_number >= 1),
    label TEXT,
    unlocked BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, dock_number)
  )`,

  // ── L3b: Fleet Presets ───────────────────────────────
  `CREATE TABLE IF NOT EXISTS fleet_presets (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS fleet_preset_slots (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    preset_id INTEGER NOT NULL REFERENCES fleet_presets(id) ON DELETE CASCADE,
    dock_number INTEGER,
    loadout_id INTEGER REFERENCES loadouts(id) ON DELETE CASCADE,
    variant_id INTEGER REFERENCES loadout_variants(id) ON DELETE CASCADE,
    away_officers JSONB,
    label TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    CHECK (
      (loadout_id IS NOT NULL AND variant_id IS NULL AND away_officers IS NULL) OR
      (loadout_id IS NULL AND variant_id IS NOT NULL AND away_officers IS NULL) OR
      (loadout_id IS NULL AND variant_id IS NULL AND away_officers IS NOT NULL)
    ),
    UNIQUE(preset_id, dock_number),
    FOREIGN KEY (user_id, dock_number) REFERENCES docks(user_id, dock_number) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_fps_preset ON fleet_preset_slots(preset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fps_loadout ON fleet_preset_slots(loadout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fps_variant ON fleet_preset_slots(variant_id)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_preset_one_active
    ON fleet_presets (user_id) WHERE is_active = TRUE`,

  // ── L3c: Plan Items ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS plan_items (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    intent_key TEXT REFERENCES intent_catalog(key) ON DELETE SET NULL,
    label TEXT,
    loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL,
    variant_id INTEGER REFERENCES loadout_variants(id) ON DELETE SET NULL,
    dock_number INTEGER,
    away_officers JSONB,
    priority INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    source TEXT NOT NULL DEFAULT 'manual'
      CHECK (source IN ('manual', 'preset')),
    notes TEXT,
    CHECK (
      (loadout_id IS NOT NULL AND variant_id IS NULL AND away_officers IS NULL) OR
      (loadout_id IS NULL AND variant_id IS NOT NULL AND away_officers IS NULL) OR
      (loadout_id IS NULL AND variant_id IS NULL AND away_officers IS NOT NULL)
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plan_items_loadout ON plan_items(loadout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_variant ON plan_items(variant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_dock ON plan_items(dock_number)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_intent ON plan_items(intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_active ON plan_items(is_active) WHERE is_active = TRUE`,

  // ── L2e: Officer Reservations ────────────────────────
  `CREATE TABLE IF NOT EXISTS officer_reservations (
    user_id TEXT NOT NULL DEFAULT 'local',
    officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
    reserved_for TEXT NOT NULL,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, officer_id)
  )`,

  // ── User-id indexes ──────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_bridge_cores_user ON bridge_cores(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bcm_user ON bridge_core_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bdp_user ON below_deck_policies(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_user ON loadouts(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_variants_user ON loadout_variants(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_docks_user ON docks(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fps_user ON fleet_presets(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fps_slots_user ON fleet_preset_slots(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_user ON plan_items(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reservations_user ON officer_reservations(user_id)`,

  // ── RLS policies (#94) ──────────────────────────────
  ...["bridge_cores", "bridge_core_members", "below_deck_policies",
    "loadouts", "loadout_variants", "docks", "fleet_presets",
    "fleet_preset_slots", "plan_items", "officer_reservations",
  ].flatMap(t => [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = '${t}' AND policyname = '${t}_user_isolation'
      ) THEN
        CREATE POLICY ${t}_user_isolation ON ${t}
          USING (user_id = current_setting('app.current_user_id', true))
          WITH CHECK (user_id = current_setting('app.current_user_id', true));
      END IF;
    END $$`,
  ]),
];

// ═══════════════════════════════════════════════════════════
// SQL Fragments
// ═══════════════════════════════════════════════════════════

const BC_COLS = `id, name, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
const BCM_COLS = `id, bridge_core_id AS "bridgeCoreId", officer_id AS "officerId", slot`;
const BDP_COLS = `id, name, mode, spec_version AS "specVersion", spec, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
const LOADOUT_COLS = `id, ship_id AS "shipId", bridge_core_id AS "bridgeCoreId",
  below_deck_policy_id AS "belowDeckPolicyId", name, priority, is_active AS "isActive",
  intent_keys AS "intentKeys", tags, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const VARIANT_COLS = `id, base_loadout_id AS "baseLoadoutId", name, patch, notes, created_at AS "createdAt"`;
const DOCK_COLS = `dock_number AS "dockNumber", label, unlocked, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
const FP_COLS = `id, name, is_active AS "isActive", notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
const FPS_COLS = `id, preset_id AS "presetId", dock_number AS "dockNumber",
  loadout_id AS "loadoutId", variant_id AS "variantId", away_officers AS "awayOfficers",
  label, priority, notes`;
const PI_COLS = `id, intent_key AS "intentKey", label, loadout_id AS "loadoutId",
  variant_id AS "variantId", dock_number AS "dockNumber", away_officers AS "awayOfficers",
  priority, is_active AS "isActive", source, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const RES_COLS = `officer_id AS "officerId", reserved_for AS "reservedFor", locked, notes, created_at AS "createdAt"`;

// ═══════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════

function createScopedCrewStore(pool: Pool, userId: string): CrewStore {

  // ── Helper: attach members to bridge cores ────────────
  async function attachMembers(client: PoolClient, cores: BridgeCore[]): Promise<BridgeCoreWithMembers[]> {
    if (cores.length === 0) return [];
    const ids = cores.map((c) => c.id);
    const membersResult = await client.query(
      `SELECT ${BCM_COLS} FROM bridge_core_members WHERE bridge_core_id = ANY($1) ORDER BY slot`,
      [ids],
    );
    const membersByCore = new Map<number, BridgeCoreMember[]>();
    for (const m of membersResult.rows as BridgeCoreMember[]) {
      const arr = membersByCore.get(m.bridgeCoreId) ?? [];
      arr.push(m);
      membersByCore.set(m.bridgeCoreId, arr);
    }
    return cores.map((c) => ({ ...c, members: membersByCore.get(c.id) ?? [] }));
  }

  // ── Helper: attach slots to fleet presets ─────────────
  async function attachSlots(client: PoolClient, presets: FleetPreset[]): Promise<FleetPresetWithSlots[]> {
    if (presets.length === 0) return [];
    const ids = presets.map((p) => p.id);
    const slotsResult = await client.query(
      `SELECT ${FPS_COLS} FROM fleet_preset_slots WHERE preset_id = ANY($1) ORDER BY priority`,
      [ids],
    );
    const slotsByPreset = new Map<number, FleetPresetSlot[]>();
    for (const s of slotsResult.rows as FleetPresetSlot[]) {
      const arr = slotsByPreset.get(s.presetId) ?? [];
      arr.push(s);
      slotsByPreset.set(s.presetId, arr);
    }
    return presets.map((p) => ({ ...p, slots: slotsByPreset.get(p.id) ?? [] }));
  }

  // ── Helper: resolve a loadout into a ResolvedLoadout ──
  async function resolveLoadout(client: PoolClient, loadoutId: number): Promise<ResolvedLoadout | null> {
    const loadoutResult = await client.query(
      `SELECT ${LOADOUT_COLS} FROM loadouts WHERE id = $1`, [loadoutId],
    );
    const loadout = loadoutResult.rows[0] as Loadout | undefined;
    if (!loadout) return null;

    const bridge = { captain: null as string | null, bridge_1: null as string | null, bridge_2: null as string | null };
    if (loadout.bridgeCoreId) {
      const membersResult = await client.query(
        `SELECT ${BCM_COLS} FROM bridge_core_members WHERE bridge_core_id = $1`,
        [loadout.bridgeCoreId],
      );
      for (const m of membersResult.rows as BridgeCoreMember[]) {
        bridge[m.slot] = m.officerId;
      }
    }

    let belowDeckPolicy: BelowDeckPolicy | null = null;
    if (loadout.belowDeckPolicyId) {
      const bdpResult = await client.query(
        `SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`,
        [loadout.belowDeckPolicyId],
      );
      belowDeckPolicy = (bdpResult.rows[0] as BelowDeckPolicy) ?? null;
    }

    return {
      loadoutId: loadout.id,
      shipId: loadout.shipId,
      name: loadout.name,
      bridge,
      belowDeckPolicy,
      intentKeys: loadout.intentKeys ?? [],
      tags: loadout.tags ?? [],
      notes: loadout.notes,
    };
  }

  // ── Self-scoping wrapper for resolveLoadout ───────────
  async function resolveLoadoutScoped(loadoutId: number): Promise<ResolvedLoadout | null> {
    return withUserRead(pool, userId, async (client) => resolveLoadout(client, loadoutId));
  }

  const store: CrewStore = {
    // ═══════════════════════════════════════════════════════
    // Bridge Cores
    // ═══════════════════════════════════════════════════════

    async listBridgeCores() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${BC_COLS} FROM bridge_cores ORDER BY name`);
        return attachMembers(client, result.rows as BridgeCore[]);
      });
    },

    async getBridgeCore(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${BC_COLS} FROM bridge_cores WHERE id = $1`, [id]);
        const cores = await attachMembers(client, result.rows as BridgeCore[]);
        return cores[0] ?? null;
      });
    },

    async createBridgeCore(name, members, notes) {
      return withUserScope(pool, userId, async (client) => {
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

    async updateBridgeCore(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteBridgeCore(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM bridge_cores WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async setBridgeCoreMembers(bridgeCoreId, members) {
      return withUserScope(pool, userId, async (client) => {
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

    async listBelowDeckPolicies() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies ORDER BY name`);
        return result.rows as BelowDeckPolicy[];
      });
    },

    async getBelowDeckPolicy(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`, [id]);
        return (result.rows[0] as BelowDeckPolicy) ?? null;
      });
    },

    async createBelowDeckPolicy(name, mode, spec, notes) {
      return withUserScope(pool, userId, async (client) => {
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

    async updateBelowDeckPolicy(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteBelowDeckPolicy(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM below_deck_policies WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Loadouts
    // ═══════════════════════════════════════════════════════

    async listLoadouts(filters) {
      return withUserRead(pool, userId, async (client) => {
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

    async getLoadout(id) {
      return withUserRead(pool, userId, async (client) => {
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

    async getLoadoutsByIds(ids) {
      if (ids.length === 0) return new Map();
      return withUserRead(pool, userId, async (client) => {
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

    async createLoadout(fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async updateLoadout(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteLoadout(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM loadouts WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Loadout Variants
    // ═══════════════════════════════════════════════════════

    async listVariants(baseLoadoutId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(
          `SELECT ${VARIANT_COLS} FROM loadout_variants WHERE base_loadout_id = $1 ORDER BY name`,
          [baseLoadoutId],
        );
        return result.rows as LoadoutVariant[];
      });
    },

    async getVariant(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${VARIANT_COLS} FROM loadout_variants WHERE id = $1`, [id]);
        return (result.rows[0] as LoadoutVariant) ?? null;
      });
    },

    async createVariant(baseLoadoutId, name, patch, notes) {
      validatePatch(patch);
      return withUserScope(pool, userId, async (client) => {
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

    async updateVariant(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteVariant(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM loadout_variants WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Docks
    // ═══════════════════════════════════════════════════════

    async listDocks() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${DOCK_COLS} FROM docks ORDER BY dock_number`);
        return result.rows as Dock[];
      });
    },

    async getDock(dockNumber) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${DOCK_COLS} FROM docks WHERE dock_number = $1`, [dockNumber]);
        return (result.rows[0] as Dock) ?? null;
      });
    },

    async upsertDock(dockNumber, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteDock(dockNumber) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM docks WHERE dock_number = $1`, [dockNumber]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Fleet Presets
    // ═══════════════════════════════════════════════════════

    async listFleetPresets() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${FP_COLS} FROM fleet_presets ORDER BY name`);
        return attachSlots(client, result.rows as FleetPreset[]);
      });
    },

    async getFleetPreset(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${FP_COLS} FROM fleet_presets WHERE id = $1`, [id]);
        const presets = await attachSlots(client, result.rows as FleetPreset[]);
        return presets[0] ?? null;
      });
    },

    async createFleetPreset(name, notes) {
      return withUserScope(pool, userId, async (client) => {
        const now = new Date().toISOString();
        const result = await client.query(
          `INSERT INTO fleet_presets (user_id, name, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING ${FP_COLS}`,
          [userId, name, notes ?? null, now, now],
        );
        log.fleet.debug({ id: result.rows[0].id, name }, "fleet preset created");
        return result.rows[0] as FleetPreset;
      });
    },

    async updateFleetPreset(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteFleetPreset(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM fleet_presets WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async setFleetPresetSlots(presetId, slots) {
      return withUserScope(pool, userId, async (client) => {
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

    async listPlanItems(filters) {
      return withUserRead(pool, userId, async (client) => {
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

    async getPlanItem(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${PI_COLS} FROM plan_items WHERE id = $1`, [id]);
        return (result.rows[0] as PlanItem) ?? null;
      });
    },

    async createPlanItem(fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async updatePlanItem(id, fields) {
      return withUserScope(pool, userId, async (client) => {
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

    async deletePlanItem(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM plan_items WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Officer Reservations
    // ═══════════════════════════════════════════════════════

    async listReservations() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${RES_COLS} FROM officer_reservations ORDER BY officer_id`);
        return result.rows as OfficerReservation[];
      });
    },

    async getReservation(officerId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(`SELECT ${RES_COLS} FROM officer_reservations WHERE officer_id = $1`, [officerId]);
        return (result.rows[0] as OfficerReservation) ?? null;
      });
    },

    async setReservation(officerId, reservedFor, locked, notes) {
      return withUserScope(pool, userId, async (client) => {
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

    async deleteReservation(officerId) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(`DELETE FROM officer_reservations WHERE officer_id = $1`, [officerId]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    // ═══════════════════════════════════════════════════════
    // Composition Functions (ADR-025 § D6)
    // ═══════════════════════════════════════════════════════

    async resolveVariant(baseLoadoutId, variantId) {
      return withUserRead(pool, userId, async (client) => {
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
      return withUserRead(pool, userId, async (client) => {
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
// Patch Validation (ADR-025 § Patch Merge Semantics)
// ═══════════════════════════════════════════════════════════

function validatePatch(patch: VariantPatch): void {
  const allowedKeys = new Set(["bridge", "below_deck_policy_id", "below_deck_patch", "intent_keys"]);
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown patch key: "${key}". Allowed: ${[...allowedKeys].join(", ")}`);
    }
  }

  // Mutual exclusion: below_deck_policy_id and below_deck_patch
  if (patch.below_deck_policy_id !== undefined && patch.below_deck_patch !== undefined) {
    throw new Error("Patch cannot contain both below_deck_policy_id and below_deck_patch (mutually exclusive)");
  }

  // Validate bridge slot names
  if (patch.bridge) {
    for (const slot of Object.keys(patch.bridge)) {
      if (!VALID_BRIDGE_SLOTS.includes(slot as BridgeSlot)) {
        throw new Error(`Invalid bridge slot: "${slot}". Must be one of: ${VALID_BRIDGE_SLOTS.join(", ")}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Factory (ADR-025 + #94)
// ═══════════════════════════════════════════════════════════

class CrewStoreFactory {
  constructor(private pool: Pool) {}
  forUser(userId: string): CrewStore {
    return createScopedCrewStore(this.pool, userId);
  }
}

/** Initialise schema and return a factory that produces user-scoped stores. */
export async function createCrewStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<CrewStoreFactory> {
  await initSchema(adminPool, [...MIGRATION_STATEMENTS, ...SCHEMA_STATEMENTS]);
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
