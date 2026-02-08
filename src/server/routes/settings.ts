/**
 * routes/settings.ts — Settings CRUD routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { GEMINI_API_KEY, readFleetConfig, readDockBriefing } from "../app-context.js";
import { log } from "../logger.js";
import { getCategories } from "../settings.js";
import { createGeminiEngine } from "../gemini.js";

export function createSettingsRoutes(appState: AppState): Router {
  const router = Router();

  router.get("/api/settings", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const category = req.query.category as string | undefined;
    const categories = getCategories();

    if (category) {
      if (!categories.includes(category)) {
        return res.status(400).json({
          error: `Unknown category: ${category}. Valid: ${categories.join(", ")}`,
        });
      }
      return res.json({
        category,
        settings: appState.settingsStore.getByCategory(category),
      });
    }

    res.json({
      categories,
      settings: appState.settingsStore.getAll(),
    });
  });

  router.patch("/api/settings", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res
        .status(400)
        .json({ error: "Request body must be an object of { key: value } pairs" });
    }

    const results: Array<{ key: string; status: string; error?: string }> = [];
    let fleetConfigChanged = false;
    for (const [key, value] of Object.entries(updates)) {
      try {
        appState.settingsStore.set(key, String(value));
        results.push({ key, status: "updated" });
        if (key.startsWith("fleet.")) fleetConfigChanged = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ key, status: "error", error: message });
      }
    }

    // Rebuild Gemini engine with updated fleet config so the model sees the new values
    if (fleetConfigChanged && GEMINI_API_KEY && appState.geminiEngine) {
      appState.geminiEngine = createGeminiEngine(
        GEMINI_API_KEY,
        appState.fleetData,
        readFleetConfig(appState.settingsStore),
        readDockBriefing(appState.dockStore),
      );
      log.boot.info("gemini engine refreshed with updated fleet config");
    }

    res.json({ results });
  });

  router.delete("/api/settings/:key(*)", (req, res) => {
    if (!appState.settingsStore) {
      return res.status(503).json({ error: "Settings store not available" });
    }

    const key = req.params.key;
    const deleted = appState.settingsStore.delete(key);

    if (deleted) {
      // Return the new resolved value (env or default)
      const newValue = appState.settingsStore.get(key);
      res.json({ key, status: "reset", resolvedValue: newValue });
    } else {
      res.json({ key, status: "not_found", message: "No user override existed" });
    }
  });

  return router;
}
