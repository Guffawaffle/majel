/**
 * request-context.ts — Request Context & Scoped Database Execution (ADR-039)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Three exports:
 *   - RequestContext  — thin, immutable, request-scoped identity + tracing + DB scoping
 *   - DbScope         — short-lived, transaction-scoped query executor with RLS
 *   - QueryExecutor   — interface satisfied by Pool and DbScope (boot/global compatibility)
 *
 * See ADR-039 for design rationale and migration plan.
 */

import type { Pool, PoolClient } from "./db.js";
import type pg from "pg";
import type { Logger } from "pino";

// ─── Public Types ───────────────────────────────────────────────

/**
 * Immutable identity snapshot for a single request.
 * Frozen at construction — never mutated after creation.
 */
export type RequestIdentity = Readonly<{
  requestId: string;
  userId: string;
  /** Tenant isolation key — distinct from userId (may diverge for org tenancy). */
  tenantId: string;
  /** Role list for RBAC checks. e.g. ["ensign"], ["admiral"] */
  roles: readonly string[];
}>;

/**
 * Minimal query interface satisfied by both Pool (boot-time) and DbScope (request-time).
 * Global/reference stores accept this — agnostic to caller context.
 */
export interface QueryExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

// ─── ScopeProvider ──────────────────────────────────────────────

/**
 * Abstraction over read/write scope creation.
 *
 * Stores accept a ScopeProvider instead of a raw pool — the provider handles
 * transaction boundaries and RLS setup. Two implementations:
 *   - Legacy: wraps withUserScope/withUserRead (pool + userId closure)
 *   - New:    wraps RequestContext.readScope/writeScope (DbScope-backed)
 *
 * Phase 9 removes the legacy path.
 */
export interface ScopeProvider {
  read<T>(fn: (db: QueryExecutor) => Promise<T>): Promise<T>;
  write<T>(fn: (db: QueryExecutor) => Promise<T>): Promise<T>;
}

// ─── DbScope ────────────────────────────────────────────────────

/**
 * Transaction-scoped query executor with RLS identity set via SET LOCAL.
 *
 * Created by RequestContext.readScope() or writeScope(). Dies when the scope
 * callback returns. The transaction boundary guarantees tenant isolation —
 * SET LOCAL is automatically cleared on COMMIT/ROLLBACK.
 *
 * Not constructed directly — use ctx.readScope() or ctx.writeScope().
 */
export class DbScope implements QueryExecutor {
  /** Back-reference for logging/correlation inside scoped operations. */
  readonly ctx: RequestContext;
  private readonly client: PoolClient;

  /** @internal — constructed by RequestContext scope methods. */
  constructor(ctx: RequestContext, client: PoolClient) {
    this.ctx = ctx;
    this.client = client;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    return this.client.query<T>(text, params);
  }
}

// ─── RequestContext ─────────────────────────────────────────────

/**
 * Thin, immutable, request-scoped context.
 *
 * Created once per HTTP request by createRequestContext() middleware.
 * All fields are readonly — no mutations after construction.
 *
 * Provides readScope() and writeScope() for transaction-scoped DB access
 * with automatic RLS tenant isolation via SET LOCAL.
 *
 * NOT created for:
 * - Boot-time operations (migrations, seeding, reference ingest)
 * - Background jobs that outlive requests
 */
export class RequestContext {
  readonly identity: RequestIdentity;
  /** Monotonic timestamp for latency measurement. */
  readonly startedAtMs: number;
  /** ISO 8601 wall-clock timestamp for logs/audit. */
  readonly timestamp: string;
  /** Child logger with userId + requestId baked in. */
  readonly log: Logger;
  /** Reference to app-level pool (not owned — do not close). */
  readonly pool: Pool;

  constructor(opts: {
    identity: RequestIdentity;
    log: Logger;
    pool: Pool;
    startedAtMs?: number;
    timestamp?: string;
  }) {
    this.identity = Object.freeze({ ...opts.identity, roles: Object.freeze([...opts.identity.roles]) });
    this.log = opts.log;
    this.pool = opts.pool;
    this.startedAtMs = opts.startedAtMs ?? performance.now();
    this.timestamp = opts.timestamp ?? new Date().toISOString();
  }

  /** Check if the identity holds a specific role. */
  hasRole(role: string): boolean {
    return this.identity.roles.includes(role);
  }

  /** Milliseconds elapsed since this context was created. */
  elapsed(): number {
    return performance.now() - this.startedAtMs;
  }

  /**
   * Execute a read-only callback within a single transaction.
   *
   * Flow: checkout → BEGIN READ ONLY → SET LOCAL tenant → callback → COMMIT → release.
   * All queries inside the callback serialize on one client (pool-safe).
   */
  async readScope<T>(fn: (db: DbScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [this.identity.tenantId],
      );
      const db = new DbScope(this, client);
      const result = await fn(db);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a read-write callback within a transaction.
   *
   * Flow: checkout → BEGIN → SET LOCAL tenant → callback → COMMIT/ROLLBACK → release.
   * SET LOCAL dies with the transaction — no cleanup needed.
   */
  async writeScope<T>(fn: (db: DbScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [this.identity.tenantId],
      );
      const db = new DbScope(this, client);
      const result = await fn(db);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

// ─── Scope Helpers ──────────────────────────────────────────────

/** Create a ScopeProvider backed by a RequestContext's readScope/writeScope. */
export function scopeFromContext(ctx: RequestContext): ScopeProvider {
  return {
    read: (fn) => ctx.readScope(fn),
    write: (fn) => ctx.writeScope(fn),
  };
}

/**
 * Create a ScopeProvider backed by a raw pool + userId.
 *
 * Used by store factory `.forUser(userId)` when no RequestContext is available
 * (e.g. singleton initialization, test helpers, toolContextFactory).
 * Scopes are transaction-wrapped with SET LOCAL for RLS — same guarantees as
 * RequestContext.readScope/writeScope.
 */
export function scopeFromPool(pool: Pool, userId: string): ScopeProvider {
  return {
    async read<T>(fn: (db: QueryExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async write<T>(fn: (db: QueryExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
