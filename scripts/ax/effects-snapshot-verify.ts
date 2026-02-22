import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, getFlag, makeResult } from "./runner.js";
import { sha256Hex, stableJsonStringify } from "../../src/server/services/effects-contract-v3.js";

interface SnapshotExportLike {
  schemaVersion: string;
  snapshot: {
    snapshotId: string;
    source: string;
    sourceVersion: string;
    generatedAt: string;
    schemaHash: string;
    contentHash: string;
  };
  officers: Array<{
    officerId: string;
    abilities: Array<{
      abilityId: string;
      slot: "cm" | "oa" | "bda";
      name: string | null;
      rawText: string;
      isInert: boolean;
      sourceRef: string;
    }>;
  }>;
}

const EXPORT_SCHEMA_DESCRIPTOR = {
  schemaVersion: "1.0.0",
  snapshot: {
    snapshotId: "string",
    source: "fixture-seed",
    sourceVersion: "effect-taxonomy.json",
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

const command: AxCommand = {
  name: "effects:snapshot:verify",
  description: "Verify snapshot export integrity and pinned content hash",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const input = getFlag(args, "input") ?? resolve("tmp", "effects", "exports", "effects-snapshot.fixture-seed-v1.json");
    const expectContentHash = getFlag(args, "expect-content-hash");

    const absoluteInputPath = resolve(ROOT, input);
    let parsed: SnapshotExportLike;

    try {
      const raw = await readFile(absoluteInputPath, "utf-8");
      parsed = JSON.parse(raw) as SnapshotExportLike;
    } catch (error) {
      return makeResult("effects:snapshot:verify", start, {
        input,
      }, {
        success: false,
        errors: [error instanceof Error ? `Unable to read snapshot export: ${error.message}` : "Unable to read snapshot export"],
      });
    }

    const computedSchemaHash = sha256Hex(stableJsonStringify(EXPORT_SCHEMA_DESCRIPTOR));
    const computedContentHash = sha256Hex(stableJsonStringify({
      schemaVersion: parsed.schemaVersion,
      snapshot: {
        snapshotId: parsed.snapshot.snapshotId,
        source: parsed.snapshot.source,
        sourceVersion: parsed.snapshot.sourceVersion,
        generatedAt: parsed.snapshot.generatedAt,
        schemaHash: parsed.snapshot.schemaHash,
      },
      officers: parsed.officers,
    }));

    const schemaHashMatch = parsed.snapshot.schemaHash === computedSchemaHash;
    const contentHashMatch = parsed.snapshot.contentHash === computedContentHash;
    const expectedHashMatch = expectContentHash ? expectContentHash === parsed.snapshot.contentHash : true;

    const errors: string[] = [];
    if (!schemaHashMatch) {
      errors.push(`schemaHash mismatch: file=${parsed.snapshot.schemaHash} computed=${computedSchemaHash}`);
    }
    if (!contentHashMatch) {
      errors.push(`contentHash mismatch: file=${parsed.snapshot.contentHash} computed=${computedContentHash}`);
    }
    if (!expectedHashMatch) {
      errors.push(`expected contentHash mismatch: expected=${expectContentHash} actual=${parsed.snapshot.contentHash}`);
    }

    const officerCount = Array.isArray(parsed.officers) ? parsed.officers.length : 0;
    const abilityCount = Array.isArray(parsed.officers)
      ? parsed.officers.reduce((sum, officer) => sum + officer.abilities.length, 0)
      : 0;

    return makeResult("effects:snapshot:verify", start, {
      input,
      snapshotId: parsed.snapshot.snapshotId,
      source: parsed.snapshot.source,
      generatedAt: parsed.snapshot.generatedAt,
      officerCount,
      abilityCount,
      schemaHash: {
        file: parsed.snapshot.schemaHash,
        computed: computedSchemaHash,
        match: schemaHashMatch,
      },
      contentHash: {
        file: parsed.snapshot.contentHash,
        computed: computedContentHash,
        expected: expectContentHash ?? null,
        match: contentHashMatch && expectedHashMatch,
      },
    }, {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      hints: ["Use --expect-content-hash=<sha256> in nightly/pinned validation workflows"],
    });
  },
};

export default command;
