/**
 * effect-store.test.ts — Tests for the effect taxonomy store (ADR-034)
 *
 * PostgreSQL integration tests covering taxonomy seeding, intent CRUD,
 * ability catalog operations, and dataset run lifecycle.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createEffectStore, type EffectStore, type SeedTaxonomyData, type SeedIntentInput, type SeedAbilityInput } from "../src/server/stores/effect-store.js";

// ─── Fixtures ───────────────────────────────────────────────

const TAXONOMY: SeedTaxonomyData = {
  targetKinds: ["ship", "station", "crew"],
  targetTags: ["explorer", "battleship", "interceptor"],
  shipClasses: ["explorer", "battleship", "interceptor", "survey"],
  slots: ["cm", "oa", "bda"],
  effectKeys: [
    { id: "attack_boost", category: "offense" },
    { id: "defense_boost", category: "defense" },
    { id: "shield_regen", category: "defense" },
    { id: "mining_speed", category: "utility" },
  ],
  conditionKeys: [
    { id: "is_in_combat" },
    { id: "below_hp_threshold", paramSchema: '{"threshold":"number"}' },
  ],
  issueTypes: [
    { id: "missing_effect", severity: "warning", defaultMessage: "No effect mapped" },
    { id: "ambiguous_text", severity: "info", defaultMessage: "Ability text is ambiguous" },
  ],
};

function makeIntent(overrides: Partial<SeedIntentInput> = {}): SeedIntentInput {
  return {
    id: overrides.id ?? "test-intent-pvp",
    name: overrides.name ?? "PvP Combat",
    description: overrides.description ?? "Optimize for player combat",
    defaultContext: overrides.defaultContext ?? {
      targetKind: "ship",
      engagement: "hostile",
      targetTags: ["battleship"],
      shipClass: "battleship",
    },
    effectWeights: overrides.effectWeights ?? [
      { effectKey: "attack_boost", weight: 1.0 },
      { effectKey: "defense_boost", weight: 0.8 },
    ],
  };
}

function makeAbility(overrides: Partial<SeedAbilityInput> = {}): SeedAbilityInput {
  return {
    id: overrides.id ?? "kirk-cm",
    officerId: overrides.officerId ?? "test-officer-1",
    slot: overrides.slot ?? "cm",
    name: overrides.name ?? "Inspire",
    rawText: overrides.rawText ?? "Increases all crew stats",
    isInert: overrides.isInert ?? false,
    effects: overrides.effects ?? [
      {
        id: "kirk-cm-e1",
        effectKey: "attack_boost",
        magnitude: 0.25,
        unit: "percent",
        stacking: "additive",
        targetKinds: ["ship"],
        targetTags: ["explorer"],
        conditions: [{ conditionKey: "is_in_combat" }],
      },
    ],
  };
}

// ─── Setup ──────────────────────────────────────────────────

let pool: Pool;
let store: EffectStore;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await cleanDatabase(pool);
  // Effect store has FK to reference_officers — create a stub table
  await pool.query(`CREATE TABLE IF NOT EXISTS reference_officers (id TEXT PRIMARY KEY)`);
  await pool.query(`INSERT INTO reference_officers (id) VALUES ('test-officer-1'), ('test-officer-2')`);
  store = await createEffectStore(pool);
});

afterAll(async () => {
  await pool.end();
});

// ─── Taxonomy Seeding ───────────────────────────────────────

describe("seedTaxonomy", () => {
  it("inserts taxonomy entries and returns counts", async () => {
    const result = await store.seedTaxonomy(TAXONOMY);
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.inserted + result.skipped).toBe(
      TAXONOMY.targetKinds.length +
      TAXONOMY.targetTags.length +
      TAXONOMY.shipClasses.length +
      TAXONOMY.slots.length +
      TAXONOMY.effectKeys.length +
      TAXONOMY.conditionKeys.length +
      TAXONOMY.issueTypes.length,
    );
  });

  it("is idempotent — second run skips all", async () => {
    await store.seedTaxonomy(TAXONOMY);
    const result = await store.seedTaxonomy(TAXONOMY);
    expect(result.skipped).toBe(
      TAXONOMY.targetKinds.length +
      TAXONOMY.targetTags.length +
      TAXONOMY.shipClasses.length +
      TAXONOMY.slots.length +
      TAXONOMY.effectKeys.length +
      TAXONOMY.conditionKeys.length +
      TAXONOMY.issueTypes.length,
    );
    expect(result.inserted).toBe(0);
  });
});

// ─── Taxonomy Reads ─────────────────────────────────────────

describe("taxonomy reads", () => {
  beforeEach(async () => {
    await store.seedTaxonomy(TAXONOMY);
  });

  it("listTargetKinds returns seeded kinds", async () => {
    const kinds = await store.listTargetKinds();
    expect(kinds).toEqual(expect.arrayContaining(["ship", "station", "crew"]));
    expect(kinds.length).toBe(3);
  });

  it("listTargetTags returns seeded tags", async () => {
    const tags = await store.listTargetTags();
    expect(tags).toEqual(expect.arrayContaining(["explorer", "battleship", "interceptor"]));
  });

  it("listShipClasses returns seeded classes", async () => {
    const classes = await store.listShipClasses();
    expect(classes).toEqual(expect.arrayContaining(["explorer", "battleship", "interceptor", "survey"]));
  });

  it("listEffectKeys returns keys with categories", async () => {
    const keys = await store.listEffectKeys();
    expect(keys.length).toBe(4);
    const attackKey = keys.find((k) => k.id === "attack_boost");
    expect(attackKey?.category).toBe("offense");
  });

  it("listConditionKeys returns keys with param schemas", async () => {
    const keys = await store.listConditionKeys();
    expect(keys.length).toBe(2);
    const hpKey = keys.find((k) => k.id === "below_hp_threshold");
    expect(hpKey?.paramSchema).toBe('{"threshold":"number"}');
    const combatKey = keys.find((k) => k.id === "is_in_combat");
    expect(combatKey?.paramSchema).toBeNull();
  });

  it("listIssueTypes returns types with severity and message", async () => {
    const types = await store.listIssueTypes();
    expect(types.length).toBe(2);
    const missing = types.find((t) => t.id === "missing_effect");
    expect(missing?.severity).toBe("warning");
    expect(missing?.defaultMessage).toBe("No effect mapped");
  });
});

// ─── Intent Seeding & Reads ─────────────────────────────────

describe("intent operations", () => {
  beforeEach(async () => {
    await store.seedTaxonomy(TAXONOMY);
  });

  it("seedIntents inserts intent definitions", async () => {
    const intent = makeIntent();
    const result = await store.seedIntents([intent]);
    expect(result.inserted).toBe(1);
  });

  it("seedIntents is idempotent", async () => {
    const intent = makeIntent();
    await store.seedIntents([intent]);
    const result = await store.seedIntents([intent]);
    // ON CONFLICT DO UPDATE counts as a row affected, so inserted stays 1
    expect(result.inserted).toBe(1);
  });

  it("getIntent returns null for missing intent", async () => {
    const result = await store.getIntent("nonexistent");
    expect(result).toBeNull();
  });

  it("getIntent returns intent with weights and context", async () => {
    const intent = makeIntent();
    await store.seedIntents([intent]);
    const result = await store.getIntent("test-intent-pvp");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("PvP Combat");
    expect(result!.description).toBe("Optimize for player combat");
    expect(result!.effectWeights.length).toBe(2);
    expect(result!.effectWeights[0].effectKey).toBe("attack_boost");
    expect(result!.defaultContext).not.toBeNull();
    expect(result!.defaultContext!.targetKind).toBe("ship");
    expect(result!.defaultContext!.engagement).toBe("hostile");
  });

  it("listIntents returns all intent definitions", async () => {
    await store.seedIntents([
      makeIntent({ id: "intent-1", name: "Alpha" }),
      makeIntent({ id: "intent-2", name: "Beta" }),
    ]);
    const intents = await store.listIntents();
    expect(intents.length).toBe(2);
  });

  it("listIntentsFull returns intents with weights and context", async () => {
    await store.seedIntents([makeIntent()]);
    const intents = await store.listIntentsFull();
    expect(intents.length).toBe(1);
    expect(intents[0].effectWeights.length).toBe(2);
    expect(intents[0].defaultContext).not.toBeNull();
  });

  it("getIntentWeights returns a weight map", async () => {
    await store.seedIntents([makeIntent()]);
    const weights = await store.getIntentWeights("test-intent-pvp");
    expect(weights.attack_boost).toBe(1.0);
    expect(weights.defense_boost).toBeCloseTo(0.8);
  });

  it("getIntentDefaultContext returns context or null", async () => {
    await store.seedIntents([makeIntent()]);
    const ctx = await store.getIntentDefaultContext("test-intent-pvp");
    expect(ctx).not.toBeNull();
    expect(ctx!.shipClass).toBe("battleship");

    const missing = await store.getIntentDefaultContext("nonexistent");
    expect(missing).toBeNull();
  });

  it("seedIntents handles intent without defaultContext", async () => {
    const intent: SeedIntentInput = {
      id: "no-ctx",
      name: "No Context",
      description: "Intent with no default context",
      effectWeights: [{ effectKey: "attack_boost", weight: 0.5 }],
    };
    await store.seedIntents([intent]);
    const result = await store.getIntent("no-ctx");
    expect(result).not.toBeNull();
    expect(result!.defaultContext).toBeNull();
  });
});

// ─── Dataset Run Lifecycle ──────────────────────────────────

describe("dataset run lifecycle", () => {
  it("registerDatasetRun creates a new run", async () => {
    const run = await store.registerDatasetRun({
      runId: "run-1",
      contentHash: "abc123",
      datasetKind: "deterministic",
      sourceLabel: "test",
    });
    expect(run.runId).toBe("run-1");
    expect(run.contentHash).toBe("abc123");
    expect(run.status).toBe("staged");
  });

  it("registerDatasetRun defaults status to staged", async () => {
    const run = await store.registerDatasetRun({
      runId: "run-2",
      contentHash: "def456",
      datasetKind: "deterministic",
      sourceLabel: "test",
    });
    expect(run.status).toBe("staged");
  });

  it("registerDatasetRun upserts on conflict", async () => {
    await store.registerDatasetRun({
      runId: "run-3",
      contentHash: "hash-v1",
      datasetKind: "deterministic",
      sourceLabel: "test-v1",
    });
    const updated = await store.registerDatasetRun({
      runId: "run-3",
      contentHash: "hash-v1",
      datasetKind: "deterministic",
      sourceLabel: "test-v2",
    });
    expect(updated.sourceLabel).toBe("test-v2");
  });

  it("activateDatasetRun sets run to active and retires others", async () => {
    await store.registerDatasetRun({
      runId: "run-a",
      contentHash: "hash-a",
      datasetKind: "deterministic",
      sourceLabel: "test",
    });
    await store.registerDatasetRun({
      runId: "run-b",
      contentHash: "hash-b",
      datasetKind: "deterministic",
      sourceLabel: "test",
    });
    await store.activateDatasetRun("run-a");
    await store.activateDatasetRun("run-b");

    const active = await store.getActiveDatasetRun();
    expect(active).not.toBeNull();
    expect(active!.runId).toBe("run-b");
    expect(active!.status).toBe("active");

    // run-a should now be retired
    const runs = await store.listDatasetRuns();
    const runA = runs.find((r) => r.runId === "run-a");
    expect(runA?.status).toBe("retired");
  });

  it("activateDatasetRun throws for missing run", async () => {
    await expect(store.activateDatasetRun("nonexistent")).rejects.toThrow("Cannot activate missing");
  });

  it("getActiveDatasetRun returns null when none active", async () => {
    const result = await store.getActiveDatasetRun();
    expect(result).toBeNull();
  });

  it("listDatasetRuns respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.registerDatasetRun({
        runId: `run-${i}`,
        contentHash: `hash-${i}`,
        datasetKind: "deterministic",
        sourceLabel: "test",
      });
    }
    const runs = await store.listDatasetRuns(3);
    expect(runs.length).toBe(3);
  });

  it("applyDatasetRunRetention removes old runs", async () => {
    for (let i = 0; i < 5; i++) {
      await store.registerDatasetRun({
        runId: `ret-${i}`,
        contentHash: `hash-ret-${i}`,
        datasetKind: "deterministic",
        sourceLabel: "test",
      });
    }
    // Activate one so it's excluded from retention candidates
    await store.activateDatasetRun("ret-4");

    const result = await store.applyDatasetRunRetention(2);
    // Kept 2, removed the rest of non-active runs
    expect(result.keptRunIds.length).toBe(2);
    expect(result.removedRunIds.length).toBeGreaterThan(0);
  });
});

// ─── Ability Catalog ────────────────────────────────────────

describe("ability catalog", () => {
  const RUN_ID = "test-run-1";

  beforeEach(async () => {
    await store.seedTaxonomy(TAXONOMY);
    await store.registerDatasetRun({
      runId: RUN_ID,
      contentHash: "ability-hash",
      datasetKind: "deterministic",
      sourceLabel: "test",
    });
    await store.activateDatasetRun(RUN_ID);
  });

  it("seedAbilityCatalog inserts abilities with effects", async () => {
    const ability = makeAbility();
    const result = await store.seedAbilityCatalog([ability], { runId: RUN_ID });
    expect(result.inserted).toBe(1);
  });

  it("getOfficerAbilities returns abilities with full effect details", async () => {
    const ability = makeAbility();
    await store.seedAbilityCatalog([ability], { runId: RUN_ID });

    const abilities = await store.getOfficerAbilities("test-officer-1", { runId: RUN_ID });
    expect(abilities.length).toBe(1);
    expect(abilities[0].slot).toBe("cm");
    expect(abilities[0].name).toBe("Inspire");
    expect(abilities[0].isInert).toBe(false);

    expect(abilities[0].effects.length).toBe(1);
    const effect = abilities[0].effects[0];
    expect(effect.effectKey).toBe("attack_boost");
    expect(effect.magnitude).toBeCloseTo(0.25);
    expect(effect.unit).toBe("percent");
    expect(effect.targetKinds).toEqual(["ship"]);
    expect(effect.targetTags).toEqual(["explorer"]);
    expect(effect.conditions.length).toBe(1);
    expect(effect.conditions[0].conditionKey).toBe("is_in_combat");
  });

  it("getOfficerAbilities returns empty for unknown officer", async () => {
    const abilities = await store.getOfficerAbilities("nonexistent", { runId: RUN_ID });
    expect(abilities).toEqual([]);
  });

  it("getOfficerAbilities returns empty when no run exists", async () => {
    // Clean database has no runs with abilities
    await cleanDatabase(pool);
    await pool.query(`CREATE TABLE IF NOT EXISTS reference_officers (id TEXT PRIMARY KEY)`);
    store = await createEffectStore(pool);
    const abilities = await store.getOfficerAbilities("test-officer-1");
    expect(abilities).toEqual([]);
  });

  it("getOfficerAbilitiesBulk returns abilities grouped by officer", async () => {
    const ability1 = makeAbility({ id: "kirk-cm", officerId: "test-officer-1", slot: "cm" });
    const ability2 = makeAbility({ id: "spock-oa", officerId: "test-officer-2", slot: "oa", name: "Logic" });
    await store.seedAbilityCatalog([ability1, ability2], { runId: RUN_ID });

    const result = await store.getOfficerAbilitiesBulk(
      ["test-officer-1", "test-officer-2"],
      { runId: RUN_ID },
    );
    expect(result.size).toBe(2);
    expect(result.get("test-officer-1")?.length).toBe(1);
    expect(result.get("test-officer-2")?.length).toBe(1);
    expect(result.get("test-officer-2")?.[0].name).toBe("Logic");
  });

  it("getOfficerAbilitiesBulk returns empty map for empty input", async () => {
    const result = await store.getOfficerAbilitiesBulk([]);
    expect(result.size).toBe(0);
  });

  it("seedAbilityCatalog handles abilities with multiple effects", async () => {
    const ability = makeAbility({
      effects: [
        { id: "e1", effectKey: "attack_boost", magnitude: 0.3, targetKinds: ["ship"] },
        { id: "e2", effectKey: "defense_boost", magnitude: 0.2, targetKinds: ["station"] },
      ],
    });
    await store.seedAbilityCatalog([ability], { runId: RUN_ID });

    const abilities = await store.getOfficerAbilities("test-officer-1", { runId: RUN_ID });
    expect(abilities[0].effects.length).toBe(2);
  });

  it("seedAbilityCatalog handles inert abilities with no effects", async () => {
    const ability = makeAbility({ id: "inert-1", isInert: true, effects: [] });
    await store.seedAbilityCatalog([ability], { runId: RUN_ID });

    const abilities = await store.getOfficerAbilities("test-officer-1", { runId: RUN_ID });
    expect(abilities[0].isInert).toBe(true);
    expect(abilities[0].effects).toEqual([]);
  });

  it("seedAbilityCatalog handles effects with conditions and params", async () => {
    const ability = makeAbility({
      effects: [
        {
          id: "e-cond",
          effectKey: "defense_boost",
          magnitude: 0.5,
          conditions: [
            { conditionKey: "below_hp_threshold", params: { threshold: "0.5" } },
          ],
        },
      ],
    });
    await store.seedAbilityCatalog([ability], { runId: RUN_ID });

    const abilities = await store.getOfficerAbilities("test-officer-1", { runId: RUN_ID });
    const cond = abilities[0].effects[0].conditions[0];
    expect(cond.conditionKey).toBe("below_hp_threshold");
    expect(cond.params).toEqual({ threshold: "0.5" });
  });
});

// ─── Counts ─────────────────────────────────────────────────

describe("counts", () => {
  it("returns zero counts on empty store", async () => {
    const c = await store.counts();
    expect(c.taxonomyTargetKinds).toBe(0);
    expect(c.taxonomyEffectKeys).toBe(0);
    expect(c.catalogAbilities).toBe(0);
    expect(c.intentDefs).toBe(0);
  });

  it("returns accurate counts after seeding", async () => {
    await store.seedTaxonomy(TAXONOMY);
    await store.seedIntents([makeIntent()]);

    const c = await store.counts();
    expect(c.taxonomyTargetKinds).toBe(3);
    expect(c.taxonomyTargetTags).toBe(3);
    expect(c.taxonomyEffectKeys).toBe(4);
    expect(c.taxonomyConditionKeys).toBe(2);
    expect(c.taxonomyIssueTypes).toBe(2);
    expect(c.intentDefs).toBe(1);
    expect(c.intentWeights).toBe(2);
  });
});
