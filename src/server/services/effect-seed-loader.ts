/**
 * effect-seed-loader.ts — Loads effect taxonomy seed data (ADR-034 Phase A, #132)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Reads the effect-taxonomy.json seed file and calls the effect store's
 * seed methods to populate taxonomy, ability catalog, and intent definitions.
 * All inserts use ON CONFLICT DO NOTHING/UPDATE so this is idempotent.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffectStore, SeedAbilityInput, SeedIntentInput, SeedTaxonomyData } from "../stores/effect-store.js";
import { log } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(__dirname, "..", "..", "..", "data", "seed", "effect-taxonomy.json");
const OFFICER_FIXTURE_PATH = resolve(__dirname, "..", "..", "..", "data", "seed", "effect-taxonomy.officer-fixture.v1.json");

interface SeedFile {
  taxonomy: SeedTaxonomyData;
  intents: SeedIntentInput[];
  officers: (SeedAbilityInput & { _comment?: string })[];
}

interface OfficerFixtureFile {
  schemaVersion: "1.0.0";
  source: "effect-taxonomy.json";
  officers: (SeedAbilityInput & { _comment?: string })[];
}

/**
 * Load and apply the effect taxonomy seed data.
 *
 * Reads from data/seed/effect-taxonomy.json and calls:
 *   1. store.seedTaxonomy() — taxonomy tables
 *   2. store.seedIntents() — intent definitions + effect weights
 *   3. store.seedAbilityCatalog() — officer ability → effect mappings
 *
 * Safe to call repeatedly — all inserts are idempotent.
 */
export async function loadEffectSeedData(store: EffectStore): Promise<{
  taxonomy: { inserted: number; skipped: number };
  intents: { inserted: number; skipped: number };
  abilities: { inserted: number; skipped: number };
}> {
  const raw = await readFile(SEED_PATH, "utf-8");
  const data: SeedFile = JSON.parse(raw);

  try {
    const fixtureRaw = await readFile(OFFICER_FIXTURE_PATH, "utf-8");
    const fixture = JSON.parse(fixtureRaw) as OfficerFixtureFile;
    if (Array.isArray(fixture.officers)) {
      data.officers = fixture.officers;
    }
  } catch {
    data.officers = data.officers ?? [];
  }

  // 1. Seed taxonomy (must go first — FK dependencies)
  const taxonomy = await store.seedTaxonomy(data.taxonomy);

  // 2. Seed intents (depends on taxonomy_target_kind, taxonomy_effect_key)
  const intents = await store.seedIntents(data.intents);

  // 3. Seed officer abilities (depends on taxonomy_slot, taxonomy_effect_key, taxonomy_target_kind, taxonomy_target_tag, taxonomy_condition_key)
  // Strip _comment fields
  const abilities = data.officers.map(({ _comment, ...rest }) => rest);
  const abilitiesResult = await store.seedAbilityCatalog(abilities);

  log.boot.info(
    {
      taxonomy: `${taxonomy.inserted} inserted, ${taxonomy.skipped} existing`,
      intents: `${intents.inserted} inserted, ${intents.skipped} existing`,
      abilities: `${abilitiesResult.inserted} inserted, ${abilitiesResult.skipped} existing`,
    },
    "effect taxonomy seed complete",
  );

  return { taxonomy, intents, abilities: abilitiesResult };
}
