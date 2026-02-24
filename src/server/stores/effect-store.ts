/**
 * effect-store.ts — Effect Taxonomy Store (ADR-034 Phase A, #132)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed store for the effect taxonomy, normalized ability catalog,
 * and data-driven intent definitions. Global scope (no RLS) — taxonomy data
 * is shared across all users.
 *
 * Tables (15):
 *   Taxonomy (7):  taxonomy_target_kind, taxonomy_target_tag, taxonomy_ship_class,
 *                  taxonomy_slot, taxonomy_effect_key, taxonomy_condition_key,
 *                  taxonomy_issue_type
 *   Ability (5):   catalog_officer_ability, catalog_ability_effect,
 *                  catalog_ability_effect_target_kind, catalog_ability_effect_target_tag,
 *                  catalog_ability_effect_condition
 *   Intent (3):    intent_def, intent_default_context, intent_effect_weight
 */

import { initSchema, withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Row Types (DB-level, camelCased after SELECT aliasing) ─

export interface TaxonomyRow {
  id: string;
}

export interface EffectKeyRow {
  id: string;
  category: string;
}

export interface ConditionKeyRow {
  id: string;
  paramSchema: string | null;
}

export interface IssueTypeRow {
  id: string;
  severity: string;
  defaultMessage: string;
}

export interface OfficerAbilityRow {
  id: string;
  officerId: string;
  slot: string;
  name: string | null;
  rawText: string | null;
  isInert: boolean;
}

export interface AbilityEffectRow {
  id: string;
  abilityId: string;
  effectKey: string;
  magnitude: number | null;
  unit: string | null;
  stacking: string | null;
}

export interface AbilityEffectTargetKindRow {
  abilityEffectId: string;
  targetKind: string;
}

export interface AbilityEffectTargetTagRow {
  abilityEffectId: string;
  targetTag: string;
}

export interface AbilityEffectConditionRow {
  id: string;
  abilityEffectId: string;
  conditionKey: string;
  paramsJson: string | null;
}

export interface IntentDefRow {
  id: string;
  name: string;
  description: string;
}

export interface IntentDefaultContextRow {
  intentId: string;
  targetKind: string;
  engagement: string;
  targetTagsJson: string | null;
  shipClass: string | null;
}

export interface IntentEffectWeightRow {
  intentId: string;
  effectKey: string;
  weight: number;
}

// ─── Joined Query Types ─────────────────────────────────────

/** Full officer ability with all joined effects, conditions, and applicability. */
export interface OfficerAbilityWithEffects extends OfficerAbilityRow {
  effects: AbilityEffectWithDetails[];
}

/** Effect with joined target kinds, tags, and conditions. */
export interface AbilityEffectWithDetails extends AbilityEffectRow {
  targetKinds: string[];
  targetTags: string[];
  conditions: { conditionKey: string; params: Record<string, string> | null }[];
}

/** Intent with default context and effect weights. */
export interface IntentWithWeights extends IntentDefRow {
  defaultContext: IntentDefaultContextRow | null;
  effectWeights: { effectKey: string; weight: number }[];
}

export type EffectDatasetRunStatus = "staged" | "active" | "retired" | "failed";

export interface EffectDatasetRunRow {
  runId: string;
  contentHash: string;
  datasetKind: string;
  sourceLabel: string;
  sourceVersion: string | null;
  snapshotId: string | null;
  status: EffectDatasetRunStatus;
  metricsJson: string | null;
  metadataJson: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface RegisterEffectDatasetRunInput {
  runId: string;
  contentHash: string;
  datasetKind: string;
  sourceLabel: string;
  sourceVersion?: string | null;
  snapshotId?: string | null;
  metricsJson?: string | null;
  metadataJson?: string | null;
  status?: EffectDatasetRunStatus;
}

export interface EffectDatasetRetentionResult {
  removedRunIds: string[];
  keptRunIds: string[];
}

export interface EffectReadOptions {
  runId?: string | null;
}

export interface SeedAbilityCatalogOptions {
  runId?: string;
}

// ─── Store Interface ────────────────────────────────────────

export interface EffectStore {
  // ── Taxonomy reads ──
  listTargetKinds(): Promise<string[]>;
  listTargetTags(): Promise<string[]>;
  listShipClasses(): Promise<string[]>;
  listEffectKeys(): Promise<EffectKeyRow[]>;
  listConditionKeys(): Promise<ConditionKeyRow[]>;
  listIssueTypes(): Promise<IssueTypeRow[]>;

  // ── Ability catalog reads ──
  getOfficerAbilities(officerId: string, options?: EffectReadOptions): Promise<OfficerAbilityWithEffects[]>;
  getOfficerAbilitiesBulk(officerIds: string[], options?: EffectReadOptions): Promise<Map<string, OfficerAbilityWithEffects[]>>;

  // ── Intent reads ──
  getIntent(intentId: string): Promise<IntentWithWeights | null>;
  listIntents(): Promise<IntentDefRow[]>;
  listIntentsFull(): Promise<IntentWithWeights[]>;
  getIntentWeights(intentId: string): Promise<Record<string, number>>;
  getIntentDefaultContext(intentId: string): Promise<IntentDefaultContextRow | null>;

  // ── Dataset run metadata / activation ──
  registerDatasetRun(input: RegisterEffectDatasetRunInput): Promise<EffectDatasetRunRow>;
  activateDatasetRun(runId: string): Promise<void>;
  getActiveDatasetRun(): Promise<EffectDatasetRunRow | null>;
  listDatasetRuns(limit?: number): Promise<EffectDatasetRunRow[]>;
  applyDatasetRunRetention(keepRuns: number): Promise<EffectDatasetRetentionResult>;

  // ── Seed / bulk writes ──
  seedTaxonomy(data: SeedTaxonomyData): Promise<SeedResult>;
  seedAbilityCatalog(abilities: SeedAbilityInput[], options?: SeedAbilityCatalogOptions): Promise<SeedResult>;
  seedIntents(intents: SeedIntentInput[]): Promise<SeedResult>;

  // ── Diagnostics ──
  counts(): Promise<EffectStoreCounts>;
  close(): void;
}

// ─── Seed Input Types ───────────────────────────────────────

export interface SeedTaxonomyData {
  targetKinds: string[];
  targetTags: string[];
  shipClasses: string[];
  slots: string[];
  effectKeys: { id: string; category: string }[];
  conditionKeys: { id: string; paramSchema?: string }[];
  issueTypes: { id: string; severity: string; defaultMessage: string }[];
}

export interface SeedAbilityInput {
  id: string;
  officerId: string;
  slot: "cm" | "oa" | "bda";
  name: string | null;
  rawText: string | null;
  isInert: boolean;
  effects: SeedEffectInput[];
}

export interface SeedEffectInput {
  id: string;
  effectKey: string;
  magnitude?: number | null;
  unit?: string | null;
  stacking?: string | null;
  targetKinds?: string[];
  targetTags?: string[];
  conditions?: { conditionKey: string; params?: Record<string, string> | null }[];
}

export interface SeedIntentInput {
  id: string;
  name: string;
  description: string;
  defaultContext?: {
    targetKind: string;
    engagement: string;
    targetTags?: string[];
    shipClass?: string | null;
  };
  effectWeights: { effectKey: string; weight: number }[];
}

export interface SeedResult {
  inserted: number;
  skipped: number;
}

export interface EffectStoreCounts {
  taxonomyTargetKinds: number;
  taxonomyTargetTags: number;
  taxonomyEffectKeys: number;
  taxonomyConditionKeys: number;
  taxonomyIssueTypes: number;
  catalogAbilities: number;
  catalogEffects: number;
  intentDefs: number;
  intentWeights: number;
}

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  // ── Taxonomy tables ──

  `CREATE TABLE IF NOT EXISTS taxonomy_target_kind (
    id TEXT PRIMARY KEY
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_target_tag (
    id TEXT PRIMARY KEY
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_ship_class (
    id TEXT PRIMARY KEY
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_slot (
    id TEXT PRIMARY KEY
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_effect_key (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_condition_key (
    id TEXT PRIMARY KEY,
    param_schema TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS taxonomy_issue_type (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL,
    default_message TEXT NOT NULL
  )`,

  // ── Ability catalog tables ──

  `CREATE TABLE IF NOT EXISTS catalog_officer_ability (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL DEFAULT 'seed-bootstrap',
    officer_id TEXT NOT NULL,
    slot TEXT NOT NULL REFERENCES taxonomy_slot(id),
    name TEXT,
    raw_text TEXT,
    is_inert BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_officer FOREIGN KEY (officer_id) REFERENCES reference_officers(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_catalog_officer_ability_officer ON catalog_officer_ability(officer_id)`,

  `CREATE TABLE IF NOT EXISTS catalog_ability_effect (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL DEFAULT 'seed-bootstrap',
    ability_id TEXT NOT NULL REFERENCES catalog_officer_ability(id) ON DELETE CASCADE,
    effect_key TEXT NOT NULL REFERENCES taxonomy_effect_key(id),
    magnitude REAL,
    unit TEXT,
    stacking TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS catalog_effect_value (
    id TEXT PRIMARY KEY,
    ability_effect_id TEXT NOT NULL REFERENCES catalog_ability_effect(id) ON DELETE CASCADE UNIQUE,
    magnitude REAL,
    unit TEXT,
    stacking TEXT,
    comparator TEXT,
    scale TEXT,
    raw_span_ref TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_catalog_ability_effect_ability ON catalog_ability_effect(ability_id)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_ability_effect_key ON catalog_ability_effect(effect_key)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_effect_value_effect ON catalog_effect_value(ability_effect_id)`,

  `ALTER TABLE catalog_officer_ability ADD COLUMN IF NOT EXISTS run_id TEXT`,
  `UPDATE catalog_officer_ability SET run_id = 'seed-bootstrap' WHERE run_id IS NULL`,
  `ALTER TABLE catalog_officer_ability ALTER COLUMN run_id SET DEFAULT 'seed-bootstrap'`,
  `ALTER TABLE catalog_officer_ability ALTER COLUMN run_id SET NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_officer_ability_run_officer ON catalog_officer_ability(run_id, officer_id)`,

  `ALTER TABLE catalog_ability_effect ADD COLUMN IF NOT EXISTS run_id TEXT`,
  `UPDATE catalog_ability_effect SET run_id = 'seed-bootstrap' WHERE run_id IS NULL`,
  `ALTER TABLE catalog_ability_effect ALTER COLUMN run_id SET DEFAULT 'seed-bootstrap'`,
  `ALTER TABLE catalog_ability_effect ALTER COLUMN run_id SET NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_ability_effect_run_ability ON catalog_ability_effect(run_id, ability_id)`,

  `CREATE TABLE IF NOT EXISTS catalog_ability_effect_target_kind (
    ability_effect_id TEXT NOT NULL REFERENCES catalog_ability_effect(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL REFERENCES taxonomy_target_kind(id),
    PRIMARY KEY (ability_effect_id, target_kind)
  )`,

  `CREATE TABLE IF NOT EXISTS catalog_ability_effect_target_tag (
    ability_effect_id TEXT NOT NULL REFERENCES catalog_ability_effect(id) ON DELETE CASCADE,
    target_tag TEXT NOT NULL REFERENCES taxonomy_target_tag(id),
    PRIMARY KEY (ability_effect_id, target_tag)
  )`,

  `CREATE TABLE IF NOT EXISTS catalog_ability_effect_condition (
    id TEXT PRIMARY KEY,
    ability_effect_id TEXT NOT NULL REFERENCES catalog_ability_effect(id) ON DELETE CASCADE,
    condition_key TEXT NOT NULL REFERENCES taxonomy_condition_key(id),
    params_json TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_catalog_effect_condition_effect ON catalog_ability_effect_condition(ability_effect_id)`,

  // ── Intent definition tables ──

  `CREATE TABLE IF NOT EXISTS intent_def (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS intent_default_context (
    intent_id TEXT PRIMARY KEY REFERENCES intent_def(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL REFERENCES taxonomy_target_kind(id),
    engagement TEXT NOT NULL DEFAULT 'any',
    target_tags_json TEXT,
    ship_class TEXT REFERENCES taxonomy_ship_class(id)
  )`,

  `CREATE TABLE IF NOT EXISTS intent_effect_weight (
    intent_id TEXT NOT NULL REFERENCES intent_def(id) ON DELETE CASCADE,
    effect_key TEXT NOT NULL REFERENCES taxonomy_effect_key(id),
    weight REAL NOT NULL,
    PRIMARY KEY (intent_id, effect_key)
  )`,

  // ── Dataset run metadata / active pointer tables ──

  `CREATE TABLE IF NOT EXISTS effect_dataset_run (
    run_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    dataset_kind TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_version TEXT,
    snapshot_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'retired', 'failed')),
    metrics_json TEXT,
    metadata_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS effect_dataset_active (
    scope TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES effect_dataset_run(run_id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_effect_dataset_run_status_created
    ON effect_dataset_run(status, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_effect_dataset_run_created
    ON effect_dataset_run(created_at DESC)`,
];

// ─── SQL Constants ──────────────────────────────────────────

const SQL = {
  // Taxonomy reads
  listTargetKinds: `SELECT id FROM taxonomy_target_kind ORDER BY id`,
  listTargetTags: `SELECT id FROM taxonomy_target_tag ORDER BY id`,
  listShipClasses: `SELECT id FROM taxonomy_ship_class ORDER BY id`,
  listEffectKeys: `SELECT id, category FROM taxonomy_effect_key ORDER BY category, id`,
  listConditionKeys: `SELECT id, param_schema AS "paramSchema" FROM taxonomy_condition_key ORDER BY id`,
  listIssueTypes: `SELECT id, severity, default_message AS "defaultMessage" FROM taxonomy_issue_type ORDER BY severity, id`,

  // Officer abilities + joined effects (single officer)
  getOfficerAbilities: `
    SELECT id, officer_id AS "officerId", slot, name, raw_text AS "rawText", is_inert AS "isInert"
    FROM catalog_officer_ability
    WHERE officer_id = $1 AND run_id = $2
    ORDER BY CASE slot WHEN 'cm' THEN 0 WHEN 'oa' THEN 1 WHEN 'bda' THEN 2 ELSE 3 END
  `,

  getAbilityEffects: `
    SELECT id, ability_id AS "abilityId", effect_key AS "effectKey",
           magnitude, unit, stacking
    FROM catalog_ability_effect
        WHERE ability_id = ANY($1) AND run_id = $2
    ORDER BY effect_key
  `,

  getEffectTargetKinds: `
    SELECT ability_effect_id AS "abilityEffectId", target_kind AS "targetKind"
    FROM catalog_ability_effect_target_kind
    WHERE ability_effect_id = ANY($1)
  `,

  getEffectTargetTags: `
    SELECT ability_effect_id AS "abilityEffectId", target_tag AS "targetTag"
    FROM catalog_ability_effect_target_tag
    WHERE ability_effect_id = ANY($1)
  `,

  getEffectConditions: `
    SELECT id, ability_effect_id AS "abilityEffectId", condition_key AS "conditionKey",
           params_json AS "paramsJson"
    FROM catalog_ability_effect_condition
    WHERE ability_effect_id = ANY($1)
  `,

  // Bulk officer abilities
  getOfficerAbilitiesBulk: `
    SELECT id, officer_id AS "officerId", slot, name, raw_text AS "rawText", is_inert AS "isInert"
    FROM catalog_officer_ability
    WHERE officer_id = ANY($1) AND run_id = $2
    ORDER BY officer_id, CASE slot WHEN 'cm' THEN 0 WHEN 'oa' THEN 1 WHEN 'bda' THEN 2 ELSE 3 END
  `,

  getLatestDatasetRunId: `
    SELECT run_id AS "runId"
    FROM effect_dataset_run
    WHERE status IN ('active', 'staged')
    ORDER BY created_at DESC
    LIMIT 1
  `,

  getLatestDatasetRunIdWithAbilities: `
    SELECT r.run_id AS "runId"
    FROM effect_dataset_run r
    WHERE r.status IN ('active', 'staged')
      AND EXISTS (
        SELECT 1
        FROM catalog_officer_ability a
        WHERE a.run_id = r.run_id
      )
    ORDER BY r.created_at DESC
    LIMIT 1
  `,

  runHasAbilities: `
    SELECT EXISTS(
      SELECT 1
      FROM catalog_officer_ability
      WHERE run_id = $1
    ) AS "exists"
  `,

  getAnyAbilityRunId: `
    SELECT run_id AS "runId"
    FROM catalog_officer_ability
    GROUP BY run_id
    ORDER BY run_id DESC
    LIMIT 1
  `,

  // Intent reads
  getIntent: `SELECT id, name, description FROM intent_def WHERE id = $1`,
  listIntents: `SELECT id, name, description FROM intent_def ORDER BY name`,
  listAllIntentWeights: `
    SELECT intent_id AS "intentId", effect_key AS "effectKey", weight
    FROM intent_effect_weight
    ORDER BY intent_id, weight DESC
  `,
  listAllIntentDefaultContexts: `
    SELECT intent_id AS "intentId", target_kind AS "targetKind", engagement,
           target_tags_json AS "targetTagsJson", ship_class AS "shipClass"
    FROM intent_default_context
  `,
  getIntentWeights: `
    SELECT effect_key AS "effectKey", weight
    FROM intent_effect_weight
    WHERE intent_id = $1
    ORDER BY weight DESC
  `,
  getIntentDefaultContext: `
    SELECT intent_id AS "intentId", target_kind AS "targetKind", engagement,
           target_tags_json AS "targetTagsJson", ship_class AS "shipClass"
    FROM intent_default_context
    WHERE intent_id = $1
  `,

  registerDatasetRun: `
    INSERT INTO effect_dataset_run (
      run_id, content_hash, dataset_kind, source_label, source_version, snapshot_id,
      status, metrics_json, metadata_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (run_id) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      dataset_kind = EXCLUDED.dataset_kind,
      source_label = EXCLUDED.source_label,
      source_version = EXCLUDED.source_version,
      snapshot_id = EXCLUDED.snapshot_id,
      status = EXCLUDED.status,
      metrics_json = EXCLUDED.metrics_json,
      metadata_json = EXCLUDED.metadata_json
    RETURNING
      run_id AS "runId",
      content_hash AS "contentHash",
      dataset_kind AS "datasetKind",
      source_label AS "sourceLabel",
      source_version AS "sourceVersion",
      snapshot_id AS "snapshotId",
      status,
      metrics_json AS "metricsJson",
      metadata_json AS "metadataJson",
      created_at::text AS "createdAt",
      activated_at::text AS "activatedAt"
  `,

  setRunStatus: `
    UPDATE effect_dataset_run
    SET status = $2,
        activated_at = CASE
          WHEN $2 = 'active' THEN now()
          ELSE activated_at
        END
    WHERE run_id = $1
  `,

  setAllActiveToRetired: `
    UPDATE effect_dataset_run
    SET status = 'retired'
    WHERE status = 'active' AND run_id <> $1
  `,

  upsertActivePointer: `
    INSERT INTO effect_dataset_active (scope, run_id, updated_at)
    VALUES ('global', $1, now())
    ON CONFLICT (scope) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      updated_at = now()
  `,

  getActiveDatasetRun: `
    SELECT
      r.run_id AS "runId",
      r.content_hash AS "contentHash",
      r.dataset_kind AS "datasetKind",
      r.source_label AS "sourceLabel",
      r.source_version AS "sourceVersion",
      r.snapshot_id AS "snapshotId",
      r.status,
      r.metrics_json AS "metricsJson",
      r.metadata_json AS "metadataJson",
      r.created_at::text AS "createdAt",
      r.activated_at::text AS "activatedAt"
    FROM effect_dataset_active a
    JOIN effect_dataset_run r ON r.run_id = a.run_id
    WHERE a.scope = 'global'
  `,

  listDatasetRuns: `
    SELECT
      run_id AS "runId",
      content_hash AS "contentHash",
      dataset_kind AS "datasetKind",
      source_label AS "sourceLabel",
      source_version AS "sourceVersion",
      snapshot_id AS "snapshotId",
      status,
      metrics_json AS "metricsJson",
      metadata_json AS "metadataJson",
      created_at::text AS "createdAt",
      activated_at::text AS "activatedAt"
    FROM effect_dataset_run
    ORDER BY created_at DESC
    LIMIT $1
  `,

  listRetentionCandidates: `
    SELECT
      run_id AS "runId",
      content_hash AS "contentHash",
      dataset_kind AS "datasetKind",
      source_label AS "sourceLabel",
      source_version AS "sourceVersion",
      snapshot_id AS "snapshotId",
      status,
      metrics_json AS "metricsJson",
      metadata_json AS "metadataJson",
      created_at::text AS "createdAt",
      activated_at::text AS "activatedAt"
    FROM effect_dataset_run
    WHERE run_id NOT IN (
      SELECT run_id FROM effect_dataset_active WHERE scope = 'global'
    )
    ORDER BY created_at DESC
  `,

  deleteDatasetRun: `DELETE FROM effect_dataset_run WHERE run_id = $1`,

  // Seed inserts (all use ON CONFLICT DO NOTHING for idempotent seeding)
  seedTargetKind: `INSERT INTO taxonomy_target_kind (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedTargetTag: `INSERT INTO taxonomy_target_tag (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedShipClass: `INSERT INTO taxonomy_ship_class (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedSlot: `INSERT INTO taxonomy_slot (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedEffectKey: `INSERT INTO taxonomy_effect_key (id, category) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
  seedConditionKey: `INSERT INTO taxonomy_condition_key (id, param_schema) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
  seedIssueType: `INSERT INTO taxonomy_issue_type (id, severity, default_message) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,

  seedOfficerAbility: `
    INSERT INTO catalog_officer_ability (id, run_id, officer_id, slot, name, raw_text, is_inert)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      name = EXCLUDED.name,
      raw_text = EXCLUDED.raw_text,
      is_inert = EXCLUDED.is_inert
  `,

  seedAbilityEffect: `
    INSERT INTO catalog_ability_effect (id, run_id, ability_id, effect_key, magnitude, unit, stacking)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      ability_id = EXCLUDED.ability_id,
      effect_key = EXCLUDED.effect_key,
      magnitude = EXCLUDED.magnitude,
      unit = EXCLUDED.unit,
      stacking = EXCLUDED.stacking
  `,

  seedEffectTargetKind: `
    INSERT INTO catalog_ability_effect_target_kind (ability_effect_id, target_kind)
    VALUES ($1, $2)
    ON CONFLICT (ability_effect_id, target_kind) DO NOTHING
  `,

  seedEffectTargetTag: `
    INSERT INTO catalog_ability_effect_target_tag (ability_effect_id, target_tag)
    VALUES ($1, $2)
    ON CONFLICT (ability_effect_id, target_tag) DO NOTHING
  `,

  seedEffectCondition: `
    INSERT INTO catalog_ability_effect_condition (id, ability_effect_id, condition_key, params_json)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      condition_key = EXCLUDED.condition_key,
      params_json = EXCLUDED.params_json
  `,

  seedIntentDef: `
    INSERT INTO intent_def (id, name, description)
    VALUES ($1, $2, $3)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description
  `,

  seedIntentDefaultContext: `
    INSERT INTO intent_default_context (intent_id, target_kind, engagement, target_tags_json, ship_class)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (intent_id) DO UPDATE SET
      target_kind = EXCLUDED.target_kind,
      engagement = EXCLUDED.engagement,
      target_tags_json = EXCLUDED.target_tags_json,
      ship_class = EXCLUDED.ship_class
  `,

  seedIntentEffectWeight: `
    INSERT INTO intent_effect_weight (intent_id, effect_key, weight)
    VALUES ($1, $2, $3)
    ON CONFLICT (intent_id, effect_key) DO UPDATE SET
      weight = EXCLUDED.weight
  `,

  // Counts
  counts: `
    SELECT
      (SELECT count(*) FROM taxonomy_target_kind)::int AS "taxonomyTargetKinds",
      (SELECT count(*) FROM taxonomy_target_tag)::int AS "taxonomyTargetTags",
      (SELECT count(*) FROM taxonomy_effect_key)::int AS "taxonomyEffectKeys",
      (SELECT count(*) FROM taxonomy_condition_key)::int AS "taxonomyConditionKeys",
      (SELECT count(*) FROM taxonomy_issue_type)::int AS "taxonomyIssueTypes",
      (SELECT count(*) FROM catalog_officer_ability)::int AS "catalogAbilities",
      (SELECT count(*) FROM catalog_ability_effect)::int AS "catalogEffects",
      (SELECT count(*) FROM intent_def)::int AS "intentDefs",
      (SELECT count(*) FROM intent_effect_weight)::int AS "intentWeights"
  `,
};

// ─── Factory ────────────────────────────────────────────────

export async function createEffectStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<EffectStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  async function runHasAbilities(runId: string): Promise<boolean> {
    const result = await pool.query<{ exists: boolean }>(SQL.runHasAbilities, [runId]);
    return Boolean(result.rows[0]?.exists);
  }

  async function resolveReadRunId(explicitRunId?: string | null): Promise<string | null> {
    if (explicitRunId && explicitRunId.trim().length > 0) {
      if (await runHasAbilities(explicitRunId)) return explicitRunId;
    }

    const latestWithAbilities = await pool.query<{ runId: string }>(SQL.getLatestDatasetRunIdWithAbilities);
    if (latestWithAbilities.rows[0]?.runId) return latestWithAbilities.rows[0].runId;

    const activeResult = await pool.query<EffectDatasetRunRow>(SQL.getActiveDatasetRun);
    const activeRunId = activeResult.rows[0]?.runId;
    if (activeRunId && await runHasAbilities(activeRunId)) return activeRunId;

    return null;
  }

  // ── Helpers ──

  async function assembleAbilityEffects(
    abilityRows: OfficerAbilityRow[],
    runId: string,
  ): Promise<OfficerAbilityWithEffects[]> {
    if (abilityRows.length === 0) return [];

    const abilityIds = abilityRows.map((a) => a.id);

    // Fetch effects for all abilities in one query
    const effectsResult = await pool.query<AbilityEffectRow>(SQL.getAbilityEffects, [abilityIds, runId]);
    const effectRows = effectsResult.rows;

    if (effectRows.length === 0) {
      return abilityRows.map((a) => ({ ...a, effects: [] }));
    }

    const effectIds = effectRows.map((e) => e.id);

    // Fetch all target kinds, tags, and conditions in parallel
    const [targetKindsResult, targetTagsResult, conditionsResult] = await Promise.all([
      pool.query<AbilityEffectTargetKindRow>(SQL.getEffectTargetKinds, [effectIds]),
      pool.query<AbilityEffectTargetTagRow>(SQL.getEffectTargetTags, [effectIds]),
      pool.query<AbilityEffectConditionRow>(SQL.getEffectConditions, [effectIds]),
    ]);

    // Index by ability_effect_id
    const kindsByEffect = new Map<string, string[]>();
    for (const row of targetKindsResult.rows) {
      const arr = kindsByEffect.get(row.abilityEffectId) ?? [];
      arr.push(row.targetKind);
      kindsByEffect.set(row.abilityEffectId, arr);
    }

    const tagsByEffect = new Map<string, string[]>();
    for (const row of targetTagsResult.rows) {
      const arr = tagsByEffect.get(row.abilityEffectId) ?? [];
      arr.push(row.targetTag);
      tagsByEffect.set(row.abilityEffectId, arr);
    }

    const condsByEffect = new Map<string, { conditionKey: string; params: Record<string, string> | null }[]>();
    for (const row of conditionsResult.rows) {
      const arr = condsByEffect.get(row.abilityEffectId) ?? [];
      arr.push({
        conditionKey: row.conditionKey,
        params: row.paramsJson ? JSON.parse(row.paramsJson) : null,
      });
      condsByEffect.set(row.abilityEffectId, arr);
    }

    // Assemble effects per ability
    const effectsByAbility = new Map<string, AbilityEffectWithDetails[]>();
    for (const effect of effectRows) {
      const detailed: AbilityEffectWithDetails = {
        ...effect,
        targetKinds: kindsByEffect.get(effect.id) ?? [],
        targetTags: tagsByEffect.get(effect.id) ?? [],
        conditions: condsByEffect.get(effect.id) ?? [],
      };
      const arr = effectsByAbility.get(effect.abilityId) ?? [];
      arr.push(detailed);
      effectsByAbility.set(effect.abilityId, arr);
    }

    return abilityRows.map((a) => ({
      ...a,
      effects: effectsByAbility.get(a.id) ?? [],
    }));
  }

  // ── Store implementation ──

  const store: EffectStore = {
    // ── Taxonomy reads ──

    async listTargetKinds() {
      const { rows } = await pool.query<TaxonomyRow>(SQL.listTargetKinds);
      return rows.map((r) => r.id);
    },

    async listTargetTags() {
      const { rows } = await pool.query<TaxonomyRow>(SQL.listTargetTags);
      return rows.map((r) => r.id);
    },

    async listShipClasses() {
      const { rows } = await pool.query<TaxonomyRow>(SQL.listShipClasses);
      return rows.map((r) => r.id);
    },

    async listEffectKeys() {
      const { rows } = await pool.query<EffectKeyRow>(SQL.listEffectKeys);
      return rows;
    },

    async listConditionKeys() {
      const { rows } = await pool.query<ConditionKeyRow>(SQL.listConditionKeys);
      return rows;
    },

    async listIssueTypes() {
      const { rows } = await pool.query<IssueTypeRow>(SQL.listIssueTypes);
      return rows;
    },

    // ── Ability catalog reads ──

    async getOfficerAbilities(officerId, options) {
      const runId = await resolveReadRunId(options?.runId ?? null);
      if (!runId) return [];
      const { rows } = await pool.query<OfficerAbilityRow>(SQL.getOfficerAbilities, [officerId, runId]);
      return assembleAbilityEffects(rows, runId);
    },

    async getOfficerAbilitiesBulk(officerIds, options) {
      if (officerIds.length === 0) return new Map();
      const runId = await resolveReadRunId(options?.runId ?? null);
      if (!runId) return new Map();
      const { rows } = await pool.query<OfficerAbilityRow>(SQL.getOfficerAbilitiesBulk, [officerIds, runId]);
      const assembled = await assembleAbilityEffects(rows, runId);

      const byOfficer = new Map<string, OfficerAbilityWithEffects[]>();
      for (const ability of assembled) {
        const arr = byOfficer.get(ability.officerId) ?? [];
        arr.push(ability);
        byOfficer.set(ability.officerId, arr);
      }
      return byOfficer;
    },

    // ── Intent reads ──

    async getIntent(intentId) {
      const { rows } = await pool.query<IntentDefRow>(SQL.getIntent, [intentId]);
      if (rows.length === 0) return null;

      const [ctx, weights] = await Promise.all([
        pool.query<IntentDefaultContextRow>(SQL.getIntentDefaultContext, [intentId]),
        pool.query<IntentEffectWeightRow>(SQL.getIntentWeights, [intentId]),
      ]);

      return {
        ...rows[0],
        defaultContext: ctx.rows[0] ?? null,
        effectWeights: weights.rows.map((w) => ({ effectKey: w.effectKey, weight: w.weight })),
      };
    },

    async listIntents() {
      const { rows } = await pool.query<IntentDefRow>(SQL.listIntents);
      return rows;
    },

    async listIntentsFull() {
      const [intentResult, weightsResult, contextsResult] = await Promise.all([
        pool.query<IntentDefRow>(SQL.listIntents),
        pool.query<IntentEffectWeightRow>(SQL.listAllIntentWeights),
        pool.query<IntentDefaultContextRow>(SQL.listAllIntentDefaultContexts),
      ]);

      const weightsByIntent = new Map<string, { effectKey: string; weight: number }[]>();
      for (const row of weightsResult.rows) {
        const arr = weightsByIntent.get(row.intentId) ?? [];
        arr.push({ effectKey: row.effectKey, weight: row.weight });
        weightsByIntent.set(row.intentId, arr);
      }

      const contextByIntent = new Map<string, IntentDefaultContextRow>();
      for (const row of contextsResult.rows) {
        contextByIntent.set(row.intentId, row);
      }

      return intentResult.rows.map((intent) => ({
        ...intent,
        defaultContext: contextByIntent.get(intent.id) ?? null,
        effectWeights: weightsByIntent.get(intent.id) ?? [],
      }));
    },

    async getIntentWeights(intentId) {
      const { rows } = await pool.query<IntentEffectWeightRow>(SQL.getIntentWeights, [intentId]);
      const weights: Record<string, number> = {};
      for (const row of rows) {
        weights[row.effectKey] = row.weight;
      }
      return weights;
    },

    async getIntentDefaultContext(intentId) {
      const { rows } = await pool.query<IntentDefaultContextRow>(SQL.getIntentDefaultContext, [intentId]);
      return rows[0] ?? null;
    },

    // ── Dataset run metadata / activation ──

    async registerDatasetRun(input) {
      const status: EffectDatasetRunStatus = input.status ?? "staged";
      const { rows } = await pool.query<EffectDatasetRunRow>(SQL.registerDatasetRun, [
        input.runId,
        input.contentHash,
        input.datasetKind,
        input.sourceLabel,
        input.sourceVersion ?? null,
        input.snapshotId ?? null,
        status,
        input.metricsJson ?? null,
        input.metadataJson ?? null,
      ]);
      return rows[0];
    },

    async activateDatasetRun(runId) {
      await withTransaction(pool, async (client) => {
        const exists = await client.query<{ exists: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM effect_dataset_run WHERE run_id = $1) AS exists",
          [runId],
        );
        if (!exists.rows[0]?.exists) {
          throw new Error(`Cannot activate missing effect dataset run '${runId}'`);
        }

        await client.query(SQL.setAllActiveToRetired, [runId]);
        await client.query(SQL.setRunStatus, [runId, "active"]);
        await client.query(SQL.upsertActivePointer, [runId]);
      });
    },

    async getActiveDatasetRun() {
      const { rows } = await pool.query<EffectDatasetRunRow>(SQL.getActiveDatasetRun);
      return rows[0] ?? null;
    },

    async listDatasetRuns(limit = 20) {
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
      const { rows } = await pool.query<EffectDatasetRunRow>(SQL.listDatasetRuns, [safeLimit]);
      return rows;
    },

    async applyDatasetRunRetention(keepRuns) {
      const keep = Number.isFinite(keepRuns) ? Math.max(0, Math.floor(keepRuns)) : 0;
      const { rows } = await pool.query<EffectDatasetRunRow>(SQL.listRetentionCandidates);
      const keptRunIds = rows.slice(0, keep).map((row) => row.runId);
      const toDelete = rows.slice(keep);
      for (const row of toDelete) {
        await pool.query(SQL.deleteDatasetRun, [row.runId]);
      }
      return {
        removedRunIds: toDelete.map((row) => row.runId),
        keptRunIds,
      };
    },

    // ── Seed / bulk writes ──

    async seedTaxonomy(data) {
      let inserted = 0;
      let skipped = 0;

      const count = (result: { rowCount: number | null }) =>
        result.rowCount && result.rowCount > 0 ? inserted++ : skipped++;

      for (const id of data.targetKinds) {
        count(await pool.query(SQL.seedTargetKind, [id]));
      }
      for (const id of data.targetTags) {
        count(await pool.query(SQL.seedTargetTag, [id]));
      }
      for (const id of data.shipClasses) {
        count(await pool.query(SQL.seedShipClass, [id]));
      }
      for (const id of data.slots) {
        count(await pool.query(SQL.seedSlot, [id]));
      }
      for (const ek of data.effectKeys) {
        count(await pool.query(SQL.seedEffectKey, [ek.id, ek.category]));
      }
      for (const ck of data.conditionKeys) {
        count(await pool.query(SQL.seedConditionKey, [ck.id, ck.paramSchema ?? null]));
      }
      for (const it of data.issueTypes) {
        count(await pool.query(SQL.seedIssueType, [it.id, it.severity, it.defaultMessage]));
      }

      log.boot.info({ inserted, skipped }, "effect taxonomy seeded");
      return { inserted, skipped };
    },

    async seedAbilityCatalog(abilities, options) {
      let inserted = 0;
      const skipped = 0;
      const runId = options?.runId ?? "seed-bootstrap-v2";

      for (const ability of abilities) {
        const scopedAbilityId = `${runId}:${ability.id}`;
        const res = await pool.query(SQL.seedOfficerAbility, [
          scopedAbilityId, runId, ability.officerId, ability.slot,
          ability.name, ability.rawText, ability.isInert,
        ]);
        if (res.rowCount && res.rowCount > 0) inserted++;

        for (const effect of ability.effects) {
          const scopedEffectId = `${runId}:${effect.id}`;
          await pool.query(SQL.seedAbilityEffect, [
            scopedEffectId, runId, scopedAbilityId, effect.effectKey,
            effect.magnitude ?? null, effect.unit ?? null, effect.stacking ?? null,
          ]);

          if (effect.targetKinds) {
            for (const tk of effect.targetKinds) {
              await pool.query(SQL.seedEffectTargetKind, [scopedEffectId, tk]);
            }
          }
          if (effect.targetTags) {
            for (const tt of effect.targetTags) {
              await pool.query(SQL.seedEffectTargetTag, [scopedEffectId, tt]);
            }
          }
          if (effect.conditions) {
            for (let ci = 0; ci < effect.conditions.length; ci++) {
              const cond = effect.conditions[ci];
              const condId = `${scopedEffectId}:cond:${ci}`;
              await pool.query(SQL.seedEffectCondition, [
                condId, scopedEffectId, cond.conditionKey,
                cond.params ? JSON.stringify(cond.params) : null,
              ]);
            }
          }
        }
      }

      log.boot.info({ inserted, skipped: abilities.length - inserted }, "ability catalog seeded");
      return { inserted, skipped };
    },

    async seedIntents(intents) {
      let inserted = 0;
      const skipped = 0;

      for (const intent of intents) {
        const res = await pool.query(SQL.seedIntentDef, [
          intent.id, intent.name, intent.description,
        ]);
        if (res.rowCount && res.rowCount > 0) inserted++;

        if (intent.defaultContext) {
          const ctx = intent.defaultContext;
          await pool.query(SQL.seedIntentDefaultContext, [
            intent.id, ctx.targetKind, ctx.engagement,
            ctx.targetTags ? JSON.stringify(ctx.targetTags) : null,
            ctx.shipClass ?? null,
          ]);
        }

        for (const ew of intent.effectWeights) {
          await pool.query(SQL.seedIntentEffectWeight, [
            intent.id, ew.effectKey, ew.weight,
          ]);
        }
      }

      log.boot.info({ inserted, skipped: intents.length - inserted }, "intent definitions seeded");
      return { inserted, skipped };
    },

    // ── Diagnostics ──

    async counts() {
      const { rows } = await pool.query<EffectStoreCounts>(SQL.counts);
      return rows[0];
    },

    close() {
      /* pool managed externally */
    },
  };

  return store;
}
