#!/usr/bin/env tsx

import pg from "pg";

import {
  CANONICAL_RUNTIME_SCOPE,
  parseFlag,
  parsePositiveIntFlag,
} from "./lib/ingestion-types.js";
import { compareRecordsByNaturalKey } from "./lib/ingestion-entity.js";
import { validateFeed } from "./lib/ingestion-feed.js";
import { ensureIngestionSchema } from "./lib/ingestion-schema.js";
import { cmdLoad } from "./lib/ingestion-load.js";

async function cmdValidate(args: string[]): Promise<void> {
  const feed = parseFlag(args, "--feed");
  if (!feed) {
    throw new Error("validate requires --feed <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";

  const result = await validateFeed(feed, feedsRoot);
  if (result.errors.length > 0) {
    console.error(`❌ validation failed for ${result.feedPath}`);
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`✅ validation ok for ${result.feedPath}`);
  console.log(`feedId=${result.manifest.feedId} runId=${result.manifest.runId}`);
  console.log(`contentHash=${result.manifest.contentHash}`);
}

async function cmdDiff(args: string[]): Promise<void> {
  const a = parseFlag(args, "--a");
  const b = parseFlag(args, "--b");
  if (!a || !b) {
    throw new Error("diff requires --a <feedId-or-path> --b <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";

  const feedA = await validateFeed(a, feedsRoot);
  const feedB = await validateFeed(b, feedsRoot);
  const changedEntityTypes = new Set<string>();

  const allEntityTypes = new Set([
    ...Object.keys(feedA.manifest.entityHashes),
    ...Object.keys(feedB.manifest.entityHashes),
  ]);

  for (const entityType of [...allEntityTypes].sort()) {
    if (feedA.manifest.entityHashes[entityType] !== feedB.manifest.entityHashes[entityType]) {
      changedEntityTypes.add(entityType);
    }
  }

  console.log(`A: ${feedA.feedPath}`);
  console.log(`B: ${feedB.feedPath}`);

  if (changedEntityTypes.size === 0) {
    console.log("No entity hash changes");
    return;
  }

  console.log("Changed entities:");
  for (const entityType of [...changedEntityTypes]) {
    const aRecords = feedA.entityFiles[entityType]?.records ?? [];
    const bRecords = feedB.entityFiles[entityType]?.records ?? [];
    const details = compareRecordsByNaturalKey(entityType, aRecords, bRecords);
    const sample = [...details.changed, ...details.added, ...details.removed].slice(0, 5);
    console.log(
      `- ${entityType}: +${details.added.length} -${details.removed.length} ~${details.changed.length}`
      + (sample.length > 0 ? ` sample=[${sample.join(", ")}]` : "")
    );
  }
}

interface RuntimeStatusRow {
  runId: string;
  contentHash: string;
  datasetKind: string;
  sourceLabel: string;
  sourceVersion: string | null;
  snapshotId: string | null;
  status: string;
  createdAt: string;
  activatedAt: string | null;
}

async function cmdStatus(args: string[]): Promise<void> {
  const dbUrl = parseFlag(args, "--db-url") ?? process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
  const scope = parseFlag(args, "--scope") ?? CANONICAL_RUNTIME_SCOPE;
  const limit = parsePositiveIntFlag(args, "--limit") ?? 10;

  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    await ensureIngestionSchema(pool);

    const activeResult = await pool.query<{ scope: string; run_id: string; updated_at: string }>(
      `SELECT scope, run_id, updated_at
       FROM effect_dataset_active
       WHERE scope = $1`,
      [scope]
    );

    const runsResult = await pool.query<RuntimeStatusRow>(
      `SELECT
         run_id AS "runId",
         content_hash AS "contentHash",
         dataset_kind AS "datasetKind",
         source_label AS "sourceLabel",
         source_version AS "sourceVersion",
         snapshot_id AS "snapshotId",
         status,
         created_at AS "createdAt",
         activated_at AS "activatedAt"
       FROM effect_dataset_run
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    const active = activeResult.rows[0] ?? null;
    const payload = {
      scope,
      active: active
        ? {
            scope: active.scope,
            runId: active.run_id,
            updatedAt: active.updated_at,
          }
        : null,
      runs: runsResult.rows,
    };

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await pool.end();
  }
}

function usage(): string {
  return [
    "Usage:",
    "  tsx scripts/data-ingestion.ts validate --feed <feedId-or-path> [--feeds-root data/feeds]",
    "  tsx scripts/data-ingestion.ts load --feed <feedId-or-path> [--feeds-root data/feeds] [--db-url <postgres-url>] [--activate-runtime-dataset] [--retention-keep-runs <n>]",
    "  tsx scripts/data-ingestion.ts diff --a <feedId-or-path> --b <feedId-or-path> [--feeds-root data/feeds]",
    "  tsx scripts/data-ingestion.ts status [--db-url <postgres-url>] [--scope global] [--limit 10]",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "validate") {
    await cmdValidate(args.slice(1));
    return;
  }

  if (command === "load") {
    await cmdLoad(args.slice(1));
    return;
  }

  if (command === "diff") {
    await cmdDiff(args.slice(1));
    return;
  }

  if (command === "status") {
    await cmdStatus(args.slice(1));
    return;
  }

  console.log(usage());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
