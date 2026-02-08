/**
 * routes/sessions.ts — Chat session management routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";

export function createSessionRoutes(appState: AppState): Router {
  const router = Router();

  router.get("/api/sessions", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const limit = parseInt((req.query.limit as string) || "50", 10);
    res.json({ sessions: appState.sessionStore.list(limit) });
  });

  router.get("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const session = appState.sessionStore.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  });

  router.patch("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "Missing 'title' in request body" });
    }
    const updated = appState.sessionStore.updateTitle(req.params.id, title.trim());
    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ id: req.params.id, title: title.trim(), status: "updated" });
  });

  router.delete("/api/sessions/:id", (req, res) => {
    if (!appState.sessionStore) {
      return res.status(503).json({ error: "Session store not available" });
    }
    const deleted = appState.sessionStore.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ id: req.params.id, status: "deleted" });
  });

  return router;
}
