/**
 * invite-store.ts — Invite Code & Tenant Session Store (ADR-018 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages invite codes (creation, redemption, revocation) and tenant sessions
 * (created on invite redemption, validated on every authenticated request).
 *
 * Migrated to @libsql/client from the start — no better-sqlite3 legacy.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { openDatabase, initSchema, type Client } from "./db.js";
import { log } from "./logger.js";

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    label TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_sessions (
    tenant_id TEXT PRIMARY KEY,
    invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// ─── SQL ────────────────────────────────────────────────────────

const SQL = {
  // Invite codes
  insertCode: `INSERT INTO invite_codes (code, label, max_uses, expires_at) VALUES (?, ?, ?, ?)`,
  getCode: `SELECT * FROM invite_codes WHERE code = ?`,
  listCodes: `SELECT * FROM invite_codes ORDER BY created_at DESC`,
  incrementUses: `UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`,
  revokeCode: `UPDATE invite_codes SET revoked = 1 WHERE code = ?`,
  deleteCode: `DELETE FROM invite_codes WHERE code = ?`,

  // Tenant sessions
  insertSession: `INSERT INTO tenant_sessions (tenant_id, invite_code) VALUES (?, ?)`,
  getSession: `SELECT * FROM tenant_sessions WHERE tenant_id = ?`,
  touchSession: `UPDATE tenant_sessions SET last_seen_at = datetime('now') WHERE tenant_id = ?`,
  listSessions: `SELECT * FROM tenant_sessions ORDER BY last_seen_at DESC`,
  deleteSession: `DELETE FROM tenant_sessions WHERE tenant_id = ?`,
  deleteExpiredSessions: `DELETE FROM tenant_sessions WHERE last_seen_at < datetime('now', ?)`,
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

/** Parse a duration string like "7d", "24h", "30m" into an SQLite modifier string. */
function parseDuration(duration: string): string {
  const match = duration.match(/^(\d+)(d|h|m)$/);
  if (!match) throw new Error(`Invalid duration format: ${duration}. Use "7d", "24h", or "30m".`);
  const [, amount, unit] = match;
  switch (unit) {
    case "d": return `+${amount} days`;
    case "h": return `+${amount} hours`;
    case "m": return `+${amount} minutes`;
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
    revoked: !!(row.revoked as number),
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
  getDbPath(): string;
}

// ─── Factory ────────────────────────────────────────────────────

const DB_FILE = "admin.db";

export async function createInviteStore(dbPath?: string): Promise<InviteStore> {
  const resolvedPath = dbPath || DB_FILE;
  const client = openDatabase(resolvedPath);
  await initSchema(client, SCHEMA_STATEMENTS);

  log.fleet.debug({ dbPath: resolvedPath }, "invite store initialized");

  return {
    async createCode(options?: CreateInviteOptions) {
      const code = generateCode();
      const label = options?.label ?? null;
      const maxUses = options?.maxUses ?? 1;

      // Calculate expiry datetime
      let expiresAt: string | null = null;
      if (options?.expiresIn) {
        const modifier = parseDuration(options.expiresIn);
        const res = await client.execute({
          sql: `SELECT datetime('now', ?) as expires`,
          args: [modifier],
        });
        expiresAt = (res.rows[0] as unknown as { expires: string }).expires;
      }

      await client.execute({ sql: SQL.insertCode, args: [code, label, maxUses, expiresAt] });
      return (await this.getCode(code))!;
    },

    async getCode(code: string) {
      const res = await client.execute({ sql: SQL.getCode, args: [code] });
      const row = res.rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? rowToInvite(row) : null;
    },

    async listCodes() {
      const res = await client.execute(SQL.listCodes);
      return (res.rows as unknown as Record<string, unknown>[]).map(rowToInvite);
    },

    async revokeCode(code: string) {
      const res = await client.execute({ sql: SQL.revokeCode, args: [code] });
      return res.rowsAffected > 0;
    },

    async deleteCode(code: string) {
      const res = await client.execute({ sql: SQL.deleteCode, args: [code] });
      return res.rowsAffected > 0;
    },

    async redeemCode(code: string) {
      const invite = await this.getCode(code);
      if (!invite) throw new Error("Invalid invite code");
      if (invite.revoked) throw new Error("Invite code has been revoked");
      if (invite.usedCount >= invite.maxUses) throw new Error("Invite code has been fully used");
      if (invite.expiresAt && new Date(invite.expiresAt + "Z") < new Date()) {
        throw new Error("Invite code has expired");
      }

      // Increment use count
      await client.execute({ sql: SQL.incrementUses, args: [code] });

      // Create tenant session
      const tenantId = randomUUID();
      await client.execute({ sql: SQL.insertSession, args: [tenantId, code] });

      return (await this.getSession(tenantId))!;
    },

    async getSession(tenantId: string) {
      const res = await client.execute({ sql: SQL.getSession, args: [tenantId] });
      const row = res.rows[0] as unknown as Record<string, unknown> | undefined;
      return row ? rowToSession(row) : null;
    },

    async touchSession(tenantId: string) {
      await client.execute({ sql: SQL.touchSession, args: [tenantId] });
    },

    async listSessions() {
      const res = await client.execute(SQL.listSessions);
      return (res.rows as unknown as Record<string, unknown>[]).map(rowToSession);
    },

    async deleteSession(tenantId: string) {
      const res = await client.execute({ sql: SQL.deleteSession, args: [tenantId] });
      return res.rowsAffected > 0;
    },

    close() {
      client.close();
    },

    getDbPath() {
      return resolvedPath;
    },
  };
}
