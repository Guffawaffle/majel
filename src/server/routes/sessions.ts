/**
 * routes/sessions.ts — Chat session management routes.
 *
 * Ownership model (ADR-019 Phase 2):
 *   - list:   returns only sessions owned by the authenticated user
 *   - get:    owner or admiral
 *   - patch:  owner or admiral
 *   - delete: owner or admiral
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";

export function createSessionRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  router.use("/api/sessions", visitor);

  /** Max string length for session title. */
  const MAX_TITLE = 200;

  router.get("/api/sessions", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    const limit = parseInt((req.query.limit as string) || "50", 10);
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "limit must be an integer between 1 and 200", 400);
    }
    const userId = res.locals.userId as string;
    // Admirals can see all sessions via ?all=true
    const showAll = res.locals.isAdmiral && req.query.all === "true";
    sendOk(res, { sessions: await appState.sessionStore.list(limit, showAll ? undefined : userId) });
  });

  router.get("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    if (req.params.id.length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    // Ownership check: owner or admiral
    const owner = await appState.sessionStore.getOwner(req.params.id);
    const userId = res.locals.userId as string;
    // null owner = unowned legacy session → only admirals may access
    if (owner === null) {
      const session = await appState.sessionStore.get(req.params.id);
      if (!session) return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
      if (!res.locals.isAdmiral) return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
      return sendOk(res, session);
    }
    if (owner !== userId && !res.locals.isAdmiral) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
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
    if (req.params.id.length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'title' in request body");
    }
    if (title.length > MAX_TITLE) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Title must be ${MAX_TITLE} characters or fewer`, 400);
    }
    // Ownership check: owner or admiral
    const owner = await appState.sessionStore.getOwner(req.params.id);
    const userId = res.locals.userId as string;
    // null owner = unowned legacy session → only admirals may modify
    if (owner === null && !res.locals.isAdmiral) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    if (owner !== null && owner !== userId && !res.locals.isAdmiral) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
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
    if (req.params.id.length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    // Ownership check: owner or admiral
    const owner = await appState.sessionStore.getOwner(req.params.id);
    const userId = res.locals.userId as string;
    // null owner = unowned legacy session → only admirals may delete
    if (owner === null && !res.locals.isAdmiral) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    if (owner !== null && owner !== userId && !res.locals.isAdmiral) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const deleted = await appState.sessionStore.delete(req.params.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { id: req.params.id, status: "deleted" });
  });

  return router;
}
