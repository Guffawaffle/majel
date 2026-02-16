/**
 * invite-store.ts — Invite Code & Tenant Session Store (ADR-018 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages invite codes (creation, redemption, revocation) and tenant sessions
 * (created on invite redemption, validated on every authenticated request).
 *
 * Migrated to PostgreSQL in ADR-018 Phase 3.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    label TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_sessions (
    tenant_id TEXT PRIMARY KEY,
    invite_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// ─── SQL ────────────────────────────────────────────────────────

const SQL = {
  // Invite codes
  insertCode: `INSERT INTO invite_codes (code, label, max_uses, expires_at) VALUES ($1, $2, $3, $4)`,
  getCode: `SELECT * FROM invite_codes WHERE code = $1`,
  listCodes: `SELECT * FROM invite_codes ORDER BY created_at DESC`,
  incrementUses: `UPDATE invite_codes SET used_count = used_count + 1
    WHERE code = $1 AND revoked = FALSE AND used_count < max_uses
    AND (expires_at IS NULL OR expires_at > NOW())
    RETURNING *`,
  revokeCode: `UPDATE invite_codes SET revoked = TRUE WHERE code = $1`,
  deleteCode: `DELETE FROM invite_codes WHERE code = $1`,

  // Tenant sessions
  insertSession: `INSERT INTO tenant_sessions (tenant_id, invite_code) VALUES ($1, $2)`,
  getSession: `SELECT * FROM tenant_sessions WHERE tenant_id = $1`,
  touchSession: `UPDATE tenant_sessions SET last_seen_at = NOW() WHERE tenant_id = $1`,
  listSessions: `SELECT * FROM tenant_sessions ORDER BY last_seen_at DESC`,
  deleteSession: `DELETE FROM tenant_sessions WHERE tenant_id = $1`,
  deleteExpiredSessions: `DELETE FROM tenant_sessions WHERE last_seen_at < NOW() - $1::INTERVAL`,
};

// ─── Types ──────────────────────────────────────────────────────

export interface InviteCode {
  code: string;
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export interface TenantSession {
  tenantId: string;
  inviteCode: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface CreateInviteOptions {
  label?: string;
  maxUses?: number;
  /** Expiry duration like "7d", "24h", "30m" */
  expiresIn?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Generate a URL-safe invite code: MAJEL-XXXX-XXXX */
function generateCode(): string {
  const bytes = randomBytes(6);
  const hex = bytes.toString("hex").toUpperCase();
  return `MAJEL-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/** Parse a duration string like "7d", "24h", "30m" into a PostgreSQL interval string. */
function parseDuration(duration: string): string {
  const match = duration.match(/^(\d+)(d|h|m)$/);
  if (!match) throw new Error(`Invalid duration format: ${duration}. Use "7d", "24h", or "30m".`);
  const [, amount, unit] = match;
  switch (unit) {
    case "d": return `${amount} days`;
    case "h": return `${amount} hours`;
    case "m": return `${amount} minutes`;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/** Convert a DB row to an InviteCode. */
function rowToInvite(row: Record<string, unknown>): InviteCode {
  return {
    code: row.code as string,
    label: row.label as string | null,
    maxUses: row.max_uses as number,
    usedCount: row.used_count as number,
    expiresAt: row.expires_at as string | null,
    createdAt: row.created_at as string,
    revoked: row.revoked as boolean,
  };
}

/** Convert a DB row to a TenantSession. */
function rowToSession(row: Record<string, unknown>): TenantSession {
  return {
    tenantId: row.tenant_id as string,
    inviteCode: row.invite_code as string | null,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
  };
}

// ─── Store Interface ────────────────────────────────────────────

export interface InviteStore {
  // Invite codes
  createCode(options?: CreateInviteOptions): Promise<InviteCode>;
  getCode(code: string): Promise<InviteCode | null>;
  listCodes(): Promise<InviteCode[]>;
  revokeCode(code: string): Promise<boolean>;
  deleteCode(code: string): Promise<boolean>;

  // Redeem flow
  redeemCode(code: string): Promise<TenantSession>;

  // Tenant sessions
  getSession(tenantId: string): Promise<TenantSession | null>;
  touchSession(tenantId: string): Promise<void>;
  listSessions(): Promise<TenantSession[]>;
  deleteSession(tenantId: string): Promise<boolean>;

  // Lifecycle
  close(): void;
}

// ─── Factory ────────────────────────────────────────────────────

export async function createInviteStore(adminPool: Pool, runtimePool?: Pool): Promise<InviteStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.fleet.debug("invite store initialized (pg)");

  const store: InviteStore = {
    async createCode(options?: CreateInviteOptions) {
      const code = generateCode();
      const label = options?.label ?? null;
      const maxUses = options?.maxUses ?? 1;

      // Calculate expiry datetime
      let expiresAt: string | null = null;
      if (options?.expiresIn) {
        const interval = parseDuration(options.expiresIn);
        const res = await pool.query(
          `SELECT (NOW() + $1::INTERVAL) as expires`,
          [interval],
        );
        expiresAt = (res.rows[0] as { expires: string }).expires;
      }

      await pool.query(SQL.insertCode, [code, label, maxUses, expiresAt]);
      return (await store.getCode(code))!;
    },

    async getCode(code: string) {
      const res = await pool.query(SQL.getCode, [code]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToInvite(row) : null;
    },

    async listCodes() {
      const res = await pool.query(SQL.listCodes);
      return (res.rows as Record<string, unknown>[]).map(rowToInvite);
    },

    async revokeCode(code: string) {
      const res = await pool.query(SQL.revokeCode, [code]);
      return (res.rowCount ?? 0) > 0;
    },

    async deleteCode(code: string) {
      const res = await pool.query(SQL.deleteCode, [code]);
      return (res.rowCount ?? 0) > 0;
    },

    async redeemCode(code: string) {
      // Atomic check-and-increment: prevents TOCTOU race on concurrent redemption.
      // The WHERE clause enforces all validity checks in a single UPDATE.
      const result = await pool.query(SQL.incrementUses, [code]);
      if ((result.rowCount ?? 0) === 0) {
        // Determine specific failure reason for user-facing error
        const invite = await store.getCode(code);
        if (!invite) throw new Error("Invalid invite code");
        if (invite.revoked) throw new Error("Invite code has been revoked");
        if (invite.usedCount >= invite.maxUses) throw new Error("Invite code has been fully used");
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
          throw new Error("Invite code has expired");
        }
        throw new Error("Invalid invite code");
      }

      // Create tenant session
      const tenantId = randomUUID();
      await pool.query(SQL.insertSession, [tenantId, code]);

      return (await store.getSession(tenantId))!;
    },

    async getSession(tenantId: string) {
      const res = await pool.query(SQL.getSession, [tenantId]);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToSession(row) : null;
    },

    async touchSession(tenantId: string) {
      await pool.query(SQL.touchSession, [tenantId]);
    },

    async listSessions() {
      const res = await pool.query(SQL.listSessions);
      return (res.rows as Record<string, unknown>[]).map(rowToSession);
    },

    async deleteSession(tenantId: string) {
      const res = await pool.query(SQL.deleteSession, [tenantId]);
      return (res.rowCount ?? 0) > 0;
    },

    close() {
      // Pool lifecycle managed externally
    },
  };

  return store;
}
