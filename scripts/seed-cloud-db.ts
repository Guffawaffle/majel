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
import {
  CdnIngestPipeline,
  ShipCdnIngestor,
  OfficerCdnIngestor,
} from "./lib/cdn-ingest-pipeline.ts";
import { ShipCdnUpsertService, type CdnShipSummary } from "./lib/ship-cdn-upsert-service.ts";
import { OfficerCdnUpsertService, type CdnOfficerSummary } from "./lib/officer-cdn-upsert-service.ts";
import {
  HULL_TYPE_LABELS,
  OFFICER_CLASS_LABELS,
  RARITY_LABELS,
  FACTION_LABELS,
} from "../src/server/services/game-enums.js";
import { formatAbilityDescription } from "../src/server/services/cdn-mappers.js";

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

  // Purge legacy raw/wiki entries and related data
  console.log("\n🧹 Purging legacy raw/wiki entries...");
  await pool.query(`DELETE FROM ship_overlay WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%'`);
  await pool.query(`DELETE FROM officer_overlay WHERE ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
  await pool.query(`DELETE FROM targets WHERE ref_id LIKE 'raw:ship:%' OR ref_id LIKE 'wiki:ship:%' OR ref_id LIKE 'raw:officer:%' OR ref_id LIKE 'wiki:officer:%'`);
  const { rowCount: purgedShips } = await pool.query(`DELETE FROM reference_ships WHERE id LIKE 'raw:ship:%' OR id LIKE 'wiki:ship:%'`);
  const { rowCount: purgedOfficers } = await pool.query(`DELETE FROM reference_officers WHERE id LIKE 'raw:officer:%' OR id LIKE 'wiki:officer:%'`);
  console.log(`   ✅ Purged ${purgedShips ?? 0} legacy ships, ${purgedOfficers ?? 0} legacy officers`);

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

  const shipUpsertService = new ShipCdnUpsertService({
    pool,
    snapshotDir: SNAPSHOT_DIR,
    hullTypeLabels: HULL_TYPE_LABELS,
    rarityLabels: RARITY_LABELS,
    factionLabels: FACTION_LABELS,
    shipNameMap,
    shipAbilityNameMap,
    shipAbilityDescMap,
  });

  const officerUpsertService = new OfficerCdnUpsertService({
    pool,
    snapshotDir: SNAPSHOT_DIR,
    rarityLabels: RARITY_LABELS,
    officerClassLabels: OFFICER_CLASS_LABELS,
    factionLabels: FACTION_LABELS,
    officerNameMap,
    officerAbilityTextMap,
    factionNameMap,
    traitNameMap,
    formatAbilityDescription,
  });

  // ─── Sync via class-based ingest pipeline ────────────────
  console.log("\n🔄 Running CDN ingest pipeline...");
  const pipeline = new CdnIngestPipeline([
    new ShipCdnIngestor<CdnShipSummary>({
      pool,
      snapshotDir: SNAPSHOT_DIR,
      upsertOne: (ship) => shipUpsertService.upsertOne(ship),
    }),
    new OfficerCdnIngestor<CdnOfficerSummary>({
      pool,
      snapshotDir: SNAPSHOT_DIR,
      upsertOne: (officer) => officerUpsertService.upsertOne(officer),
    }),
  ]);
  await pipeline.run();

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
