/**
 * user-store.ts — User Account Store (ADR-019 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages user accounts, sessions, and email verification tokens.
 *
 * Tables:
 *   users            — Core user accounts (email, password_hash, role)
 *   user_sessions    — Session tokens (HttpOnly cookie sessions)
 *   email_tokens     — Email verification + password reset tokens
 */

import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";
import { hashPassword, verifyPassword, validatePassword, timingSafeCompare } from "../services/password.js";

// ─── Constants ──────────────────────────────────────────────────

/**
 * Derive a deterministic UUID from the admin token via HMAC-SHA256.
 * This replaces hardcoded UUIDs — the virtual Admiral's identity is
 * unique per deployment (depends on the secret), and cannot be guessed
 * even by someone reading the source code.
 *
 * Format: HMAC-SHA256(adminToken, "majel-admin") → first 16 bytes → UUIDv4 format.
 */
export function deriveAdminUserId(adminToken: string): string {
  const hmac = createHmac("sha256", adminToken).update("majel-admin").digest();
  // Set version 4 bits and variant bits per RFC 4122
  hmac[6] = (hmac[6]! & 0x0f) | 0x40; // version 4
  hmac[8] = (hmac[8]! & 0x3f) | 0x80; // variant 10
  const hex = hmac.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Valid role values, ordered by privilege level. */
export const ROLES = ["ensign", "lieutenant", "captain", "admiral"] as const;
export type Role = (typeof ROLES)[number];

/** Numeric privilege level for each role. */
export function roleLevel(role: Role): number {
  return ROLES.indexOf(role);
}

/** Session token length in bytes (32 bytes = 64 hex chars). */
const SESSION_TOKEN_BYTES = 32;

/** Session expiry in days. */
const SESSION_EXPIRY_DAYS = 30;

/** Email verification token expiry in hours. */
const VERIFY_TOKEN_EXPIRY_HOURS = 48;

/** Password reset token expiry in hours. */
const RESET_TOKEN_EXPIRY_HOURS = 1;

/** Maximum failed logins before lockout. */
const MAX_FAILED_LOGINS = 5;

/** Lockout duration in minutes. */
const LOCKOUT_MINUTES = 15;

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT,
    role            TEXT NOT NULL DEFAULT 'ensign'
                    CHECK (role IN ('ensign', 'lieutenant', 'captain', 'admiral')),
    locked_at       TIMESTAMPTZ,
    lock_reason     TEXT,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Case-insensitive email uniqueness
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
    id           TEXT PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address   INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS email_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_type  TEXT NOT NULL CHECK (token_type IN ('verify', 'reset')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_tokens (user_id)`,
];

// ─── SQL ────────────────────────────────────────────────────────

const SQL = {
  // Users
  insertUser: `INSERT INTO users (id, email, display_name, password_hash, role, email_verified)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
  getUserById: `SELECT * FROM users WHERE id = $1`,
  getUserByEmail: `SELECT * FROM users WHERE LOWER(email) = LOWER($1)`,
  updateUser: `UPDATE users SET display_name = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
  updateRole: `UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
  verifyEmail: `UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1`,
  updatePasswordHash: `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
  updateLastLogin: `UPDATE users SET last_login_at = NOW(), failed_login_count = 0, updated_at = NOW() WHERE id = $1`,
  incrementFailedLogins: `UPDATE users SET
    failed_login_count = failed_login_count + 1,
    locked_at = CASE WHEN failed_login_count + 1 >= $2 THEN NOW() ELSE locked_at END,
    lock_reason = CASE WHEN failed_login_count + 1 >= $2 THEN 'Too many failed login attempts' ELSE lock_reason END,
    updated_at = NOW()
    WHERE id = $1`,
  lockUser: `UPDATE users SET locked_at = NOW(), lock_reason = $2, updated_at = NOW() WHERE id = $1`,
  unlockUser: `UPDATE users SET locked_at = NULL, lock_reason = NULL, failed_login_count = 0, updated_at = NOW() WHERE id = $1`,
  deleteUser: `DELETE FROM users WHERE id = $1`,
  listUsers: `SELECT id, email, email_verified, display_name, role, locked_at, last_login_at, created_at
    FROM users ORDER BY created_at DESC`,
  countUsers: `SELECT COUNT(*) as count FROM users`,

  // Sessions
  insertSession: `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, expires_at)
    VALUES ($1, $2, $3, $4, NOW() + $5::INTERVAL) RETURNING *`,
  getSession: `SELECT s.*, u.email, u.display_name, u.role, u.email_verified, u.locked_at
    FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE s.id = $1`,
  touchSession: `UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1`,
  deleteSession: `DELETE FROM user_sessions WHERE id = $1`,
  deleteUserSessions: `DELETE FROM user_sessions WHERE user_id = $1`,
  deleteOtherSessions: `DELETE FROM user_sessions WHERE user_id = $1 AND id != $2`,
  deleteExpiredSessions: `DELETE FROM user_sessions WHERE expires_at < NOW()`,
  listUserSessions: `SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC`,

  // Email tokens
  insertEmailToken: `INSERT INTO email_tokens (token, user_id, token_type, expires_at)
    VALUES ($1, $2, $3, NOW() + $4::INTERVAL) RETURNING *`,
  getEmailToken: `SELECT * FROM email_tokens WHERE token = $1 AND token_type = $2 AND used_at IS NULL AND expires_at > NOW()`,
  markTokenUsed: `UPDATE email_tokens SET used_at = NOW() WHERE token = $1`,
  deleteUserTokens: `DELETE FROM email_tokens WHERE user_id = $1 AND token_type = $2`,
};

// ─── Types ──────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  passwordHash: string | null;
  role: Role;
  lockedAt: string | null;
  lockReason: string | null;
  failedLoginCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Public user info (no password hash). */
export interface UserPublic {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  role: Role;
  lockedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserSession {
  id: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

/** Resolved session with joined user data. */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  emailVerified: boolean;
  lockedAt: string | null;
}

export interface EmailToken {
  token: string;
  userId: string;
  tokenType: "verify" | "reset";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
}

export interface SignUpResult {
  user: UserPublic;
  verifyToken: string;
}

export interface SignInResult {
  user: UserPublic;
  sessionToken: string;
}

// ─── Row Mappers ────────────────────────────────────────────────

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    emailVerified: row.email_verified as boolean,
    displayName: row.display_name as string,
    passwordHash: row.password_hash as string | null,
    role: row.role as Role,
    lockedAt: row.locked_at as string | null,
    lockReason: row.lock_reason as string | null,
    failedLoginCount: row.failed_login_count as number,
    lastLoginAt: row.last_login_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function userToPublic(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    role: user.role,
    lockedAt: user.lockedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function rowToSession(row: Record<string, unknown>): UserSession {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    ipAddress: row.ip_address as string | null,
    userAgent: row.user_agent as string | null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    lastSeenAt: row.last_seen_at as string,
  };
}

function rowToResolvedSession(row: Record<string, unknown>): ResolvedSession {
  return {
    sessionId: row.id as string,
    userId: row.user_id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    role: row.role as Role,
    emailVerified: row.email_verified as boolean,
    lockedAt: row.locked_at as string | null,
  };
}

function rowToEmailToken(row: Record<string, unknown>): EmailToken {
  return {
    token: row.token as string,
    userId: row.user_id as string,
    tokenType: row.token_type as "verify" | "reset",
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    usedAt: row.used_at as string | null,
  };
}

/** Generate a cryptographically secure hex token. */
function generateToken(bytes: number = SESSION_TOKEN_BYTES): string {
  return randomBytes(bytes).toString("hex");
}

// ─── Store Interface ────────────────────────────────────────────

export interface UserStore {
  // ── Sign Up ──────────────────────────────────────────────
  signUp(input: SignUpInput): Promise<SignUpResult>;

  // ── Sign In ──────────────────────────────────────────────
  signIn(email: string, password: string, ip?: string, ua?: string): Promise<SignInResult>;

  // ── Session Management ───────────────────────────────────
  resolveSession(sessionToken: string): Promise<ResolvedSession | null>;
  touchSession(sessionToken: string): Promise<void>;
  destroySession(sessionToken: string): Promise<void>;
  destroyAllSessions(userId: string): Promise<void>;
  destroyOtherSessions(userId: string, keepSessionId: string): Promise<void>;
  listUserSessions(userId: string): Promise<UserSession[]>;

  // ── Email Verification ───────────────────────────────────
  verifyEmail(token: string): Promise<boolean>;
  createVerifyToken(userId: string): Promise<string>;

  // ── Password Reset ───────────────────────────────────────
  createResetToken(email: string): Promise<string | null>;
  resetPassword(token: string, newPassword: string): Promise<boolean>;

  // ── Password Change ──────────────────────────────────────
  changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId: string): Promise<boolean>;

  // ── User Management (Admiral) ────────────────────────────
  getUser(userId: string): Promise<UserPublic | null>;
  getUserByEmail(email: string): Promise<UserPublic | null>;
  listUsers(): Promise<UserPublic[]>;
  setRole(userId: string, role: Role): Promise<UserPublic | null>;
  lockUser(userId: string, reason?: string): Promise<boolean>;
  unlockUser(userId: string): Promise<boolean>;
  deleteUser(userId: string): Promise<boolean>;
  countUsers(): Promise<number>;

  // ── Lifecycle ────────────────────────────────────────────
  close(): void;
}

// ─── Factory ────────────────────────────────────────────────────

export async function createUserStore(pool: Pool): Promise<UserStore> {
  await initSchema(pool, SCHEMA_STATEMENTS);

  log.fleet.debug("user store initialized (pg)");

  const store: UserStore = {
    // ── Sign Up ────────────────────────────────────────────
    async signUp(input: SignUpInput): Promise<SignUpResult> {
      // Validate password
      const passwordCheck = validatePassword(input.password);
      if (!passwordCheck.valid) {
        throw new Error(passwordCheck.reason!);
      }

      // Validate email format (basic)
      const emailTrimmed = input.email.trim().toLowerCase();
      if (!emailTrimmed || !emailTrimmed.includes("@") || emailTrimmed.length > 254) {
        throw new Error("Invalid email address");
      }

      // Validate display name
      const displayName = input.displayName.trim();
      if (!displayName || displayName.length > 100) {
        throw new Error("Display name must be 1–100 characters");
      }

      // Check for existing user
      const existing = await pool.query(SQL.getUserByEmail, [emailTrimmed]);
      if (existing.rows.length > 0) {
        // Generic error — don't reveal if email exists
        throw new Error("Unable to create account");
      }

      // Hash password
      const hash = await hashPassword(input.password);
      const userId = randomUUID();

      // Insert user
      const res = await pool.query(SQL.insertUser, [
        userId, emailTrimmed, displayName, hash, "ensign", false,
      ]);
      const user = rowToUser(res.rows[0] as Record<string, unknown>);

      // Create email verification token
      const verifyToken = generateToken();
      await pool.query(SQL.deleteUserTokens, [userId, "verify"]);
      await pool.query(SQL.insertEmailToken, [
        verifyToken, userId, "verify", `${VERIFY_TOKEN_EXPIRY_HOURS} hours`,
      ]);

      return { user: userToPublic(user), verifyToken };
    },

    // ── Sign In ────────────────────────────────────────────
    async signIn(email: string, password: string, ip?: string, ua?: string): Promise<SignInResult> {
      const emailTrimmed = email.trim().toLowerCase();

      // Always look up user — but also always hash to prevent timing leaks
      const res = await pool.query(SQL.getUserByEmail, [emailTrimmed]);
      const row = res.rows[0] as Record<string, unknown> | undefined;

      if (!row) {
        // Constant-time: hash the password anyway to prevent timing attacks
        await hashPassword(password);
        throw new Error("Invalid email or password");
      }

      const user = rowToUser(row);

      // Check if account is locked
      if (user.lockedAt) {
        const lockTime = new Date(user.lockedAt).getTime();
        const unlockTime = lockTime + LOCKOUT_MINUTES * 60 * 1000;
        if (Date.now() < unlockTime) {
          throw new Error("Account temporarily locked. Try again later.");
        }
        // Lock expired — unlock
        await pool.query(SQL.unlockUser, [user.id]);
      }

      // Verify password
      if (!user.passwordHash) {
        throw new Error("Invalid email or password");
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        // Increment failed login count (may trigger lockout)
        await pool.query(SQL.incrementFailedLogins, [user.id, MAX_FAILED_LOGINS]);
        throw new Error("Invalid email or password");
      }

      // Check email verified
      if (!user.emailVerified) {
        throw new Error("Please verify your email before signing in");
      }

      // Success — update last login, reset failed count
      await pool.query(SQL.updateLastLogin, [user.id]);

      // Create session
      const sessionToken = generateToken();
      await pool.query(SQL.insertSession, [
        sessionToken, user.id, ip ?? null, ua ?? null,
        `${SESSION_EXPIRY_DAYS} days`,
      ]);

      return { user: userToPublic(user), sessionToken };
    },

    // ── Session Management ─────────────────────────────────
    async resolveSession(sessionToken: string): Promise<ResolvedSession | null> {
      const res = await pool.query(SQL.getSession, [sessionToken]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;

      // Check expiry
      const expiresAt = new Date(row.expires_at as string).getTime();
      if (Date.now() > expiresAt) {
        await pool.query(SQL.deleteSession, [sessionToken]);
        return null;
      }

      return rowToResolvedSession(row);
    },

    async touchSession(sessionToken: string): Promise<void> {
      await pool.query(SQL.touchSession, [sessionToken]);
    },

    async destroySession(sessionToken: string): Promise<void> {
      await pool.query(SQL.deleteSession, [sessionToken]);
    },

    async destroyAllSessions(userId: string): Promise<void> {
      await pool.query(SQL.deleteUserSessions, [userId]);
    },

    async destroyOtherSessions(userId: string, keepSessionId: string): Promise<void> {
      await pool.query(SQL.deleteOtherSessions, [userId, keepSessionId]);
    },

    async listUserSessions(userId: string): Promise<UserSession[]> {
      const res = await pool.query(SQL.listUserSessions, [userId]);
      return (res.rows as Record<string, unknown>[]).map(rowToSession);
    },

    // ── Email Verification ─────────────────────────────────
    async verifyEmail(token: string): Promise<boolean> {
      const res = await pool.query(SQL.getEmailToken, [token, "verify"]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return false;

      const emailToken = rowToEmailToken(row);

      // Mark token as used
      await pool.query(SQL.markTokenUsed, [token]);

      // Set email_verified = true
      await pool.query(SQL.verifyEmail, [emailToken.userId]);

      return true;
    },

    async createVerifyToken(userId: string): Promise<string> {
      const token = generateToken();
      await pool.query(SQL.deleteUserTokens, [userId, "verify"]);
      await pool.query(SQL.insertEmailToken, [
        token, userId, "verify", `${VERIFY_TOKEN_EXPIRY_HOURS} hours`,
      ]);
      return token;
    },

    // ── Password Reset ─────────────────────────────────────
    async createResetToken(email: string): Promise<string | null> {
      const emailTrimmed = email.trim().toLowerCase();
      const res = await pool.query(SQL.getUserByEmail, [emailTrimmed]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null; // Don't reveal if email exists

      const user = rowToUser(row);
      if (!user.emailVerified) return null;

      const token = generateToken();
      await pool.query(SQL.deleteUserTokens, [user.id, "reset"]);
      await pool.query(SQL.insertEmailToken, [
        token, user.id, "reset", `${RESET_TOKEN_EXPIRY_HOURS} hours`,
      ]);
      return token;
    },

    async resetPassword(token: string, newPassword: string): Promise<boolean> {
      // Validate new password
      const check = validatePassword(newPassword);
      if (!check.valid) throw new Error(check.reason!);

      // Look up token
      const res = await pool.query(SQL.getEmailToken, [token, "reset"]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return false;

      const emailToken = rowToEmailToken(row);

      // Hash new password and update
      const hash = await hashPassword(newPassword);
      await pool.query(SQL.updatePasswordHash, [emailToken.userId, hash]);
      await pool.query(SQL.markTokenUsed, [token]);

      // Kill all sessions (force re-login)
      await pool.query(SQL.deleteUserSessions, [emailToken.userId]);

      return true;
    },

    // ── Password Change ────────────────────────────────────
    async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId: string): Promise<boolean> {
      // Validate new password
      const check = validatePassword(newPassword);
      if (!check.valid) throw new Error(check.reason!);

      // Get user
      const res = await pool.query(SQL.getUserById, [userId]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return false;

      const user = rowToUser(row);
      if (!user.passwordHash) return false;

      // Verify current password
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) throw new Error("Current password is incorrect");

      // Hash and update
      const hash = await hashPassword(newPassword);
      await pool.query(SQL.updatePasswordHash, [userId, hash]);

      // Kill all OTHER sessions
      await pool.query(SQL.deleteOtherSessions, [userId, keepSessionId]);

      return true;
    },

    // ── User Management (Admiral) ──────────────────────────
    async getUser(userId: string): Promise<UserPublic | null> {
      const res = await pool.query(SQL.getUserById, [userId]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return userToPublic(rowToUser(row));
    },

    async getUserByEmail(email: string): Promise<UserPublic | null> {
      const res = await pool.query(SQL.getUserByEmail, [email.trim().toLowerCase()]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return userToPublic(rowToUser(row));
    },

    async listUsers(): Promise<UserPublic[]> {
      const res = await pool.query(SQL.listUsers);
      return (res.rows as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        email: r.email as string,
        emailVerified: r.email_verified as boolean,
        displayName: r.display_name as string,
        role: r.role as Role,
        lockedAt: r.locked_at as string | null,
        lastLoginAt: r.last_login_at as string | null,
        createdAt: r.created_at as string,
      }));
    },

    async setRole(userId: string, role: Role): Promise<UserPublic | null> {
      if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
      const res = await pool.query(SQL.updateRole, [userId, role]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return userToPublic(rowToUser(row));
    },

    async lockUser(userId: string, reason?: string): Promise<boolean> {
      const res = await pool.query(SQL.lockUser, [userId, reason || "Locked by administrator"]);
      return (res.rowCount ?? 0) > 0;
    },

    async unlockUser(userId: string): Promise<boolean> {
      const res = await pool.query(SQL.unlockUser, [userId]);
      return (res.rowCount ?? 0) > 0;
    },

    async deleteUser(userId: string): Promise<boolean> {
      // Cascade deletes: sessions, email_tokens, and (Phase 2) all user data
      const res = await pool.query(SQL.deleteUser, [userId]);
      return (res.rowCount ?? 0) > 0;
    },

    async countUsers(): Promise<number> {
      const res = await pool.query(SQL.countUsers);
      return parseInt((res.rows[0] as Record<string, unknown>).count as string, 10);
    },

    // ── Lifecycle ──────────────────────────────────────────
    close() {
      // Pool lifecycle managed externally
    },
  };

  return store;
}
