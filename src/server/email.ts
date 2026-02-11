/**
 * email.ts — Email Delivery Service (ADR-019 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Development mode: Logs email content to console (no actual delivery).
 * Production mode: Gmail API (Phase 4 — not yet implemented).
 *
 * All email functions are no-throw: failures are logged, never crash the request.
 */

import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// ─── Dev Mode Token Registry ────────────────────────────────────

/**
 * In dev mode, we store the last token per email for test/dev verification.
 * This is cleared on server restart. Only populated in non-production.
 */
const devTokens = new Map<string, { token: string; type: string }>();

/** Get the last dev token for an email (for dev-verify endpoint). */
export function getDevToken(email: string): { token: string; type: string } | undefined {
  return devTokens.get(email.toLowerCase());
}

// ─── Send Functions ─────────────────────────────────────────────

/**
 * Send an email. In dev mode, logs to console and stores token in devTokens.
 * In production, will use Gmail API (Phase 4).
 */
async function sendEmail(message: EmailMessage, tokenInfo?: { token: string; type: string }): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    // Dev mode: log the email content
    log.boot.info(
      {
        to: message.to,
        subject: message.subject,
        token: tokenInfo?.token,
        type: tokenInfo?.type,
      },
      `📧 [DEV EMAIL] ${message.subject}`,
    );

    // Store token for dev-verify endpoint
    if (tokenInfo) {
      devTokens.set(message.to.toLowerCase(), tokenInfo);
    }
    return;
  }

  // Production: Gmail API (Phase 4)
  // For now, log a warning that email delivery is not yet configured
  log.boot.warn(
    { to: message.to, subject: message.subject, token: tokenInfo?.token, type: tokenInfo?.type },
    "Email delivery not yet configured (Gmail API Phase 4) — token logged for manual verification",
  );

  // Still store token in dev registry as fallback until Gmail is configured
  if (tokenInfo) {
    devTokens.set(message.to.toLowerCase(), tokenInfo);
  }
}

// ─── Template Functions ─────────────────────────────────────────

const BASE_URL = process.env.MAJEL_BASE_URL || "https://aria.smartergpt.dev";

/**
 * Send email verification link to a new user.
 */
export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${BASE_URL}/verify?token=${encodeURIComponent(token)}`;

  await sendEmail(
    {
      to: email,
      subject: "Welcome to Ariadne — Verify Your Email",
      text: [
        "Welcome to Ariadne, Commander!",
        "",
        "Please verify your email address to activate your account:",
        "",
        verifyUrl,
        "",
        "This link expires in 48 hours.",
        "",
        "If you didn't create this account, you can safely ignore this email.",
        "",
        "— Ariadne Fleet Intelligence",
      ].join("\n"),
    },
    { token, type: "verify" },
  );
}

/**
 * Send password reset link.
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;

  await sendEmail(
    {
      to: email,
      subject: "Ariadne — Password Reset",
      text: [
        "A password reset was requested for your Ariadne account.",
        "",
        "Reset your password:",
        "",
        resetUrl,
        "",
        "This link expires in 1 hour.",
        "",
        "If you didn't request this, you can safely ignore this email.",
        "",
        "— Ariadne Fleet Intelligence",
      ].join("\n"),
    },
    { token, type: "reset" },
  );
}

/**
 * Send role change notification.
 */
export async function sendRoleChangeEmail(email: string, newRole: string): Promise<void> {
  const roleNames: Record<string, string> = {
    ensign: "Ensign",
    lieutenant: "Lieutenant",
    captain: "Captain",
    admiral: "Admiral",
  };

  await sendEmail({
    to: email,
    subject: `Ariadne — Rank Updated to ${roleNames[newRole] ?? newRole}`,
    text: [
      "Your rank on Ariadne has been updated.",
      "",
      `New rank: ${roleNames[newRole] ?? newRole}`,
      "",
      "Log in to see your updated permissions.",
      "",
      "— Ariadne Fleet Intelligence",
    ].join("\n"),
  });
}

/**
 * Send account deletion confirmation.
 */
export async function sendDeletionConfirmationEmail(email: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Ariadne — Account Deleted",
    text: [
      "Your Ariadne account and all associated data have been permanently deleted.",
      "",
      "If you did not request this, please contact support immediately.",
      "",
      "— Ariadne Fleet Intelligence",
    ].join("\n"),
  });
}
