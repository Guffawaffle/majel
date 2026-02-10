/**
 * routes/auth.ts — Public Auth Routes (ADR-018 Phase 2)
 *
 * Unauthenticated endpoints for invite code redemption.
 *
 * Routes:
 *   POST /api/auth/redeem  — Redeem an invite code → tenant cookie
 *   POST /api/auth/logout  — Clear tenant cookie
 *   GET  /api/auth/status  — Check current auth tier
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { TENANT_COOKIE } from "../auth.js";

export function createAuthRoutes(appState: AppState): Router {
  const router = Router();

  // ── POST /api/auth/redeem ─────────────────────────────────
  router.post("/api/auth/redeem", async (req, res) => {
    // In demo mode, no invite codes needed
    if (!appState.config.authEnabled) {
      return sendOk(res, {
        tenantId: "local",
        tier: "admiral",
        message: "Auth disabled — running in local/demo mode",
      });
    }

    const { code } = req.body ?? {};
    if (!code || typeof code !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing invite code", 400);
    }

    if (!appState.inviteStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Invite store not available", 503);
    }

    try {
      const session = await appState.inviteStore.redeemCode(code.trim());
      // Set HttpOnly tenant cookie
      res.cookie(TENANT_COOKIE, session.tenantId, {
        httpOnly: true,
        sameSite: "strict",
        secure: appState.config.nodeEnv === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: "/",
      });
      sendOk(res, {
        tenantId: session.tenantId,
        tier: "visitor",
        message: "Welcome aboard, Ensign. Explore freely.",
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to redeem invite code";
      sendFail(res, ErrorCode.FORBIDDEN, message, 403);
    }
  });

  // ── POST /api/auth/logout ─────────────────────────────────
  router.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(TENANT_COOKIE, { path: "/" });
    sendOk(res, { message: "Session cleared" });
  });

  // ── GET /api/auth/status ──────────────────────────────────
  router.get("/api/auth/status", async (req, res) => {
    if (!appState.config.authEnabled) {
      return sendOk(res, { tier: "admiral", authEnabled: false, tenantId: "local" });
    }

    // Check for admiral token
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === appState.config.adminToken) {
        return sendOk(res, { tier: "admiral", authEnabled: true, tenantId: "admiral" });
      }
    }

    // Check for tenant cookie
    const tenantId = req.cookies?.[TENANT_COOKIE];
    if (tenantId && appState.inviteStore) {
      const session = await appState.inviteStore.getSession(tenantId);
      if (session) {
        return sendOk(res, { tier: "visitor", authEnabled: true, tenantId });
      }
    }

    sendOk(res, { tier: "public", authEnabled: true, tenantId: null });
  });

  return router;
}
