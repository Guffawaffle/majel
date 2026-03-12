/**
 * routes/scan.ts — Structured image extraction endpoint (ADR-008 Phase B)
 *
 * POST /api/fleet/scan — Extract structured fleet data from STFC screenshots.
 * Returns parsed JSON with confidence scores and cross-references against
 * the reference catalog.
 */

import express, { type Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode, defineModuleErrorCodes } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireVisitor } from "../services/auth.js";
import { createContextMiddleware } from "../context-middleware.js";
import { type ScanType, extractFromImage, crossReference } from "../services/scan.js";
import { log } from "../logger.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_DATA_LENGTH = 10 * 1024 * 1024;
const VALID_SCAN_TYPES = new Set<ScanType>(["officer", "ship", "event", "auto"]);

const ScanErrorCode = defineModuleErrorCodes("scan", [
  "extraction_failed",
] as const);

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

  return router;
}
