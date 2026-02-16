/**
 * routes/admiral.ts — Admiral Routes (ADR-018 Phase 2, renamed ADR-023 Phase 4)
 *
 * Admiral-only endpoints for invite code management.
 * Old paths (/api/admin/*) are gone, not redirected.
 * Intentional: redirects would leak the new path to scanners.
 *
 * Routes:
 *   POST   /api/admiral/invites      — Create a new invite code
 *   GET    /api/admiral/invites      — List all invite codes
 *   DELETE /api/admiral/invites/:code — Revoke an invite code
 *   GET    /api/admiral/sessions     — List all tenant sessions
 *   DELETE /api/admiral/sessions/:id — Delete a tenant session
 */

import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireAdmiral } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import type { Router } from "express";

export function createAdmiralRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // All admin routes require Admiral access
  router.use("/api/admiral", requireAdmiral(appState));

  // ── POST /api/admiral/invites ─────────────────────────────
  router.post("/api/admiral/invites", async (req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    const { label, maxUses, expiresIn } = req.body ?? {};

    // Validate inputs
    if (label !== undefined) {
      if (typeof label !== "string" || label.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Label must be a string of 200 characters or fewer", 400);
      }
    }
    if (maxUses !== undefined) {
      const n = Number(maxUses);
      if (!Number.isInteger(n) || n < 1 || n > 10000) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "maxUses must be an integer between 1 and 10000", 400);
      }
    }
    if (expiresIn !== undefined) {
      if (typeof expiresIn !== "string" || expiresIn.length > 20) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "expiresIn must be a duration string (e.g. '7d', '24h')", 400);
      }
    }

    try {
      const invite = await appState.inviteStore.createCode({
        label: label ?? undefined,
        maxUses: maxUses ? Number(maxUses) : undefined,
        expiresIn: expiresIn ?? undefined,
      });
      sendOk(res, invite, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create invite";
      sendFail(res, ErrorCode.INTERNAL_ERROR, message, 500);
    }
  });

  // ── GET /api/admiral/invites ──────────────────────────────
  router.get("/api/admiral/invites", async (_req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    const codes = await appState.inviteStore.listCodes();
    sendOk(res, { codes, count: codes.length });
  });

  // ── DELETE /api/admiral/invites/:code ─────────────────────
  router.delete("/api/admiral/invites/:code", async (req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    if (req.params.code.length > 100) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid invite code", 400);
    }

    const revoked = await appState.inviteStore.revokeCode(req.params.code);
    if (!revoked) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Invite code not found", 404);
    }
    sendOk(res, { revoked: true });
  });

  // ── GET /api/admiral/sessions ─────────────────────────────
  router.get("/api/admiral/sessions", async (_req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    const sessions = await appState.inviteStore.listSessions();
    sendOk(res, { sessions, count: sessions.length });
  });

  // ── DELETE /api/admiral/sessions/:id ──────────────────────
  router.delete("/api/admiral/sessions/:id", async (req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    if (req.params.id.length > 100) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid session ID", 400);
    }

    const deleted = await appState.inviteStore.deleteSession(req.params.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    sendOk(res, { deleted: true });
  });

  // ── DELETE /api/admiral/sessions (all) ────────────────────
  // Kill all tenant sessions
  router.delete("/api/admiral/sessions", async (_req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    const sessions = await appState.inviteStore.listSessions();
    let count = 0;
    for (const s of sessions) {
      const ok = await appState.inviteStore.deleteSession(s.tenantId);
      if (ok) count++;
    }
    sendOk(res, { deleted: count });
  });

  return router;
}
