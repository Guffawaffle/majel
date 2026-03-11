/**
 * crew-store-schema.ts — Schema DDL + SQL column fragments for crew-store
 *
 * Extracted from crew-store.ts (ADR-025) for #191 store decomposition.
 */

// ═══════════════════════════════════════════════════════════
// Schema DDL
// ═══════════════════════════════════════════════════════════

export const SCHEMA_STATEMENTS = [
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
// SQL Column Fragments
// ═══════════════════════════════════════════════════════════

export const BC_COLS = `id, name, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const BCM_COLS = `id, bridge_core_id AS "bridgeCoreId", officer_id AS "officerId", slot`;
export const BDP_COLS = `id, name, mode, spec_version AS "specVersion", spec, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const LOADOUT_COLS = `id, ship_id AS "shipId", bridge_core_id AS "bridgeCoreId",
  below_deck_policy_id AS "belowDeckPolicyId", name, priority, is_active AS "isActive",
  intent_keys AS "intentKeys", tags, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const VARIANT_COLS = `id, base_loadout_id AS "baseLoadoutId", name, patch, notes, created_at AS "createdAt"`;
export const DOCK_COLS = `dock_number AS "dockNumber", label, unlocked, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const FP_COLS = `id, name, is_active AS "isActive", notes, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const FPS_COLS = `id, preset_id AS "presetId", dock_number AS "dockNumber",
  loadout_id AS "loadoutId", variant_id AS "variantId", away_officers AS "awayOfficers",
  label, priority, notes`;
export const PI_COLS = `id, intent_key AS "intentKey", label, loadout_id AS "loadoutId",
  variant_id AS "variantId", dock_number AS "dockNumber", away_officers AS "awayOfficers",
  priority, is_active AS "isActive", source, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const RES_COLS = `officer_id AS "officerId", reserved_for AS "reservedFor", locked, notes, created_at AS "createdAt"`;
