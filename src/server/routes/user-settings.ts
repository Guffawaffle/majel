/**
 * routes/user-settings.ts — Per-User Settings API (#86)
 *
 * Endpoints for user-level preference overrides.
 * All routes require auth (visitor minimum — users manage their own settings).
 *
 *   GET    /api/user-settings        — all settings merged (user + system defaults)
 *   PUT    /api/user-settings/:key   — set a per-user override
 *   DELETE /api/user-settings/:key   — remove override, revert to system default
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireVisitor } from "../services/auth.js";
import { createContextMiddleware } from "../context-middleware.js";

export function createUserSettingsRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);

  // All user-settings endpoints require auth, then build RequestContext (ADR-039)
  router.use("/api/user-settings", visitor);
  if (appState.pool) {
    router.use("/api/user-settings", createContextMiddleware(appState.pool));
  }

  // GET /api/user-settings — merged view of all user-overridable settings
  router.get("/api/user-settings", async (_req, res) => {
    if (!appState.userSettingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "User settings store not available", 503);
    }

    const ctx = res.locals.ctx;
    if (!ctx) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const { userId } = ctx.identity;
    const settings = await appState.userSettingsStore.getAllForUser(userId);
    const overrideCount = await appState.userSettingsStore.countForUser(userId);

    sendOk(res, { settings, overrideCount });
  });

  // PUT /api/user-settings/:key — set a per-user override
  router.put("/api/user-settings/:key", async (req, res) => {
    if (!appState.userSettingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "User settings store not available", 503);
    }

    const ctx = res.locals.ctx;
    if (!ctx) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const { userId } = ctx.identity;
    const key = String(req.params.key);
    if (!key || key.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Setting key must be 1–200 characters");
    }

    const { value } = req.body ?? {};
    if (value === undefined || value === null) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Request body must include { value: ... }");
    }
    const strValue = String(value);
    if (strValue.length > 2000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Value must be 2000 characters or fewer");
    }

    try {
      await appState.userSettingsStore.setForUser(userId, key, strValue);
      sendOk(res, { key, value: strValue, status: "updated" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err: message, key }, "user-setting update failed");
      return sendFail(res, ErrorCode.INVALID_PARAM, "Failed to update setting");
    }
  });

  // DELETE /api/user-settings/:key — remove user override
  router.delete("/api/user-settings/:key", async (req, res) => {
    if (!appState.userSettingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "User settings store not available", 503);
    }

    const ctx = res.locals.ctx;
    if (!ctx) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const { userId } = ctx.identity;
    const key = String(req.params.key);
    const deleted = await appState.userSettingsStore.deleteForUser(userId, key);

    if (deleted) {
      // Return new resolved value (system default)
      const entry = await appState.userSettingsStore.getForUser(userId, key);
      sendOk(res, { key, status: "reset", resolvedValue: entry.value });
    } else {
      sendOk(res, { key, status: "not_found", message: "No user override existed" });
    }
  });

  return router;
}
