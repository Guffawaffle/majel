#!/usr/bin/env tsx
/**
 * seed-cloud-db.ts — One-Time CDN Data Seed to Cloud DB
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Seeds the cloud PostgreSQL database with CDN snapshot data.
 * Requires Cloud SQL Auth Proxy running locally (npx tsx scripts/cloud.ts ssh).
 *
 * Usage:
 *   # Terminal 1: Start the Cloud SQL proxy
 *   npx tsx scripts/cloud.ts ssh
 *
 *   # Terminal 2: Run the seed script
 *   npx tsx scripts/seed-cloud-db.ts
 *
 * The script reads from local data/.stfc-snapshot/ and writes to the cloud DB.
 * This is a one-time migration — run it once after the snapshot is prepared.
 *
 * @see docs/ADR-028-data-pipeline-roadmap.md
 */

import pg from "pg";
import { existsSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SNAPSHOT_DIR = resolve(ROOT, "data", ".stfc-snapshot");

// Cloud DB connection - supports either:
// 1. DATABASE_URL (full postgres:// URL)
// 2. Individual env vars (CLOUD_DB_HOST, CLOUD_DB_PASSWORD)
// 3. Default: localhost:5433 via Cloud SQL proxy
function getDbConfig(): { connectionString?: string; host?: string; port?: number; database?: string; user?: string; password?: string; ssl?: { rejectUnauthorized: boolean } } {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.CLOUD_DB_HOST || "127.0.0.1",
    port: parseInt(process.env.CLOUD_DB_PORT || "5433", 10),
    database: "majel",
    user: "postgres",
    password: process.env.CLOUD_DB_PASSWORD || "",
    ssl: process.env.CLOUD_DB_HOST ? { rejectUnauthorized: false } : undefined,
  };
}

// ─── Enum Maps (from game-enums.ts) ─────────────────────────

const HULL_TYPE_LABELS: Record<number, string> = {
  0: "Unknown", 1: "Mining", 2: "Explorer", 3: "Interceptor",
  4: "Survey", 5: "Battleship", 6: "Armada", 7: "Faction Armada",
};

const RARITY_LABELS: Record<number, string> = {
  1: "common", 2: "uncommon", 3: "rare", 4: "epic", 5: "legendary",
};

const OFFICER_CLASS_LABELS: Record<number, string> = {
  1: "Command", 2: "Science", 3: "Engineering",
};

const FACTION_LABELS: Record<number, string> = {
  2064723306: "Federation", 2103576126: "Romulan", 862505714: "Klingon",
  1068994017: "Augment", 1947299029: "Rogue", 1: "Independent", 0: "Neutral",
};

// ─── Helpers ────────────────────────────────────────────────

function stripColorTags(text: string): string {
  return text.replace(/<\/?color[^>]*>/gi, "").trim();
}

interface TranslationEntry {
  id: number | null;
  key: string;
  text: string;
}

async function loadTranslationPack(pack: string): Promise<TranslationEntry[]> {
  const path = join(SNAPSHOT_DIR, "translations", "en", `${pack}.json`);
  try {
    await access(path);
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as TranslationEntry[];
  } catch {
    console.warn(`⚠️  Translation pack not found: ${pack}`);
    return [];
  }
}

function buildNameMap(entries: TranslationEntry[], nameKey: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const e of entries) {
    if (e.id != null && e.key === nameKey) {
      map.set(e.id, e.text);
    }
  }
  return map;
}

function buildAbilityTextMap(entries: TranslationEntry[]): Map<number, { name: string; description: string; shortDescription: string }> {
  const map = new Map<number, { name: string; description: string; shortDescription: string }>();
  for (const e of entries) {
    if (e.id == null) continue;
    const existing = map.get(e.id) ?? { name: "", description: "", shortDescription: "" };
    if (e.key === "officer_ability_name") existing.name = e.text;
    else if (e.key === "officer_ability_desc") existing.description = stripColorTags(e.text);
    else if (e.key === "officer_ability_short_desc") existing.shortDescription = stripColorTags(e.text);
    map.set(e.id, existing);
  }
  return map;
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🌱 Majel CDN → Cloud DB Seed");
  console.log("════════════════════════════════════════");

  // Check snapshot exists
  if (!existsSync(SNAPSHOT_DIR)) {
    console.error("❌ CDN snapshot not found at:", SNAPSHOT_DIR);
    console.error("   Run: node scripts/stfc-snapshot.mjs");
    process.exit(1);
  }

  // Get DB config
  const dbConfig = getDbConfig();
  
  // Check we have credentials
  if (!dbConfig.connectionString && !dbConfig.password) {
    console.error("❌ Database credentials not set");
    console.error("   Options:");
    console.error("   1. DATABASE_URL=postgres://... npx tsx scripts/seed-cloud-db.ts");
    console.error("   2. CLOUD_DB_HOST=x.x.x.x CLOUD_DB_PASSWORD=xxx npx tsx scripts/seed-cloud-db.ts");
    console.error("   3. Start proxy + CLOUD_DB_PASSWORD=xxx npx tsx scripts/seed-cloud-db.ts");
    process.exit(1);
  }

  // Test connection
  const hostInfo = dbConfig.connectionString ? "DATABASE_URL" : `${dbConfig.host}:${dbConfig.port}`;
  console.log(`📡 Connecting to Cloud DB (${hostInfo})...`);
  const pool = new pg.Pool(dbConfig);
  
  try {
    const { rows } = await pool.query("SELECT 1 as test");
    if (rows[0]?.test !== 1) throw new Error("Connection test failed");
    console.log("✅ Connected to Cloud DB");
  } catch (err) {
    console.error("❌ Failed to connect to Cloud DB");
    console.error("   Error:", err instanceof Error ? err.message : String(err));
    if (!dbConfig.connectionString && dbConfig.host === "127.0.0.1") {
      console.error("   Is Cloud SQL proxy running? npx tsx scripts/cloud.ts ssh");
    }
    process.exit(1);
  }

  // Check current counts
  const { rows: countRows } = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM reference_officers) as officers,
      (SELECT COUNT(*) FROM reference_ships) as ships
  `);
  console.log(`📊 Current DB state: ${countRows[0].officers} officers, ${countRows[0].ships} ships`);

  // Load translations
  console.log("📖 Loading translations...");
  const shipTranslations = await loadTranslationPack("ships");
  const shipNameMap = buildNameMap(shipTranslations, "ship_name");
  const shipAbilityNameMap = buildNameMap(shipTranslations, "ship_ability_name");
  const shipAbilityDescMap = buildNameMap(shipTranslations, "ship_ability_desc");

  const officerNames = await loadTranslationPack("officer_names");
  const officerBuffs = await loadTranslationPack("officer_buffs");
  const officerNameMap = buildNameMap(officerNames, "officer_name");
  const officerAbilityTextMap = buildAbilityTextMap(officerBuffs);

  const factionTrans = await loadTranslationPack("factions");
  const factionNameMap = buildNameMap(factionTrans, "faction_name");

  const traitTrans = await loadTranslationPack("traits");
  const traitNameMap = buildNameMap(traitTrans, "trait_name");

  // ─── Sync Ships ───────────────────────────────────────────
  console.log("\n🚀 Syncing ships...");
  const shipSummaryPath = join(SNAPSHOT_DIR, "ship", "summary.json");
  if (!existsSync(shipSummaryPath)) {
    console.warn("⚠️  Ship summary not found, skipping ships");
  } else {
    const shipSummary = JSON.parse(await readFile(shipSummaryPath, "utf-8"));
    let shipCreated = 0, shipUpdated = 0;

    for (const ship of shipSummary) {
      const id = `cdn:ship:${ship.id}`;
      const name = shipNameMap.get(ship.loca_id) ?? `Ship ${ship.id}`;
      const factionId = ship.faction?.id ?? null;
      const factionName = factionId != null && factionId !== -1 ? (FACTION_LABELS[factionId] ?? null) : null;
      const hullTypeName = HULL_TYPE_LABELS[ship.hull_type] ?? null;
      const rarityStr = typeof ship.rarity === "string" ? ship.rarity.toLowerCase() : (RARITY_LABELS[ship.rarity] ?? null);

      // Try to load detail
      let detail = null;
      try {
        const detailPath = join(SNAPSHOT_DIR, "ship", `${ship.id}.json`);
        if (existsSync(detailPath)) {
          detail = JSON.parse(await readFile(detailPath, "utf-8"));
        }
      } catch { /* ignore */ }

      // Build ability
      let ability = null;
      if (detail?.ability?.[0]) {
        const a = detail.ability[0];
        ability = {
          name: shipAbilityNameMap.get(ship.loca_id) ?? null,
          description: shipAbilityDescMap.get(ship.loca_id) ?? null,
          valueIsPercentage: a.value_is_percentage,
          values: a.values,
        };
      }

      const result = await pool.query(`
        INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, ability, 
          hull_type, build_time_in_seconds, max_tier, max_level, officer_bonus, crew_slots,
          build_cost, levels, tiers, build_requirements, blueprints_required, game_id,
          link, source, source_url, license)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          ship_class = EXCLUDED.ship_class,
          grade = EXCLUDED.grade,
          rarity = EXCLUDED.rarity,
          faction = EXCLUDED.faction,
          ability = EXCLUDED.ability,
          hull_type = EXCLUDED.hull_type,
          build_time_in_seconds = EXCLUDED.build_time_in_seconds,
          max_tier = EXCLUDED.max_tier,
          max_level = EXCLUDED.max_level,
          officer_bonus = EXCLUDED.officer_bonus,
          crew_slots = EXCLUDED.crew_slots,
          build_cost = EXCLUDED.build_cost,
          levels = EXCLUDED.levels,
          tiers = EXCLUDED.tiers,
          build_requirements = EXCLUDED.build_requirements,
          blueprints_required = EXCLUDED.blueprints_required,
          game_id = EXCLUDED.game_id
        RETURNING (xmax = 0) as inserted
      `, [
        id,
        name,
        hullTypeName,
        ship.grade,
        rarityStr,
        factionName,
        ability ? JSON.stringify(ability) : null,
        ship.hull_type,
        detail?.build_time_in_seconds ?? null,
        detail?.max_tier ?? ship.max_tier,
        detail?.max_level ?? null,
        detail?.officer_bonus ? JSON.stringify(detail.officer_bonus) : null,
        detail?.crew_slots ? JSON.stringify(detail.crew_slots) : null,
        detail?.build_cost ? JSON.stringify(detail.build_cost) : null,
        detail?.levels ? JSON.stringify(detail.levels) : null,
        detail?.tiers ? JSON.stringify(detail.tiers) : null,
        detail?.build_requirements ?? ship.build_requirements ? JSON.stringify(detail?.build_requirements ?? ship.build_requirements) : null,
        detail?.blueprints_required ?? ship.blueprints_required ?? null,
        ship.id,
        `https://stfc.space/ships/${ship.id}`,
        "cdn:data.stfc.space",
        `https://data.stfc.space/ship/${ship.id}.json`,
        "CC-BY-NC 4.0",
      ]);

      if (result.rows[0]?.inserted) shipCreated++;
      else shipUpdated++;
    }

    console.log(`   ✅ Ships: ${shipCreated} created, ${shipUpdated} updated (${shipSummary.length} total)`);
  }

  // ─── Sync Officers ────────────────────────────────────────
  console.log("\n👤 Syncing officers...");
  const officerSummaryPath = join(SNAPSHOT_DIR, "officer", "summary.json");
  if (!existsSync(officerSummaryPath)) {
    console.warn("⚠️  Officer summary not found, skipping officers");
  } else {
    const officerSummary = JSON.parse(await readFile(officerSummaryPath, "utf-8"));
    let officerCreated = 0, officerUpdated = 0;

    for (const officer of officerSummary) {
      const id = `cdn:officer:${officer.id}`;
      const name = officerNameMap.get(officer.loca_id) ?? `Officer ${officer.id}`;
      const factionId = officer.faction?.id ?? null;
      const factionName = factionId != null ? (FACTION_LABELS[factionId] ?? factionNameMap.get(officer.faction?.loca_id) ?? null) : null;
      const rarityStr = RARITY_LABELS[officer.rarity] ?? String(officer.rarity);
      const className = OFFICER_CLASS_LABELS[officer.class] ?? null;

      // Get ability text
      const cmText = officer.captain_ability?.loca_id != null ? officerAbilityTextMap.get(officer.captain_ability.loca_id) : null;
      const oaText = officer.ability?.loca_id != null ? officerAbilityTextMap.get(officer.ability.loca_id) : null;
      const bdText = officer.below_decks_ability?.loca_id != null ? officerAbilityTextMap.get(officer.below_decks_ability.loca_id) : null;

      // Try to load detail
      let detail = null;
      try {
        const detailPath = join(SNAPSHOT_DIR, "officer", `${officer.id}.json`);
        if (existsSync(detailPath)) {
          detail = JSON.parse(await readFile(detailPath, "utf-8"));
        }
      } catch { /* ignore */ }

      // Build abilities
      const abilities: Record<string, unknown> = {};
      if (officer.captain_ability) {
        abilities.captainManeuver = {
          name: cmText?.name ?? null,
          description: cmText?.description ?? null,
          shortDescription: cmText?.shortDescription ?? null,
          valueIsPercentage: officer.captain_ability.value_is_percentage,
          values: officer.captain_ability.values,
        };
      }
      if (officer.ability) {
        abilities.officerAbility = {
          name: oaText?.name ?? null,
          description: oaText?.description ?? null,
          shortDescription: oaText?.shortDescription ?? null,
          valueIsPercentage: officer.ability.value_is_percentage,
          values: officer.ability.values,
        };
      }
      if (officer.below_decks_ability) {
        abilities.belowDeckAbility = {
          name: bdText?.name ?? null,
          description: bdText?.description ?? null,
          shortDescription: bdText?.shortDescription ?? null,
          valueIsPercentage: officer.below_decks_ability.value_is_percentage,
          values: officer.below_decks_ability.values,
        };
      }

      // Trait config
      let traitConfig = null;
      if (detail?.trait_config) {
        traitConfig = {
          progression: detail.trait_config.progression.map((p: { required_rank: number; trait_id: number }) => ({
            requiredRank: p.required_rank,
            traitId: p.trait_id,
            traitName: traitNameMap.get(p.trait_id) ?? null,
          })),
        };
      }

      // Faction JSON
      const factionJson = factionId != null ? { id: factionId, name: factionName } : null;

      const result = await pool.query(`
        INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability,
          below_deck_ability, abilities, tags, officer_game_id, officer_class, faction, synergy_id,
          max_rank, trait_config, source, source_url, license)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          rarity = EXCLUDED.rarity,
          group_name = EXCLUDED.group_name,
          captain_maneuver = EXCLUDED.captain_maneuver,
          officer_ability = EXCLUDED.officer_ability,
          below_deck_ability = EXCLUDED.below_deck_ability,
          abilities = EXCLUDED.abilities,
          officer_game_id = EXCLUDED.officer_game_id,
          officer_class = EXCLUDED.officer_class,
          faction = EXCLUDED.faction,
          synergy_id = EXCLUDED.synergy_id,
          max_rank = EXCLUDED.max_rank,
          trait_config = EXCLUDED.trait_config
        RETURNING (xmax = 0) as inserted
      `, [
        id,
        name,
        rarityStr,
        className,
        cmText?.shortDescription ?? cmText?.description ?? null,
        oaText?.shortDescription ?? oaText?.description ?? null,
        bdText?.shortDescription ?? bdText?.description ?? null,
        Object.keys(abilities).length > 0 ? JSON.stringify(abilities) : null,
        null, // tags — CDN doesn't have activity tags
        officer.id,
        officer.class,
        factionJson ? JSON.stringify(factionJson) : null,
        officer.synergy_id,
        officer.max_rank ?? detail?.max_rank ?? null,
        traitConfig ? JSON.stringify(traitConfig) : null,
        "cdn:data.stfc.space",
        `https://data.stfc.space/officer/${officer.id}.json`,
        "CC-BY-NC 4.0",
      ]);

      if (result.rows[0]?.inserted) officerCreated++;
      else officerUpdated++;
    }

    console.log(`   ✅ Officers: ${officerCreated} created, ${officerUpdated} updated (${officerSummary.length} total)`);
  }

  // Final counts
  const { rows: finalRows } = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM reference_officers) as officers,
      (SELECT COUNT(*) FROM reference_ships) as ships
  `);
  console.log(`\n📊 Final DB state: ${finalRows[0].officers} officers, ${finalRows[0].ships} ships`);

  await pool.end();
  console.log("\n✅ Seed complete!");
}

main().catch((err) => {
  console.error("💥 Seed failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
