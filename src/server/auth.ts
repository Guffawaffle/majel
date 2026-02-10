/**
 * auth.ts — Authentication Middleware (ADR-018 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Three-tier access control:
 *   Public  — no auth needed (catalog reads, health, API discovery)
 *   Visitor — tenant cookie (from invite redemption) OR admiral token
 *   Admiral — bearer token matching MAJEL_ADMIN_TOKEN
 *
 * When MAJEL_ADMIN_TOKEN is not set, auth is disabled (local/demo mode).
 * All endpoints are open, just like running `npm run dev` today.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AppState } from "./app-context.js";
import { sendFail, ErrorCode } from "./envelope.js";

// ─── Cookie name ────────────────────────────────────────────────

export const TENANT_COOKIE = "majel_tenant";

// ─── Middleware Factories ───────────────────────────────────────

/**
 * Require Admiral (bearer token) access.
 *
 * Used for: chat, AI diagnostics, admin routes.
 * In demo mode (no adminToken): always passes.
 */
export function requireAdmiral(appState: AppState): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!appState.config.authEnabled) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      sendFail(res, ErrorCode.UNAUTHORIZED, "Admiral authorization required", 401);
      return;
    }

    const token = authHeader.slice(7);
    if (token !== appState.config.adminToken) {
      sendFail(res, ErrorCode.FORBIDDEN, "Invalid admiral token", 403);
      return;
    }

    // Mark this request as admiral-level
    res.locals.isAdmiral = true;
    res.locals.tenantId = "admiral";
    next();
  };
}

/**
 * Require Visitor (tenant cookie OR admiral token) access.
 *
 * Used for: fleet management, overlays, docks, settings, sessions.
 * In demo mode (no adminToken): always passes with tenantId "local".
 */
export function requireVisitor(appState: AppState): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!appState.config.authEnabled) {
      res.locals.tenantId = "local";
      return next();
    }

    // Admiral token grants visitor access too
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === appState.config.adminToken) {
        res.locals.isAdmiral = true;
        res.locals.tenantId = "admiral";
        return next();
      }
    }

    // Check tenant cookie
    const tenantId = req.cookies?.[TENANT_COOKIE];
    if (!tenantId) {
      sendFail(res, ErrorCode.UNAUTHORIZED, "Visitor session required — redeem an invite code", 401);
      return;
    }

    // Validate session exists in store
    if (!appState.inviteStore) {
      sendFail(res, ErrorCode.UNAUTHORIZED, "Auth system unavailable", 503);
      return;
    }

    const session = await appState.inviteStore.getSession(tenantId);
    if (!session) {
      sendFail(res, ErrorCode.UNAUTHORIZED, "Invalid or expired session — redeem a new invite code", 401);
      return;
    }

    // Touch the session (update last_seen_at)
    await appState.inviteStore.touchSession(tenantId);

    res.locals.tenantId = tenantId;
    next();
  };
}
