import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";
import { readEffectsSeedFile, writeJsonAt } from "./effects-harness.js";
import { sha256Hex, stableJsonStringify } from "../../src/server/services/effects-contract-v3.js";

type ExportSlot = "cm" | "oa" | "bda";

interface ExportAbility {
  abilityId: string;
  slot: ExportSlot;
  name: string | null;
  rawText: string;
  isInert: boolean;
  sourceRef: string;
}

interface ExportOfficer {
  officerId: string;
  abilities: ExportAbility[];
}

interface SnapshotExport {
  schemaVersion: "1.0.0";
  snapshot: {
    snapshotId: string;
    source: string;
    sourceVersion: string;
    generatedAt: string;
    schemaHash: string;
    contentHash: string;
  };
  officers: ExportOfficer[];
}

interface FeedManifest {
  schemaVersion: string;
  feedId: string;
  runId: string;
  sourceLabel: string;
  sourceVersion: string | null;
  snapshotId: string | null;
  schemaHash: string;
  contentHash: string;
  entityFiles: Record<string, string>;
}

interface FeedEntityFile {
  records: Array<Record<string, unknown>>;
}

interface CdnSnapshotTranslationEntry {
  id?: number | null;
  key?: string;
  text?: string;
}

interface TranslationHit {
  text: string;
  sourceRef: string;
}

const SLOT_ORDER: Record<ExportSlot, number> = {
  cm: 0,
  oa: 1,
  bda: 2,
};

const EXPORT_SCHEMA_DESCRIPTOR = {
  schemaVersion: "1.0.0",
  snapshot: {
    snapshotId: "string",
    source: "fixture-seed",
    sourceVersion: "effect-taxonomy.officer-fixture.v1.json",
    generatedAt: "iso8601",
    schemaHash: "sha256",
    contentHash: "sha256",
  },
  officers: [{
    officerId: "string",
    abilities: [{
      abilityId: "string",
      slot: "cm|oa|bda",
      name: "string|null",
      rawText: "string",
      isInert: "boolean",
      sourceRef: "string",
    }],
  }],
} as const;

function canonicalize(seedAbilities: Awaited<ReturnType<typeof readEffectsSeedFile>>["officers"]): ExportOfficer[] {
  const ordered = [...seedAbilities].sort((left, right) => {
    const officerCmp = left.officerId.localeCompare(right.officerId);
    if (officerCmp !== 0) return officerCmp;
    const slotCmp = SLOT_ORDER[left.slot] - SLOT_ORDER[right.slot];
    if (slotCmp !== 0) return slotCmp;
    return left.id.localeCompare(right.id);
  });

  const grouped = new Map<string, ExportOfficer>();
  for (const ability of ordered) {
    const officer = grouped.get(ability.officerId) ?? {
      officerId: ability.officerId,
      abilities: [],
    };

    officer.abilities.push({
      abilityId: ability.id,
      slot: ability.slot,
      name: ability.name,
      rawText: ability.rawText ?? "",
      isInert: ability.isInert,
      sourceRef: `effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/${ability.id}`,
    });

    grouped.set(ability.officerId, officer);
  }

  return [...grouped.values()];
}

async function resolveFeedPath(feedsRoot: string, feedOrPath: string): Promise<string> {
  const direct = resolve(feedOrPath);
  try {
    const details = await stat(direct);
    if (details.isDirectory()) return direct;
  } catch {
    // no-op
  }

  const feedRoot = resolve(feedsRoot, feedOrPath);
  const runCandidates = await readdir(feedRoot, { withFileTypes: true });
  const runDirs = runCandidates.filter((entry) => entry.isDirectory()).map((entry) => join(feedRoot, entry.name));
  if (runDirs.length === 0) {
    throw new Error(`No feed runs found for '${feedOrPath}' in ${feedsRoot}`);
  }

  const stats = await Promise.all(runDirs.map(async (path) => ({ path, stat: await stat(path) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0]?.path ?? runDirs[0]!;
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function buildTranslationLookup(feedPath: string, manifest: FeedManifest): Promise<Map<string, TranslationHit>> {
  const byExternalId = new Map<string, TranslationHit>();
  const preferredNamespaces = [
    "translation.en.officer_buffs",
    "translation.en.officer_names",
    "translation.en.officers",
  ];

  for (const namespace of preferredNamespaces) {
    const relativePath = manifest.entityFiles?.[namespace];
    if (!relativePath) continue;

    const translationEntity = JSON.parse(await readFile(join(feedPath, relativePath), "utf-8")) as FeedEntityFile;
    const records = Array.isArray(translationEntity.records) ? translationEntity.records : [];
    for (const record of records) {
      const externalId = normalizeId(record.translation_external_id);
      const text = normalizeText(record.translation_text);
      if (!externalId || !text) continue;

      const translationKey = typeof record.translation_key === "string" ? record.translation_key : "";
      const sourceRef = `${namespace}:${translationKey || externalId}`;
      const existing = byExternalId.get(externalId);
      if (!existing || existing.text.length < text.length) {
        byExternalId.set(externalId, { text, sourceRef });
      }
    }
  }

  const snapshotBuffsPath = resolve("data", ".stfc-snapshot", "translations", "en", "officer_buffs.json");
  try {
    const snapshotEntries = JSON.parse(await readFile(snapshotBuffsPath, "utf-8")) as CdnSnapshotTranslationEntry[];
    for (const entry of snapshotEntries) {
      const externalId = normalizeId(entry.id);
      const text = normalizeText(entry.text);
      if (!externalId || !text) continue;
      const key = typeof entry.key === "string" ? entry.key : "";
      if (!key.includes("officer_ability")) continue;

      const existing = byExternalId.get(externalId);
      if (!existing || existing.text.startsWith("loca_id:")) {
        byExternalId.set(externalId, {
          text,
          sourceRef: `cdn-snapshot:officer_buffs:${key || externalId}`,
        });
      }
    }
  } catch {
    // no-op: snapshot backfill is optional
  }

  return byExternalId;
}

function abilityFromRecord(
  record: Record<string, unknown>,
  officerNumericId: string,
  slot: ExportSlot,
  key: string,
  translationByExternalId: Map<string, TranslationHit>,
): ExportAbility | null {
  const payload = record[key] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;

  const abilityNumericId = normalizeId(payload.id) ?? `${officerNumericId}-${slot}`;
  const abilityId = `cdn:ability:${abilityNumericId}`;
  const locaId = normalizeId(payload.loca_id);
  const translation = locaId ? translationByExternalId.get(locaId) : undefined;
  const rawText = translation?.text ?? (locaId ? `loca_id:${locaId}` : `ability_id:${abilityNumericId}`);
  const normalized = rawText.toLowerCase();
  const isNoCaptainManeuver = normalized.includes("does not have a captain")
    || normalized.includes("provides no benefit");

  return {
    abilityId,
    slot,
    name: null,
    rawText,
    isInert: slot === "cm" && isNoCaptainManeuver,
    sourceRef: translation?.sourceRef ?? `feed:officer/${officerNumericId}/${key}`,
  };
}

function officersFromFeedRecords(
  records: Array<Record<string, unknown>>,
  translationByExternalId: Map<string, TranslationHit>,
): ExportOfficer[] {
  const officers: ExportOfficer[] = [];

  for (const record of records) {
    const officerNumericId = normalizeId(record.game_id) ?? normalizeId(record.id);
    if (!officerNumericId) continue;

    const officerId = `cdn:officer:${officerNumericId}`;
    const abilities = [
      abilityFromRecord(record, officerNumericId, "cm", "captain_ability", translationByExternalId),
      abilityFromRecord(record, officerNumericId, "oa", "ability", translationByExternalId),
      abilityFromRecord(record, officerNumericId, "bda", "below_decks_ability", translationByExternalId),
    ].filter((entry): entry is ExportAbility => Boolean(entry));

    if (abilities.length === 0) continue;
    abilities.sort((left, right) => {
      const slotCmp = SLOT_ORDER[left.slot] - SLOT_ORDER[right.slot];
      if (slotCmp !== 0) return slotCmp;
      return left.abilityId.localeCompare(right.abilityId);
    });

    officers.push({ officerId, abilities });
  }

  officers.sort((left, right) => left.officerId.localeCompare(right.officerId));
  return officers;
}

const command: AxCommand = {
  name: "effects:snapshot:export",
  description: "Export deterministic officer scaffold snapshot from fixture seed",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const feedArg = getFlag(args, "feed");
    const feedsRoot = getFlag(args, "feeds-root") ?? resolve("/srv", "crawlers", "stfc.space", "data", "feeds");
    const snapshotId = getFlag(args, "snapshotId") ?? "fixture-seed-v1";
    const generatedAt = getFlag(args, "generatedAt") ?? "1970-01-01T00:00:00.000Z";
    const outPath = getFlag(args, "out")
      ?? resolve("tmp", "effects", "exports", `effects-snapshot.${snapshotId}.json`);

    let officers: ExportOfficer[];
    let source = "fixture-seed";
    let sourceVersion = "effect-taxonomy.officer-fixture.v1.json";
    let resolvedSnapshotId = snapshotId;
    let resolvedGeneratedAt = generatedAt;
    let schemaHash = sha256Hex(stableJsonStringify(EXPORT_SCHEMA_DESCRIPTOR));

    if (feedArg) {
      const feedPath = await resolveFeedPath(feedsRoot, feedArg);
      const manifest = JSON.parse(await readFile(join(feedPath, "feed.json"), "utf-8")) as FeedManifest;
      const officerEntityPath = manifest.entityFiles?.officer;
      if (!officerEntityPath) {
        return makeResult("effects:snapshot:export", start, {
          feed: feedArg,
          feedPath,
        }, {
          success: false,
          errors: ["Feed manifest missing officer entity path"],
        });
      }

      const officerEntity = JSON.parse(await readFile(join(feedPath, officerEntityPath), "utf-8")) as FeedEntityFile;
      const records = Array.isArray(officerEntity.records) ? officerEntity.records : [];
      const translationByExternalId = await buildTranslationLookup(feedPath, manifest);
      officers = officersFromFeedRecords(records, translationByExternalId);
      source = manifest.sourceLabel;
      sourceVersion = manifest.sourceVersion ?? manifest.feedId;
      resolvedSnapshotId = manifest.snapshotId ?? manifest.runId;
      resolvedGeneratedAt = manifest.generatedAt ?? generatedAt;
      schemaHash = manifest.schemaHash;
    } else {
      const seed = await readEffectsSeedFile();
      officers = canonicalize(seed.officers);
    }

    const withoutContentHash = {
      schemaVersion: "1.0.0" as const,
      snapshot: {
        snapshotId: resolvedSnapshotId,
        source,
        sourceVersion,
        generatedAt: resolvedGeneratedAt,
        schemaHash,
      },
      officers,
    };

    const contentHash = sha256Hex(stableJsonStringify({
      schemaVersion: withoutContentHash.schemaVersion,
      snapshot: {
        snapshotId: withoutContentHash.snapshot.snapshotId,
        source: withoutContentHash.snapshot.source,
        sourceVersion: withoutContentHash.snapshot.sourceVersion,
        schemaHash: withoutContentHash.snapshot.schemaHash,
      },
      officers: withoutContentHash.officers,
    }));
    const payload: SnapshotExport = {
      schemaVersion: "1.0.0",
      snapshot: {
        ...withoutContentHash.snapshot,
        contentHash,
      },
      officers,
    };

    await writeJsonAt(outPath, payload);

    const abilityCount = officers.reduce((sum, officer) => sum + officer.abilities.length, 0);
    return makeResult("effects:snapshot:export", start, {
      snapshotId: resolvedSnapshotId,
      generatedAt: resolvedGeneratedAt,
      source: payload.snapshot.source,
      sourceVersion: payload.snapshot.sourceVersion,
      schemaHash,
      contentHash,
      officerCount: officers.length,
      abilityCount,
      outPath,
      inputFeed: feedArg ?? null,
    }, {
      success: true,
      hints: [
        feedArg
          ? "Feed-backed snapshot export generated from crawler feed"
          : "Use --feed <feedId-or-path> for full dataset export; fixture mode remains available for hermetic baselines",
      ],
    });
  },
};

export default command;
