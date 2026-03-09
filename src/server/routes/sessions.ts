/**
 * routes/sessions.ts — Chat session management routes.
 *
 * Ownership model (ADR-019 Phase 2):
 *   - list:   returns only sessions owned by the authenticated user
 *   - get:    owner only
 *   - patch:  owner only
 *   - delete: owner only
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import type { ChatSession, ChatMessage } from "../sessions.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import { createContextMiddleware } from "../context-middleware.js";
import { log } from "../logger.js";

/**
 * Hydrate proposal data for messages that have proposalIds.
 * Attaches a `proposals` map to the session response so the frontend
 * can reconstruct ChatProposalCards with correct status.
 */
async function hydrateSessionProposals(
  session: ChatSession & { messages: ChatMessage[] },
  userId: string,
  appState: AppState,
): Promise<Record<string, unknown>> {
  // Collect all proposal IDs from messages
  const allIds = new Set<string>();
  for (const msg of session.messages) {
    if (msg.proposalIds?.length) {
      for (const id of msg.proposalIds) allIds.add(id);
    }
  }

  // If no proposals or no proposal store, return as-is
  if (allIds.size === 0 || !appState.proposalStoreFactory) {
    return session as unknown as Record<string, unknown>;
  }

  // Batch-fetch proposals
  const proposalStore = appState.proposalStoreFactory.forUser(userId);
  const proposals: Record<string, { id: string; status: string; batchItems: Array<{ tool: string; preview: string }>; expiresAt: string }> = {};

  await Promise.all(
    [...allIds].map(async (id) => {
      try {
        const p = await proposalStore.get(id);
        if (p) {
          proposals[id] = {
            id: p.id,
            status: p.status,
            batchItems: (p.batchItems ?? []).map((b) => ({ tool: b.tool, preview: b.preview })),
            expiresAt: p.expiresAt,
          };
        }
      } catch (err) {
        log.fleet.warn({ err: err instanceof Error ? err.message : String(err), proposalId: id }, "proposal hydrate failed");
      }
    }),
  );

  return { ...session, proposals } as unknown as Record<string, unknown>;
}

export function createSessionRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  router.use("/api/sessions", visitor);
  if (appState.pool) {
    router.use("/api/sessions", createContextMiddleware(appState.pool));
  }

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
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    sendOk(res, { sessions: await appState.sessionStore.list(limit, userId) });
  });

  router.get("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    if ((req.params.id as string).length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    // Ownership check: owner only
    const owner = await appState.sessionStore.getOwner(req.params.id as string);
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    if (owner !== userId) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const session = await appState.sessionStore.get(req.params.id as string);
    if (!session) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, await hydrateSessionProposals(session, userId, appState));
  });

  router.patch("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    if ((req.params.id as string).length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'title' in request body");
    }
    if (title.length > MAX_TITLE) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Title must be ${MAX_TITLE} characters or fewer`, 400);
    }
    // Ownership check: owner only
    const owner = await appState.sessionStore.getOwner(req.params.id as string);
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    if (owner !== userId) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const updated = await appState.sessionStore.updateTitle(req.params.id as string, title.trim());
    if (!updated) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { id: req.params.id as string, title: title.trim(), status: "updated" });
  });

  router.delete("/api/sessions/:id", async (req, res) => {
    if (!appState.sessionStore) {
      return sendFail(res, ErrorCode.SESSION_STORE_NOT_AVAILABLE, "Session store not available", 503);
    }
    if ((req.params.id as string).length > 200) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    // Ownership check: owner only
    const owner = await appState.sessionStore.getOwner(req.params.id as string);
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    if (owner !== userId) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    const deleted = await appState.sessionStore.delete(req.params.id as string);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { id: req.params.id as string, status: "deleted" });
  });

  return router;
}
