/**
 * routes/auth.ts — Authentication Routes (ADR-019 Phase 1)
 *
 * User sign-up, sign-in, email verification, password management,
 * session management, and legacy invite code redemption.
 *
 * Routes:
 *   POST /api/auth/signup          — Create account → verification email
 *   POST /api/auth/verify-email    — Verify email with token
 *   POST /api/auth/signin          — Sign in → session cookie
 *   GET  /api/auth/me              — Current user info + role
 *   POST /api/auth/logout          — Destroy current session
 *   POST /api/auth/logout-all      — Destroy all sessions
 *   POST /api/auth/change-password — Change password (kills other sessions)
 *   POST /api/auth/forgot-password — Request password reset email
 *   POST /api/auth/reset-password  — Reset password with token
 *   GET  /api/auth/status          — Auth tier check (legacy compat)
 *   POST /api/auth/redeem          — Legacy invite code redemption
 *   GET  /api/auth/dev-verify      — Dev-only: verify email by address
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode, asyncHandler } from "../envelope.js";
import { SESSION_COOKIE, TENANT_COOKIE, requireRole, requireAdmiral } from "../auth.js";
import { authRateLimiter } from "../rate-limit.js";
import { sendVerificationEmail, sendPasswordResetEmail, getDevToken } from "../email.js";

export function createAuthRoutes(appState: AppState): Router {
  const router = Router();

  // Apply rate limiting to all auth endpoints
  router.use("/api/auth", authRateLimiter);

  // ── POST /api/auth/signup ─────────────────────────────────
  router.post("/api/auth/signup", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, password, displayName } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }
    if (!password || typeof password !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Password is required", 400);
    }
    if (!displayName || typeof displayName !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Display name is required", 400);
    }

    try {
      const result = await appState.userStore.signUp({ email, password, displayName });

      // Send verification email (fire-and-forget)
      sendVerificationEmail(result.user.email, result.verifyToken).catch(() => {});

      sendOk(res, {
        message: "Account created. Please check your email to verify your address.",
        user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-up failed";
      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  }));

  // ── POST /api/auth/verify-email ───────────────────────────
  router.post("/api/auth/verify-email", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { token } = req.body ?? {};
    if (!token || typeof token !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Verification token is required", 400);
    }

    const verified = await appState.userStore.verifyEmail(token);
    if (!verified) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid or expired verification token", 400);
    }

    sendOk(res, { verified: true, message: "Email verified. You can now sign in." });
  }));

  // ── POST /api/auth/signin ─────────────────────────────────
  router.post("/api/auth/signin", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, password } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }
    if (!password || typeof password !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Password is required", 400);
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || undefined;
      const ua = req.headers["user-agent"] || undefined;
      const result = await appState.userStore.signIn(email, password, ip, ua);

      // Set session cookie
      res.cookie(SESSION_COOKIE, result.sessionToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: appState.config.nodeEnv === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: "/",
      });

      sendOk(res, {
        user: result.user,
        message: `Welcome back, ${result.user.displayName}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed";
      sendFail(res, ErrorCode.UNAUTHORIZED, message, 401);
    }
  }));

  // ── GET /api/auth/me ──────────────────────────────────────
  router.get("/api/auth/me", requireRole(appState, "ensign"), asyncHandler(async (_req, res) => {
    sendOk(res, {
      user: {
        id: res.locals.userId,
        email: res.locals.userEmail,
        displayName: res.locals.userDisplayName,
        role: res.locals.userRole,
      },
    });
  }));

  // ── POST /api/auth/logout ─────────────────────────────────
  router.post("/api/auth/logout", asyncHandler(async (req, res) => {
    // Destroy user session if present
    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (sessionToken && appState.userStore) {
      await appState.userStore.destroySession(sessionToken);
    }

    // Clear both cookies (new + legacy)
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie(TENANT_COOKIE, { path: "/" });

    sendOk(res, { message: "Signed out." });
  }));

  // ── POST /api/auth/logout-all ─────────────────────────────
  router.post("/api/auth/logout-all", requireRole(appState, "ensign"), asyncHandler(async (_req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    await appState.userStore.destroyAllSessions(res.locals.userId!);

    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie(TENANT_COOKIE, { path: "/" });

    sendOk(res, { message: "All sessions destroyed." });
  }));

  // ── POST /api/auth/change-password ────────────────────────
  router.post("/api/auth/change-password", requireRole(appState, "ensign"), asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || typeof currentPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Current password is required", 400);
    }
    if (!newPassword || typeof newPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "New password is required", 400);
    }

    try {
      // Keep the current session alive, kill all others
      const sessionToken = req.cookies?.[SESSION_COOKIE] || "";
      await appState.userStore.changePassword(
        res.locals.userId!, currentPassword, newPassword, sessionToken,
      );
      sendOk(res, { message: "Password changed. All other sessions have been signed out." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password change failed";
      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  }));

  // ── POST /api/auth/forgot-password ────────────────────────
  router.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }

    // Always return 200 — never reveal if email exists
    const token = await appState.userStore.createResetToken(email);
    if (token) {
      sendPasswordResetEmail(email, token).catch(() => {});
    }

    sendOk(res, { message: "If that email is registered, a reset link has been sent." });
  }));

  // ── POST /api/auth/reset-password ─────────────────────────
  router.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { token, newPassword } = req.body ?? {};
    if (!token || typeof token !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Reset token is required", 400);
    }
    if (!newPassword || typeof newPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "New password is required", 400);
    }

    try {
      const reset = await appState.userStore.resetPassword(token, newPassword);
      if (!reset) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid or expired reset token", 400);
      }
      sendOk(res, { message: "Password has been reset. Please sign in with your new password." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password reset failed";
      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  }));

  // ── GET /api/auth/status ──────────────────────────────────
  // Legacy compatibility endpoint
  router.get("/api/auth/status", asyncHandler(async (req, res) => {
    if (!appState.config.authEnabled) {
      return sendOk(res, { tier: "admiral", authEnabled: false, tenantId: "local" });
    }

    // Check for admin bearer token
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === appState.config.adminToken) {
        return sendOk(res, { tier: "admiral", authEnabled: true, tenantId: "admiral" });
      }
    }

    // Check for user session
    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (sessionToken && appState.userStore) {
      const session = await appState.userStore.resolveSession(sessionToken);
      if (session) {
        return sendOk(res, {
          tier: session.role,
          authEnabled: true,
          user: {
            id: session.userId,
            email: session.email,
            displayName: session.displayName,
            role: session.role,
          },
        });
      }
    }

    // Check for legacy tenant cookie
    const tenantId = req.cookies?.[TENANT_COOKIE];
    if (tenantId && appState.inviteStore) {
      const session = await appState.inviteStore.getSession(tenantId);
      if (session) {
        return sendOk(res, { tier: "visitor", authEnabled: true, tenantId });
      }
    }

    sendOk(res, { tier: "public", authEnabled: true, tenantId: null });
  }));

  // ── POST /api/auth/redeem ─────────────────────────────────
  // Legacy invite code redemption (backward compat)
  router.post("/api/auth/redeem", asyncHandler(async (req, res) => {
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
      res.cookie(TENANT_COOKIE, session.tenantId, {
        httpOnly: true,
        sameSite: "strict",
        secure: appState.config.nodeEnv === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000,
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
  }));

  // ── Admiral Console Routes ────────────────────────────────
  // These routes accept both Bearer token AND session-cookie admirals.
  // Bearer token is still needed for the very first promotion (no admirals yet).
  router.use("/api/auth/admiral", (req, res, next) => {
    // Try Bearer token first (always works for bootstrapping)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === appState.config.adminToken) {
        return next();
      }
    }
    // Fall back to session-based admiral check
    return requireAdmiral(appState)(req, res, next);
  });

  // ── POST /api/auth/admiral/set-role ─────────────────────
  // Admin-only: set a user's role (the only way to create the first Admiral)
  router.post("/api/auth/admiral/set-role", asyncHandler(async (req, res) => {

    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, role } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (!role || !["ensign", "lieutenant", "captain", "admiral"].includes(role)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Role must be ensign, lieutenant, captain, or admiral", 400);
    }

    // Look up user by email to get their ID
    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }

    const updated = await appState.userStore.setRole(user.id, role);
    if (!updated) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to update role", 500);
    }

    sendOk(res, {
      message: `${updated.displayName} promoted to ${role}.`,
      user: updated,
    });
  }));

  // ── GET /api/auth/admiral/users ─────────────────────
  // Admin-only: list all users
  router.get("/api/auth/admiral/users", asyncHandler(async (_req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }
    const users = await appState.userStore.listUsers();
    sendOk(res, { users, count: users.length });
  }));

  // ── PATCH /api/auth/admiral/lock ────────────────────
  // Admin-only: lock or unlock a user account
  router.patch("/api/auth/admiral/lock", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, locked, reason } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (typeof locked !== "boolean") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "locked (boolean) required", 400);
    }

    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }

    const ok = locked
      ? await appState.userStore.lockUser(user.id, reason || "Locked by administrator")
      : await appState.userStore.unlockUser(user.id);

    if (!ok) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to update lock status", 500);
    }

    sendOk(res, { message: `${user.displayName} ${locked ? "locked" : "unlocked"}.` });
  }));

  // ── DELETE /api/auth/admiral/user ───────────────────
  // Admin-only: delete a user by email
  router.delete("/api/auth/admiral/user", asyncHandler(async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }

    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }

    const deleted = await appState.userStore.deleteUser(user.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to delete user", 500);
    }

    sendOk(res, { message: `User ${email} deleted.` });
  }));

  // ── GET /api/auth/dev-verify ──────────────────────────────
  // Dev-only: verify email without actually sending/receiving email
  if (process.env.NODE_ENV !== "production") {
    router.get("/api/auth/dev-verify", asyncHandler(async (req, res) => {
      if (!appState.userStore) {
        return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
      }

      const email = req.query.email as string;
      if (!email) {
        return sendFail(res, ErrorCode.MISSING_PARAM, "Email query parameter required", 400);
      }

      const devToken = getDevToken(email);
      if (!devToken || devToken.type !== "verify") {
        return sendFail(res, ErrorCode.NOT_FOUND, "No pending verification for that email", 404);
      }

      const verified = await appState.userStore.verifyEmail(devToken.token);
      if (!verified) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Token already used or expired", 400);
      }

      sendOk(res, { verified: true, email, message: "Email verified (dev mode)." });
    }));
  }

  return router;
}
