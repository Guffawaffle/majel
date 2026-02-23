import { resolve } from "node:path";
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
    source: "fixture-seed";
    sourceVersion: "effect-taxonomy.officer-fixture.v1.json";
    generatedAt: string;
    schemaHash: string;
    contentHash: string;
  };
  officers: ExportOfficer[];
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

const command: AxCommand = {
  name: "effects:snapshot:export",
  description: "Export deterministic officer scaffold snapshot from fixture seed",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const snapshotId = getFlag(args, "snapshotId") ?? "fixture-seed-v1";
    const generatedAt = getFlag(args, "generatedAt") ?? "1970-01-01T00:00:00.000Z";
    const outPath = getFlag(args, "out")
      ?? resolve("tmp", "effects", "exports", `effects-snapshot.${snapshotId}.json`);

    const seed = await readEffectsSeedFile();
    const officers = canonicalize(seed.officers);
    const schemaHash = sha256Hex(stableJsonStringify(EXPORT_SCHEMA_DESCRIPTOR));

    const withoutContentHash = {
      schemaVersion: "1.0.0" as const,
      snapshot: {
        snapshotId,
        source: "fixture-seed" as const,
        sourceVersion: "effect-taxonomy.officer-fixture.v1.json" as const,
        generatedAt,
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
      snapshotId,
      generatedAt,
      source: payload.snapshot.source,
      sourceVersion: payload.snapshot.sourceVersion,
      schemaHash,
      contentHash,
      officerCount: officers.length,
      abilityCount,
      outPath,
    }, {
      success: true,
      hints: [
        "Use --generatedAt=<iso8601> when pinning a fixture baseline",
      ],
    });
  },
};

export default command;
