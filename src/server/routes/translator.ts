/**
 * translator.ts — External Overlay Translator API Routes (#78 Phase 4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides endpoints to list translator configs, preview translations,
 * and translate + apply external game data via the sync_overlay pipeline.
 *
 * Pattern: factory function createTranslatorRoutes(appState) → Router
 */

import { join } from "node:path";
import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import { listTranslatorConfigs, loadTranslatorConfig, translate } from "../services/translator/index.js";
import { executeFleetTool } from "../services/fleet-tools/index.js";

/** Characters forbidden in configName to prevent path traversal. */
const UNSAFE_CONFIG_RE = /[./\\]/;

export function createTranslatorRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  router.use("/api/translate", visitor);

  // ── List available translator configs ─────────────────────

  router.get("/api/translate/configs", async (_req, res) => {
    const configDir = join(process.cwd(), "data", "translators");
    const configs = await listTranslatorConfigs(configDir);
    sendOk(res, { configs });
  });

  // ── Preview translation (dry-run, no apply) ───────────────

  router.post("/api/translate/preview", async (req, res) => {
    const { configName, payload } = req.body ?? {};

    if (typeof configName !== "string" || configName.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "configName is required", 400);
    }
    if (UNSAFE_CONFIG_RE.test(configName)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "configName contains invalid characters", 400);
    }
    if (payload === undefined || payload === null || typeof payload !== "object") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "payload must be a non-null object", 400);
    }

    const configPath = join(process.cwd(), "data", "translators", `${configName}.translator.json`);

    try {
      const config = await loadTranslatorConfig(configPath);
      const result = translate(config, payload);
      return sendOk(res, result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INVALID_PARAM, `Translation failed: ${msg}`, 400);
    }
  });

  // ── Translate + apply via sync_overlay ─────────────────────

  router.post("/api/translate/apply", async (req, res) => {
    const { configName, payload, dry_run } = req.body ?? {};

    if (typeof configName !== "string" || configName.length === 0) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "configName is required", 400);
    }
    if (UNSAFE_CONFIG_RE.test(configName)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "configName contains invalid characters", 400);
    }
    if (payload === undefined || payload === null || typeof payload !== "object") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "payload must be a non-null object", 400);
    }

    const configPath = join(process.cwd(), "data", "translators", `${configName}.translator.json`);

    let config;
    try {
      config = await loadTranslatorConfig(configPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendFail(res, ErrorCode.INVALID_PARAM, `Failed to load translator config: ${msg}`, 400);
    }

    const result = translate(config, payload);
    if (!result.success || !result.data) {
      return sendOk(res, { translation: result, sync: null });
    }

    // Build tool context for sync_overlay execution
    const userId = res.locals.userId as string;
    if (!appState.toolContextFactory) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Tool context factory not available", 503);
    }
    const toolContext = appState.toolContextFactory.forUser(userId);

    const syncResult = await executeFleetTool(
      "sync_overlay",
      { export: result.data, dry_run: dry_run ?? true },
      toolContext,
    );

    sendOk(res, { translation: result, sync: syncResult });
  });

  return router;
}
