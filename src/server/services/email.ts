/**
 * email.ts — Email Delivery Service (ADR-019 Phase 4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Transport selection:
 *   1. SMTP configured (MAJEL_SMTP_HOST) → nodemailer SMTP transport
 *   2. NODE_ENV !== "production"          → dev-mode console log + devTokens
 *   3. Production without SMTP           → warning log (no delivery)
 *
 * All email functions are no-throw: failures are logged, never crash the request.
 */

import { createTransport, type Transporter } from "nodemailer";
import { log } from "../logger.js";

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
const DEV_TOKEN_MAX = 200; // Cap to prevent unbounded growth in dev mode

/** Get the last dev token for an email (for dev-verify endpoint). */
export function getDevToken(email: string): { token: string; type: string } | undefined {
  return devTokens.get(email.toLowerCase());
}

// ─── SMTP Transport ─────────────────────────────────────────────

let smtpTransport: Transporter | null = null;

function getSmtpTransport(): Transporter | null {
  if (smtpTransport) return smtpTransport;

  const host = process.env.MAJEL_SMTP_HOST;
  if (!host) return null;

  const port = parseInt(process.env.MAJEL_SMTP_PORT || "587", 10);
  const user = process.env.MAJEL_SMTP_USER || "";
  const pass = process.env.MAJEL_SMTP_PASS || "";

  smtpTransport = createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  log.boot.info({ host, port, user: user || "(none)" }, "SMTP email transport configured");
  return smtpTransport;
}

const SMTP_FROM = () => process.env.MAJEL_SMTP_FROM || process.env.MAJEL_SMTP_USER || "noreply@aria.smartergpt.dev";

// ─── Send Functions ─────────────────────────────────────────────

/**
 * Send an email via SMTP if configured, otherwise fall back to dev-mode log.
 */
async function sendEmail(message: EmailMessage, tokenInfo?: { token: string; type: string }): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const transport = getSmtpTransport();

  // Always store token in dev registry (useful for dev-verify endpoint)
  if (tokenInfo) {
    if (devTokens.size >= DEV_TOKEN_MAX && !devTokens.has(message.to.toLowerCase())) {
      const oldest = devTokens.keys().next().value;
      if (oldest) devTokens.delete(oldest);
    }
    devTokens.set(message.to.toLowerCase(), tokenInfo);
  }

  // Path 1: SMTP transport available → send real email
  if (transport) {
    try {
      await transport.sendMail({
        from: SMTP_FROM(),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      log.boot.info(
        { to: message.to, subject: message.subject },
        `📧 Email sent: ${message.subject}`,
      );
    } catch (err) {
      log.boot.error(
        { to: message.to, subject: message.subject, err },
        `📧 Email delivery failed: ${message.subject}`,
      );
    }
    return;
  }

  // Path 2: No SMTP → dev-mode log or production warning
  if (!isProduction) {
    log.boot.info(
      {
        to: message.to,
        subject: message.subject,
        tokenPrefix: tokenInfo?.token?.slice(0, 8),
        type: tokenInfo?.type,
      },
      `📧 [DEV EMAIL] ${message.subject}`,
    );
  } else {
    log.boot.warn(
      { to: message.to, subject: message.subject, tokenType: tokenInfo?.type },
      "📧 No SMTP configured — email not delivered. Set MAJEL_SMTP_HOST to enable.",
    );
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
