/**
 * password.ts — Argon2id Password Hashing (ADR-019 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * OWASP-compliant password hashing using Argon2id:
 *   memory:      19 MiB (m=19456)
 *   iterations:  2
 *   parallelism: 1
 *   hash length: 32 bytes
 *
 * Also handles password policy validation (NIST SP800-63B):
 *   - Minimum 15 characters (no MFA at launch)
 *   - Maximum 128 characters
 *   - No composition rules
 *   - Breached password check (NCSC top 100k — Phase 4)
 */

import * as argon2 from "argon2";
import { timingSafeEqual } from "node:crypto";

// ─── Argon2id Configuration (OWASP 2025) ────────────────────────

const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 19456,      // 19 MiB
  timeCost: 2,            // iterations
  parallelism: 1,
  hashLength: 32,
  raw: false,             // returns encoded string
};

// ─── Password Policy ────────────────────────────────────────────

const MIN_LENGTH = 15;
const MAX_LENGTH = 128;

export interface PasswordValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a password against NIST SP800-63B policy.
 *
 * Rules:
 * - 15–128 characters (no MFA at launch, so 15 minimum)
 * - No composition rules (no forced uppercase/numbers/symbols)
 * - Unicode and whitespace allowed
 * - Breached password check: Phase 4 (not yet)
 */
export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== "string") {
    return { valid: false, reason: "Password must be a string" };
  }
  if (password.length < MIN_LENGTH) {
    return { valid: false, reason: `Password must be at least ${MIN_LENGTH} characters` };
  }
  if (password.length > MAX_LENGTH) {
    return { valid: false, reason: `Password must be at most ${MAX_LENGTH} characters` };
  }
  return { valid: true };
}

// ─── Hashing ────────────────────────────────────────────────────

/**
 * Hash a password with Argon2id.
 * Returns an encoded string including algorithm params, salt, and hash.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored Argon2id hash.
 * Returns true if the password matches.
 *
 * Constant-time: argon2.verify internally uses timing-safe comparison.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Invalid hash format or corrupted — always return false
    return false;
  }
}

// ─── Timing-Safe Comparison Utilities ───────────────────────────

/**
 * Constant-time string comparison using crypto.timingSafeEqual.
 * Prevents timing attacks on token/secret comparisons.
 *
 * Returns false if strings differ in length (leaks length, which is
 * acceptable for fixed-length tokens like admin bearer tokens).
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}
