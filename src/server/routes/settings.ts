/**
 * routes/settings.ts — Settings CRUD routes.
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { getCategories } from "../stores/settings.js";
import { resolveConfig } from "../config.js";
import { requireVisitor, requireAdmiral } from "../services/auth.js";

export function createSettingsRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  const admiral = requireAdmiral(appState);
  router.use("/api/settings", visitor);

  router.get("/api/settings", async (req, res) => {
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "Settings store not available", 503);
    }

    const category = req.query.category as string | undefined;
    const categories = getCategories();

    if (category) {
      if (!categories.includes(category)) {
        return sendFail(res, ErrorCode.UNKNOWN_CATEGORY, `Unknown category: ${category}. Valid: ${categories.join(", ")}`);
      }
      return sendOk(res, {
        category,
        settings: await appState.settingsStore.getByCategory(category),
      });
    }

    sendOk(res, {
      categories,
      settings: await appState.settingsStore.getAll(),
    });
  });

  router.patch("/api/settings", admiral, async (req, res) => {
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "Settings store not available", 503);
    }

    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Request body must be an object of { key: value } pairs");
    }

    const keys = Object.keys(updates);
    if (keys.length > 50) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Too many settings in one request (max 50)", 400);
    }
    if (keys.includes("model.name")) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Setting \"model.name\" is locked to gemini-3-flash-preview", 400, {
        hints: ["Model selection is disabled for reliability and consistency"],
      });
    }
    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== "string" || key.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Setting key must be a string of 200 characters or fewer", 400);
      }
      if (value !== null && value !== undefined && String(value).length > 2000) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Value for "${key}" must be 2000 characters or fewer`, 400);
      }
    }

    const results: Array<{ key: string; status: string; error?: string }> = [];
    let configChanged = false;
    
    for (const [key, value] of Object.entries(updates)) {
      try {
        await appState.settingsStore.set(key, String(value));
        results.push({ key, status: "updated" });
        configChanged = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ key, status: "error", error: message });
      }
    }

    // Re-resolve config after settings change (ADR-005 Phase 3)
    if (configChanged) {
      appState.config = await resolveConfig(appState.settingsStore);
    }

    // #85 H3: Fleet config changes no longer require engine rebuild.
    // Per-user fleet config is now injected per-message in the chat route,
    // so changes take effect immediately on the next chat request.

    sendOk(res, { results });
  });

  router.delete("/api/settings/{*key}", admiral, async (req, res) => {
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "Settings store not available", 503);
    }

    const key = String(req.params.key);
    const deleted = await appState.settingsStore.delete(key);

    if (deleted) {
      // Return the new resolved value (env or default)
      const newValue = await appState.settingsStore.get(key);
      sendOk(res, { key, status: "reset", resolvedValue: newValue });
    } else {
      sendOk(res, { key, status: "not_found", message: "No user override existed" });
    }
  });

  return router;
}
