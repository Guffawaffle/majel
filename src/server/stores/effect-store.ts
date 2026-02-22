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

import { initSchema, type Pool } from "../db.js";
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
  getOfficerAbilities(officerId: string): Promise<OfficerAbilityWithEffects[]>;
  getOfficerAbilitiesBulk(officerIds: string[]): Promise<Map<string, OfficerAbilityWithEffects[]>>;

  // ── Intent reads ──
  getIntent(intentId: string): Promise<IntentWithWeights | null>;
  listIntents(): Promise<IntentDefRow[]>;
  listIntentsFull(): Promise<IntentWithWeights[]>;
  getIntentWeights(intentId: string): Promise<Record<string, number>>;
  getIntentDefaultContext(intentId: string): Promise<IntentDefaultContextRow | null>;

  // ── Seed / bulk writes ──
  seedTaxonomy(data: SeedTaxonomyData): Promise<SeedResult>;
  seedAbilityCatalog(abilities: SeedAbilityInput[]): Promise<SeedResult>;
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
    ability_id TEXT NOT NULL REFERENCES catalog_officer_ability(id) ON DELETE CASCADE,
    effect_key TEXT NOT NULL REFERENCES taxonomy_effect_key(id),
    magnitude REAL,
    unit TEXT,
    stacking TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_catalog_ability_effect_ability ON catalog_ability_effect(ability_id)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_ability_effect_key ON catalog_ability_effect(effect_key)`,

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
    WHERE officer_id = $1
    ORDER BY CASE slot WHEN 'cm' THEN 0 WHEN 'oa' THEN 1 WHEN 'bda' THEN 2 ELSE 3 END
  `,

  getAbilityEffects: `
    SELECT id, ability_id AS "abilityId", effect_key AS "effectKey",
           magnitude, unit, stacking
    FROM catalog_ability_effect
    WHERE ability_id = ANY($1)
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
    WHERE officer_id = ANY($1)
    ORDER BY officer_id, CASE slot WHEN 'cm' THEN 0 WHEN 'oa' THEN 1 WHEN 'bda' THEN 2 ELSE 3 END
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

  // Seed inserts (all use ON CONFLICT DO NOTHING for idempotent seeding)
  seedTargetKind: `INSERT INTO taxonomy_target_kind (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedTargetTag: `INSERT INTO taxonomy_target_tag (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedShipClass: `INSERT INTO taxonomy_ship_class (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedSlot: `INSERT INTO taxonomy_slot (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
  seedEffectKey: `INSERT INTO taxonomy_effect_key (id, category) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
  seedConditionKey: `INSERT INTO taxonomy_condition_key (id, param_schema) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
  seedIssueType: `INSERT INTO taxonomy_issue_type (id, severity, default_message) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,

  seedOfficerAbility: `
    INSERT INTO catalog_officer_ability (id, officer_id, slot, name, raw_text, is_inert)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      raw_text = EXCLUDED.raw_text,
      is_inert = EXCLUDED.is_inert
  `,

  seedAbilityEffect: `
    INSERT INTO catalog_ability_effect (id, ability_id, effect_key, magnitude, unit, stacking)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
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

  // ── Helpers ──

  async function assembleAbilityEffects(
    abilityRows: OfficerAbilityRow[],
  ): Promise<OfficerAbilityWithEffects[]> {
    if (abilityRows.length === 0) return [];

    const abilityIds = abilityRows.map((a) => a.id);

    // Fetch effects for all abilities in one query
    const effectsResult = await pool.query<AbilityEffectRow>(SQL.getAbilityEffects, [abilityIds]);
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

    async getOfficerAbilities(officerId) {
      const { rows } = await pool.query<OfficerAbilityRow>(SQL.getOfficerAbilities, [officerId]);
      return assembleAbilityEffects(rows);
    },

    async getOfficerAbilitiesBulk(officerIds) {
      if (officerIds.length === 0) return new Map();
      const { rows } = await pool.query<OfficerAbilityRow>(SQL.getOfficerAbilitiesBulk, [officerIds]);
      const assembled = await assembleAbilityEffects(rows);

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

    async seedAbilityCatalog(abilities) {
      let inserted = 0;
      const skipped = 0;

      for (const ability of abilities) {
        const res = await pool.query(SQL.seedOfficerAbility, [
          ability.id, ability.officerId, ability.slot,
          ability.name, ability.rawText, ability.isInert,
        ]);
        if (res.rowCount && res.rowCount > 0) inserted++;

        for (const effect of ability.effects) {
          await pool.query(SQL.seedAbilityEffect, [
            effect.id, ability.id, effect.effectKey,
            effect.magnitude ?? null, effect.unit ?? null, effect.stacking ?? null,
          ]);

          if (effect.targetKinds) {
            for (const tk of effect.targetKinds) {
              await pool.query(SQL.seedEffectTargetKind, [effect.id, tk]);
            }
          }
          if (effect.targetTags) {
            for (const tt of effect.targetTags) {
              await pool.query(SQL.seedEffectTargetTag, [effect.id, tt]);
            }
          }
          if (effect.conditions) {
            for (let ci = 0; ci < effect.conditions.length; ci++) {
              const cond = effect.conditions[ci];
              const condId = `${effect.id}:cond:${ci}`;
              await pool.query(SQL.seedEffectCondition, [
                condId, effect.id, cond.conditionKey,
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
