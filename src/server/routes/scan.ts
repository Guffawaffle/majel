/**
 * routes/scan.ts — Structured image extraction + smart import (ADR-008 Phase B+C)
 *
 * POST /api/fleet/scan       — Extract structured fleet data from a single STFC screenshot.
 * POST /api/fleet/scan/batch — Extract from multiple screenshots in one request.
 * POST /api/fleet/scan/commit — Apply reviewed scan results to overlay + create receipt.
 */

import express, { type Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode, defineModuleErrorCodes } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireVisitor } from "../services/auth.js";
import { createContextMiddleware } from "../context-middleware.js";
import { type ScanType, type ScanResult, extractFromImage, crossReference } from "../services/scan.js";
import { log } from "../logger.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_DATA_LENGTH = 10 * 1024 * 1024;
const MAX_BATCH_IMAGES = 10;
const MAX_COMMIT_ENTITIES = 500;
const VALID_SCAN_TYPES = new Set<ScanType>(["officer", "ship", "event", "auto"]);

const ScanErrorCode = defineModuleErrorCodes("scan", [
  "extraction_failed",
  "commit_failed",
] as const);

/** Shape of an entity in a scan commit request. */
interface ScanCommitEntity {
  entityType: "officer" | "ship";
  refId: string;
  level?: number;
  rank?: number;
  tier?: number;
  power?: number;
}

export function createScanRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // 10MB body limit for base64 image payloads
  const scanBodyParser = express.json({ limit: "10mb" });

  router.post(
    "/api/fleet/scan",
    scanBodyParser,
    requireVisitor(appState),
    ...(appState.pool ? [createContextMiddleware(appState.pool)] : []),
    async (req, res) => {
      const { image, scanType } = req.body;

      // ── Validate scanType ─────────────────────────────────
      if (!scanType || typeof scanType !== "string") {
        return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'scanType' — must be one of: officer, ship, event, auto", 400);
      }
      if (!VALID_SCAN_TYPES.has(scanType as ScanType)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid scanType '${scanType}'. Must be one of: officer, ship, event, auto`, 400);
      }

      // ── Validate image ────────────────────────────────────
      if (!image || typeof image !== "object") {
        return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'image' — must have 'data' (base64) and 'mimeType' fields", 400);
      }
      if (!image.data || !image.mimeType) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Image must have 'data' (base64) and 'mimeType' fields", 400);
      }
      if (!ALLOWED_IMAGE_TYPES.has(image.mimeType)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Unsupported image type: ${image.mimeType}. Allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")}`, 400);
      }
      if (typeof image.data !== "string" || image.data.length > MAX_IMAGE_DATA_LENGTH) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Image data must be a base64 string under ${Math.round(MAX_IMAGE_DATA_LENGTH / 1024 / 1024)}MB`, 400);
      }

      // ── Check prerequisites ───────────────────────────────
      if (!appState.config.geminiApiKey) {
        return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini API key not configured", 503);
      }
      if (!appState.referenceStore) {
        return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      }

      const modelId = appState.geminiEngine?.getModel() ?? "gemini-2.5-flash-lite";
      const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string | undefined);

      try {
        // ── Extract structured data from image ──────────────
        const extracted = await extractFromImage(
          appState.config.geminiApiKey,
          modelId,
          { data: image.data, mimeType: image.mimeType },
          scanType as ScanType,
        );

        // ── Cross-reference against catalog ─────────────────
        const overlayStore = userId && appState.overlayStoreFactory
          ? appState.overlayStoreFactory.forUser(userId)
          : null;

        const matched = await crossReference(
          extracted,
          appState.referenceStore,
          overlayStore,
        );

        log.gemini.info({
          scanType,
          confidence: extracted.confidence,
          matchedCount: matched.length,
          officerCount: extracted.officers?.length ?? 0,
          shipCount: extracted.ships?.length ?? 0,
          eventCount: extracted.events?.length ?? 0,
        }, "scan:complete");

        return sendOk(res, {
          scanType: extracted.scanType,
          extracted,
          matched,
        });
      } catch (err) {
        log.gemini.error({ err, scanType }, "scan:extraction_failed");
        return sendFail(res, ScanErrorCode.extraction_failed, "Image extraction failed", 500, {
          hints: ["The image may be too blurry or not a recognized STFC screenshot", "Try a clearer screenshot"],
        });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════
  // POST /api/fleet/scan/batch — Multiple screenshots (ADR-008 Phase C)
  // ═══════════════════════════════════════════════════════════

  router.post(
    "/api/fleet/scan/batch",
    scanBodyParser,
    requireVisitor(appState),
    ...(appState.pool ? [createContextMiddleware(appState.pool)] : []),
    async (req, res) => {
      const { images } = req.body;

      if (!Array.isArray(images) || images.length === 0) {
        return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'images' — must be a non-empty array", 400);
      }
      if (images.length > MAX_BATCH_IMAGES) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Batch limited to ${MAX_BATCH_IMAGES} images`, 400);
      }

      // Validate each image entry
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || typeof img !== "object") {
          return sendFail(res, ErrorCode.INVALID_PARAM, `images[${i}] must be an object with image and scanType`, 400);
        }
        if (!img.scanType || !VALID_SCAN_TYPES.has(img.scanType)) {
          return sendFail(res, ErrorCode.INVALID_PARAM, `images[${i}].scanType must be one of: officer, ship, event, auto`, 400);
        }
        if (!img.image || typeof img.image !== "object" || !img.image.data || !img.image.mimeType) {
          return sendFail(res, ErrorCode.INVALID_PARAM, `images[${i}].image must have 'data' (base64) and 'mimeType'`, 400);
        }
        if (!ALLOWED_IMAGE_TYPES.has(img.image.mimeType)) {
          return sendFail(res, ErrorCode.INVALID_PARAM, `images[${i}]: unsupported type ${img.image.mimeType}`, 400);
        }
        if (typeof img.image.data !== "string" || img.image.data.length > MAX_IMAGE_DATA_LENGTH) {
          return sendFail(res, ErrorCode.INVALID_PARAM, `images[${i}]: image data must be a base64 string under 10MB`, 400);
        }
      }

      if (!appState.config.geminiApiKey) {
        return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini API key not configured", 503);
      }
      if (!appState.referenceStore) {
        return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      }

      const modelId = appState.geminiEngine?.getModel() ?? "gemini-2.5-flash-lite";
      const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string | undefined);
      const overlayStore = userId && appState.overlayStoreFactory
        ? appState.overlayStoreFactory.forUser(userId)
        : null;

      const results: ScanResult[] = [];
      const errors: Array<{ index: number; error: string }> = [];

      // Process sequentially to avoid Gemini rate limits
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const extracted = await extractFromImage(
            appState.config.geminiApiKey,
            modelId,
            { data: img.image.data, mimeType: img.image.mimeType },
            img.scanType as ScanType,
          );
          const matched = await crossReference(extracted, appState.referenceStore, overlayStore);
          results.push({ scanType: extracted.scanType, extracted, matched });
        } catch (err) {
          log.gemini.error({ err, index: i, scanType: img.scanType }, "scan:batch_extraction_failed");
          errors.push({ index: i, error: "Extraction failed for this image" });
        }
      }

      log.gemini.info({
        batchSize: images.length,
        successes: results.length,
        failures: errors.length,
      }, "scan:batch_complete");

      return sendOk(res, { results, errors });
    },
  );

  // ═══════════════════════════════════════════════════════════
  // POST /api/fleet/scan/commit — Apply scan results (ADR-008 Phase C)
  // ═══════════════════════════════════════════════════════════

  router.post(
    "/api/fleet/scan/commit",
    scanBodyParser,
    requireVisitor(appState),
    ...(appState.pool ? [createContextMiddleware(appState.pool)] : []),
    async (req, res) => {
      const { entities } = req.body ?? {};

      // ── Validate entities array (before DB check for better error messages) ──
      if (!Array.isArray(entities) || entities.length === 0) {
        return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'entities' — must be a non-empty array of scan results to commit", 400);
      }
      if (entities.length > MAX_COMMIT_ENTITIES) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `entities limited to ${MAX_COMMIT_ENTITIES} items`, 400);
      }

      // Validate each entity
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e || typeof e !== "object") {
          return sendFail(res, ErrorCode.INVALID_PARAM, `entities[${i}] must be an object`, 400);
        }
        if (e.entityType !== "officer" && e.entityType !== "ship") {
          return sendFail(res, ErrorCode.INVALID_PARAM, `entities[${i}].entityType must be 'officer' or 'ship'`, 400);
        }
        if (typeof e.refId !== "string" || e.refId.length === 0) {
          return sendFail(res, ErrorCode.INVALID_PARAM, `entities[${i}].refId must be a non-empty string`, 400);
        }
      }

      // ── Check prerequisites ───────────────────────────────
      const ctx = res.locals.ctx;
      if (!ctx) {
        return sendFail(res, ErrorCode.OVERLAY_STORE_NOT_AVAILABLE, "Database pool not available", 503);
      }
      const userId = ctx.identity.userId;

      if (!appState.referenceStore) {
        return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
      }

      // ── Verify all refIds exist in reference catalog ──────
      const typedEntities = entities as ScanCommitEntity[];
      const officerRefIds = [...new Set(typedEntities.filter((e) => e.entityType === "officer").map((e) => e.refId))];
      const shipRefIds = [...new Set(typedEntities.filter((e) => e.entityType === "ship").map((e) => e.refId))];

      const [officerChecks, shipChecks] = await Promise.all([
        Promise.all(officerRefIds.map(async (id) => ({ id, found: !!(await appState.referenceStore!.getOfficer(id)) }))),
        Promise.all(shipRefIds.map(async (id) => ({ id, found: !!(await appState.referenceStore!.getShip(id)) }))),
      ]);

      const missingOfficers = officerChecks.filter((c) => !c.found).map((c) => c.id);
      const missingShips = shipChecks.filter((c) => !c.found).map((c) => c.id);
      if (missingOfficers.length > 0 || missingShips.length > 0) {
        return sendFail(
          res,
          ErrorCode.INVALID_PARAM,
          `Unknown reference IDs (officers: ${missingOfficers.join(", ") || "none"}; ships: ${missingShips.join(", ") || "none"})`,
          400,
        );
      }

      // ── Transactional commit ──────────────────────────────
      try {
        const outcome = await ctx.writeScope(async (db) => {
          const changesAdded: unknown[] = [];
          const changesUpdated: unknown[] = [];
          const inverseEntries: unknown[] = [];

          for (const entity of typedEntities) {
            if (entity.entityType === "officer") {
              // Read before-state
              const beforeResult = await db.query(
                `SELECT ref_id AS "refId", ownership_state AS "ownershipState", level, rank, power
                 FROM officer_overlay WHERE ref_id = $1`,
                [entity.refId],
              );
              const before = beforeResult.rows[0] ?? null;

              await db.query(
                `INSERT INTO officer_overlay (user_id, ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
                 VALUES ($1, $2, 'owned',
                   COALESCE((SELECT target FROM officer_overlay WHERE ref_id = $2 AND user_id = $1), FALSE),
                   $3, $4, $5,
                   COALESCE((SELECT target_note FROM officer_overlay WHERE ref_id = $2 AND user_id = $1), NULL),
                   COALESCE((SELECT target_priority FROM officer_overlay WHERE ref_id = $2 AND user_id = $1), NULL),
                   $6)
                 ON CONFLICT(user_id, ref_id) DO UPDATE SET
                   ownership_state = 'owned',
                   level = COALESCE(EXCLUDED.level, officer_overlay.level),
                   rank = COALESCE(EXCLUDED.rank, officer_overlay.rank),
                   power = COALESCE(EXCLUDED.power, officer_overlay.power),
                   updated_at = EXCLUDED.updated_at`,
                [
                  userId,
                  entity.refId,
                  entity.level ?? null,
                  entity.rank != null ? String(entity.rank) : null,
                  entity.power ?? null,
                  new Date().toISOString(),
                ],
              );

              const afterResult = await db.query(
                `SELECT ref_id AS "refId", ownership_state AS "ownershipState", level, rank, power
                 FROM officer_overlay WHERE ref_id = $1`,
                [entity.refId],
              );

              const payload = { entityType: "officer", refId: entity.refId, before, after: afterResult.rows[0] };
              if (before) changesUpdated.push(payload);
              else changesAdded.push(payload);
              inverseEntries.push({ entityType: "officer", refId: entity.refId, before });

            } else {
              // Ship
              const beforeResult = await db.query(
                `SELECT ref_id AS "refId", ownership_state AS "ownershipState", tier, level, power
                 FROM ship_overlay WHERE ref_id = $1`,
                [entity.refId],
              );
              const before = beforeResult.rows[0] ?? null;

              await db.query(
                `INSERT INTO ship_overlay (user_id, ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
                 VALUES ($1, $2, 'owned',
                   COALESCE((SELECT target FROM ship_overlay WHERE ref_id = $2 AND user_id = $1), FALSE),
                   $3, $4, $5,
                   COALESCE((SELECT target_note FROM ship_overlay WHERE ref_id = $2 AND user_id = $1), NULL),
                   COALESCE((SELECT target_priority FROM ship_overlay WHERE ref_id = $2 AND user_id = $1), NULL),
                   $6)
                 ON CONFLICT(user_id, ref_id) DO UPDATE SET
                   ownership_state = 'owned',
                   tier = COALESCE(EXCLUDED.tier, ship_overlay.tier),
                   level = COALESCE(EXCLUDED.level, ship_overlay.level),
                   power = COALESCE(EXCLUDED.power, ship_overlay.power),
                   updated_at = EXCLUDED.updated_at`,
                [
                  userId,
                  entity.refId,
                  entity.tier ?? null,
                  entity.level ?? null,
                  entity.power ?? null,
                  new Date().toISOString(),
                ],
              );

              const afterResult = await db.query(
                `SELECT ref_id AS "refId", ownership_state AS "ownershipState", tier, level, power
                 FROM ship_overlay WHERE ref_id = $1`,
                [entity.refId],
              );

              const payload = { entityType: "ship", refId: entity.refId, before, after: afterResult.rows[0] };
              if (before) changesUpdated.push(payload);
              else changesAdded.push(payload);
              inverseEntries.push({ entityType: "ship", refId: entity.refId, before });
            }
          }

          // ── Create receipt ────────────────────────────────
          const receiptInsert = await db.query<{ id: number }>(
            `INSERT INTO import_receipts (user_id, source_type, source_meta, mapping, layer, changeset, inverse, unresolved, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              userId,
              "image_scan",
              JSON.stringify({ entityCount: entities.length }),
              null,
              "ownership",
              JSON.stringify({ added: changesAdded, updated: changesUpdated, removed: [] }),
              JSON.stringify({ added: [], updated: inverseEntries, removed: [] }),
              null,
              new Date().toISOString(),
            ],
          );

          return {
            receiptId: receiptInsert.rows[0].id,
            summary: {
              added: changesAdded.length,
              updated: changesUpdated.length,
              total: entities.length,
            },
          };
        });

        log.fleet.info({
          receiptId: outcome.receiptId,
          added: outcome.summary.added,
          updated: outcome.summary.updated,
        }, "scan:commit_complete");

        return sendOk(res, {
          receipt: { id: outcome.receiptId },
          summary: outcome.summary,
        });
      } catch (err) {
        log.fleet.error({ err }, "scan:commit_failed");
        return sendFail(res, ScanErrorCode.commit_failed, "Scan commit failed", 500);
      }
    },
  );

  return router;
}
