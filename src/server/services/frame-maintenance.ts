/**
 * frame-maintenance.ts — Lex Frame Defragmentation & Retention
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Composes on FrameStore's existing interface to implement:
 * - TTL-based retention (delete frames older than N days)
 * - Superseded frame purging (delete frames marked as replaced)
 * - Stats reporting for monitoring bloat
 *
 * Designed to run as a periodic background task (not per-request).
 * All operations respect RLS — the store must already be user-scoped.
 *
 * @see docs/ADR-021-postgres-frame-store.md
 */

import type { FrameStore } from "@smartergpt/lex/store";
import { log } from "../logger.js";
import type { Pool } from "../db.js";
import { withUserScope } from "../stores/postgres-frame-store.js";

// ─── Configuration ──────────────────────────────────────────────

export interface MaintenanceConfig {
  /** Maximum age in days before frames are eligible for TTL deletion. Default: 90. */
  ttlDays: number;

  /** Whether to purge frames that have been superseded. Default: true. */
  purgeSuperseded: boolean;

  /** Dry-run mode: report what would be deleted without actually deleting. Default: false. */
  dryRun: boolean;
}

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  ttlDays: 90,
  purgeSuperseded: true,
  dryRun: false,
};

// ─── Result Types ───────────────────────────────────────────────

export interface MaintenanceResult {
  /** Frames deleted by TTL policy. */
  ttlDeleted: number;

  /** Superseded frames purged. */
  supersededPurged: number;

  /** Total frames remaining after maintenance. */
  remainingFrames: number;

  /** Wall-clock duration in milliseconds. */
  durationMs: number;

  /** Whether this was a dry run (no actual deletions). */
  dryRun: boolean;
}

export interface BloatReport {
  /** Total frames in store. */
  totalFrames: number;

  /** Frames with superseded_by set (dead weight). */
  supersededCount: number;

  /** Frames older than TTL threshold. */
  expiredCount: number;

  /** Estimated reclaimable rows (superseded + expired, deduplicated). */
  reclaimableRows: number;

  /** Percentage of store that is reclaimable. */
  reclaimablePercent: number;
}

// ─── Maintenance Operations ─────────────────────────────────────

/**
 * Run maintenance on a single user's frame store.
 *
 * The store MUST already be user-scoped (via FrameStoreFactory.forUser()).
 * This ensures RLS isolation — one user's maintenance can't touch another's data.
 */
export async function runMaintenance(
  store: FrameStore,
  config: Partial<MaintenanceConfig> = {},
): Promise<MaintenanceResult> {
  const opts = { ...DEFAULT_MAINTENANCE_CONFIG, ...config };
  const start = Date.now();

  let ttlDeleted = 0;
  let supersededPurged = 0;

  // 1. TTL: delete frames older than threshold
  if (opts.ttlDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - opts.ttlDays);

    if (opts.dryRun) {
      // Count how many would be deleted (search with until + large limit)
      const expired = await store.searchFrames({
        until: cutoff,
        limit: 100000,
      });
      ttlDeleted = expired.length;
    } else {
      ttlDeleted = await store.deleteFramesBefore(cutoff);
    }
  }

  // 2. Purge superseded frames
  // These are frames that Lex's dedup/consolidation has marked as replaced.
  // They serve no query purpose but still consume storage + index space.
  if (opts.purgeSuperseded) {
    supersededPurged = await purgeSupersededFrames(store, opts.dryRun);
  }

  const remainingFrames = await store.getFrameCount();
  const durationMs = Date.now() - start;

  const result: MaintenanceResult = {
    ttlDeleted,
    supersededPurged,
    remainingFrames,
    durationMs,
    dryRun: opts.dryRun,
  };

  log.lex.info(
    result,
    opts.dryRun ? "maintenance dry-run" : "maintenance complete",
  );
  return result;
}

/**
 * Delete frames where superseded_by is set.
 *
 * Uses FrameStore.purgeSuperseded() for O(1) bulk delete (Lex ≥ 2.5.0).
 * In dry-run mode, falls back to pagination to count without deleting.
 */
async function purgeSupersededFrames(
  store: FrameStore,
  dryRun: boolean,
): Promise<number> {
  if (!dryRun) {
    // Single bulk DELETE — no pagination needed
    return store.purgeSuperseded();
  }

  // Dry-run: count superseded frames without deleting
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await store.listFrames({ limit: 100, cursor });
    for (const frame of page.frames) {
      if (frame.superseded_by) count++;
    }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);

  return count;
}

/**
 * Generate a bloat report for a user's frame store.
 * Read-only — does not modify any data.
 */
export async function getBloatReport(
  store: FrameStore,
  ttlDays = 90,
): Promise<BloatReport> {
  const stats = await store.getStats();
  const totalFrames = stats.totalFrames;

  // Count superseded frames
  let supersededCount = 0;
  let cursor: string | undefined;
  do {
    const page = await store.listFrames({ limit: 100, cursor });
    for (const frame of page.frames) {
      if (frame.superseded_by) supersededCount++;
    }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);

  // Count expired frames
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ttlDays);
  const expired = await store.searchFrames({ until: cutoff, limit: 100000 });
  const expiredCount = expired.length;

  // Reclaimable is the union (some expired frames may also be superseded)
  // Approximate: sum minus estimated overlap
  const reclaimableRows = Math.min(totalFrames, supersededCount + expiredCount);
  const reclaimablePercent =
    totalFrames > 0 ? Math.round((reclaimableRows / totalFrames) * 100) : 0;

  return {
    totalFrames,
    supersededCount,
    expiredCount,
    reclaimableRows,
    reclaimablePercent,
  };
}

// ─── Postgres-Optimized Bulk Operations ─────────────────────────

/**
 * Postgres-native bulk purge of superseded frames.
 * Bypasses the FrameStore interface for O(1) bulk DELETE.
 * Requires direct pool access — only available in Postgres mode.
 *
 * Still respects RLS — withUserScope ensures only the scoped user's
 * superseded frames are deleted.
 */
export async function bulkPurgeSuperseded(
  pool: Pool,
  userId: string,
): Promise<number> {
  return withUserScope(pool, userId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM lex_frames WHERE superseded_by IS NOT NULL`,
    );
    return rowCount ?? 0;
  });
}

/**
 * Postgres-native VACUUM ANALYZE on the lex_frames table.
 * Should be called after large deletes to reclaim disk space and update planner stats.
 *
 * NOTE: VACUUM cannot run inside a transaction, so this uses a raw pool query
 * without withUserScope. It's a table-wide operation, not user-scoped.
 * Only call from admin/maintenance contexts.
 */
export async function vacuumFrames(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("VACUUM ANALYZE lex_frames");
    log.lex.info("VACUUM ANALYZE lex_frames complete");
  } finally {
    client.release();
  }
}
