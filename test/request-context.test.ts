/**
 * request-context.test.ts — Tests for RequestContext, DbScope, QueryExecutor (ADR-039)
 *
 * Tests cover:
 *   - RequestContext construction and immutability
 *   - readScope / writeScope transaction semantics
 *   - DbScope RLS tenant isolation via SET LOCAL
 *   - QueryExecutor interface compliance (Pool + DbScope)
 *   - TestContextBuilder
 *   - AsyncLocalStorage correlation (context-store)
 *   - Context middleware
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, type Pool } from "./helpers/pg-test.js";
import {
  RequestContext,
  type QueryExecutor,
  type RequestIdentity,
} from "../src/server/request-context.js";
import { TestContextBuilder } from "../src/server/test-context-builder.js";
import { runWithContext, getRequestContext } from "../src/server/context-store.js";
import pino from "pino";

// ─── Shared Test Pool ───────────────────────────────────────────

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

// ─── Helpers ────────────────────────────────────────────────────

function silentLog() {
  return pino({ level: "silent" });
}

function makeCtx(overrides: Partial<RequestIdentity> = {}): RequestContext {
  return new RequestContext({
    identity: {
      requestId: "test-req-1",
      userId: "user-abc",
      tenantId: "user-abc",
      roles: ["ensign"],
      ...overrides,
    },
    log: silentLog(),
    pool,
  });
}

// ═══════════════════════════════════════════════════════════
// RequestContext
// ═══════════════════════════════════════════════════════════

describe("RequestContext", () => {
  it("freezes identity at construction", () => {
    const ctx = makeCtx();
    expect(Object.isFrozen(ctx.identity)).toBe(true);
    expect(Object.isFrozen(ctx.identity.roles)).toBe(true);
  });

  it("cannot mutate identity fields", () => {
    const ctx = makeCtx();
    // TypeScript readonly + Object.freeze — runtime mutation throws in strict mode
    expect(() => {
      (ctx.identity as Record<string, unknown>).userId = "hacked";
    }).toThrow();
  });

  it("hasRole returns true for matching role", () => {
    const ctx = makeCtx({ roles: ["lieutenant", "admiral"] });
    expect(ctx.hasRole("admiral")).toBe(true);
    expect(ctx.hasRole("lieutenant")).toBe(true);
  });

  it("hasRole returns false for non-matching role", () => {
    const ctx = makeCtx({ roles: ["ensign"] });
    expect(ctx.hasRole("admiral")).toBe(false);
  });

  it("elapsed returns positive milliseconds", async () => {
    const ctx = makeCtx();
    // Wait a tiny bit so there's measurable elapsed time
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ctx.elapsed()).toBeGreaterThan(0);
  });

  it("sets startedAtMs from performance.now() by default", () => {
    const before = performance.now();
    const ctx = makeCtx();
    const after = performance.now();
    expect(ctx.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(ctx.startedAtMs).toBeLessThanOrEqual(after);
  });

  it("accepts explicit startedAtMs", () => {
    const ctx = new RequestContext({
      identity: { requestId: "r", userId: "u", tenantId: "u", roles: [] },
      log: silentLog(),
      pool,
      startedAtMs: 12345,
    });
    expect(ctx.startedAtMs).toBe(12345);
  });

  it("sets ISO timestamp", () => {
    const ctx = makeCtx();
    expect(ctx.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ═══════════════════════════════════════════════════════════
// readScope / writeScope — Transaction Semantics
// ═══════════════════════════════════════════════════════════

describe("readScope", () => {
  it("executes a read-only query successfully", async () => {
    const ctx = makeCtx();
    const result = await ctx.readScope(async (db) => {
      return db.query("SELECT 1 AS val");
    });
    expect(result.rows[0].val).toBe(1);
  });

  it("sets tenant identity via SET LOCAL", async () => {
    const ctx = makeCtx({ tenantId: "tenant-xyz" });
    await ctx.readScope(async (db) => {
      const result = await db.query(
        "SELECT current_setting('app.current_user_id', true) AS uid",
      );
      expect(result.rows[0].uid).toBe("tenant-xyz");
    });
  });

  it("tenant identity is cleared after scope exits", async () => {
    const ctx = makeCtx({ tenantId: "tenant-scope-test" });
    await ctx.readScope(async (db) => {
      await db.query("SELECT 1");
    });

    // After the scope exits, the pool client is released and the transaction
    // is committed — SET LOCAL is automatically cleared
    const directResult = await pool.query(
      "SELECT current_setting('app.current_user_id', true) AS uid",
    );
    // Should be empty string (no session var set outside a scope)
    expect(directResult.rows[0].uid).toBe("");
  });

  it("rolls back on error", async () => {
    const ctx = makeCtx();
    await expect(
      ctx.readScope(async () => {
        throw new Error("deliberate test error");
      }),
    ).rejects.toThrow("deliberate test error");
  });

  it("provides a DbScope that implements QueryExecutor", async () => {
    const ctx = makeCtx();
    await ctx.readScope(async (db) => {
      // Type-level check: DbScope satisfies QueryExecutor
      const executor: QueryExecutor = db;
      const result = await executor.query("SELECT 42 AS answer");
      expect(result.rows[0].answer).toBe(42);
    });
  });

  it("DbScope has back-reference to ctx", async () => {
    const ctx = makeCtx({ requestId: "back-ref-test" });
    await ctx.readScope(async (db) => {
      expect(db.ctx).toBe(ctx);
      expect(db.ctx.identity.requestId).toBe("back-ref-test");
    });
  });
});

describe("writeScope", () => {
  beforeEach(async () => {
    // Ensure clean table for write tests
    await pool.query("CREATE TABLE IF NOT EXISTS _test_write_scope (id SERIAL, val TEXT)");
    await pool.query("TRUNCATE TABLE _test_write_scope RESTART IDENTITY");
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS _test_write_scope");
  });

  it("commits a write on success", async () => {
    const ctx = makeCtx();
    await ctx.writeScope(async (db) => {
      await db.query("INSERT INTO _test_write_scope (val) VALUES ($1)", ["committed"]);
    });

    // Verify the write persisted
    const result = await pool.query("SELECT val FROM _test_write_scope");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].val).toBe("committed");
  });

  it("rolls back a write on error", async () => {
    const ctx = makeCtx();
    await expect(
      ctx.writeScope(async (db) => {
        await db.query("INSERT INTO _test_write_scope (val) VALUES ($1)", ["rolled-back"]);
        throw new Error("deliberate rollback test");
      }),
    ).rejects.toThrow("deliberate rollback test");

    // Verify the write was rolled back
    const result = await pool.query("SELECT val FROM _test_write_scope");
    expect(result.rows).toHaveLength(0);
  });

  it("sets tenant identity via SET LOCAL", async () => {
    const ctx = makeCtx({ tenantId: "write-tenant-456" });
    await ctx.writeScope(async (db) => {
      const result = await db.query(
        "SELECT current_setting('app.current_user_id', true) AS uid",
      );
      expect(result.rows[0].uid).toBe("write-tenant-456");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// QueryExecutor — Interface Compliance
// ═══════════════════════════════════════════════════════════

describe("QueryExecutor", () => {
  it("Pool satisfies QueryExecutor interface", async () => {
    // Pool has a .query() method — this is a compile-time + runtime check
    const executor: QueryExecutor = pool;
    const result = await executor.query("SELECT 1 AS one");
    expect(result.rows[0].one).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// TestContextBuilder
// ═══════════════════════════════════════════════════════════

describe("TestContextBuilder", () => {
  it("builds a RequestContext with defaults", () => {
    const ctx = new TestContextBuilder().withPool(pool).build();
    expect(ctx.identity.userId).toBe("test-user");
    expect(ctx.identity.tenantId).toBe("test-user");
    expect(ctx.identity.roles).toEqual(["ensign"]);
    expect(ctx.identity.requestId).toMatch(/^test-request-/);
  });

  it("allows user override", () => {
    const ctx = new TestContextBuilder()
      .withUser("admiral-1")
      .withPool(pool)
      .build();
    expect(ctx.identity.userId).toBe("admiral-1");
    expect(ctx.identity.tenantId).toBe("admiral-1");
  });

  it("allows tenant override independently from user", () => {
    const ctx = new TestContextBuilder()
      .withUser("user-1")
      .withTenant("org-tenant-1")
      .withPool(pool)
      .build();
    expect(ctx.identity.userId).toBe("user-1");
    expect(ctx.identity.tenantId).toBe("org-tenant-1");
  });

  it("allows role override", () => {
    const ctx = new TestContextBuilder()
      .withRoles("admiral", "captain")
      .withPool(pool)
      .build();
    expect(ctx.identity.roles).toEqual(["admiral", "captain"]);
  });

  it("throws when pool is not provided", () => {
    expect(() => new TestContextBuilder().build()).toThrow(
      "pool is required",
    );
  });

  it("generates unique requestIds", () => {
    const ctx1 = new TestContextBuilder().withPool(pool).build();
    const ctx2 = new TestContextBuilder().withPool(pool).build();
    expect(ctx1.identity.requestId).not.toBe(ctx2.identity.requestId);
  });

  it("built context can execute readScope", async () => {
    const ctx = new TestContextBuilder().withPool(pool).build();
    const result = await ctx.readScope(async (db) => {
      return db.query("SELECT 1 AS val");
    });
    expect(result.rows[0].val).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// AsyncLocalStorage — Context Store
// ═══════════════════════════════════════════════════════════

describe("context-store", () => {
  it("returns undefined outside request scope", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("returns the context inside runWithContext", () => {
    const ctx = makeCtx({ requestId: "als-test" });
    runWithContext(ctx, () => {
      const stored = getRequestContext();
      expect(stored).toBe(ctx);
      expect(stored?.identity.requestId).toBe("als-test");
    });
  });

  it("returns undefined after runWithContext exits", () => {
    const ctx = makeCtx();
    runWithContext(ctx, () => {
      // inside — context exists
      expect(getRequestContext()).toBe(ctx);
    });
    // outside — context gone
    expect(getRequestContext()).toBeUndefined();
  });

  it("nests correctly with separate contexts", () => {
    const outer = makeCtx({ requestId: "outer" });
    const inner = makeCtx({ requestId: "inner" });

    runWithContext(outer, () => {
      expect(getRequestContext()?.identity.requestId).toBe("outer");
      runWithContext(inner, () => {
        expect(getRequestContext()?.identity.requestId).toBe("inner");
      });
      // Back to outer after inner exits
      expect(getRequestContext()?.identity.requestId).toBe("outer");
    });
  });

  it("propagates through async operations", async () => {
    const ctx = makeCtx({ requestId: "async-als-test" });
    await new Promise<void>((resolve) => {
      runWithContext(ctx, async () => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 5));
        expect(getRequestContext()?.identity.requestId).toBe("async-als-test");
        resolve();
      });
    });
  });
});
