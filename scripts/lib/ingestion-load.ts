/**
 * ingestion-load.ts — Canonical feed load pipeline (cmdLoad)
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import pg from "pg";

import {
  type JsonObject,
  type JsonValue,
  type PreparedEntityRecords,
  CANONICAL_DATASET_KIND,
  CANONICAL_RUNTIME_SCOPE,
  stableSortObject,
  parseFlag,
  hasFlag,
  parsePositiveIntFlag,
} from "./ingestion-types.js";
import { extractNaturalKey, findOrphanViolations } from "./ingestion-entity.js";
import { validateFeed } from "./ingestion-feed.js";
import { ensureIngestionSchema } from "./ingestion-schema.js";

async function writeLoadReceipt(path: string, payload: JsonValue): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

export async function cmdLoad(args: string[]): Promise<void> {
  const feed = parseFlag(args, "--feed");
  if (!feed) {
    throw new Error("load requires --feed <feedId-or-path>");
  }
  const feedsRoot = parseFlag(args, "--feeds-root") ?? "data/feeds";
  const dbUrl = parseFlag(args, "--db-url") ?? process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
  const strict = !hasFlag(args, "--allow-partial");
  const activateRuntimeDataset = hasFlag(args, "--activate-runtime-dataset");
  const retentionKeepRuns = parsePositiveIntFlag(args, "--retention-keep-runs");

  const startedAt = Date.now();
  const validated = await validateFeed(feed, feedsRoot);
  const loadReceiptPath = join(validated.feedPath, "receipts", "load-receipt.json");

  if (validated.errors.length > 0) {
    const failedReceipt: JsonValue = {
      schemaVersion: "1.0.0",
      feedId: validated.manifest.feedId,
      runId: validated.manifest.runId,
      status: "failed",
      feedPath: validated.feedPath,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      integrity: {
        validationOk: false,
        errors: validated.errors,
      },
    };
    await writeLoadReceipt(loadReceiptPath, failedReceipt);
    console.error(`❌ load blocked by validation errors (${validated.errors.length})`);
    for (const error of validated.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const recordsByEntity: PreparedEntityRecords[] = Object.entries(validated.entityFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entityType, file]) => {
      const records = file.records
        .map((record) => ({
          naturalKey: extractNaturalKey(entityType, record),
          payload: record,
        }))
        .filter((entry): entry is { naturalKey: string; payload: JsonValue } => typeof entry.naturalKey === "string")
        .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
      return { entityType, records };
    });

  let inserted = 0;
  let updated = 0;
  let duplicateNaturalKeys = 0;
  let retentionRemovedRunIds: string[] = [];
  const orphanViolations = findOrphanViolations(recordsByEntity);
  const datasetKind = CANONICAL_DATASET_KIND;
  const runtimeMetadata: JsonObject = {
    feedPath: validated.feedPath,
    feedId: validated.manifest.feedId,
    runId: validated.manifest.runId,
    schemaVersion: validated.manifest.schemaVersion,
    schemaHash: validated.manifest.schemaHash,
    artifactUri: validated.manifest.artifactUri ?? null,
    artifactFormat: validated.manifest.artifactFormat ?? null,
    hashSemantics: validated.manifest.hashSemantics ?? null,
    artifactAvailability: validated.manifest.artifactAvailability ?? null,
  };

  const pool = new pg.Pool({ connectionString: dbUrl });
  let runId: number | null = null;

  console.log(`[load] feed=${validated.manifest.feedId} run=${validated.manifest.runId}`);
  console.log(`[load] contentHash=${validated.manifest.contentHash}`);
  console.log(`[load] connecting to database...`);

  try {
    await ensureIngestionSchema(pool);
    console.log(`[load] schema verified`);

    const existingSuccessful = await pool.query<{
      id: number;
      content_hash: string;
      status: string;
      inserted_count: number;
      updated_count: number;
      duplicate_count: number;
      orphan_count: number;
      completed_at: string | null;
    }>(
      `SELECT
         id,
         content_hash,
         status,
         inserted_count,
         updated_count,
         duplicate_count,
         orphan_count,
         completed_at
       FROM canonical_ingestion_runs
       WHERE feed_id = $1 AND run_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [validated.manifest.feedId, validated.manifest.runId]
    );

    const prior = existingSuccessful.rows[0] ?? null;
    if (prior && prior.status === "success" && prior.content_hash === validated.manifest.contentHash) {
      const completedAt = Date.now();
      const noOpReceipt: JsonValue = {
        schemaVersion: "1.0.0",
        feedId: validated.manifest.feedId,
        runId: validated.manifest.runId,
        status: "noop",
        reason: "idempotent_replay",
        feedPath: validated.feedPath,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        sourceLabel: validated.manifest.sourceLabel,
        sourceVersion: validated.manifest.sourceVersion,
        snapshotId: validated.manifest.snapshotId,
        contentHash: validated.manifest.contentHash,
        entityCounts: stableSortObject(validated.manifest.entityCounts),
        priorRun: {
          id: prior.id,
          status: prior.status,
          completedAt: prior.completed_at,
          inserted: prior.inserted_count,
          updated: prior.updated_count,
          duplicateNaturalKeys: prior.duplicate_count,
          orphanViolations: prior.orphan_count,
        },
      };
      await writeLoadReceipt(loadReceiptPath, noOpReceipt);
      console.log(`✅ load no-op replay for ${validated.feedPath}`);
      console.log(`reason=idempotent_replay`);
      console.log(`loadReceipt=${loadReceiptPath}`);
      return;
    }

    const existingRuntimeByHash = await pool.query<{
      run_id: string;
      dataset_kind: string;
      status: string;
    }>(
      `SELECT run_id, dataset_kind, status
       FROM effect_dataset_run
       WHERE content_hash = $1
       LIMIT 1`,
      [validated.manifest.contentHash]
    );

    const runtimeByHash = existingRuntimeByHash.rows[0] ?? null;
    if (runtimeByHash && runtimeByHash.run_id !== validated.manifest.runId) {
      if (runtimeByHash.dataset_kind !== datasetKind) {
        throw new Error(
          `content hash already exists under dataset kind '${runtimeByHash.dataset_kind}' (expected '${datasetKind}')`
        );
      }

      const aliasClient = await pool.connect();
      try {
        await aliasClient.query("BEGIN");

        await aliasClient.query(
          `INSERT INTO canonical_ingestion_runs (
            feed_id, run_id, feed_path, content_hash, source_label,
            source_version, snapshot_id, status, validation_errors, entity_counts,
            inserted_count, updated_count, duplicate_count, orphan_count,
            started_at, completed_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            'success', '[]'::jsonb, $8::jsonb,
            0, 0, 0, 0,
            NOW(), NOW()
          )
          ON CONFLICT (feed_id, run_id) DO UPDATE SET
            feed_path = EXCLUDED.feed_path,
            content_hash = EXCLUDED.content_hash,
            source_label = EXCLUDED.source_label,
            source_version = EXCLUDED.source_version,
            snapshot_id = EXCLUDED.snapshot_id,
            status = 'success',
            validation_errors = '[]'::jsonb,
            entity_counts = EXCLUDED.entity_counts,
            inserted_count = 0,
            updated_count = 0,
            duplicate_count = 0,
            orphan_count = 0,
            started_at = NOW(),
            completed_at = NOW()`,
          [
            validated.manifest.feedId,
            validated.manifest.runId,
            validated.feedPath,
            validated.manifest.contentHash,
            validated.manifest.sourceLabel,
            validated.manifest.sourceVersion,
            validated.manifest.snapshotId,
            JSON.stringify(stableSortObject(validated.manifest.entityCounts)),
          ]
        );

        if (activateRuntimeDataset) {
          await aliasClient.query(
            `UPDATE effect_dataset_run
             SET status = 'retired'
             WHERE status = 'active'
               AND dataset_kind = $2
               AND run_id <> $1`,
            [runtimeByHash.run_id, CANONICAL_DATASET_KIND]
          );

          await aliasClient.query(
            `UPDATE effect_dataset_run
             SET status = 'active', activated_at = COALESCE(activated_at, NOW())
             WHERE run_id = $1`,
            [runtimeByHash.run_id]
          );

          await aliasClient.query(
            `INSERT INTO effect_dataset_active (scope, run_id, updated_at)
             VALUES ($2, $1, NOW())
             ON CONFLICT (scope) DO UPDATE SET
               run_id = EXCLUDED.run_id,
               updated_at = NOW()`,
            [runtimeByHash.run_id, CANONICAL_RUNTIME_SCOPE]
          );
        }

        if (retentionKeepRuns != null) {
          const retentionResult = await aliasClient.query<{ run_id: string }>(
            `WITH ranked AS (
               SELECT run_id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
               FROM effect_dataset_run
               WHERE dataset_kind = $2
             ),
             active_run AS (
               SELECT run_id
               FROM effect_dataset_active
               WHERE scope = $3
             ),
             removable AS (
               SELECT ranked.run_id
               FROM ranked
               LEFT JOIN active_run ON active_run.run_id = ranked.run_id
               WHERE ranked.rn > $1 AND active_run.run_id IS NULL
             )
             DELETE FROM effect_dataset_run
             WHERE run_id IN (SELECT run_id FROM removable)
             RETURNING run_id`,
            [retentionKeepRuns, CANONICAL_DATASET_KIND, CANONICAL_RUNTIME_SCOPE]
          );
          retentionRemovedRunIds = retentionResult.rows.map((row) => row.run_id).sort();
        }

        await aliasClient.query("COMMIT");
      } catch (error) {
        await aliasClient.query("ROLLBACK");
        throw error;
      } finally {
        aliasClient.release();
      }

      const completedAt = Date.now();
      const noOpByHashReceipt: JsonValue = {
        schemaVersion: "1.0.0",
        feedId: validated.manifest.feedId,
        runId: validated.manifest.runId,
        status: "noop",
        reason: "idempotent_content_hash_reuse",
        feedPath: validated.feedPath,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        sourceLabel: validated.manifest.sourceLabel,
        sourceVersion: validated.manifest.sourceVersion,
        snapshotId: validated.manifest.snapshotId,
        contentHash: validated.manifest.contentHash,
        entityCounts: stableSortObject(validated.manifest.entityCounts),
        runtimeDataset: {
          runId: runtimeByHash.run_id,
          contentHash: validated.manifest.contentHash,
          datasetKind,
          status: activateRuntimeDataset ? "active" : runtimeByHash.status,
          retentionKeepRuns: retentionKeepRuns ?? null,
          retentionRemovedRunIds,
        },
      };

      await writeLoadReceipt(loadReceiptPath, noOpByHashReceipt);
      console.log(`✅ load no-op by content hash for ${validated.feedPath}`);
      console.log(`reason=idempotent_content_hash_reuse existingRunId=${runtimeByHash.run_id}`);
      console.log(`loadReceipt=${loadReceiptPath}`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      console.log(`[load] acquiring advisory lock...`);
      const lockResult = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [`canonical-ingestion:${validated.manifest.feedId}:${validated.manifest.runId}`]
      );
      if (!lockResult.rows[0]?.acquired) {
        throw new Error("concurrent canonical load already in progress for this feed/run");
      }
      console.log(`[load] lock acquired, inserting run record...`);

      const runInsert = await client.query<{ id: number }>(
        `INSERT INTO canonical_ingestion_runs (
          feed_id, run_id, feed_path, content_hash, source_label,
          source_version, snapshot_id, status, validation_errors, entity_counts, started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', '[]'::jsonb, $8::jsonb, NOW())
        ON CONFLICT (feed_id, run_id) DO UPDATE SET
          feed_path = EXCLUDED.feed_path,
          content_hash = EXCLUDED.content_hash,
          source_label = EXCLUDED.source_label,
          source_version = EXCLUDED.source_version,
          snapshot_id = EXCLUDED.snapshot_id,
          status = 'running',
          validation_errors = '[]'::jsonb,
          entity_counts = EXCLUDED.entity_counts,
          inserted_count = 0,
          updated_count = 0,
          duplicate_count = 0,
          orphan_count = 0,
          started_at = NOW(),
          completed_at = NULL
        RETURNING id`,
        [
          validated.manifest.feedId,
          validated.manifest.runId,
          validated.feedPath,
          validated.manifest.contentHash,
          validated.manifest.sourceLabel,
          validated.manifest.sourceVersion,
          validated.manifest.snapshotId,
          JSON.stringify(stableSortObject(validated.manifest.entityCounts)),
        ]
      );
      runId = runInsert.rows[0]?.id ?? null;

      await client.query(
        `INSERT INTO effect_dataset_run (
          run_id, content_hash, dataset_kind, source_label,
          source_version, snapshot_id, status, metrics_json, metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (run_id) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          dataset_kind = EXCLUDED.dataset_kind,
          source_label = EXCLUDED.source_label,
          source_version = EXCLUDED.source_version,
          snapshot_id = EXCLUDED.snapshot_id,
          status = EXCLUDED.status,
          metrics_json = EXCLUDED.metrics_json,
          metadata_json = EXCLUDED.metadata_json`,
        [
          validated.manifest.runId,
          validated.manifest.contentHash,
          datasetKind,
          validated.manifest.sourceLabel,
          validated.manifest.sourceVersion,
          validated.manifest.snapshotId,
          activateRuntimeDataset ? "active" : "staged",
          validated.manifest.metrics ? JSON.stringify(validated.manifest.metrics) : null,
          JSON.stringify(runtimeMetadata),
        ]
      );

      console.log(`[load] runtime dataset record created`);

      if (activateRuntimeDataset) {
        console.log(`[load] activating runtime dataset...`);
        await client.query(
          `UPDATE effect_dataset_run
           SET status = 'retired'
           WHERE status = 'active'
             AND dataset_kind = $2
             AND run_id <> $1`,
          [validated.manifest.runId, CANONICAL_DATASET_KIND]
        );

        await client.query(
          `UPDATE effect_dataset_run
           SET status = 'active', activated_at = NOW()
           WHERE run_id = $1`,
          [validated.manifest.runId]
        );

        await client.query(
          `INSERT INTO effect_dataset_active (scope, run_id, updated_at)
           VALUES ($2, $1, NOW())
           ON CONFLICT (scope) DO UPDATE SET
             run_id = EXCLUDED.run_id,
             updated_at = NOW()`,
          [validated.manifest.runId, CANONICAL_RUNTIME_SCOPE]
        );
      }

      if (retentionKeepRuns != null) {
        const retentionResult = await client.query<{ run_id: string }>(
          `WITH ranked AS (
             SELECT run_id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
             FROM effect_dataset_run
             WHERE dataset_kind = $2
           ),
           active_run AS (
             SELECT run_id
             FROM effect_dataset_active
             WHERE scope = $3
           ),
           removable AS (
             SELECT ranked.run_id
             FROM ranked
             LEFT JOIN active_run ON active_run.run_id = ranked.run_id
             WHERE ranked.rn > $1 AND active_run.run_id IS NULL
           )
           DELETE FROM effect_dataset_run
           WHERE run_id IN (SELECT run_id FROM removable)
           RETURNING run_id`,
          [retentionKeepRuns, CANONICAL_DATASET_KIND, CANONICAL_RUNTIME_SCOPE]
        );
        retentionRemovedRunIds = retentionResult.rows.map((row) => row.run_id).sort();
      }

      for (const entity of recordsByEntity) {
        const seen = new Set<string>();
        const deduped: Array<{ naturalKey: string; payload: JsonValue }> = [];
        for (const record of entity.records) {
          if (seen.has(record.naturalKey)) {
            duplicateNaturalKeys += 1;
            if (strict) {
              throw new Error(`duplicate natural key detected during load: ${entity.entityType}:${record.naturalKey}`);
            }
            continue;
          }
          seen.add(record.naturalKey);
          deduped.push(record);
        }

        console.log(`[load] ${entity.entityType}: ${deduped.length} records`);
        if (deduped.length === 0) continue;

        // Batch upsert via UNNEST — one round trip per entity type
        const BATCH_SIZE = 2000;
        for (let offset = 0; offset < deduped.length; offset += BATCH_SIZE) {
          const batch = deduped.slice(offset, offset + BATCH_SIZE);
          const entityTypes: string[] = [];
          const naturalKeys: string[] = [];
          const payloads: string[] = [];

          for (const record of batch) {
            entityTypes.push(entity.entityType);
            naturalKeys.push(record.naturalKey);
            payloads.push(JSON.stringify(record.payload));
          }

          const upsertResult = await client.query<{ inserted: boolean }>(
            `INSERT INTO canonical_ingestion_records (
              entity_type, natural_key, payload, source_label, feed_id, run_id, content_hash
            )
            SELECT * FROM unnest(
              $1::text[], $2::text[], $3::jsonb[],
              array_fill($4::text, ARRAY[$8::int]),
              array_fill($5::text, ARRAY[$8::int]),
              array_fill($6::text, ARRAY[$8::int]),
              array_fill($7::text, ARRAY[$8::int])
            )
            ON CONFLICT (entity_type, natural_key) DO UPDATE SET
              payload = EXCLUDED.payload,
              source_label = EXCLUDED.source_label,
              feed_id = EXCLUDED.feed_id,
              run_id = EXCLUDED.run_id,
              content_hash = EXCLUDED.content_hash,
              last_seen_at = NOW()
            RETURNING (xmax = 0) AS inserted`,
            [
              entityTypes,
              naturalKeys,
              payloads,
              validated.manifest.sourceLabel,
              validated.manifest.feedId,
              validated.manifest.runId,
              validated.manifest.contentHash,
              batch.length,
            ]
          );

          const batchInserted = upsertResult.rows.filter((r) => r.inserted).length;
          const batchUpdated = upsertResult.rows.length - batchInserted;
          inserted += batchInserted;
          updated += batchUpdated;

          const progress = Math.min(offset + BATCH_SIZE, deduped.length);
          const pct = ((progress / deduped.length) * 100).toFixed(1);
          console.log(`[load]   ${entity.entityType}: ${progress}/${deduped.length} (${pct}%) — ${inserted} ins, ${updated} upd`);
        }
      }

      if (strict && orphanViolations.length > 0) {
        const sample = orphanViolations
          .slice(0, 5)
          .map((violation) => `${violation.entityType}:${violation.naturalKey}.${violation.field}->${violation.referencedEntityType}:${violation.referencedNaturalKey}`)
          .join(", ");
        throw new Error(`orphan violations detected: ${orphanViolations.length}${sample ? ` (sample: ${sample})` : ""}`);
      }

      await client.query(
        `UPDATE canonical_ingestion_runs
         SET status = 'success',
             inserted_count = $1,
             updated_count = $2,
             duplicate_count = $3,
             orphan_count = $4,
             completed_at = NOW()
         WHERE id = $5`,
        [inserted, updated, duplicateNaturalKeys, orphanViolations.length, runId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (runId != null) {
        await pool.query(
          `UPDATE canonical_ingestion_runs
           SET status = 'failed',
               validation_errors = $1::jsonb,
               completed_at = NOW()
           WHERE id = $2`,
          [JSON.stringify([String(error)]), runId]
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }

    const completedAt = Date.now();
    const loadReceipt: JsonValue = {
      schemaVersion: "1.0.0",
      feedId: validated.manifest.feedId,
      runId: validated.manifest.runId,
      status: duplicateNaturalKeys > 0 && !strict ? "partial" : "success",
      feedPath: validated.feedPath,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      sourceLabel: validated.manifest.sourceLabel,
      sourceVersion: validated.manifest.sourceVersion,
      snapshotId: validated.manifest.snapshotId,
      contentHash: validated.manifest.contentHash,
      entityCounts: stableSortObject(validated.manifest.entityCounts),
      upsertSummary: {
        inserted,
        updated,
        total: inserted + updated,
      },
      integrity: {
        validationOk: true,
        duplicateNaturalKeys,
        orphanViolations: orphanViolations.length,
        orphanSamples: orphanViolations.slice(0, 10),
      },
      runtimeDataset: {
        runId: validated.manifest.runId,
        contentHash: validated.manifest.contentHash,
        datasetKind,
        status: activateRuntimeDataset ? "active" : "staged",
        retentionKeepRuns: retentionKeepRuns ?? null,
        retentionRemovedRunIds,
      },
    };

    await writeLoadReceipt(loadReceiptPath, loadReceipt);

    console.log(`✅ load completed for ${validated.feedPath}`);
    console.log(`inserted=${inserted} updated=${updated}`);
    console.log(`runtimeDataset=${validated.manifest.runId}:${activateRuntimeDataset ? "active" : "staged"}`);
    console.log(`loadReceipt=${loadReceiptPath}`);
  } finally {
    await pool.end();
  }
}
