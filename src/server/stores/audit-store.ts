/**
 * audit-store.ts — Auth Audit Log Store (#91 Phase A)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Append-only audit log for all authentication & authorization events.
 * Used for SOC2 compliance, security forensics, and GCP Cloud Logging integration.
 *
 * Table: auth_audit_log
 *   - Append-only (no UPDATE/DELETE by design)
 *   - Not RLS-scoped — Admiral can read all entries
 *   - Indexed by actor_id, event_type, and timestamp for forensic queries
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Event Types ────────────────────────────────────────────────

/**
 * Exhaustive list of auditable events.
 * Each category groups related actions for filtering.
 */
export const AUDIT_EVENTS = [
  // Authentication
  "auth.signup",
  "auth.signin.success",
  "auth.signin.failure",
  "auth.logout",
  "auth.logout_all",

  // Email verification
  "auth.verify_email",

  // Password
  "auth.password.change",
  "auth.password.reset_request",
  "auth.password.reset_complete",

  // Session
  "auth.session.expired_cleanup",

  // Account management (Admiral)
  "admin.role_change",
  "admin.lock_user",
  "admin.unlock_user",
  "admin.delete_user",

  // Legacy
  "auth.invite.redeem",
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS auth_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    event_type  TEXT NOT NULL,
    actor_id    UUID,
    target_id   UUID,
    ip_address  INET,
    user_agent  TEXT,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Query patterns: "what happened to user X?", "who did what when?"
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON auth_audit_log (actor_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON auth_audit_log (target_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_event_type ON auth_audit_log (event_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created_at ON auth_audit_log (created_at DESC)`,
];

// ─── SQL ────────────────────────────────────────────────────────

const SQL = {
  insert: `INSERT INTO auth_audit_log (event_type, actor_id, target_id, ip_address, user_agent, detail)
    VALUES ($1, $2, $3, $4, $5, $6)`,

  queryByActor: `SELECT * FROM auth_audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT $2`,

  queryByTarget: `SELECT * FROM auth_audit_log WHERE target_id = $1 ORDER BY created_at DESC LIMIT $2`,

  queryByEvent: `SELECT * FROM auth_audit_log WHERE event_type = $1 ORDER BY created_at DESC LIMIT $2`,

  queryRecent: `SELECT * FROM auth_audit_log ORDER BY created_at DESC LIMIT $1`,

  countByEvent: `SELECT event_type, COUNT(*) as count FROM auth_audit_log GROUP BY event_type ORDER BY count DESC`,
};

// ─── Types ──────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  eventType: AuditEvent;
  actorId: string | null;
  targetId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogInput {
  /** The type of event being logged. */
  event: AuditEvent;
  /** The user who performed the action (null for anonymous actions like failed sign-in). */
  actorId?: string | null;
  /** The user affected by the action (e.g., target of role change). */
  targetId?: string | null;
  /** Client IP address. */
  ip?: string | null;
  /** Client user agent string. */
  userAgent?: string | null;
  /** Arbitrary structured metadata (e.g., { oldRole, newRole }). NEVER include secrets/passwords. */
  detail?: Record<string, unknown> | null;
}

export interface AuditStore {
  /** Append an audit entry. Fire-and-forget safe — errors are logged, not thrown. */
  logEvent(input: AuditLogInput): Promise<void>;

  /** Query audit entries by the actor who performed the action. */
  queryByActor(actorId: string, limit?: number): Promise<AuditEntry[]>;

  /** Query audit entries by the target user affected. */
  queryByTarget(targetId: string, limit?: number): Promise<AuditEntry[]>;

  /** Query audit entries by event type. */
  queryByEvent(event: AuditEvent, limit?: number): Promise<AuditEntry[]>;

  /** Query most recent audit entries. */
  queryRecent(limit?: number): Promise<AuditEntry[]>;

  /** Get event counts grouped by event type. */
  eventCounts(): Promise<Array<{ eventType: string; count: number }>>;
}

// ─── Row Mapping ────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    eventType: row.event_type as AuditEvent,
    actorId: (row.actor_id as string) ?? null,
    targetId: (row.target_id as string) ?? null,
    ipAddress: (row.ip_address as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
    detail: (row.detail as Record<string, unknown>) ?? null,
    createdAt: String(row.created_at),
  };
}

// ─── Factory ────────────────────────────────────────────────────

export async function createAuditStore(adminPool: Pool, runtimePool?: Pool): Promise<AuditStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.auth.debug("audit store initialized (pg)");

  const store: AuditStore = {
    async logEvent(input: AuditLogInput): Promise<void> {
      try {
        await pool.query(SQL.insert, [
          input.event,
          input.actorId ?? null,
          input.targetId ?? null,
          input.ip ?? null,
          input.userAgent ?? null,
          input.detail ? JSON.stringify(input.detail) : null,
        ]);

        // Structured log for GCP Cloud Logging pickup.
        // Fields: component, event, userId, ip — matches Phase E spec.
        log.auth.info(
          {
            component: "auth",
            event: input.event,
            userId: input.actorId ?? undefined,
            targetId: input.targetId ?? undefined,
            ip: input.ip ?? undefined,
            ...(input.detail ? { detail: input.detail } : {}),
          },
          `audit: ${input.event}`,
        );
      } catch (err) {
        // Audit logging must NEVER block the caller — log and swallow
        log.auth.error({ err, event: input.event }, "audit log write failed");
      }
    },

    async queryByActor(actorId: string, limit = 100): Promise<AuditEntry[]> {
      const result = await pool.query(SQL.queryByActor, [actorId, limit]);
      return result.rows.map(rowToEntry);
    },

    async queryByTarget(targetId: string, limit = 100): Promise<AuditEntry[]> {
      const result = await pool.query(SQL.queryByTarget, [targetId, limit]);
      return result.rows.map(rowToEntry);
    },

    async queryByEvent(event: AuditEvent, limit = 100): Promise<AuditEntry[]> {
      const result = await pool.query(SQL.queryByEvent, [event, limit]);
      return result.rows.map(rowToEntry);
    },

    async queryRecent(limit = 100): Promise<AuditEntry[]> {
      const result = await pool.query(SQL.queryRecent, [limit]);
      return result.rows.map(rowToEntry);
    },

    async eventCounts(): Promise<Array<{ eventType: string; count: number }>> {
      const result = await pool.query(SQL.countByEvent);
      return result.rows.map((r: Record<string, unknown>) => ({
        eventType: String(r.event_type),
        count: Number(r.count),
      }));
    },
  };

  return store;
}
