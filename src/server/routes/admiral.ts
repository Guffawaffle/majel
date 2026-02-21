/**
 * routes/admiral.ts — Admiral Routes (ADR-018 Phase 2, renamed ADR-023 Phase 4)
 *
 * Admiral-only endpoints for invite code management.
 * Old paths (/api/admin/*) are gone, not redirected.
 * Intentional: redirects would leak the new path to scanners.
 *
 * Routes:
 *   POST   /api/admiral/invites       — Create a new invite code
 *   GET    /api/admiral/invites       — List all invite codes
 *   DELETE /api/admiral/invites/:code — Revoke an invite code
 *   GET    /api/admiral/sessions      — List all tenant sessions
 *   DELETE /api/admiral/sessions/:id  — Delete a tenant session
 *   GET    /api/admiral/audit-log     — Query auth audit log
 */

import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireAdmiral } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import { AUDIT_EVENTS, type AuditEntry, type AuditEvent } from "../stores/audit-store.js";
import type { Router } from "express";

export function createAdmiralRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const validAuditEvents = new Set<string>(AUDIT_EVENTS);

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

    if ((req.params.code as string).length > 100) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid invite code", 400);
    }

    const revoked = await appState.inviteStore.revokeCode(req.params.code as string);
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

    if ((req.params.id as string).length > 100) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid session ID", 400);
    }

    const deleted = await appState.inviteStore.deleteSession(req.params.id as string);
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

  // ── GET /api/admiral/audit-log ─────────────────────────────
  router.get("/api/admiral/audit-log", async (req, res) => {
    if (!appState.auditStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Audit store not available", 503);
    }

    const event = typeof req.query.event === "string" ? req.query.event.trim() : undefined;
    const actorId = typeof req.query.actorId === "string" ? req.query.actorId.trim() : undefined;
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : undefined;
    const from = typeof req.query.from === "string" ? req.query.from.trim() : undefined;
    const to = typeof req.query.to === "string" ? req.query.to.trim() : undefined;
    const limitRaw = typeof req.query.limit === "string" ? req.query.limit.trim() : undefined;

    if (event && !validAuditEvents.has(event)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "event must be a valid audit event type", 400);
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (actorId && !uuidRegex.test(actorId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "actorId must be a valid UUID", 400);
    }
    if (targetId && !uuidRegex.test(targetId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "targetId must be a valid UUID", 400);
    }

    const parsedLimit = limitRaw ? Number(limitRaw) : 100;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "limit must be an integer between 1 and 1000", 400);
    }

    const fromTs = from ? Date.parse(from) : Number.NaN;
    if (from && Number.isNaN(fromTs)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "from must be an ISO date string", 400);
    }

    const toTs = to ? Date.parse(to) : Number.NaN;
    if (to && Number.isNaN(toTs)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "to must be an ISO date string", 400);
    }

    if (from && to && fromTs > toTs) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "from must be before or equal to to", 400);
    }

    let entries: AuditEntry[] = [];
    if (actorId) {
      entries = await appState.auditStore.queryByActor(actorId, 1000);
    } else if (targetId) {
      entries = await appState.auditStore.queryByTarget(targetId, 1000);
    } else if (event) {
      entries = await appState.auditStore.queryByEvent(event as AuditEvent, 1000);
    } else {
      entries = await appState.auditStore.queryRecent(1000);
    }

    const filtered = entries
      .filter((entry) => (!event || entry.eventType === event))
      .filter((entry) => (!actorId || entry.actorId === actorId))
      .filter((entry) => (!targetId || entry.targetId === targetId))
      .filter((entry) => (!from || Date.parse(entry.createdAt) >= fromTs))
      .filter((entry) => (!to || Date.parse(entry.createdAt) <= toTs))
      .slice(0, parsedLimit);

    sendOk(res, {
      entries: filtered,
      count: filtered.length,
      filters: {
        ...(event ? { event } : {}),
        ...(actorId ? { actorId } : {}),
        ...(targetId ? { targetId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: parsedLimit,
      },
    });
  });

  return router;
}
