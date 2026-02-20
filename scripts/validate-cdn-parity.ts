#!/usr/bin/env tsx
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapCdnShipToReferenceInput,
  mapCdnOfficerToReferenceInput,
  formatAbilityDescription,
  type CdnShipSummaryForMapping,
  type CdnShipDetailForMapping,
  type CdnOfficerSummaryForMapping,
  type CdnOfficerDetailForMapping,
  type OfficerAbilityText,
} from "../src/server/services/cdn-mappers.js";
import {
  HULL_TYPE_LABELS,
  OFFICER_CLASS_LABELS,
  RARITY_LABELS,
  FACTION_LABELS,
} from "../src/server/services/game-enums.js";

interface TranslationEntry {
  id: number | null;
  key: string;
  text: string;
}

interface ParityDiff {
  id: string;
  reason: "missing-runtime" | "missing-seed" | "payload-mismatch";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SNAPSHOT_DIR = resolve(ROOT, "data", ".stfc-snapshot");

function stripColorTags(text: string): string {
  return text.replace(/<\/?color[^>]*>/gi, "").trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `"${key}":${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function loadJson<T>(relativePath: string): Promise<T> {
  const path = join(SNAPSHOT_DIR, relativePath);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

async function loadTranslationPack(pack: string): Promise<TranslationEntry[]> {
  try {
    return await loadJson<TranslationEntry[]>(join("translations", "en", `${pack}.json`));
  } catch {
    return [];
  }
}

function buildNameMap(entries: TranslationEntry[], key: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const entry of entries) {
    if (entry.id != null && entry.key === key) {
      map.set(entry.id, entry.text);
    }
  }
  return map;
}

function buildAbilityTextMap(entries: TranslationEntry[]): Map<number, OfficerAbilityText> {
  const map = new Map<number, OfficerAbilityText>();
  for (const entry of entries) {
    if (entry.id == null) continue;
    const existing = map.get(entry.id) ?? { name: "", description: "", shortDescription: "" };
    if (entry.key === "officer_ability_name") existing.name = entry.text;
    if (entry.key === "officer_ability_desc") existing.description = stripColorTags(entry.text);
    if (entry.key === "officer_ability_short_desc") existing.shortDescription = stripColorTags(entry.text);
    map.set(entry.id, existing);
  }
  return map;
}

async function loadShipDetailMap(summaries: CdnShipSummaryForMapping[]): Promise<Map<number, CdnShipDetailForMapping | null>> {
  const map = new Map<number, CdnShipDetailForMapping | null>();
  for (const ship of summaries) {
    try {
      map.set(ship.id, await loadJson<CdnShipDetailForMapping>(join("ship", `${ship.id}.json`)));
    } catch {
      map.set(ship.id, null);
    }
  }
  return map;
}

async function loadOfficerDetailMap(summaries: CdnOfficerSummaryForMapping[]): Promise<Map<number, CdnOfficerDetailForMapping | null>> {
  const map = new Map<number, CdnOfficerDetailForMapping | null>();
  for (const officer of summaries) {
    try {
      map.set(officer.id, await loadJson<CdnOfficerDetailForMapping>(join("officer", `${officer.id}.json`)));
    } catch {
      map.set(officer.id, null);
    }
  }
  return map;
}

function diffRecordSets(runtime: Record<string, unknown>, seed: Record<string, unknown>): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  const allIds = new Set<string>([...Object.keys(runtime), ...Object.keys(seed)]);
  for (const id of allIds) {
    if (!(id in runtime)) {
      diffs.push({ id, reason: "missing-runtime" });
      continue;
    }
    if (!(id in seed)) {
      diffs.push({ id, reason: "missing-seed" });
      continue;
    }
    if (canonicalJson(runtime[id]) !== canonicalJson(seed[id])) {
      diffs.push({ id, reason: "payload-mismatch" });
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  try {
    await access(join(SNAPSHOT_DIR, "ship", "summary.json"));
    await access(join(SNAPSHOT_DIR, "officer", "summary.json"));
  } catch {
    console.error("❌ Snapshot not found at data/.stfc-snapshot (ship/officer summaries required)");
    process.exit(1);
  }

  const [shipSummaries, officerSummaries] = await Promise.all([
    loadJson<CdnShipSummaryForMapping[]>(join("ship", "summary.json")),
    loadJson<CdnOfficerSummaryForMapping[]>(join("officer", "summary.json")),
  ]);

  const [shipTranslations, officerNames, officerBuffs, factionTranslations, traitTranslations] = await Promise.all([
    loadTranslationPack("ships"),
    loadTranslationPack("officer_names"),
    loadTranslationPack("officer_buffs"),
    loadTranslationPack("factions"),
    loadTranslationPack("traits"),
  ]);

  const shipNameMap = buildNameMap(shipTranslations, "ship_name");
  const shipAbilityNameMap = buildNameMap(shipTranslations, "ship_ability_name");
  const shipAbilityDescMap = buildNameMap(shipTranslations, "ship_ability_desc");

  const officerNameMap = buildNameMap(officerNames, "officer_name");
  const abilityTextMap = buildAbilityTextMap(officerBuffs);
  const factionNameMap = buildNameMap(factionTranslations, "faction_name");
  const traitNameMap = buildNameMap(traitTranslations, "trait_name");

  const [shipDetailMap, officerDetailMap] = await Promise.all([
    loadShipDetailMap(shipSummaries),
    loadOfficerDetailMap(officerSummaries),
  ]);

  const runtimeShips: Record<string, unknown> = {};
  const seedShips: Record<string, unknown> = {};
  for (const ship of shipSummaries) {
    const detail = shipDetailMap.get(ship.id) ?? null;
    const runtimeMapped = mapCdnShipToReferenceInput({
      ship,
      detail,
      shipNameMap,
      shipAbilityNameMap,
      shipAbilityDescMap,
      hullTypeLabels: HULL_TYPE_LABELS,
      rarityLabels: RARITY_LABELS,
      factionLabels: FACTION_LABELS,
    });
    const seedMapped = mapCdnShipToReferenceInput({
      ship,
      detail,
      shipNameMap,
      shipAbilityNameMap,
      shipAbilityDescMap,
      hullTypeLabels: HULL_TYPE_LABELS,
      rarityLabels: RARITY_LABELS,
      factionLabels: FACTION_LABELS,
    });
    runtimeShips[runtimeMapped.id] = runtimeMapped;
    seedShips[seedMapped.id] = seedMapped;
  }

  const runtimeOfficers: Record<string, unknown> = {};
  const seedOfficers: Record<string, unknown> = {};
  for (const officer of officerSummaries) {
    const detail = officerDetailMap.get(officer.id) ?? null;
    const runtimeMapped = mapCdnOfficerToReferenceInput({
      officer,
      detail,
      rarityLabels: RARITY_LABELS,
      officerClassLabels: OFFICER_CLASS_LABELS,
      factionLabels: FACTION_LABELS,
      officerNameMap,
      officerAbilityTextMap: abilityTextMap,
      factionNameMap,
      traitNameMap,
      formatAbilityDescription,
    });
    const seedMapped = mapCdnOfficerToReferenceInput({
      officer,
      detail,
      rarityLabels: RARITY_LABELS,
      officerClassLabels: OFFICER_CLASS_LABELS,
      factionLabels: FACTION_LABELS,
      officerNameMap,
      officerAbilityTextMap: abilityTextMap,
      factionNameMap,
      traitNameMap,
      formatAbilityDescription,
    });
    runtimeOfficers[runtimeMapped.id] = runtimeMapped;
    seedOfficers[seedMapped.id] = seedMapped;
  }

  const shipDiffs = diffRecordSets(runtimeShips, seedShips);
  const officerDiffs = diffRecordSets(runtimeOfficers, seedOfficers);

  console.log("📊 CDN path parity summary");
  console.log(`   Ships: runtime=${Object.keys(runtimeShips).length}, seed=${Object.keys(seedShips).length}, diffs=${shipDiffs.length}`);
  console.log(`   Officers: runtime=${Object.keys(runtimeOfficers).length}, seed=${Object.keys(seedOfficers).length}, diffs=${officerDiffs.length}`);

  const allDiffs = [...shipDiffs.map((entry) => ({ entity: "ship", ...entry })), ...officerDiffs.map((entry) => ({ entity: "officer", ...entry }))];
  if (allDiffs.length > 0) {
    console.error("\n❌ Parity check failed. First 10 diffs:");
    for (const diff of allDiffs.slice(0, 10)) {
      console.error(`   - ${diff.entity}:${diff.id} (${diff.reason})`);
    }
    process.exit(1);
  }

  console.log("\n✅ Parity check passed: runtime and seed mapping outputs are consistent for this snapshot.");
}

main().catch((error) => {
  console.error("❌ Parity check failed with error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
