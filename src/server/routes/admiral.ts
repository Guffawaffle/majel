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

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireAdmiral } from "../services/auth.js";

export function createAdmiralRoutes(appState: AppState): Router {
  const router = Router();

  // All admin routes require Admiral access
  router.use("/api/admiral", requireAdmiral(appState));

  // ── POST /api/admiral/invites ─────────────────────────────
  router.post("/api/admiral/invites", async (req, res) => {
    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    const { label, maxUses, expiresIn } = req.body ?? {};

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
