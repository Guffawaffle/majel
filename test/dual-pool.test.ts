/**
 * dual-pool.test.ts — Non-superuser role + dual-pool integration tests (#39)
 *
 * Verifies that:
 * 1. ensureAppRole() creates the majel_app role idempotently
 * 2. Store factories accept dual pools (admin for DDL, app for queries)
 * 3. RLS is enforced on the app pool (superuser bypass eliminated)
 * 4. All DML operations work through the non-superuser pool
 *
 * Tests run against a real PostgreSQL instance (docker-compose).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool, ensureAppRole, type Pool } from "../src/server/db.js";
import { createTestPool, cleanDatabase } from "./helpers/pg-test.js";
import { createSettingsStore } from "../src/server/stores/settings.js";
import { createBehaviorStore } from "../src/server/stores/behavior-store.js";
import {
  createFrameStoreFactory,
} from "../src/server/stores/postgres-frame-store.js";
import type { Frame } from "@smartergpt/lex/store";

// ─── Setup ──────────────────────────────────────────────────────

const APP_ROLE = "majel_app";
const APP_PASSWORD = "majel_app";
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";
const APP_DB_URL = TEST_DB_URL.replace(
  /postgres:\/\/[^@]+@/,
  `postgres://${APP_ROLE}:${APP_PASSWORD}@`,
);

let adminPool: Pool;
let appPool: Pool;

beforeAll(async () => {
  adminPool = createTestPool();
  await cleanDatabase(adminPool);
  await ensureAppRole(adminPool);
  appPool = createPool(APP_DB_URL);
});

afterAll(async () => {
  await appPool.end();
  await adminPool.end();
});

// ─── ensureAppRole ──────────────────────────────────────────────

describe("ensureAppRole", () => {
  it("creates the majel_app role", async () => {
    const result = await adminPool.query(
      "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rolsuper).toBe(false);
    expect(result.rows[0].rolcreatedb).toBe(false);
    expect(result.rows[0].rolcreaterole).toBe(false);
  });

  it("is idempotent — runs twice without error", async () => {
    await expect(ensureAppRole(adminPool)).resolves.not.toThrow();
  });

  it("grants CONNECT to the app role", async () => {
    // If CONNECT were missing, creating a pool would fail
    const testPool = createPool(APP_DB_URL);
    const result = await testPool.query("SELECT 1 AS ok");
    expect(result.rows[0].ok).toBe(1);
    await testPool.end();
  });
});

// ─── Dual-pool store factories ──────────────────────────────────

describe("dual-pool store factories", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    // Re-grant after table drop (default privileges cover new tables,
    // but existing grants are lost on DROP TABLE CASCADE)
    await ensureAppRole(adminPool);
  });

  it("settings store: admin pool for DDL, app pool for queries", async () => {
    const store = await createSettingsStore(adminPool, appPool);
    // Write + read through the app pool
    await store.set("system.port", "4000");
    const val = await store.get("system.port");
    expect(val).toBe("4000");
    store.close();
  });

  it("behavior store: admin pool for DDL, app pool for queries", async () => {
    const store = await createBehaviorStore(adminPool, appPool);
    // Create + read through the app pool
    const ruleId = `rule-dual-${Date.now()}`;
    const rule = await store.createRule(ruleId, "test behavior rule", "should");
    expect(rule.id).toBe(ruleId);
    const fetched = await store.getRule(ruleId);
    expect(fetched?.text).toBe("test behavior rule");
    store.close();
  });

  it("frame store factory: RLS enforced on app pool", async () => {
    const factory = await createFrameStoreFactory(adminPool, appPool);

    // Create frames for two different users
    const storeA = factory.forUser("user-alpha");
    const storeB = factory.forUser("user-beta");

    const frameA = makeFrame({ id: "frame-alpha-1", userId: "user-alpha" });
    const frameB = makeFrame({ id: "frame-beta-1", userId: "user-beta" });

    await storeA.saveFrame(frameA);
    await storeB.saveFrame(frameB);

    // User A can only see their own frame
    const listA = await storeA.listFrames({ limit: 100 });
    expect(listA.frames.map((f) => f.id)).toContain("frame-alpha-1");
    expect(listA.frames.map((f) => f.id)).not.toContain("frame-beta-1");

    // User B can only see their own frame
    const listB = await storeB.listFrames({ limit: 100 });
    expect(listB.frames.map((f) => f.id)).toContain("frame-beta-1");
    expect(listB.frames.map((f) => f.id)).not.toContain("frame-alpha-1");
  });

  it("frame store: superuser pool bypasses RLS (proving app pool is needed)", async () => {
    // Init schema with admin pool, then create factory with ADMIN pool for queries
    const superFactory = await createFrameStoreFactory(adminPool);

    const storeA = superFactory.forUser("user-super-a");
    const storeB = superFactory.forUser("user-super-b");

    await storeA.saveFrame(makeFrame({ id: "frame-sa-1", userId: "user-super-a" }));
    await storeB.saveFrame(makeFrame({ id: "frame-sb-1", userId: "user-super-b" }));

    // Superuser bypasses RLS — user A can see user B's frames (THIS IS THE BUG)
    const listA = await storeA.listFrames({ limit: 100 });
    const ids = listA.frames.map((f) => f.id);
    // With superuser, both are visible (RLS bypassed)
    expect(ids).toContain("frame-sa-1");
    expect(ids).toContain("frame-sb-1");
  });

  it("app pool cannot run DDL (ALTER TABLE, CREATE TABLE)", async () => {
    // Non-superuser should not be able to create tables directly
    // (they can only use tables the admin created)
    await expect(
      appPool.query("CREATE TABLE _test_ddl_guard (id INT)"),
    ).rejects.toThrow();
  });
});

// ─── Backward compatibility ─────────────────────────────────────

describe("backward compat: single pool (no runtimePool)", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await ensureAppRole(adminPool);
  });

  it("settings store works with one pool", async () => {
    // Tests pass a single superuser pool — should still work
    const store = await createSettingsStore(adminPool);
    await store.set("system.port", "5000");
    expect(await store.get("system.port")).toBe("5000");
    store.close();
  });

  it("behavior store works with one pool", async () => {
    const store = await createBehaviorStore(adminPool);
    const rule = await store.createRule(`rule-compat-${Date.now()}`, "compat rule", "must");
    expect(rule.id).toBeDefined();
    store.close();
  });
});

// ─── Frame helpers ──────────────────────────────────────────────

let frameCounter = 0;

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  frameCounter++;
  return {
    id: overrides.id ?? `frame-dual-${frameCounter}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    branch: "test",
    module_scope: ["test/dual-pool"],
    summary_caption: "dual pool test frame",
    reference_point: `Test frame ${frameCounter}`,
    status_snapshot: { phase: "testing" },
    keywords: ["test"],
    userId: overrides.userId ?? "test-user",
    ...overrides,
  } as Frame;
}
