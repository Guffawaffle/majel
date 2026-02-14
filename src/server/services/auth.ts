/**
 * auth.ts — Authentication Middleware (ADR-019 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Role-based access control with four tiers:
 *   Ensign     — Read-only catalog, own profile
 *   Lieutenant — Overlays, fleet read, limited chat
 *   Captain    — Full fleet management, unlimited chat (with token cap)
 *   Admiral    — Full system access, user management
 *
 * Backward compatible: MAJEL_ADMIN_TOKEN bearer continues to work
 * as a virtual Admiral session during transition.
 *
 * When MAJEL_ADMIN_TOKEN is not set, auth is disabled (local dev mode).
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AppState } from "../app-context.js";
import { sendFail, ErrorCode } from "../envelope.js";
import { timingSafeCompare } from "./password.js";
import { roleLevel, deriveAdminUserId, type Role } from "../stores/user-store.js";

// ─── Cookie Names ───────────────────────────────────────────────

/** New user session cookie (ADR-019). */
export const SESSION_COOKIE = "majel_session";

/** Legacy tenant cookie (ADR-018 Phase 2 — kept for backward compat). */
export const TENANT_COOKIE = "majel_tenant";

// ─── Session Resolution ─────────────────────────────────────────

/**
 * Attempt to resolve the current request's identity.
 *
 * Priority:
 *   1. Bearer token matching MAJEL_ADMIN_TOKEN → virtual Admiral
 *   2. Session cookie → user session from user_sessions table
 *   3. Legacy tenant cookie → old tenant session (backward compat)
 */
async function resolveIdentity(
  req: Request,
  appState: AppState,
): Promise<{
  userId: string;
  role: Role;
  email: string;
  displayName: string;
  emailVerified: boolean;
  lockedAt: string | null;
  source: "admin-token" | "session" | "legacy-tenant";
} | null> {
  // 1. Bearer token → virtual Admiral
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") && appState.config.adminToken) {
    const token = authHeader.slice(7);
    if (timingSafeCompare(token, appState.config.adminToken)) {
      return {
        userId: deriveAdminUserId(appState.config.adminToken),
        role: "admiral",
        email: "admin@majel.local",
        displayName: "Admiral",
        emailVerified: true,
        lockedAt: null,
        source: "admin-token",
      };
    }
  }

  // 2. Session cookie → user session
  const sessionToken = req.cookies?.[SESSION_COOKIE];
  if (sessionToken && appState.userStore) {
    const session = await appState.userStore.resolveSession(sessionToken);
    if (session) {
      // Touch session (fire-and-forget)
      appState.userStore.touchSession(sessionToken).catch(() => {});
      return {
        userId: session.userId,
        role: session.role,
        email: session.email,
        displayName: session.displayName,
        emailVerified: session.emailVerified,
        lockedAt: session.lockedAt,
        source: "session",
      };
    }
  }

  // 3. Legacy tenant cookie → backward compat
  const tenantId = req.cookies?.[TENANT_COOKIE];
  if (tenantId && appState.inviteStore) {
    const tenantSession = await appState.inviteStore.getSession(tenantId);
    if (tenantSession) {
      await appState.inviteStore.touchSession(tenantId);
      // Legacy tenant sessions operate as lieutenant-level
      return {
        userId: tenantId,
        role: "lieutenant",
        email: "legacy@tenant.local",
        displayName: "Visitor",
        emailVerified: true,
        lockedAt: null,
        source: "legacy-tenant",
      };
    }
  }

  return null;
}

// ─── Middleware Factories ───────────────────────────────────────

/**
 * Require a minimum role level to access a route.
 *
 * Usage:
 *   router.get("/api/chat", requireRole(appState, "lieutenant"), handler);
 *   router.post("/api/admiral/users", requireRole(appState, "admiral"), handler);
 *
 * In dev mode (no adminToken): always passes with admiral-level access.
 */
export function requireRole(appState: AppState, minRole: Role): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Dev mode: auth disabled → everything open as admiral
    if (!appState.config.authEnabled) {
      res.locals.userId = "local";
      res.locals.userRole = "admiral";
      res.locals.userEmail = "dev@local";
      res.locals.userDisplayName = "Local Dev";
      res.locals.isAdmiral = true;
      res.locals.tenantId = "local";
      return next();
    }

    const identity = await resolveIdentity(req, appState);

    if (!identity) {
      sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401, {
        hints: [
          "Provide a Bearer token in the Authorization header",
          "Or authenticate via the session cookie flow",
        ],
      });
      return;
    }

    // Check email verified (skip for admin-token virtual admiral)
    if (identity.source !== "admin-token" && !identity.emailVerified) {
      sendFail(res, ErrorCode.EMAIL_NOT_VERIFIED, "Please verify your email before accessing this resource", 403, {
        hints: [
          "Check your email for the verification link",
          "Contact an Admiral to resend the verification email",
        ],
      });
      return;
    }

    // Check account locked
    if (identity.lockedAt) {
      sendFail(res, ErrorCode.ACCOUNT_LOCKED, "Account is temporarily locked", 403, {
        hints: ["Contact an Admiral to unlock your account"],
      });
      return;
    }

    // Check role level
    if (roleLevel(identity.role) < roleLevel(minRole)) {
      sendFail(res, ErrorCode.INSUFFICIENT_RANK, `Minimum rank required: ${minRole}`, 403, {
        detail: { requiredRole: minRole },
        hints: [`This endpoint requires ${minRole} or higher`],
      });
      return;
    }

    // Set request-scoped user context
    res.locals.userId = identity.userId;
    res.locals.userRole = identity.role;
    res.locals.userEmail = identity.email;
    res.locals.userDisplayName = identity.displayName;
    res.locals.isAdmiral = identity.role === "admiral";
    res.locals.tenantId = identity.userId;
    next();
  };
}

/**
 * Legacy compatibility: requireAdmiral = requireRole("admiral").
 * Kept so existing route files continue to work during migration.
 */
export function requireAdmiral(appState: AppState): RequestHandler {
  return requireRole(appState, "admiral");
}

/**
 * Legacy compatibility: requireVisitor = requireRole("lieutenant").
 * Kept so existing route files continue to work during migration.
 */
export function requireVisitor(appState: AppState): RequestHandler {
  return requireRole(appState, "lieutenant");
}
