/**
 * routes/settings.ts — Settings CRUD routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { readFleetConfig } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { getCategories } from "../stores/settings.js";
import { createGeminiEngine } from "../services/gemini.js";
import { resolveConfig } from "../config.js";
import { requireVisitor } from "../services/auth.js";

export function createSettingsRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
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

  router.patch("/api/settings", async (req, res) => {
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "Settings store not available", 503);
    }

    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Request body must be an object of { key: value } pairs");
    }

    const results: Array<{ key: string; status: string; error?: string }> = [];
    let fleetConfigChanged = false;
    let configChanged = false;
    
    for (const [key, value] of Object.entries(updates)) {
      try {
        await appState.settingsStore.set(key, String(value));
        results.push({ key, status: "updated" });
        if (key.startsWith("fleet.")) fleetConfigChanged = true;
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

    // Rebuild Gemini engine with updated fleet config so the model sees the new values
    if (fleetConfigChanged && appState.config.geminiApiKey && appState.geminiEngine) {
      appState.geminiEngine = createGeminiEngine(
        appState.config.geminiApiKey,
        await readFleetConfig(appState.settingsStore),
        null, // dock briefing removed (ADR-025)
      );
      log.boot.info("gemini engine refreshed with updated fleet config");
    }

    sendOk(res, { results });
  });

  router.delete("/api/settings/:key(*)", async (req, res) => {
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.SETTINGS_NOT_AVAILABLE, "Settings store not available", 503);
    }

    const key = req.params.key;
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
