#!/usr/bin/env node
/**
 * stfc-snapshot.mjs — One-Time Data Snapshot from data.stfc.space (CDN)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Fetches game data from Ripper's public CDN (data.stfc.space).
 * This is a static S3 bucket served via CloudFront — no API, no auth, no rate limits.
 * Data is the same datamined game data that powers stfc.space.
 *
 * Usage:
 *   node scripts/stfc-snapshot.mjs              # Full snapshot (summaries + translations)
 *   node scripts/stfc-snapshot.mjs --details    # Also fetch individual entity details (slow)
 *   node scripts/stfc-snapshot.mjs --type ship  # Only fetch ships
 *
 * Output:
 *   data/.stfc-snapshot/                        # Gitignored raw CDN data
 *   data/.stfc-snapshot/version.txt             # Data version UUID
 *   data/.stfc-snapshot/{type}/summary.json     # Entity summaries
 *   data/.stfc-snapshot/{type}/{id}.json        # Individual entity details
 *   data/.stfc-snapshot/translations/en/*.json  # English translations
 *
 * Provenance:
 *   Ripper (stfc.space maintainer) has approved one-time use of this data
 *   as a "raw template" for Majel's reference catalog. This script is local-only,
 *   gitignored, and not connected to the deployed application.
 *
 * License:
 *   Source data is community-maintained under PolyForm Perimeter License.
 *   See https://github.com/stfc-space/frontend for terms.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "data", ".stfc-snapshot");

const CDN_BASE = "https://data.stfc.space";

// Entity types available on the CDN
const ENTITY_TYPES = [
  "ship",
  "officer",
  "research",
  "system",
  "building",
  "consumable",
  "hostile",
];

// Translation packs to fetch
const TRANSLATION_PACKS = [
  "ships",
  "officers",
  "officer_names",
  "officer_buffs",
  "materials",
  "research",
  "factions",
  "systems",
  "ship_components",
  "blueprints",
  "consumables",
  "buildings",
  "starbase_modules",
  "hostiles",
  "traits",
  "navigation",
  "mission_titles",
];

// ─── CLI Parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
const fetchDetails = args.includes("--details");
const typeFilter = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;
const delayMs = parseInt(args[args.indexOf("--delay") + 1]) || 500;

if (typeFilter && !ENTITY_TYPES.includes(typeFilter)) {
  console.error(`Unknown type: ${typeFilter}. Available: ${ENTITY_TYPES.join(", ")}`);
  process.exit(1);
}

// ─── Fetch Helpers ──────────────────────────────────────────

let requestCount = 0;

async function fetchJSON(url) {
  requestCount++;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Majel-STFC-Snapshot/1.0 (one-time-import; github.com/Guffawaffle/majel)",
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return res.json();
  }
  return res.text();
}

async function fetchText(url) {
  requestCount++;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Majel-STFC-Snapshot/1.0 (one-time-import; github.com/Guffawaffle/majel)",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

async function writeJSON(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function writeTextFile(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf-8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Majel — STFC Data Snapshot (data.stfc.space CDN) ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log();

  // 1. Fetch version
  console.log("▸ Fetching data version...");
  const version = (await fetchText(`${CDN_BASE}/version.txt`)).trim();
  console.log(`  Version: ${version}`);
  await writeTextFile(join(OUTPUT_DIR, "version.txt"), version);

  // Check if we already have this version
  const versionFile = join(OUTPUT_DIR, "version.txt");
  if (existsSync(versionFile)) {
    const existing = (await readFile(versionFile, "utf-8")).trim();
    if (existing === version && !args.includes("--force")) {
      console.log(`  ⚠ Already have version ${version}. Use --force to re-fetch.`);
    }
  }
  // Write version
  await writeTextFile(versionFile, version);

  const types = typeFilter ? [typeFilter] : ENTITY_TYPES;

  // 2. Fetch summaries
  console.log();
  console.log("▸ Fetching entity summaries...");
  const summaries = {};

  for (const type of types) {
    const url = `${CDN_BASE}/${type}/summary.json?version=${version}`;
    try {
      const data = await fetchJSON(url);
      summaries[type] = data;
      await writeJSON(join(OUTPUT_DIR, type, "summary.json"), data);
      console.log(`  ✓ ${type}: ${data.length} entities`);
    } catch (err) {
      console.error(`  ✗ ${type}: ${err.message}`);
    }
    await sleep(100); // Polite even for CDN
  }

  // 3. Fetch translations (English only)
  console.log();
  console.log("▸ Fetching English translations...");
  for (const pack of TRANSLATION_PACKS) {
    const url = `${CDN_BASE}/translations/en/${pack}.json?version=${version}`;
    try {
      const data = await fetchJSON(url);
      await writeJSON(join(OUTPUT_DIR, "translations", "en", `${pack}.json`), data);
      console.log(`  ✓ ${pack}: ${Array.isArray(data) ? data.length : Object.keys(data).length} entries`);
    } catch (err) {
      console.error(`  ✗ ${pack}: ${err.message}`);
    }
    await sleep(100);
  }

  // 4. Optionally fetch individual entity details
  if (fetchDetails) {
    console.log();
    console.log("▸ Fetching individual entity details...");
    console.log(`  Delay between requests: ${delayMs}ms`);

    for (const type of types) {
      const entities = summaries[type] || [];
      const detailDir = join(OUTPUT_DIR, type);
      let fetched = 0;
      let skipped = 0;

      console.log(`  ${type} (${entities.length} entities)...`);

      for (const entity of entities) {
        const detailFile = join(detailDir, `${entity.id}.json`);

        // Skip if already fetched
        if (existsSync(detailFile) && !args.includes("--force")) {
          skipped++;
          continue;
        }

        try {
          const url = `${CDN_BASE}/${type}/${entity.id}.json?version=${version}`;
          const detail = await fetchJSON(url);
          await writeJSON(detailFile, detail);
          fetched++;
        } catch (err) {
          console.error(`    ✗ ${type}/${entity.id}: ${err.message}`);
        }

        // Polite delay for detail fetches
        await sleep(delayMs);
      }

      console.log(`    ✓ ${fetched} fetched, ${skipped} cached`);
    }
  }

  // 5. Write manifest
  const manifest = {
    version,
    fetchedAt: new Date().toISOString(),
    source: "data.stfc.space (Ripper's CDN)",
    license: "PolyForm Perimeter (community datamined game data)",
    approval: "Ripper approved one-time use as raw template for Majel",
    types: {},
  };
  for (const type of types) {
    manifest.types[type] = {
      summaryCount: summaries[type]?.length || 0,
      detailsFetched: fetchDetails,
    };
  }
  await writeJSON(join(OUTPUT_DIR, "manifest.json"), manifest);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`  Done! ${requestCount} requests in ${elapsed}s`);
  console.log(`  Output: data/.stfc-snapshot/`);
  console.log(`  Version: ${version}`);
  console.log(`═══════════════════════════════════════════════════`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
