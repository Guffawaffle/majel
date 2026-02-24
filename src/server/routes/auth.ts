/**
 * routes/auth.ts — Authentication Routes (ADR-019 Phase 1)
 *
 * User sign-up, sign-in, email verification, password management,
 * and session management.
 *
 * Routes:
 *   POST /api/auth/signup               — Create account → verification email
 *   POST /api/auth/verify-email         — Verify email with token
 *   POST /api/auth/resend-verification  — Resend verify email (requires nonce from signup)
 *   POST /api/auth/signin               — Sign in → session cookie
 *   GET  /api/auth/me                   — Current user info + role
 *   POST /api/auth/logout               — Destroy current session
 *   POST /api/auth/logout-all           — Destroy all sessions
 *   POST /api/auth/change-password      — Change password (kills other sessions)
 *   POST /api/auth/forgot-password      — Request password reset email
 *   POST /api/auth/reset-password       — Reset password with token
 *   GET  /api/auth/dev-verify           — Dev-only: verify email by address
 *
 * Admiral routes:
 *   POST /api/auth/admiral/resend-verification — Resend verify email for any user
 *   POST /api/auth/admiral/verify-user         — Directly approve a user's email
 */

import type { Router, Request } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { SESSION_COOKIE, TENANT_COOKIE, requireRole, requireAdmiral } from "../services/auth.js";
import { timingSafeCompare } from "../services/password.js";
import { authRateLimiter, emailRateLimiter } from "../rate-limit.js";
import { sendVerificationEmail, sendPasswordResetEmail, getDevToken } from "../services/email.js";
import { createSafeRouter } from "../safe-router.js";
import type { AuditLogInput } from "../stores/audit-store.js";
import { randomBytes } from "node:crypto";

// ─── Resend Nonces ──────────────────────────────────────────────
// Short-lived in-memory tokens returned from signup, required to call
// resend-verification. Prevents unauthenticated abuse of the endpoint.
// TTL: 15 minutes, single-use.

interface ResendNonce {
  userId: string;
  email: string;
  createdAt: number;
}

const RESEND_NONCE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const resendNonces = new Map<string, ResendNonce>();

function createResendNonce(userId: string, email: string): string {
  const nonce = randomBytes(32).toString("hex");
  resendNonces.set(nonce, { userId, email, createdAt: Date.now() });
  return nonce;
}

function consumeResendNonce(nonce: string): ResendNonce | null {
  const entry = resendNonces.get(nonce);
  if (!entry) return null;
  resendNonces.delete(nonce); // single-use
  if (Date.now() - entry.createdAt > RESEND_NONCE_TTL_MS) return null;
  return entry;
}

// Periodic cleanup of expired nonces (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of resendNonces) {
    if (now - val.createdAt > RESEND_NONCE_TTL_MS) resendNonces.delete(key);
  }
}, 5 * 60 * 1000).unref();

/** Extract IP + User-Agent from a request for audit logging. */
function auditMeta(req: Request): Pick<AuditLogInput, "ip" | "userAgent"> {
  return {
    ip: req.ip || req.socket.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null,
  };
}

/** Check if at least one Admiral exists other than `excludeId`. */
async function hasOtherAdmiral(
  userStore: NonNullable<AppState["userStore"]>,
  excludeId: string,
): Promise<boolean> {
  return userStore.hasOtherAdmiral(excludeId);
}

export function createAuthRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // Apply rate limiting to all auth endpoints
  router.use("/api/auth", authRateLimiter);

  // ── POST /api/auth/signup ─────────────────────────────────
  router.post("/api/auth/signup", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, password, displayName } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }
    if (!password || typeof password !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Password is required", 400);
    }
    if (password.length < 15) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Password must be at least 15 characters", 400);
    }
    if (password.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Password must be 200 characters or fewer", 400);
    }
    if (!displayName || typeof displayName !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Display name is required", 400);
    }
    if (displayName.length > 100) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Display name must be 100 characters or fewer", 400);
    }

    try {
      const result = await appState.userStore.signUp({ email, password, displayName });

      // Send verification email (fire-and-forget)
      sendVerificationEmail(result.user.email, result.verifyToken).catch(() => {});

      // Generate a resend nonce so the landing page can request a resend
      // without exposing a public email-based endpoint.
      const resendToken = createResendNonce(result.user.id, result.user.email);

      sendOk(res, {
        message: "Account created. Please check your email to verify your address.",
        user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
        resendToken,
      }, 201);

      appState.auditStore?.logEvent({
        event: "auth.signup", actorId: result.user.id,
        detail: { email: result.user.email }, ...auditMeta(req),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Sign-up failed";
      // Map known errors to safe messages; suppress internal details
      const message = /duplicate|already exists|unique|unable to create/i.test(raw)
        ? "An account with this email already exists"
        : "Sign-up failed";

      appState.auditStore?.logEvent({
        event: "auth.signup",
        detail: { email, success: false, reason: message },
        ...auditMeta(req),
      });

      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  });

  // ── POST /api/auth/verify-email ───────────────────────────
  router.post("/api/auth/verify-email", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { token } = req.body ?? {};
    if (!token || typeof token !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Verification token is required", 400);
    }
    if (token.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid verification token", 400);
    }

    const verified = await appState.userStore.verifyEmail(token);
    if (!verified) {
      // W6 fix: audit verify-email failure
      appState.auditStore?.logEvent({
        event: "auth.verify_email",
        detail: { success: false, reason: "Invalid or expired verification token" },
        ...auditMeta(req),
      });
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid or expired verification token", 400);
    }

    // W5 fix: audit verify-email success
    appState.auditStore?.logEvent({
      event: "auth.verify_email",
      detail: { success: true },
      ...auditMeta(req),
    });

    sendOk(res, { verified: true, message: "Email verified. You can now sign in." });
  });

  // ── POST /api/auth/resend-verification ────────────────────
  // Requires a resendToken (nonce) from the signup response — not a public endpoint.
  // This prevents unauthenticated email enumeration and sender-reputation abuse.
  router.post("/api/auth/resend-verification", emailRateLimiter, async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { resendToken } = req.body ?? {};
    if (!resendToken || typeof resendToken !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Resend token is required", 400);
    }

    const nonce = consumeResendNonce(resendToken);
    if (!nonce) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Invalid or expired resend token", 401);
    }

    try {
      const user = await appState.userStore.getUserByEmail(nonce.email);
      if (user && !user.emailVerified) {
        const token = await appState.userStore.createVerifyToken(user.id);
        sendVerificationEmail(user.email, token).catch(() => {});
        appState.auditStore?.logEvent({
          event: "auth.resend_verification",
          actorId: user.id,
          detail: { email: user.email },
          ...auditMeta(req),
        });
      }
    } catch {
      // Swallow — never reveal internal errors
    }

    // Issue a fresh nonce so the user can resend again (within rate limit)
    const freshNonce = createResendNonce(nonce.userId, nonce.email);
    sendOk(res, {
      message: "If your email is registered and unverified, a new verification link has been sent.",
      resendToken: freshNonce,
    });
  });

  // ── POST /api/auth/signin ─────────────────────────────────
  router.post("/api/auth/signin", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, password } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }
    if (!password || typeof password !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Password is required", 400);
    }
    if (password.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Password must be 200 characters or fewer", 400);
    }

    try {
      // Session rotation: destroy existing session before creating new one (#91 Phase C)
      const oldSessionToken = req.cookies?.[SESSION_COOKIE];
      if (oldSessionToken && appState.userStore) {
        await appState.userStore.destroySession(oldSessionToken);
      }

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

      appState.auditStore?.logEvent({
        event: "auth.signin.success", actorId: result.user.id,
        detail: { email: result.user.email }, ...auditMeta(req),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed";
      sendFail(res, ErrorCode.UNAUTHORIZED, message, 401);

      appState.auditStore?.logEvent({
        event: "auth.signin.failure",
        detail: { email: typeof email === "string" ? email : null, reason: message },
        ...auditMeta(req),
      });
    }
  });

  // ── GET /api/auth/me ──────────────────────────────────────
  router.get("/api/auth/me", requireRole(appState, "ensign"), async (_req, res) => {
    sendOk(res, {
      user: {
        id: res.locals.userId,
        email: res.locals.userEmail,
        displayName: res.locals.userDisplayName,
        role: res.locals.userRole,
      },
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────
  router.post("/api/auth/logout", async (req, res) => {
    // Destroy user session if present
    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (sessionToken && appState.userStore) {
      await appState.userStore.destroySession(sessionToken);
    }

    // Clear both cookies — options must match res.cookie() (minus maxAge) for cross-browser compat
    const clearOpts = { httpOnly: true, sameSite: "strict" as const, secure: appState.config.nodeEnv === "production", path: "/" };
    res.clearCookie(SESSION_COOKIE, clearOpts);
    res.clearCookie(TENANT_COOKIE, clearOpts);

    appState.auditStore?.logEvent({
      event: "auth.logout", actorId: res.locals.userId ?? null, ...auditMeta(req),
    });

    sendOk(res, { message: "Signed out." });
  });

  // ── POST /api/auth/logout-all ─────────────────────────────
  router.post("/api/auth/logout-all", requireRole(appState, "ensign"), async (_req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    await appState.userStore.destroyAllSessions(res.locals.userId!);

    appState.auditStore?.logEvent({
      event: "auth.logout_all", actorId: res.locals.userId!, ...auditMeta(_req),
    });

    const clearOpts = { httpOnly: true, sameSite: "strict" as const, secure: appState.config.nodeEnv === "production", path: "/" };
    res.clearCookie(SESSION_COOKIE, clearOpts);
    res.clearCookie(TENANT_COOKIE, clearOpts);

    sendOk(res, { message: "All sessions destroyed." });
  });

  // ── POST /api/auth/change-password ────────────────────────
  router.post("/api/auth/change-password", requireRole(appState, "ensign"), async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || typeof currentPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Current password is required", 400);
    }
    if (currentPassword.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Current password must be 200 characters or fewer", 400);
    }
    if (!newPassword || typeof newPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "New password is required", 400);
    }
    if (newPassword.length < 15) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "New password must be at least 15 characters", 400);
    }
    if (newPassword.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "New password must be 200 characters or fewer", 400);
    }

    try {
      // Keep the current session alive, kill all others
      const sessionToken = req.cookies?.[SESSION_COOKIE] || "";
      await appState.userStore.changePassword(
        res.locals.userId!, currentPassword, newPassword, sessionToken,
      );

      appState.auditStore?.logEvent({
        event: "auth.password.change", actorId: res.locals.userId!, ...auditMeta(req),
      });

      sendOk(res, { message: "Password changed. All other sessions have been signed out." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password change failed";

      appState.auditStore?.logEvent({
        event: "auth.password.change",
        actorId: res.locals.userId ?? null,
        detail: { success: false, reason: message },
        ...auditMeta(req),
      });

      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  });

  // ── POST /api/auth/forgot-password ────────────────────────
  router.post("/api/auth/forgot-password", emailRateLimiter, async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email is required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }

    // Always return 200 — never reveal if email exists
    const token = await appState.userStore.createResetToken(email);
    if (token) {
      sendPasswordResetEmail(email, token).catch(() => {});
    }

    appState.auditStore?.logEvent({
      event: "auth.password.reset_request",
      detail: { email: typeof email === "string" ? email : null },
      ...auditMeta(req),
    });

    sendOk(res, { message: "If that email is registered, a reset link has been sent." });
  });

  // ── POST /api/auth/reset-password ─────────────────────────
  router.post("/api/auth/reset-password", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { token, newPassword } = req.body ?? {};
    if (!token || typeof token !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Reset token is required", 400);
    }
    if (token.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid reset token", 400);
    }
    if (!newPassword || typeof newPassword !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "New password is required", 400);
    }
    if (newPassword.length < 15) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "New password must be at least 15 characters", 400);
    }
    if (newPassword.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "New password must be 200 characters or fewer", 400);
    }

    try {
      const reset = await appState.userStore.resetPassword(token, newPassword);
      if (!reset) {
        // W7 fix: audit reset-password failure (invalid token)
        appState.auditStore?.logEvent({
          event: "auth.password.reset_complete",
          detail: { success: false, reason: "Invalid or expired reset token" },
          ...auditMeta(req),
        });
        return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid or expired reset token", 400);
      }

      // W5 fix: audit reset-password success
      appState.auditStore?.logEvent({
        event: "auth.password.reset_complete",
        detail: { success: true },
        ...auditMeta(req),
      });

      sendOk(res, { message: "Password has been reset. Please sign in with your new password." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password reset failed";
      // W7 fix: audit reset-password exception
      appState.auditStore?.logEvent({
        event: "auth.password.reset_complete",
        detail: { success: false, reason: message },
        ...auditMeta(req),
      });
      sendFail(res, ErrorCode.INVALID_PARAM, message, 400);
    }
  });


  // ── Admiral Console Routes (#91 Phase B) ───────────────────
  // Bearer token is bootstrap-only: only works when no real Admiral exists.
  // After the first Admiral is promoted, all admin routes require session-cookie auth.
  router.use("/api/auth/admiral", async (req, res, next) => {
    // Try Bearer token — but ONLY if no Admiral exists yet (bootstrap mode)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (appState.config.adminToken && timingSafeCompare(token, appState.config.adminToken)) {
        // Check if we're still in bootstrap mode
        const hasAdmiral = appState.userStore ? await appState.userStore.hasAdmiral() : false;
        if (!hasAdmiral) {
          // W8 fix: use dedicated bootstrap event (was admin.role_change)
          // W9 fix: use auditMeta(req) for consistency
          appState.auditStore?.logEvent({
            event: "admin.bootstrap",
            detail: { note: "Bearer token used in bootstrap mode" },
            ...auditMeta(req),
          });
          return next();
        }
        // Admiral exists → Bearer is dead for admin routes
      }
    }
    // Fall back to session-based admiral check
    return requireAdmiral(appState)(req, res, next);
  });

  // ── POST /api/auth/admiral/set-role ─────────────────────
  // Admin-only: set a user's role (the only way to create the first Admiral)
  router.post("/api/auth/admiral/set-role", async (req, res) => {

    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, role } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }
    if (!role || !["ensign", "lieutenant", "captain", "admiral"].includes(role)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Role must be ensign, lieutenant, captain, or admiral", 400);
    }

    // Look up user by email to get their ID
    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }

    // Last-Admiral guard (#91 Phase D): prevent demoting the last Admiral
    if (user.role === "admiral" && role !== "admiral") {
      const hasOther = await hasOtherAdmiral(appState.userStore, user.id);
      if (!hasOther) {
        return sendFail(res, ErrorCode.INVALID_PARAM,
          "Cannot demote the last Admiral. Promote another user first.", 400);
      }
    }

    const updated = await appState.userStore.setRole(user.id, role);
    if (!updated) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to update role", 500);
    }

    sendOk(res, {
      message: `${updated.displayName} promoted to ${role}.`,
      user: updated,
    });

    appState.auditStore?.logEvent({
      event: "admin.role_change",
      actorId: res.locals.userId ?? null,
      targetId: user.id,
      detail: { email, oldRole: user.role, newRole: role },
      ...auditMeta(req),
    });
  });

  // ── GET /api/auth/admiral/users ─────────────────────
  // Admin-only: list all users
  // W10 fix: audit admin list-users access
  router.get("/api/auth/admiral/users", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }
    const users = await appState.userStore.listUsers();

    appState.auditStore?.logEvent({
      event: "admin.list_users",
      actorId: res.locals.userId ?? null,
      detail: { count: users.length },
      ...auditMeta(req),
    });

    sendOk(res, { users, count: users.length });
  });

  // ── PATCH /api/auth/admiral/lock ────────────────────
  // Admin-only: lock or unlock a user account
  router.patch("/api/auth/admiral/lock", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email, locked, reason } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }
    if (typeof locked !== "boolean") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "locked (boolean) required", 400);
    }
    if (reason !== undefined && typeof reason === "string" && reason.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Reason must be 500 characters or fewer", 400);
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

    appState.auditStore?.logEvent({
      event: locked ? "admin.lock_user" : "admin.unlock_user",
      actorId: res.locals.userId ?? null,
      targetId: user.id,
      detail: { email, reason: reason || null },
      ...auditMeta(req),
    });

    sendOk(res, { message: `${user.displayName} ${locked ? "locked" : "unlocked"}.` });
  });

  // ── DELETE /api/auth/admiral/user ───────────────────
  // Admin-only: delete a user by email
  router.delete("/api/auth/admiral/user", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }

    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }

    // Last-Admiral guard (#91 Phase D): prevent deleting the last Admiral
    if (user.role === "admiral") {
      const hasOther = await hasOtherAdmiral(appState.userStore, user.id);
      if (!hasOther) {
        return sendFail(res, ErrorCode.INVALID_PARAM,
          "Cannot delete the last Admiral. Promote another user first.", 400);
      }
    }

    const deleted = await appState.userStore.deleteUser(user.id);
    if (!deleted) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to delete user", 500);
    }

    appState.auditStore?.logEvent({
      event: "admin.delete_user",
      actorId: res.locals.userId ?? null,
      targetId: user.id,
      detail: { email },
      ...auditMeta(req),
    });

    sendOk(res, { message: `User ${email} deleted.` });
  });

  // ── POST /api/auth/admiral/resend-verification ──────────────
  // Admin-only: resend verification email for any user
  router.post("/api/auth/admiral/resend-verification", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }

    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }
    if (user.emailVerified) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "User is already verified", 400);
    }

    const token = await appState.userStore.createVerifyToken(user.id);
    sendVerificationEmail(user.email, token).catch(() => {});

    appState.auditStore?.logEvent({
      event: "admin.resend_verification",
      actorId: res.locals.userId ?? null,
      targetId: user.id,
      detail: { email },
      ...auditMeta(req),
    });

    sendOk(res, { message: `Verification email resent to ${email}.` });
  });

  // ── POST /api/auth/admiral/verify-user ──────────────────────
  // Admin-only: directly approve a user's email (skip verification)
  router.post("/api/auth/admiral/verify-user", async (req, res) => {
    if (!appState.userStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "User system not available", 503);
    }

    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Email required", 400);
    }
    if (email.length > 254) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Email must be 254 characters or fewer", 400);
    }

    const user = await appState.userStore.getUserByEmail(email);
    if (!user) {
      return sendFail(res, ErrorCode.NOT_FOUND, "User not found", 404);
    }
    if (user.emailVerified) {
      return sendOk(res, { message: `${user.displayName} is already verified.` });
    }

    const verified = await appState.userStore.setEmailVerified(user.id, true);
    if (!verified) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to verify user", 500);
    }

    appState.auditStore?.logEvent({
      event: "admin.verify_user",
      actorId: res.locals.userId ?? null,
      targetId: user.id,
      detail: { email },
      ...auditMeta(req),
    });

    sendOk(res, { message: `${user.displayName} has been verified.` });
  });

  // ── GET /api/auth/dev-verify ──────────────────────────────
  // Dev-only: verify email without actually sending/receiving email.
  // Defence-in-depth: the outer `if` prevents route registration outside dev,
  // and the inner guard rejects requests even if NODE_ENV is changed at runtime.
  if (process.env.NODE_ENV === "development") {
    router.get("/api/auth/dev-verify", async (req, res) => {
      if (process.env.NODE_ENV !== "development") {
        return sendFail(res, ErrorCode.UNAUTHORIZED, "Not available outside development", 403);
      }
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
    });
  }

  return router;
}
