/**
 * routes/sessions.ts — Chat session management routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";

export function createSessionRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  router.use("/api/sessions", visitor);

  router.get("/api/sessions", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    const limit = parseInt((req.query.limit as string) || "50", 10);
    sendOk(res, { sessions: await appState.sessionStore.list(limit) });
  });

  router.get("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    const session = await appState.sessionStore.get(req.params.id);
    if (!session) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, session);
  });

  router.patch("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'title' in request body");
    }
    const updated = await appState.sessionStore.updateTitle(req.params.id, title.trim());
    if (!updated) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { id: req.params.id, title: title.trim(), status: "updated" });
  });

  router.delete("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    const deleted = await appState.sessionStore.delete(req.params.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { id: req.params.id, status: "deleted" });
  });

  return router;
}
