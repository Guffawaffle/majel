/**
 * loadout-store.ts — Loadout-First Fleet Data Layer (ADR-022 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed loadout manager: intent catalog, loadouts with crew,
 * simplified docks, plan items with away teams, officer conflict detection,
 * and plan validation.
 *
 * Replaces dock-store.ts (ADR-010). Types & seed data: loadout-types.ts
 *
 * Pattern: factory function createLoadoutStore(pool) returns LoadoutStore.
 */

import { initSchema, withTransaction, type Pool, type PoolClient } from "../db.js";
import { log } from "../logger.js";

import type {
  Intent,
  IntentCategory,
  Loadout,
  LoadoutMember,
  LoadoutWithMembers,
  Dock,
  DockWithAssignment,
  PlanItem,
  PlanItemWithContext,
  PlanAwayMember,
  OfficerConflict,
  PlanValidation,
  PlanItemSummary,
} from "../types/loadout-types.js";

import { VALID_INTENT_CATEGORIES, SEED_INTENTS } from "../types/loadout-types.js";

// Re-export public API so consumers can keep importing from loadout-store
export { VALID_INTENT_CATEGORIES } from "../types/loadout-types.js";
export type {
  Intent,
  IntentCategory,
  Loadout,
  LoadoutMember,
  LoadoutWithMembers,
  Dock,
  DockWithAssignment,
  PlanItem,
  PlanItemWithContext,
  PlanAwayMember,
  OfficerConflict,
  PlanValidation,
  LoadoutStore,
};

// ─── Store Interface ────────────────────────────────────────

interface LoadoutStore {
  // Intent catalog (carried from ADR-010)
  listIntents(filters?: { category?: string }): Promise<Intent[]>;
  getIntent(key: string): Promise<Intent | null>;
  createIntent(intent: Pick<Intent, "key" | "label" | "category" | "description" | "icon">): Promise<Intent>;
  deleteIntent(key: string): Promise<boolean>;

  // Loadout CRUD (L2)
  listLoadouts(filters?: { shipId?: string; intentKey?: string; tag?: string; active?: boolean }): Promise<LoadoutWithMembers[]>;
  getLoadout(id: number): Promise<LoadoutWithMembers | null>;
  createLoadout(fields: {
    shipId: string; name: string; priority?: number; isActive?: boolean;
    intentKeys?: string[]; tags?: string[]; notes?: string;
  }): Promise<LoadoutWithMembers>;
  updateLoadout(id: number, fields: {
    name?: string; priority?: number; isActive?: boolean;
    intentKeys?: string[]; tags?: string[]; notes?: string;
  }): Promise<LoadoutWithMembers | null>;
  deleteLoadout(id: number): Promise<boolean>;
  setLoadoutMembers(
    loadoutId: number,
    members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>,
  ): Promise<LoadoutMember[]>;

  // Dock CRUD (L3 — simplified)
  listDocks(): Promise<DockWithAssignment[]>;
  getDock(dockNumber: number): Promise<DockWithAssignment | null>;
  upsertDock(dockNumber: number, fields: { label?: string; notes?: string }): Promise<Dock>;
  deleteDock(dockNumber: number): Promise<boolean>;

  // Plan items (L3)
  listPlanItems(filters?: { active?: boolean; dockNumber?: number; intentKey?: string }): Promise<PlanItemWithContext[]>;
  getPlanItem(id: number): Promise<PlanItemWithContext | null>;
  createPlanItem(fields: {
    intentKey?: string; label?: string; loadoutId?: number;
    dockNumber?: number; priority?: number; isActive?: boolean; notes?: string;
  }): Promise<PlanItemWithContext>;
  updatePlanItem(id: number, fields: {
    intentKey?: string; label?: string; loadoutId?: number | null;
    dockNumber?: number | null; priority?: number; isActive?: boolean; notes?: string;
  }): Promise<PlanItemWithContext | null>;
  deletePlanItem(id: number): Promise<boolean>;
  setPlanAwayMembers(
    planItemId: number,
    officerIds: string[],
  ): Promise<PlanAwayMember[]>;

  // Composed queries
  getOfficerConflicts(): Promise<OfficerConflict[]>;
  validatePlan(): Promise<PlanValidation>;
  findLoadoutsForIntent(intentKey: string): Promise<LoadoutWithMembers[]>;

  // Cascade previews
  previewDeleteLoadout(id: number): Promise<{
    planItems: Array<{ id: number; label: string | null; dockNumber: number | null }>;
    memberCount: number;
  }>;
  previewDeleteDock(dockNumber: number): Promise<{
    planItems: Array<{ id: number; label: string | null; loadoutName: string | null }>;
  }>;
  previewDeleteOfficer(officerId: string): Promise<{
    loadoutMemberships: Array<{ loadoutId: number; loadoutName: string; shipName: string }>;
    awayMemberships: Array<{ planItemId: number; planItemLabel: string | null }>;
  }>;

  // Housekeeping
  counts(): Promise<{
    intents: number; loadouts: number; loadoutMembers: number;
    docks: number; planItems: number; awayMembers: number;
  }>;
  close(): void;
}

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  // Intent catalog (same as ADR-010, vocabulary layer)
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

  // L2: Loadouts
  `CREATE TABLE IF NOT EXISTS loadouts (
    id SERIAL PRIMARY KEY,
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    intent_keys JSONB NOT NULL DEFAULT '[]',
    tags JSONB NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ship_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_ship ON loadouts(ship_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_intent ON loadouts USING GIN (intent_keys)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_tags ON loadouts USING GIN (tags jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_loadouts_priority ON loadouts(priority DESC)`,

  // L2: Loadout members
  `CREATE TABLE IF NOT EXISTS loadout_members (
    id SERIAL PRIMARY KEY,
    loadout_id INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
    officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
    role_type TEXT NOT NULL CHECK (role_type IN ('bridge', 'below_deck')),
    slot TEXT,
    UNIQUE(loadout_id, officer_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_loadout_members_officer ON loadout_members(officer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loadout_members_loadout ON loadout_members(loadout_id)`,

  // L3: Docks (simplified metadata slots)
  `CREATE TABLE IF NOT EXISTS docks (
    dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
    label TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // L3: Plan items
  `CREATE TABLE IF NOT EXISTS plan_items (
    id SERIAL PRIMARY KEY,
    intent_key TEXT REFERENCES intent_catalog(key) ON DELETE SET NULL,
    label TEXT,
    loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL,
    dock_number INTEGER REFERENCES docks(dock_number) ON DELETE SET NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_loadout ON plan_items(loadout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_dock ON plan_items(dock_number)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_intent ON plan_items(intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_items_active ON plan_items(is_active) WHERE is_active = TRUE`,

  // L3: Away team members
  `CREATE TABLE IF NOT EXISTS plan_away_members (
    id SERIAL PRIMARY KEY,
    plan_item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
    UNIQUE(plan_item_id, officer_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_away_members_officer ON plan_away_members(officer_id)`,
];

// ─── SQL Queries ────────────────────────────────────────────

const SQL = {
  // Intent catalog
  listIntents: `SELECT * FROM intent_catalog ORDER BY sort_order, key`,
  listIntentsByCategory: `SELECT * FROM intent_catalog WHERE category = $1 ORDER BY sort_order, key`,
  getIntent: `SELECT * FROM intent_catalog WHERE key = $1`,
  insertIntent: `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
  deleteIntent: `DELETE FROM intent_catalog WHERE key = $1 AND is_builtin = FALSE RETURNING key`,
  seedIntent: `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order) VALUES ($1, $2, $3, $4, $5, TRUE, $6) ON CONFLICT (key) DO NOTHING`,

  // Loadouts
  listLoadouts: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    ORDER BY l.priority DESC, l.name
  `,
  getLoadout: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE l.id = $1
  `,
  insertLoadout: `
    INSERT INTO loadouts (ship_id, name, priority, is_active, intent_keys, tags, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
  updateLoadout: `UPDATE loadouts SET updated_at = NOW()`,  // dynamically built
  deleteLoadout: `DELETE FROM loadouts WHERE id = $1 RETURNING id`,

  // Loadout members
  listLoadoutMembers: `
    SELECT lm.*, ro.name AS officer_name
    FROM loadout_members lm
    LEFT JOIN reference_officers ro ON ro.id = lm.officer_id
    WHERE lm.loadout_id = $1
    ORDER BY lm.role_type, lm.slot
  `,
  // I1: Batch-fetch members for multiple loadouts in one query
  batchLoadoutMembers: `
    SELECT lm.*, ro.name AS officer_name
    FROM loadout_members lm
    LEFT JOIN reference_officers ro ON ro.id = lm.officer_id
    WHERE lm.loadout_id = ANY($1::int[])
    ORDER BY lm.loadout_id, lm.role_type, lm.slot
  `,
  deleteLoadoutMembers: `DELETE FROM loadout_members WHERE loadout_id = $1`,
  insertLoadoutMember: `
    INSERT INTO loadout_members (loadout_id, officer_id, role_type, slot)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,

  // Docks
  listDocks: `SELECT * FROM docks ORDER BY dock_number`,
  getDock: `SELECT * FROM docks WHERE dock_number = $1`,
  upsertDock: `
    INSERT INTO docks (dock_number, label, notes) VALUES ($1, $2, $3)
    ON CONFLICT (dock_number)
    DO UPDATE SET label = EXCLUDED.label,
                  notes = EXCLUDED.notes,
                  updated_at = NOW()
    RETURNING *
  `,
  deleteDock: `DELETE FROM docks WHERE dock_number = $1 RETURNING dock_number`,

  // Plan items
  listPlanItems: `
    SELECT pi.*,
           ic.label AS intent_label,
           l.name AS loadout_name,
           l.ship_id AS ship_id,
           rs.name AS ship_name,
           d.label AS dock_label
    FROM plan_items pi
    LEFT JOIN intent_catalog ic ON ic.key = pi.intent_key
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    LEFT JOIN docks d ON d.dock_number = pi.dock_number
    ORDER BY pi.priority DESC, pi.id
  `,
  getPlanItem: `
    SELECT pi.*,
           ic.label AS intent_label,
           l.name AS loadout_name,
           l.ship_id AS ship_id,
           rs.name AS ship_name,
           d.label AS dock_label
    FROM plan_items pi
    LEFT JOIN intent_catalog ic ON ic.key = pi.intent_key
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    LEFT JOIN docks d ON d.dock_number = pi.dock_number
    WHERE pi.id = $1
  `,
  insertPlanItem: `
    INSERT INTO plan_items (intent_key, label, loadout_id, dock_number, priority, is_active, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
  updatePlanItem: `UPDATE plan_items SET updated_at = NOW()`,  // dynamically built
  deletePlanItem: `DELETE FROM plan_items WHERE id = $1 RETURNING id`,

  // Plan away members
  listAwayMembers: `
    SELECT pam.*, ro.name AS officer_name
    FROM plan_away_members pam
    LEFT JOIN reference_officers ro ON ro.id = pam.officer_id
    WHERE pam.plan_item_id = $1
    ORDER BY pam.id
  `,
  // I1: Batch-fetch away members for multiple plan items
  batchAwayMembers: `
    SELECT pam.*, ro.name AS officer_name
    FROM plan_away_members pam
    LEFT JOIN reference_officers ro ON ro.id = pam.officer_id
    WHERE pam.plan_item_id = ANY($1::int[])
    ORDER BY pam.plan_item_id, pam.id
  `,
  deleteAwayMembers: `DELETE FROM plan_away_members WHERE plan_item_id = $1`,
  insertAwayMember: `
    INSERT INTO plan_away_members (plan_item_id, officer_id)
    VALUES ($1, $2)
    RETURNING *
  `,

  // Officer conflicts — find officers appearing in multiple active plan items
  // M4: Uses window function instead of correlated subquery for efficiency
  officerConflicts: `
    WITH active_officers AS (
      -- Officers from loadouts assigned to active plan items
      SELECT
        lm.officer_id,
        ro.name AS officer_name,
        pi.id AS plan_item_id,
        pi.label AS plan_item_label,
        pi.intent_key,
        pi.dock_number,
        'loadout' AS source,
        l.name AS loadout_name
      FROM plan_items pi
      JOIN loadouts l ON l.id = pi.loadout_id
      JOIN loadout_members lm ON lm.loadout_id = l.id
      JOIN reference_officers ro ON ro.id = lm.officer_id
      WHERE pi.is_active = TRUE
      UNION ALL
      -- Officers from away teams
      SELECT
        pam.officer_id,
        ro.name AS officer_name,
        pi.id AS plan_item_id,
        pi.label AS plan_item_label,
        pi.intent_key,
        pi.dock_number,
        'away_team' AS source,
        NULL AS loadout_name
      FROM plan_items pi
      JOIN plan_away_members pam ON pam.plan_item_id = pi.id
      JOIN reference_officers ro ON ro.id = pam.officer_id
      WHERE pi.is_active = TRUE
    ),
    counted AS (
      SELECT *, COUNT(*) OVER (PARTITION BY officer_id) AS appearance_count
      FROM active_officers
    )
    SELECT officer_id, officer_name, plan_item_id, plan_item_label,
           intent_key, dock_number, source, loadout_name
    FROM counted
    WHERE appearance_count > 1
    ORDER BY officer_id, plan_item_id
  `,

  // Plan validation: dock over-assignment
  dockConflicts: `
    SELECT dock_number, array_agg(id) AS plan_item_ids, array_agg(label) AS labels
    FROM plan_items
    WHERE is_active = TRUE AND dock_number IS NOT NULL
    GROUP BY dock_number
    HAVING COUNT(*) > 1
  `,

  // Cascade previews
  previewDeleteLoadout: `
    SELECT pi.id, pi.label, pi.dock_number FROM plan_items pi WHERE pi.loadout_id = $1
  `,
  countLoadoutMembers: `SELECT COUNT(*)::int AS count FROM loadout_members WHERE loadout_id = $1`,
  previewDeleteDock: `
    SELECT pi.id, pi.label, l.name AS loadout_name
    FROM plan_items pi
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    WHERE pi.dock_number = $1
  `,
  previewDeleteOfficerLoadouts: `
    SELECT lm.loadout_id, l.name AS loadout_name, rs.name AS ship_name
    FROM loadout_members lm
    JOIN loadouts l ON l.id = lm.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE lm.officer_id = $1
  `,
  previewDeleteOfficerAway: `
    SELECT pam.plan_item_id, pi.label AS plan_item_label
    FROM plan_away_members pam
    JOIN plan_items pi ON pi.id = pam.plan_item_id
    WHERE pam.officer_id = $1
  `,

  // FK validation
  shipExists: `SELECT id FROM reference_ships WHERE id = $1`,
  officerExists: `SELECT id FROM reference_officers WHERE id = $1`,

  // Counts
  counts: `
    SELECT
      (SELECT COUNT(*)::int FROM intent_catalog) AS intents,
      (SELECT COUNT(*)::int FROM loadouts) AS loadouts,
      (SELECT COUNT(*)::int FROM loadout_members) AS loadout_members,
      (SELECT COUNT(*)::int FROM docks) AS docks,
      (SELECT COUNT(*)::int FROM plan_items) AS plan_items,
      (SELECT COUNT(*)::int FROM plan_away_members) AS away_members
  `,

  // Loadout filter queries
  listLoadoutsByShip: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE l.ship_id = $1
    ORDER BY l.priority DESC, l.name
  `,
  listLoadoutsByIntent: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE l.intent_keys @> $1::jsonb
    ORDER BY l.priority DESC, l.name
  `,
  listLoadoutsByTag: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE l.tags @> $1::jsonb
    ORDER BY l.priority DESC, l.name
  `,
  listLoadoutsByActive: `
    SELECT l.*, rs.name AS ship_name
    FROM loadouts l
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE l.is_active = $1
    ORDER BY l.priority DESC, l.name
  `,

  // Plan item filter queries
  listPlanItemsByActive: `
    SELECT pi.*, ic.label AS intent_label, l.name AS loadout_name,
           l.ship_id AS ship_id, rs.name AS ship_name, d.label AS dock_label
    FROM plan_items pi
    LEFT JOIN intent_catalog ic ON ic.key = pi.intent_key
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    LEFT JOIN docks d ON d.dock_number = pi.dock_number
    WHERE pi.is_active = $1
    ORDER BY pi.priority DESC, pi.id
  `,
  listPlanItemsByDock: `
    SELECT pi.*, ic.label AS intent_label, l.name AS loadout_name,
           l.ship_id AS ship_id, rs.name AS ship_name, d.label AS dock_label
    FROM plan_items pi
    LEFT JOIN intent_catalog ic ON ic.key = pi.intent_key
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    LEFT JOIN docks d ON d.dock_number = pi.dock_number
    WHERE pi.dock_number = $1
    ORDER BY pi.priority DESC, pi.id
  `,
  listPlanItemsByIntent: `
    SELECT pi.*, ic.label AS intent_label, l.name AS loadout_name,
           l.ship_id AS ship_id, rs.name AS ship_name, d.label AS dock_label
    FROM plan_items pi
    LEFT JOIN intent_catalog ic ON ic.key = pi.intent_key
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    LEFT JOIN docks d ON d.dock_number = pi.dock_number
    WHERE pi.intent_key = $1
    ORDER BY pi.priority DESC, pi.id
  `,

  // Dock assignment lookup
  dockAssignment: `
    SELECT pi.id, pi.intent_key, pi.label, pi.loadout_id,
           l.name AS loadout_name, rs.name AS ship_name, pi.is_active
    FROM plan_items pi
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE pi.dock_number = $1 AND pi.is_active = TRUE
    ORDER BY pi.priority DESC
    LIMIT 1
  `,
  // I2: Batch-fetch dock assignments in one query (highest-priority active item per dock)
  batchDockAssignments: `
    SELECT DISTINCT ON (pi.dock_number)
           pi.dock_number, pi.id, pi.intent_key, pi.label, pi.loadout_id,
           l.name AS loadout_name, rs.name AS ship_name, pi.is_active
    FROM plan_items pi
    LEFT JOIN loadouts l ON l.id = pi.loadout_id
    LEFT JOIN reference_ships rs ON rs.id = l.ship_id
    WHERE pi.dock_number = ANY($1::int[]) AND pi.is_active = TRUE
    ORDER BY pi.dock_number, pi.priority DESC
  `,
} as const;

// ─── Helpers ────────────────────────────────────────────────

/** PostgreSQL returns booleans as actual booleans (pg lib), but be safe. */
function fixBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "t" || v === "1";
  return false;
}

/** Parse JSONB array column to string[]. Coerces all elements to strings. */
function parseJsonbArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

/** Map a loadout row to a Loadout object. */
function mapLoadout(row: Record<string, unknown>): Loadout {
  return {
    id: row.id as number,
    shipId: row.ship_id as string,
    name: row.name as string,
    priority: row.priority as number,
    isActive: fixBool(row.is_active),
    intentKeys: parseJsonbArray(row.intent_keys),
    tags: parseJsonbArray(row.tags),
    notes: (row.notes as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    shipName: (row.ship_name as string) ?? undefined,
  };
}

/** Map a loadout_members row to a LoadoutMember. */
function mapMember(row: Record<string, unknown>): LoadoutMember {
  return {
    id: row.id as number,
    loadoutId: row.loadout_id as number,
    officerId: row.officer_id as string,
    roleType: row.role_type as "bridge" | "below_deck",
    slot: (row.slot as string) ?? null,
    officerName: (row.officer_name as string) ?? undefined,
  };
}

/** Map an intent_catalog row to an Intent. */
function mapIntent(row: Record<string, unknown>): Intent {
  return {
    key: row.key as string,
    label: row.label as string,
    category: row.category as string,
    description: (row.description as string) ?? null,
    icon: (row.icon as string) ?? null,
    isBuiltin: fixBool(row.is_builtin),
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
  };
}

/** Map a dock row to a Dock. */
function mapDock(row: Record<string, unknown>): Dock {
  return {
    dockNumber: row.dock_number as number,
    label: (row.label as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Map a plan_items row to a PlanItem. */
function mapPlanItem(row: Record<string, unknown>): PlanItem {
  return {
    id: row.id as number,
    intentKey: (row.intent_key as string) ?? null,
    label: (row.label as string) ?? null,
    loadoutId: (row.loadout_id as number) ?? null,
    dockNumber: (row.dock_number as number) ?? null,
    priority: row.priority as number,
    isActive: fixBool(row.is_active),
    notes: (row.notes as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Map a plan_away_members row. */
function mapAwayMember(row: Record<string, unknown>): PlanAwayMember {
  return {
    id: row.id as number,
    planItemId: row.plan_item_id as number,
    officerId: row.officer_id as string,
    officerName: (row.officer_name as string) ?? undefined,
  };
}

// ─── Factory ────────────────────────────────────────────────

export async function createLoadoutStore(pool: Pool): Promise<LoadoutStore> {
  // Create schema
  await initSchema(pool, SCHEMA_STATEMENTS);

  // M1: Batch-seed builtin intents in a single query instead of 24 round-trips
  if (SEED_INTENTS.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const seed of SEED_INTENTS) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, TRUE, $${idx++})`);
      values.push(seed.key, seed.label, seed.category, seed.description, seed.icon, seed.sortOrder);
    }
    await pool.query(
      `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (key) DO NOTHING`,
      values,
    );
  }

  log.boot.debug("loadout store schema ready");

  // ─── Resolve helpers ──────────────────────────────

  /** Fetch members for a single loadout (used by getLoadout, createLoadout). */
  async function resolveLoadout(row: Record<string, unknown>): Promise<LoadoutWithMembers> {
    const loadout = mapLoadout(row);
    const membersResult = await pool.query(SQL.listLoadoutMembers, [loadout.id]);
    return { ...loadout, members: membersResult.rows.map(mapMember) };
  }

  /**
   * I1: Batch-resolve loadout members — 1 query for all, then join in-memory.
   * Replaces N+1 pattern (was 1 + N queries, now always 2).
   */
  async function resolveLoadouts(rows: Record<string, unknown>[]): Promise<LoadoutWithMembers[]> {
    if (rows.length === 0) return [];
    const loadouts = rows.map(mapLoadout);
    const ids = loadouts.map((l) => l.id);
    const membersResult = await pool.query(SQL.batchLoadoutMembers, [ids]);
    const membersByLoadout = new Map<number, LoadoutMember[]>();
    for (const row of membersResult.rows) {
      const member = mapMember(row);
      const list = membersByLoadout.get(member.loadoutId) ?? [];
      list.push(member);
      membersByLoadout.set(member.loadoutId, list);
    }
    return loadouts.map((l) => ({ ...l, members: membersByLoadout.get(l.id) ?? [] }));
  }

  /** Fetch context for a single plan item (used by getPlanItem, createPlanItem). */
  async function resolvePlanItem(row: Record<string, unknown>): Promise<PlanItemWithContext> {
    const base = mapPlanItem(row);
    const members = base.loadoutId
      ? (await pool.query(SQL.listLoadoutMembers, [base.loadoutId])).rows.map(mapMember)
      : [];
    const awayResult = await pool.query(SQL.listAwayMembers, [base.id]);
    const awayMembers = awayResult.rows.map(mapAwayMember);
    return {
      ...base,
      intentLabel: (row.intent_label as string) ?? null,
      loadoutName: (row.loadout_name as string) ?? null,
      shipId: (row.ship_id as string) ?? null,
      shipName: (row.ship_name as string) ?? null,
      dockLabel: (row.dock_label as string) ?? null,
      members,
      awayMembers,
    };
  }

  /**
   * I1: Batch-resolve plan items — 2 queries for loadout members + away members.
   * Replaces N+1 pattern (was up to 3N+1 queries, now always 3).
   */
  async function resolvePlanItems(rows: Record<string, unknown>[]): Promise<PlanItemWithContext[]> {
    if (rows.length === 0) return [];
    const items = rows.map((row) => ({
      base: mapPlanItem(row),
      intentLabel: (row.intent_label as string) ?? null,
      loadoutName: (row.loadout_name as string) ?? null,
      shipId: (row.ship_id as string) ?? null,
      shipName: (row.ship_name as string) ?? null,
      dockLabel: (row.dock_label as string) ?? null,
    }));

    // Batch-fetch loadout members
    const loadoutIds = [...new Set(items.filter((i) => i.base.loadoutId).map((i) => i.base.loadoutId!))];
    const membersByLoadout = new Map<number, LoadoutMember[]>();
    if (loadoutIds.length > 0) {
      const membersResult = await pool.query(SQL.batchLoadoutMembers, [loadoutIds]);
      for (const row of membersResult.rows) {
        const member = mapMember(row);
        const list = membersByLoadout.get(member.loadoutId) ?? [];
        list.push(member);
        membersByLoadout.set(member.loadoutId, list);
      }
    }

    // Batch-fetch away members
    const planItemIds = items.map((i) => i.base.id);
    const awayByPlanItem = new Map<number, PlanAwayMember[]>();
    if (planItemIds.length > 0) {
      const awayResult = await pool.query(SQL.batchAwayMembers, [planItemIds]);
      for (const row of awayResult.rows) {
        const member = mapAwayMember(row);
        const list = awayByPlanItem.get(member.planItemId) ?? [];
        list.push(member);
        awayByPlanItem.set(member.planItemId, list);
      }
    }

    return items.map((i) => ({
      ...i.base,
      intentLabel: i.intentLabel,
      loadoutName: i.loadoutName,
      shipId: i.shipId,
      shipName: i.shipName,
      dockLabel: i.dockLabel,
      members: i.base.loadoutId ? (membersByLoadout.get(i.base.loadoutId) ?? []) : [],
      awayMembers: awayByPlanItem.get(i.base.id) ?? [],
    }));
  }

  // ─── Intent catalog ───────────────────────────────

  async function listIntents(filters?: { category?: string }): Promise<Intent[]> {
    if (filters?.category) {
      const { rows } = await pool.query(SQL.listIntentsByCategory, [filters.category]);
      return rows.map(mapIntent);
    }
    const { rows } = await pool.query(SQL.listIntents);
    return rows.map(mapIntent);
  }

  async function getIntent(key: string): Promise<Intent | null> {
    const { rows } = await pool.query(SQL.getIntent, [key]);
    return rows.length > 0 ? mapIntent(rows[0]) : null;
  }

  async function createIntent(
    intent: Pick<Intent, "key" | "label" | "category" | "description" | "icon">,
  ): Promise<Intent> {
    if (!intent.key || !intent.label || !intent.category) {
      throw new Error("Intent requires key, label, and category");
    }
    if (!VALID_INTENT_CATEGORIES.includes(intent.category as IntentCategory)) {
      throw new Error(`Invalid category: ${intent.category}. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}`);
    }
    const { rows } = await pool.query(SQL.insertIntent, [
      intent.key, intent.label, intent.category, intent.description ?? null,
      intent.icon ?? null, false, 100,
    ]);
    return mapIntent(rows[0]);
  }

  async function deleteIntent(key: string): Promise<boolean> {
    const { rowCount } = await pool.query(SQL.deleteIntent, [key]);
    return (rowCount ?? 0) > 0;
  }

  // ─── Loadout CRUD ─────────────────────────────────

  async function listLoadouts(
    filters?: { shipId?: string; intentKey?: string; tag?: string; active?: boolean },
  ): Promise<LoadoutWithMembers[]> {
    if (filters?.shipId) {
      const { rows } = await pool.query(SQL.listLoadoutsByShip, [filters.shipId]);
      return resolveLoadouts(rows);
    }
    if (filters?.intentKey) {
      const { rows } = await pool.query(SQL.listLoadoutsByIntent, [JSON.stringify([filters.intentKey])]);
      return resolveLoadouts(rows);
    }
    if (filters?.tag) {
      const { rows } = await pool.query(SQL.listLoadoutsByTag, [JSON.stringify([filters.tag])]);
      return resolveLoadouts(rows);
    }
    if (filters?.active !== undefined) {
      const { rows } = await pool.query(SQL.listLoadoutsByActive, [filters.active]);
      return resolveLoadouts(rows);
    }
    const { rows } = await pool.query(SQL.listLoadouts);
    return resolveLoadouts(rows);
  }

  async function getLoadout(id: number): Promise<LoadoutWithMembers | null> {
    const { rows } = await pool.query(SQL.getLoadout, [id]);
    if (rows.length === 0) return null;
    return resolveLoadout(rows[0]);
  }

  async function createLoadout(fields: {
    shipId: string; name: string; priority?: number; isActive?: boolean;
    intentKeys?: string[]; tags?: string[]; notes?: string;
  }): Promise<LoadoutWithMembers> {
    if (!fields.shipId || !fields.name) {
      throw new Error("Loadout requires shipId and name");
    }
    // I3: Wrap FK validation + insert in a transaction to avoid TOCTOU races
    const newId = await withTransaction(pool, async (client: PoolClient) => {
      // Validate ship exists
      const shipCheck = await client.query(SQL.shipExists, [fields.shipId]);
      if (shipCheck.rows.length === 0) {
        throw new Error(`Ship not found: ${fields.shipId}`);
      }
      try {
        const { rows } = await client.query(SQL.insertLoadout, [
          fields.shipId,
          fields.name,
          fields.priority ?? 0,
          fields.isActive ?? true,
          JSON.stringify(fields.intentKeys ?? []),
          JSON.stringify(fields.tags ?? []),
          fields.notes ?? null,
        ]);
        return rows[0].id as number;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unique") || msg.includes("UNIQUE") || msg.includes("duplicate key")) {
          throw new Error(`Loadout "${fields.name}" already exists for this ship`);
        }
        throw err;
      }
    });
    // Fetch with ship_name join after transaction commits
    return (await getLoadout(newId))!;
  }

  async function updateLoadout(
    id: number,
    fields: {
      name?: string; priority?: number; isActive?: boolean;
      intentKeys?: string[]; tags?: string[]; notes?: string;
    },
  ): Promise<LoadoutWithMembers | null> {
    // Check exists
    const existing = await getLoadout(id);
    if (!existing) return null;

    // C3: Column names in setClauses are compile-time constants from this function body.
    // They are NOT derived from user input. Only these columns can be updated:
    // name, priority, is_active, intent_keys, tags, notes, updated_at
    const setClauses: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (fields.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      values.push(fields.name);
    }
    if (fields.priority !== undefined) {
      setClauses.push(`priority = $${paramIdx++}`);
      values.push(fields.priority);
    }
    if (fields.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`);
      values.push(fields.isActive);
    }
    if (fields.intentKeys !== undefined) {
      setClauses.push(`intent_keys = $${paramIdx++}`);
      values.push(JSON.stringify(fields.intentKeys));
    }
    if (fields.tags !== undefined) {
      setClauses.push(`tags = $${paramIdx++}`);
      values.push(JSON.stringify(fields.tags));
    }
    if (fields.notes !== undefined) {
      setClauses.push(`notes = $${paramIdx++}`);
      values.push(fields.notes);
    }

    if (values.length === 0) return existing;

    values.push(id);
    const query = `UPDATE loadouts SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`;

    try {
      await pool.query(query, values);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("UNIQUE") || msg.includes("duplicate key")) {
        throw new Error(`Loadout name "${fields.name}" already exists for this ship`);
      }
      throw err;
    }

    return getLoadout(id);
  }

  async function deleteLoadout(id: number): Promise<boolean> {
    const { rowCount } = await pool.query(SQL.deleteLoadout, [id]);
    return (rowCount ?? 0) > 0;
  }

  async function setLoadoutMembers(
    loadoutId: number,
    members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>,
  ): Promise<LoadoutMember[]> {
    // Validate loadout exists
    const loadout = await getLoadout(loadoutId);
    if (!loadout) throw new Error(`Loadout not found: ${loadoutId}`);

    // Validate all officers exist
    for (const m of members) {
      const check = await pool.query(SQL.officerExists, [m.officerId]);
      if (check.rows.length === 0) {
        throw new Error(`Officer not found: ${m.officerId}`);
      }
    }

    return withTransaction(pool, async (client: PoolClient) => {
      // Clear existing members
      await client.query(SQL.deleteLoadoutMembers, [loadoutId]);

      // Insert new members
      const result: LoadoutMember[] = [];
      for (const m of members) {
        const { rows } = await client.query(SQL.insertLoadoutMember, [
          loadoutId, m.officerId, m.roleType, m.slot ?? null,
        ]);
        result.push(mapMember(rows[0]));
      }
      return result;
    });
  }

  // ─── Dock CRUD ────────────────────────────────────

  function mapAssignment(row: Record<string, unknown>): PlanItemSummary {
    return {
      id: row.id as number,
      intentKey: (row.intent_key as string) ?? null,
      label: (row.label as string) ?? null,
      loadoutId: (row.loadout_id as number) ?? null,
      loadoutName: (row.loadout_name as string) ?? null,
      shipName: (row.ship_name as string) ?? null,
      isActive: fixBool(row.is_active),
    };
  }

  async function resolveDockAssignment(dockNumber: number): Promise<PlanItemSummary | null> {
    const { rows } = await pool.query(SQL.dockAssignment, [dockNumber]);
    return rows.length > 0 ? mapAssignment(rows[0]) : null;
  }

  async function listDocks(): Promise<DockWithAssignment[]> {
    const { rows } = await pool.query(SQL.listDocks);
    if (rows.length === 0) return [];
    const docks = rows.map(mapDock);
    // I2: Batch-fetch dock assignments in 1 query instead of N
    const dockNumbers = docks.map((d) => d.dockNumber);
    const { rows: assignmentRows } = await pool.query(SQL.batchDockAssignments, [dockNumbers]);
    const assignmentMap = new Map<number, PlanItemSummary>();
    for (const row of assignmentRows) {
      assignmentMap.set(row.dock_number as number, mapAssignment(row));
    }
    return docks.map((dock) => ({
      ...dock,
      assignment: assignmentMap.get(dock.dockNumber) ?? null,
    }));
  }

  async function getDock(dockNumber: number): Promise<DockWithAssignment | null> {
    const { rows } = await pool.query(SQL.getDock, [dockNumber]);
    if (rows.length === 0) return null;
    const dock = mapDock(rows[0]);
    const assignment = await resolveDockAssignment(dockNumber);
    return { ...dock, assignment };
  }

  async function upsertDock(
    dockNumber: number,
    fields: { label?: string; notes?: string },
  ): Promise<Dock> {
    if (!Number.isInteger(dockNumber) || dockNumber < 1) {
      throw new Error("Dock number must be a positive integer");
    }
    const { rows } = await pool.query(SQL.upsertDock, [
      dockNumber, fields.label ?? null, fields.notes ?? null,
    ]);
    return mapDock(rows[0]);
  }

  async function deleteDock(dockNumber: number): Promise<boolean> {
    const { rowCount } = await pool.query(SQL.deleteDock, [dockNumber]);
    return (rowCount ?? 0) > 0;
  }

  // ─── Plan Items ───────────────────────────────────

  async function listPlanItems(
    filters?: { active?: boolean; dockNumber?: number; intentKey?: string },
  ): Promise<PlanItemWithContext[]> {
    if (filters?.active !== undefined) {
      const { rows } = await pool.query(SQL.listPlanItemsByActive, [filters.active]);
      return resolvePlanItems(rows);
    }
    if (filters?.dockNumber !== undefined) {
      const { rows } = await pool.query(SQL.listPlanItemsByDock, [filters.dockNumber]);
      return resolvePlanItems(rows);
    }
    if (filters?.intentKey) {
      const { rows } = await pool.query(SQL.listPlanItemsByIntent, [filters.intentKey]);
      return resolvePlanItems(rows);
    }
    const { rows } = await pool.query(SQL.listPlanItems);
    return resolvePlanItems(rows);
  }

  async function getPlanItem(id: number): Promise<PlanItemWithContext | null> {
    const { rows } = await pool.query(SQL.getPlanItem, [id]);
    if (rows.length === 0) return null;
    return resolvePlanItem(rows[0]);
  }

  async function createPlanItem(fields: {
    intentKey?: string; label?: string; loadoutId?: number;
    dockNumber?: number; priority?: number; isActive?: boolean; notes?: string;
  }): Promise<PlanItemWithContext> {
    // I3: Wrap FK validation + insert in a transaction to avoid TOCTOU races
    const newId = await withTransaction(pool, async (client: PoolClient) => {
      // Validate loadout exists if specified
      if (fields.loadoutId) {
        const { rows } = await client.query(SQL.getLoadout, [fields.loadoutId]);
        if (rows.length === 0) throw new Error(`Loadout not found: ${fields.loadoutId}`);
      }
      // Validate dock exists if specified
      if (fields.dockNumber) {
        const { rows } = await client.query(SQL.getDock, [fields.dockNumber]);
        if (rows.length === 0) throw new Error(`Dock not found: ${fields.dockNumber}`);
      }
      // Validate intent exists if specified
      if (fields.intentKey) {
        const { rows } = await client.query(SQL.getIntent, [fields.intentKey]);
        if (rows.length === 0) throw new Error(`Intent not found: ${fields.intentKey}`);
      }

      const { rows } = await client.query(SQL.insertPlanItem, [
        fields.intentKey ?? null,
        fields.label ?? null,
        fields.loadoutId ?? null,
        fields.dockNumber ?? null,
        fields.priority ?? 0,
        fields.isActive ?? true,
        fields.notes ?? null,
      ]);

      return rows[0].id as number;
    });
    // Fetch with full joins after transaction commits
    return (await getPlanItem(newId))!;
  }

  async function updatePlanItem(
    id: number,
    fields: {
      intentKey?: string; label?: string; loadoutId?: number | null;
      dockNumber?: number | null; priority?: number; isActive?: boolean; notes?: string;
    },
  ): Promise<PlanItemWithContext | null> {
    const existing = await getPlanItem(id);
    if (!existing) return null;

    // C3: Column names in setClauses are compile-time constants from this function body.
    // They are NOT derived from user input. Only these columns can be updated:
    // intent_key, label, loadout_id, dock_number, priority, is_active, notes, updated_at
    const setClauses: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (fields.intentKey !== undefined) {
      if (fields.intentKey !== null) {
        const intent = await getIntent(fields.intentKey);
        if (!intent) throw new Error(`Intent not found: ${fields.intentKey}`);
      }
      setClauses.push(`intent_key = $${paramIdx++}`);
      values.push(fields.intentKey);
    }
    if (fields.label !== undefined) {
      setClauses.push(`label = $${paramIdx++}`);
      values.push(fields.label);
    }
    if (fields.loadoutId !== undefined) {
      if (fields.loadoutId !== null) {
        const loadout = await getLoadout(fields.loadoutId);
        if (!loadout) throw new Error(`Loadout not found: ${fields.loadoutId}`);
      }
      setClauses.push(`loadout_id = $${paramIdx++}`);
      values.push(fields.loadoutId);
    }
    if (fields.dockNumber !== undefined) {
      if (fields.dockNumber !== null) {
        const { rows } = await pool.query(SQL.getDock, [fields.dockNumber]);
        if (rows.length === 0) throw new Error(`Dock not found: ${fields.dockNumber}`);
      }
      setClauses.push(`dock_number = $${paramIdx++}`);
      values.push(fields.dockNumber);
    }
    if (fields.priority !== undefined) {
      setClauses.push(`priority = $${paramIdx++}`);
      values.push(fields.priority);
    }
    if (fields.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`);
      values.push(fields.isActive);
    }
    if (fields.notes !== undefined) {
      setClauses.push(`notes = $${paramIdx++}`);
      values.push(fields.notes);
    }

    if (values.length === 0) return existing;

    values.push(id);
    const query = `UPDATE plan_items SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`;
    await pool.query(query, values);

    return getPlanItem(id);
  }

  async function deletePlanItem(id: number): Promise<boolean> {
    const { rowCount } = await pool.query(SQL.deletePlanItem, [id]);
    return (rowCount ?? 0) > 0;
  }

  async function setPlanAwayMembers(
    planItemId: number,
    officerIds: string[],
  ): Promise<PlanAwayMember[]> {
    // Validate plan item exists
    const item = await getPlanItem(planItemId);
    if (!item) throw new Error(`Plan item not found: ${planItemId}`);

    // Away members only make sense when there's no loadout
    // (but we don't enforce this as a hard error — flexible design)

    // Validate all officers exist
    for (const officerId of officerIds) {
      const check = await pool.query(SQL.officerExists, [officerId]);
      if (check.rows.length === 0) {
        throw new Error(`Officer not found: ${officerId}`);
      }
    }

    return withTransaction(pool, async (client: PoolClient) => {
      await client.query(SQL.deleteAwayMembers, [planItemId]);
      const result: PlanAwayMember[] = [];
      for (const officerId of officerIds) {
        const { rows } = await client.query(SQL.insertAwayMember, [planItemId, officerId]);
        result.push(mapAwayMember(rows[0]));
      }
      return result;
    });
  }

  // ─── Composed Queries ─────────────────────────────

  async function getOfficerConflicts(): Promise<OfficerConflict[]> {
    const { rows } = await pool.query(SQL.officerConflicts);
    // Group rows by officer_id
    const map = new Map<string, OfficerConflict>();
    for (const row of rows) {
      const officerId = row.officer_id as string;
      if (!map.has(officerId)) {
        map.set(officerId, {
          officerId,
          officerName: row.officer_name as string,
          appearances: [],
        });
      }
      map.get(officerId)!.appearances.push({
        planItemId: row.plan_item_id as number,
        planItemLabel: (row.plan_item_label as string) ?? null,
        intentKey: (row.intent_key as string) ?? null,
        dockNumber: (row.dock_number as number) ?? null,
        source: row.source as "loadout" | "away_team",
        loadoutName: (row.loadout_name as string) ?? null,
      });
    }
    return Array.from(map.values());
  }

  async function validatePlan(): Promise<PlanValidation> {
    const warnings: string[] = [];

    // 1. Dock conflicts (multiple active plan items on same dock)
    const { rows: dockRows } = await pool.query(SQL.dockConflicts);
    const dockConflicts = dockRows.map((r) => ({
      dockNumber: r.dock_number as number,
      planItemIds: r.plan_item_ids as number[],
      labels: (r.labels as (string | null)[]).map((l) => l ?? "(unlabeled)"),
    }));
    for (const dc of dockConflicts) {
      warnings.push(`Dock ${dc.dockNumber} has ${dc.planItemIds.length} active plan items: ${dc.labels.join(", ")}`);
    }

    // 2. Officer conflicts
    const officerConflicts = await getOfficerConflicts();
    for (const oc of officerConflicts) {
      const locs = oc.appearances.map((a) =>
        a.dockNumber ? `D${a.dockNumber}` : "Away",
      );
      warnings.push(`${oc.officerName} is in ${oc.appearances.length} active items: ${locs.join(", ")}`);
    }

    // 3. Active plan items with no loadout and no away members
    const allActive = await listPlanItems({ active: true });
    const unassignedLoadouts = allActive
      .filter((pi) => !pi.loadoutId && pi.awayMembers.length === 0)
      .map((pi) => ({ planItemId: pi.id, label: pi.label }));
    for (const ul of unassignedLoadouts) {
      warnings.push(`Plan item "${ul.label ?? ul.planItemId}" has no loadout or away team assigned`);
    }

    // 4. Active plan items with loadout but no dock (and not an away team pattern)
    const unassignedDocks = allActive
      .filter((pi) => pi.loadoutId && !pi.dockNumber)
      .map((pi) => ({ planItemId: pi.id, label: pi.label }));
    for (const ud of unassignedDocks) {
      warnings.push(`Plan item "${ud.label ?? ud.planItemId}" has a loadout but no dock assigned`);
    }

    return {
      valid: dockConflicts.length === 0 && officerConflicts.length === 0 && unassignedLoadouts.length === 0,
      dockConflicts,
      officerConflicts,
      unassignedLoadouts,
      unassignedDocks,
      warnings,
    };
  }

  async function findLoadoutsForIntent(intentKey: string): Promise<LoadoutWithMembers[]> {
    const { rows } = await pool.query(SQL.listLoadoutsByIntent, [JSON.stringify([intentKey])]);
    return resolveLoadouts(rows);
  }

  // ─── Cascade Previews ─────────────────────────────

  async function previewDeleteLoadout(id: number) {
    const { rows: planRows } = await pool.query(SQL.previewDeleteLoadout, [id]);
    const { rows: countRows } = await pool.query(SQL.countLoadoutMembers, [id]);
    return {
      planItems: planRows.map((r) => ({
        id: r.id as number,
        label: (r.label as string) ?? null,
        dockNumber: (r.dock_number as number) ?? null,
      })),
      memberCount: (countRows[0]?.count as number) ?? 0,
    };
  }

  async function previewDeleteDock(dockNumber: number) {
    const { rows } = await pool.query(SQL.previewDeleteDock, [dockNumber]);
    return {
      planItems: rows.map((r) => ({
        id: r.id as number,
        label: (r.label as string) ?? null,
        loadoutName: (r.loadout_name as string) ?? null,
      })),
    };
  }

  async function previewDeleteOfficer(officerId: string) {
    const { rows: loadoutRows } = await pool.query(SQL.previewDeleteOfficerLoadouts, [officerId]);
    const { rows: awayRows } = await pool.query(SQL.previewDeleteOfficerAway, [officerId]);
    return {
      loadoutMemberships: loadoutRows.map((r) => ({
        loadoutId: r.loadout_id as number,
        loadoutName: r.loadout_name as string,
        shipName: r.ship_name as string,
      })),
      awayMemberships: awayRows.map((r) => ({
        planItemId: r.plan_item_id as number,
        planItemLabel: (r.plan_item_label as string) ?? null,
      })),
    };
  }

  // ─── Housekeeping ─────────────────────────────────

  async function counts() {
    const { rows } = await pool.query(SQL.counts);
    return {
      intents: rows[0].intents as number,
      loadouts: rows[0].loadouts as number,
      loadoutMembers: rows[0].loadout_members as number,
      docks: rows[0].docks as number,
      planItems: rows[0].plan_items as number,
      awayMembers: rows[0].away_members as number,
    };
  }

  function close() {
    // Pool lifecycle managed externally
    log.boot.debug("loadout store closed");
  }

  return {
    listIntents, getIntent, createIntent, deleteIntent,
    listLoadouts, getLoadout, createLoadout, updateLoadout, deleteLoadout, setLoadoutMembers,
    listDocks, getDock, upsertDock, deleteDock,
    listPlanItems, getPlanItem, createPlanItem, updatePlanItem, deletePlanItem, setPlanAwayMembers,
    getOfficerConflicts, validatePlan, findLoadoutsForIntent,
    previewDeleteLoadout, previewDeleteDock, previewDeleteOfficer,
    counts, close,
  };
}
