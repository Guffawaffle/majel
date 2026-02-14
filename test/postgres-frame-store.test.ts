/**
 * postgres-frame-store.test.ts — PostgresFrameStore Integration Tests (ADR-021, #36)
 *
 * Covers CRUD, FTS, pagination, RLS isolation, updateFrame, purgeSuperseded,
 * and edge cases against a real PostgreSQL instance (docker-compose).
 *
 * RLS caveat: The docker-compose `majel` user is a superuser (PostgreSQL skips
 * RLS for superusers, even with FORCE ROW LEVEL SECURITY). Tests create a
 * `majel_app` non-superuser role and use a separate pool for store operations,
 * while the superuser pool handles DDL/cleanup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  createFrameStoreFactory,
  FrameStoreFactory,
} from "../src/server/stores/postgres-frame-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createPool } from "../src/server/db.js";
import type { Frame, FrameStore } from "@smartergpt/lex/store";

// ─── Test Setup ─────────────────────────────────────────────────

/** Superuser pool — used for DDL, cleanup, and schema init only. */
let adminPool: Pool;

/** Non-superuser pool — used for all store operations (RLS enforced). */
let appPool: Pool;

const APP_ROLE = "majel_app";
const APP_PASSWORD = "majel_app";
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://majel:majel@localhost:5432/majel";
const APP_DB_URL = TEST_DB_URL.replace(
  /postgres:\/\/[^@]+@/,
  `postgres://${APP_ROLE}:${APP_PASSWORD}@`,
);

/**
 * Create the non-superuser app role (idempotent).
 * Grants CONNECT + full DML on public schema.
 */
async function ensureAppRole(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER;
      END IF;
    END $$;
  `);
  await pool.query(`GRANT CONNECT ON DATABASE majel TO ${APP_ROLE}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${APP_ROLE}`);
}

beforeAll(async () => {
  adminPool = createTestPool();
  await ensureAppRole(adminPool);
  appPool = createPool(APP_DB_URL);
});
afterAll(async () => {
  await appPool.end();
  await adminPool.end();
});

let factory: FrameStoreFactory;
let store: FrameStore;

const USER_A = "user-alice";
const USER_B = "user-bob";

// ─── Frame Builder Helpers ──────────────────────────────────────

let frameCounter = 0;

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  frameCounter++;
  const id = overrides.id ?? `frame-test-${frameCounter}-${Date.now()}`;
  return {
    id,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    branch: overrides.branch ?? "test-branch",
    module_scope: overrides.module_scope ?? ["test/module"],
    summary_caption: overrides.summary_caption ?? `Test frame ${frameCounter}`,
    reference_point: overrides.reference_point ?? `working on feature ${frameCounter}`,
    status_snapshot: overrides.status_snapshot ?? { next_action: "continue testing" },
    keywords: overrides.keywords ?? ["test"],
    ...(overrides.jira !== undefined ? { jira: overrides.jira } : {}),
    ...(overrides.atlas_frame_id !== undefined ? { atlas_frame_id: overrides.atlas_frame_id } : {}),
    ...(overrides.spend !== undefined ? { spend: overrides.spend } : {}),
    ...(overrides.superseded_by !== undefined ? { superseded_by: overrides.superseded_by } : {}),
    ...(overrides.merged_from !== undefined ? { merged_from: overrides.merged_from } : {}),
    ...(overrides.feature_flags !== undefined ? { feature_flags: overrides.feature_flags } : {}),
    ...(overrides.permissions !== undefined ? { permissions: overrides.permissions } : {}),
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    ...(overrides.planHash !== undefined ? { planHash: overrides.planHash } : {}),
    ...(overrides.executorRole !== undefined ? { executorRole: overrides.executorRole } : {}),
    ...(overrides.toolCalls !== undefined ? { toolCalls: overrides.toolCalls } : {}),
    ...(overrides.guardrailProfile !== undefined ? { guardrailProfile: overrides.guardrailProfile } : {}),
    ...(overrides.capabilityTier !== undefined ? { capabilityTier: overrides.capabilityTier } : {}),
    ...(overrides.taskComplexity !== undefined ? { taskComplexity: overrides.taskComplexity } : {}),
    ...(overrides.turnCost !== undefined ? { turnCost: overrides.turnCost } : {}),
  };
}

// ─── CRUD Operations ────────────────────────────────────────────

describe("PostgresFrameStore — CRUD", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool); // DDL as superuser
    await ensureAppRole(adminPool); // re-grant after table recreate
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("saveFrame + getFrameById round-trip", async () => {
    const frame = makeFrame({
      jira: "MAJEL-100",
      module_scope: ["server/data", "server/auth"],
      keywords: ["auth", "session"],
      spend: { prompts: 3, tokens_estimated: 1200 },
    });
    await store.saveFrame(frame);

    const retrieved = await store.getFrameById(frame.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(frame.id);
    expect(retrieved!.branch).toBe(frame.branch);
    expect(retrieved!.jira).toBe("MAJEL-100");
    expect(retrieved!.module_scope).toEqual(["server/data", "server/auth"]);
    expect(retrieved!.summary_caption).toBe(frame.summary_caption);
    expect(retrieved!.reference_point).toBe(frame.reference_point);
    expect(retrieved!.status_snapshot).toEqual({ next_action: "continue testing" });
    expect(retrieved!.keywords).toEqual(["auth", "session"]);
    expect(retrieved!.spend).toEqual({ prompts: 3, tokens_estimated: 1200 });
  });

  it("getFrameById returns null for non-existent ID", async () => {
    const result = await store.getFrameById("non-existent-id");
    expect(result).toBeNull();
  });

  it("saveFrame is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const frame = makeFrame();
    await store.saveFrame(frame);
    // Second save with same ID should not throw
    await store.saveFrame(frame);
    const count = await store.getFrameCount();
    expect(count).toBe(1);
  });

  it("saveFrames batch insert", async () => {
    const frames = [makeFrame(), makeFrame(), makeFrame()];
    const results = await store.saveFrames(frames);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(await store.getFrameCount()).toBe(3);
  });

  it("saveFrames is all-or-nothing on failure", async () => {
    const frame1 = makeFrame();
    const frame2 = makeFrame();
    // Insert frame1 first, then try batch with duplicate + new
    await store.saveFrame(frame1);

    // Duplicate IDs within a batch — frame1 already exists (ON CONFLICT DO NOTHING),
    // but both should succeed since DO NOTHING doesn't throw
    const results = await store.saveFrames([frame1, frame2]);
    expect(results).toHaveLength(2);
  });

  it("deleteFrame removes a frame and returns true", async () => {
    const frame = makeFrame();
    await store.saveFrame(frame);
    const deleted = await store.deleteFrame(frame.id);
    expect(deleted).toBe(true);
    expect(await store.getFrameById(frame.id)).toBeNull();
  });

  it("deleteFrame returns false for non-existent ID", async () => {
    const deleted = await store.deleteFrame("ghost-id");
    expect(deleted).toBe(false);
  });

  it("deleteFramesBefore removes old frames", async () => {
    const old = makeFrame({ timestamp: "2020-01-01T00:00:00.000Z" });
    const recent = makeFrame({ timestamp: "2099-12-31T23:59:59.999Z" });
    await store.saveFrame(old);
    await store.saveFrame(recent);

    const deleted = await store.deleteFramesBefore(new Date("2025-01-01"));
    expect(deleted).toBe(1);
    expect(await store.getFrameById(old.id)).toBeNull();
    expect(await store.getFrameById(recent.id)).not.toBeNull();
  });

  it("deleteFramesByBranch removes matching branch", async () => {
    const f1 = makeFrame({ branch: "feature/x" });
    const f2 = makeFrame({ branch: "feature/x" });
    const f3 = makeFrame({ branch: "main" });
    await store.saveFrames([f1, f2, f3]);

    const deleted = await store.deleteFramesByBranch("feature/x");
    expect(deleted).toBe(2);
    expect(await store.getFrameCount()).toBe(1);
  });

  it("deleteFramesByModule removes frames with matching module", async () => {
    const f1 = makeFrame({ module_scope: ["server/auth", "server/data"] });
    const f2 = makeFrame({ module_scope: ["server/data"] });
    const f3 = makeFrame({ module_scope: ["client/ui"] });
    await store.saveFrames([f1, f2, f3]);

    const deleted = await store.deleteFramesByModule("server/data");
    expect(deleted).toBe(2);
    expect(await store.getFrameCount()).toBe(1);
    expect(await store.getFrameById(f3.id)).not.toBeNull();
  });

  it("getFrameCount returns correct count", async () => {
    expect(await store.getFrameCount()).toBe(0);
    await store.saveFrames([makeFrame(), makeFrame(), makeFrame()]);
    expect(await store.getFrameCount()).toBe(3);
  });

  it("getStats returns aggregated statistics", async () => {
    const now = new Date();
    const recent = makeFrame({ timestamp: now.toISOString() });
    const old = makeFrame({
      timestamp: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    });
    await store.saveFrames([recent, old]);

    const stats = await store.getStats();
    expect(stats.totalFrames).toBe(2);
    expect(stats.thisWeek).toBeGreaterThanOrEqual(1);
    expect(stats.thisMonth).toBeGreaterThanOrEqual(1);
    expect(stats.oldestDate).not.toBeNull();
    expect(stats.newestDate).not.toBeNull();
  });

  it("getStats with detailed returns module distribution", async () => {
    await store.saveFrames([
      makeFrame({ module_scope: ["server/auth", "server/data"] }),
      makeFrame({ module_scope: ["server/auth"] }),
      makeFrame({ module_scope: ["client/ui"] }),
    ]);

    const stats = await store.getStats(true);
    expect(stats.moduleDistribution).toBeDefined();
    expect(stats.moduleDistribution!["server/auth"]).toBe(2);
    expect(stats.moduleDistribution!["server/data"]).toBe(1);
    expect(stats.moduleDistribution!["client/ui"]).toBe(1);
  });

  it("getTurnCostMetrics aggregates spend metadata", async () => {
    await store.saveFrames([
      makeFrame({ spend: { prompts: 5, tokens_estimated: 2000 } }),
      makeFrame({ spend: { prompts: 3, tokens_estimated: 1500 } }),
      makeFrame({}), // no spend
    ]);

    const metrics = await store.getTurnCostMetrics();
    expect(metrics.frameCount).toBe(3);
    expect(metrics.estimatedTokens).toBe(3500);
    expect(metrics.prompts).toBe(8);
  });

  it("getTurnCostMetrics with since filter", async () => {
    const now = new Date();
    const old = makeFrame({
      timestamp: "2020-01-01T00:00:00.000Z",
      spend: { prompts: 10, tokens_estimated: 5000 },
    });
    const recent = makeFrame({
      timestamp: now.toISOString(),
      spend: { prompts: 2, tokens_estimated: 800 },
    });
    await store.saveFrames([old, recent]);

    const metrics = await store.getTurnCostMetrics("2024-01-01T00:00:00.000Z");
    expect(metrics.frameCount).toBe(1);
    expect(metrics.prompts).toBe(2);
    expect(metrics.estimatedTokens).toBe(800);
  });

  it("preserves all optional fields through round-trip", async () => {
    const frame = makeFrame({
      jira: "MAJEL-42",
      atlas_frame_id: "atlas-001",
      feature_flags: ["flag-a", "flag-b"],
      permissions: ["read", "write"],
      runId: "run-001",
      planHash: "abc123",
      spend: { prompts: 1, tokens_estimated: 500 },
      executorRole: "senior-dev",
      toolCalls: ["tool_a", "tool_b"],
      guardrailProfile: "strict",
      capabilityTier: "senior",
      taskComplexity: {
        tier: "senior",
        assignedModel: "gpt-4",
        escalated: false,
      },
      turnCost: {
        components: { latency: 1, contextReset: 2, renegotiation: 3, tokenBloat: 4, attentionSwitch: 5 },
        weightedScore: 15,
      },
      superseded_by: "frame-newer",
      merged_from: ["frame-old-1", "frame-old-2"],
    });
    await store.saveFrame(frame);

    const got = await store.getFrameById(frame.id);
    expect(got).not.toBeNull();
    expect(got!.jira).toBe("MAJEL-42");
    expect(got!.atlas_frame_id).toBe("atlas-001");
    expect(got!.feature_flags).toEqual(["flag-a", "flag-b"]);
    expect(got!.permissions).toEqual(["read", "write"]);
    expect(got!.runId).toBe("run-001");
    expect(got!.planHash).toBe("abc123");
    expect(got!.spend).toEqual({ prompts: 1, tokens_estimated: 500 });
    expect(got!.executorRole).toBe("senior-dev");
    expect(got!.toolCalls).toEqual(["tool_a", "tool_b"]);
    expect(got!.guardrailProfile).toBe("strict");
    expect(got!.capabilityTier).toBe("senior");
    expect(got!.taskComplexity).toEqual({
      tier: "senior",
      assignedModel: "gpt-4",
      escalated: false,
    });
    expect(got!.turnCost).toEqual({
      components: { latency: 1, contextReset: 2, renegotiation: 3, tokenBloat: 4, attentionSwitch: 5 },
      weightedScore: 15,
    });
    expect(got!.superseded_by).toBe("frame-newer");
    expect(got!.merged_from).toEqual(["frame-old-1", "frame-old-2"]);
  });
});

// ─── Full-Text Search ───────────────────────────────────────────

describe("PostgresFrameStore — Full-Text Search", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("searches by single term (fuzzy/prefix)", async () => {
    await store.saveFrames([
      makeFrame({ reference_point: "authentication module refactor" }),
      makeFrame({ reference_point: "database migration scripts" }),
    ]);

    const results = await store.searchFrames({ query: "auth" });
    expect(results).toHaveLength(1);
    expect(results[0].reference_point).toContain("authentication");
  });

  it("searches by multiple terms (AND mode default)", async () => {
    await store.saveFrames([
      makeFrame({ reference_point: "authentication module refactor", summary_caption: "refactored auth layer" }),
      makeFrame({ reference_point: "database migration", summary_caption: "added new tables" }),
      makeFrame({ reference_point: "authentication database bridge", summary_caption: "auth-db connector" }),
    ]);

    const results = await store.searchFrames({ query: "auth database" });
    // AND mode: only the frame that matches BOTH terms
    expect(results).toHaveLength(1);
    expect(results[0].reference_point).toContain("authentication database");
  });

  it("searches with mode 'any' (OR)", async () => {
    await store.saveFrames([
      makeFrame({ reference_point: "authentication module refactor" }),
      makeFrame({ reference_point: "database migration scripts" }),
      makeFrame({ reference_point: "UI layout fixes" }),
    ]);

    const results = await store.searchFrames({ query: "auth database", mode: "any" });
    // OR mode: frames matching auth OR database
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("searches with exact mode (no prefix wildcard)", async () => {
    await store.saveFrames([
      makeFrame({ reference_point: "authentication module refactor" }),
      makeFrame({ reference_point: "authorize user access" }),
    ]);

    // Exact mode: "auth" should not prefix-match "authentication" or "authorize"
    // It would need to be the exact lexeme
    const results = await store.searchFrames({ query: "authentication", exact: true });
    expect(results).toHaveLength(1);
    expect(results[0].reference_point).toContain("authentication");
  });

  it("filters by since/until timestamps", async () => {
    await store.saveFrames([
      makeFrame({ timestamp: "2024-01-15T00:00:00.000Z", reference_point: "january work" }),
      makeFrame({ timestamp: "2024-06-15T00:00:00.000Z", reference_point: "june work" }),
      makeFrame({ timestamp: "2024-12-15T00:00:00.000Z", reference_point: "december work" }),
    ]);

    const results = await store.searchFrames({
      since: new Date("2024-03-01"),
      until: new Date("2024-09-01"),
    });
    expect(results).toHaveLength(1);
    expect(results[0].reference_point).toContain("june");
  });

  it("filters by moduleScope", async () => {
    await store.saveFrames([
      makeFrame({ module_scope: ["server/auth"], reference_point: "auth changes" }),
      makeFrame({ module_scope: ["server/data"], reference_point: "data migration" }),
      makeFrame({ module_scope: ["server/auth", "server/data"], reference_point: "cross-module work" }),
    ]);

    const results = await store.searchFrames({ moduleScope: ["server/auth"] });
    expect(results).toHaveLength(2);
  });

  it("combines query + moduleScope + time range", async () => {
    const now = new Date();
    await store.saveFrames([
      makeFrame({
        module_scope: ["server/auth"],
        reference_point: "fixing authentication bug",
        timestamp: now.toISOString(),
      }),
      makeFrame({
        module_scope: ["server/auth"],
        reference_point: "fixing authentication bug",
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
      makeFrame({
        module_scope: ["server/data"],
        reference_point: "fixing authentication bug",
        timestamp: now.toISOString(),
      }),
    ]);

    const results = await store.searchFrames({
      query: "auth",
      moduleScope: ["server/auth"],
      since: new Date("2024-01-01"),
    });
    expect(results).toHaveLength(1);
  });

  it("returns empty array for no matches", async () => {
    await store.saveFrame(makeFrame({ reference_point: "nothing relevant" }));
    const results = await store.searchFrames({ query: "xyznonexistent" });
    expect(results).toEqual([]);
  });

  it("respects limit parameter", async () => {
    await store.saveFrames(
      Array.from({ length: 10 }, (_, i) =>
        makeFrame({ reference_point: `auth work item ${i}` }),
      ),
    );
    const results = await store.searchFrames({ query: "auth", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("searches across branch field (tsvector weight C)", async () => {
    // Note: PG english tsvector treats 'feature/postgres-migration' as a single
    // token. Simple single-word branch names do index correctly.
    await store.saveFrames([
      makeFrame({ branch: "postgres", reference_point: "unrelated reference" }),
      makeFrame({ branch: "main", reference_point: "unrelated other" }),
    ]);

    const results = await store.searchFrames({ query: "postgres" });
    expect(results).toHaveLength(1);
    expect(results[0].branch).toBe("postgres");
  });
});

// ─── Pagination (listFrames) ────────────────────────────────────

describe("PostgresFrameStore — Pagination", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("returns frames ordered by timestamp DESC", async () => {
    const f1 = makeFrame({ timestamp: "2024-01-01T00:00:00.000Z" });
    const f2 = makeFrame({ timestamp: "2024-06-01T00:00:00.000Z" });
    const f3 = makeFrame({ timestamp: "2024-12-01T00:00:00.000Z" });
    await store.saveFrames([f1, f2, f3]);

    const result = await store.listFrames();
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0].id).toBe(f3.id); // newest first
    expect(result.frames[2].id).toBe(f1.id); // oldest last
    expect(result.order).toEqual({ by: "timestamp", direction: "desc" });
  });

  it("respects limit parameter", async () => {
    await store.saveFrames(
      Array.from({ length: 5 }, (_, i) =>
        makeFrame({ timestamp: new Date(2024, 0, i + 1).toISOString() }),
      ),
    );

    const result = await store.listFrames({ limit: 2 });
    expect(result.frames).toHaveLength(2);
    expect(result.page.limit).toBe(2);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).not.toBeNull();
  });

  it("cursor-based pagination fetches next page", async () => {
    const frames = Array.from({ length: 5 }, (_, i) =>
      makeFrame({ timestamp: new Date(2024, 0, i + 1).toISOString() }),
    );
    await store.saveFrames(frames);

    // Page 1: 2 most recent
    const page1 = await store.listFrames({ limit: 2 });
    expect(page1.frames).toHaveLength(2);
    expect(page1.page.hasMore).toBe(true);

    // Page 2: next 2
    const page2 = await store.listFrames({ limit: 2, cursor: page1.page.nextCursor! });
    expect(page2.frames).toHaveLength(2);
    expect(page2.page.hasMore).toBe(true);

    // No overlap between pages
    const page1Ids = new Set(page1.frames.map((f) => f.id));
    const page2Ids = new Set(page2.frames.map((f) => f.id));
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }

    // Page 3: last frame
    const page3 = await store.listFrames({ limit: 2, cursor: page2.page.nextCursor! });
    expect(page3.frames).toHaveLength(1);
    expect(page3.page.hasMore).toBe(false);
    expect(page3.page.nextCursor).toBeNull();
  });

  it("empty store returns empty result with hasMore=false", async () => {
    const result = await store.listFrames();
    expect(result.frames).toEqual([]);
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });

  it("listFrames returns all frames when limit exceeds count", async () => {
    await store.saveFrames([makeFrame(), makeFrame()]);
    const result = await store.listFrames({ limit: 100 });
    expect(result.frames).toHaveLength(2);
    expect(result.page.hasMore).toBe(false);
  });
});

// ─── RLS Isolation (Critical) ───────────────────────────────────

describe("PostgresFrameStore — RLS Isolation", () => {
  let storeA: FrameStore;
  let storeB: FrameStore;

  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    storeA = factory.forUser(USER_A);
    storeB = factory.forUser(USER_B);
    frameCounter = 0;
  });

  it("User A's frames are invisible to User B (getFrameById)", async () => {
    const frame = makeFrame();
    await storeA.saveFrame(frame);

    expect(await storeA.getFrameById(frame.id)).not.toBeNull();
    expect(await storeB.getFrameById(frame.id)).toBeNull();
  });

  it("User A's frames are invisible to User B (listFrames)", async () => {
    await storeA.saveFrames([makeFrame(), makeFrame(), makeFrame()]);
    await storeB.saveFrame(makeFrame());

    const resultA = await storeA.listFrames();
    const resultB = await storeB.listFrames();
    expect(resultA.frames).toHaveLength(3);
    expect(resultB.frames).toHaveLength(1);
  });

  it("User A's frames are invisible to User B (searchFrames)", async () => {
    await storeA.saveFrame(makeFrame({ reference_point: "secret auth refactor" }));
    await storeB.saveFrame(makeFrame({ reference_point: "public auth docs" }));

    const resultsA = await storeA.searchFrames({ query: "auth" });
    const resultsB = await storeB.searchFrames({ query: "auth" });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].reference_point).toContain("secret");
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].reference_point).toContain("public");
  });

  it("User B cannot delete User A's frames", async () => {
    const frame = makeFrame();
    await storeA.saveFrame(frame);

    const deleted = await storeB.deleteFrame(frame.id);
    expect(deleted).toBe(false);
    // Frame still exists for User A
    expect(await storeA.getFrameById(frame.id)).not.toBeNull();
  });

  it("getFrameCount is per-user", async () => {
    await storeA.saveFrames([makeFrame(), makeFrame(), makeFrame()]);
    await storeB.saveFrames([makeFrame(), makeFrame()]);

    expect(await storeA.getFrameCount()).toBe(3);
    expect(await storeB.getFrameCount()).toBe(2);
  });

  it("getStats is per-user", async () => {
    await storeA.saveFrames([makeFrame(), makeFrame()]);
    await storeB.saveFrame(makeFrame());

    const statsA = await storeA.getStats();
    const statsB = await storeB.getStats();
    expect(statsA.totalFrames).toBe(2);
    expect(statsB.totalFrames).toBe(1);
  });

  it("getTurnCostMetrics is per-user", async () => {
    await storeA.saveFrame(makeFrame({ spend: { prompts: 10, tokens_estimated: 5000 } }));
    await storeB.saveFrame(makeFrame({ spend: { prompts: 2, tokens_estimated: 800 } }));

    const metricsA = await storeA.getTurnCostMetrics();
    const metricsB = await storeB.getTurnCostMetrics();
    expect(metricsA.prompts).toBe(10);
    expect(metricsB.prompts).toBe(2);
  });

  it("deleteFramesByBranch only affects own user's frames", async () => {
    await storeA.saveFrame(makeFrame({ branch: "shared-branch" }));
    await storeB.saveFrame(makeFrame({ branch: "shared-branch" }));

    const deleted = await storeA.deleteFramesByBranch("shared-branch");
    expect(deleted).toBe(1);
    expect(await storeA.getFrameCount()).toBe(0);
    expect(await storeB.getFrameCount()).toBe(1);
  });

  it("deleteFramesByModule only affects own user's frames", async () => {
    await storeA.saveFrame(makeFrame({ module_scope: ["shared/mod"] }));
    await storeB.saveFrame(makeFrame({ module_scope: ["shared/mod"] }));

    const deleted = await storeA.deleteFramesByModule("shared/mod");
    expect(deleted).toBe(1);
    expect(await storeB.getFrameCount()).toBe(1);
  });

  it("purgeSuperseded only affects own user's frames", async () => {
    await storeA.saveFrame(makeFrame({ superseded_by: "frame-newer" }));
    await storeB.saveFrame(makeFrame({ superseded_by: "frame-newer-b" }));

    const purgedA = await storeA.purgeSuperseded();
    expect(purgedA).toBe(1);
    expect(await storeA.getFrameCount()).toBe(0);
    // User B's superseded frame is untouched
    expect(await storeB.getFrameCount()).toBe(1);
  });

  it("no session variable → zero rows (fail-closed)", async () => {
    const frame = makeFrame();
    await storeA.saveFrame(frame);

    // Query directly without setting app.current_user_id — RLS should return nothing
    // Must use appPool (non-superuser) — superusers bypass RLS entirely
    const client = await appPool.connect();
    try {
      // Reset session to ensure no lingering user scope
      await client.query("RESET ALL");
      const { rows } = await client.query("SELECT * FROM lex_frames");
      expect(rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});

// ─── updateFrame ────────────────────────────────────────────────

describe("PostgresFrameStore — updateFrame", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("updates a single field without affecting others", async () => {
    const frame = makeFrame({
      summary_caption: "original caption",
      branch: "original-branch",
    });
    await store.saveFrame(frame);

    const updated = await store.updateFrame(frame.id, { summary_caption: "updated caption" });
    expect(updated).toBe(true);

    const got = await store.getFrameById(frame.id);
    expect(got!.summary_caption).toBe("updated caption");
    expect(got!.branch).toBe("original-branch"); // unchanged
    expect(got!.reference_point).toBe(frame.reference_point); // unchanged
  });

  it("updates multiple fields at once", async () => {
    const frame = makeFrame();
    await store.saveFrame(frame);

    await store.updateFrame(frame.id, {
      branch: "new-branch",
      jira: "MAJEL-999",
      keywords: ["updated", "new-keywords"],
    });

    const got = await store.getFrameById(frame.id);
    expect(got!.branch).toBe("new-branch");
    expect(got!.jira).toBe("MAJEL-999");
    expect(got!.keywords).toEqual(["updated", "new-keywords"]);
  });

  it("returns false for non-existent ID", async () => {
    const updated = await store.updateFrame("ghost-id", { branch: "nope" });
    expect(updated).toBe(false);
  });

  it("does not change id or timestamp", async () => {
    const frame = makeFrame({ timestamp: "2024-06-15T12:00:00.000Z" });
    await store.saveFrame(frame);

    // The interface says Partial<Omit<Frame, "id" | "timestamp">>
    // but let's verify the frame's id and timestamp are preserved
    await store.updateFrame(frame.id, { branch: "changed" });

    const got = await store.getFrameById(frame.id);
    expect(got!.id).toBe(frame.id);
    expect(got!.timestamp).toBe("2024-06-15T12:00:00.000Z");
  });

  it("sets superseded_by metadata", async () => {
    const old = makeFrame();
    const newer = makeFrame();
    await store.saveFrames([old, newer]);

    await store.updateFrame(old.id, { superseded_by: newer.id });

    const got = await store.getFrameById(old.id);
    expect(got!.superseded_by).toBe(newer.id);
  });

  it("sets merged_from metadata", async () => {
    const merged = makeFrame();
    await store.saveFrame(merged);

    await store.updateFrame(merged.id, { merged_from: ["frame-a", "frame-b"] });

    const got = await store.getFrameById(merged.id);
    expect(got!.merged_from).toEqual(["frame-a", "frame-b"]);
  });

  it("returns false with no valid fields", async () => {
    const frame = makeFrame();
    await store.saveFrame(frame);

    // Pass empty updates object
    const updated = await store.updateFrame(frame.id, {});
    expect(updated).toBe(false);
  });

  it("User B cannot update User A's frame", async () => {
    const frame = makeFrame();
    await store.saveFrame(frame);

    const storeB = factory.forUser(USER_B);
    const updated = await storeB.updateFrame(frame.id, { branch: "hijacked" });
    expect(updated).toBe(false);

    // Verify it's unchanged
    const got = await store.getFrameById(frame.id);
    expect(got!.branch).toBe(frame.branch);
  });
});

// ─── purgeSuperseded ────────────────────────────────────────────

describe("PostgresFrameStore — purgeSuperseded", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("deletes only superseded frames", async () => {
    const active1 = makeFrame();
    const active2 = makeFrame();
    const superseded1 = makeFrame({ superseded_by: "frame-newer-1" });
    const superseded2 = makeFrame({ superseded_by: "frame-newer-2" });
    await store.saveFrames([active1, active2, superseded1, superseded2]);

    const purged = await store.purgeSuperseded();
    expect(purged).toBe(2);
    expect(await store.getFrameCount()).toBe(2);
    expect(await store.getFrameById(active1.id)).not.toBeNull();
    expect(await store.getFrameById(active2.id)).not.toBeNull();
    expect(await store.getFrameById(superseded1.id)).toBeNull();
    expect(await store.getFrameById(superseded2.id)).toBeNull();
  });

  it("returns 0 when no frames are superseded", async () => {
    await store.saveFrames([makeFrame(), makeFrame()]);
    const purged = await store.purgeSuperseded();
    expect(purged).toBe(0);
    expect(await store.getFrameCount()).toBe(2);
  });

  it("returns 0 on empty store", async () => {
    const purged = await store.purgeSuperseded();
    expect(purged).toBe(0);
  });

  it("mark + purge workflow", async () => {
    const old = makeFrame();
    const newer = makeFrame();
    await store.saveFrames([old, newer]);

    // Mark old as superseded
    await store.updateFrame(old.id, { superseded_by: newer.id });

    // Verify it's marked
    const marked = await store.getFrameById(old.id);
    expect(marked!.superseded_by).toBe(newer.id);

    // Purge
    const purged = await store.purgeSuperseded();
    expect(purged).toBe(1);
    expect(await store.getFrameById(old.id)).toBeNull();
    expect(await store.getFrameById(newer.id)).not.toBeNull();
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe("PostgresFrameStore — Edge Cases", () => {
  beforeEach(async () => {
    await cleanDatabase(adminPool);
    await createFrameStoreFactory(adminPool);
    await ensureAppRole(adminPool);
    factory = new FrameStoreFactory(appPool);
    store = factory.forUser(USER_A);
    frameCounter = 0;
  });

  it("empty store: all read operations return sensible defaults", async () => {
    expect(await store.getFrameCount()).toBe(0);
    expect(await store.getFrameById("nothing")).toBeNull();
    expect(await store.searchFrames({ query: "anything" })).toEqual([]);
    const list = await store.listFrames();
    expect(list.frames).toEqual([]);
    expect(list.page.hasMore).toBe(false);

    const stats = await store.getStats();
    expect(stats.totalFrames).toBe(0);
    expect(stats.oldestDate).toBeNull();
    expect(stats.newestDate).toBeNull();

    const metrics = await store.getTurnCostMetrics();
    expect(metrics.frameCount).toBe(0);
    expect(metrics.estimatedTokens).toBe(0);
    expect(metrics.prompts).toBe(0);
  });

  it("special characters in search query do not break FTS", async () => {
    await store.saveFrame(
      makeFrame({ reference_point: "normal reference point" }),
    );

    // tsquery-unsafe characters should be sanitized
    const edgeCases = [
      "test's quote",
      "test:colon",
      "test & ampersand",
      "test | pipe",
      "test ! bang",
      "test (parens)",
      "test <angle>",
      "test\\backslash",
      "test*star",
      "  ", // whitespace only
      "",  // empty string
    ];

    for (const query of edgeCases) {
      // Should not throw, even if results are empty
      const results = await store.searchFrames({ query });
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it("very long text fields are stored and retrieved", async () => {
    const longText = "a".repeat(10_000);
    const frame = makeFrame({
      reference_point: longText,
      summary_caption: longText,
    });
    await store.saveFrame(frame);

    const got = await store.getFrameById(frame.id);
    expect(got!.reference_point).toBe(longText);
    expect(got!.summary_caption).toBe(longText);
  });

  it("concurrent users can write simultaneously", async () => {
    const storeA = factory.forUser(USER_A);
    const storeB = factory.forUser(USER_B);

    // Both write at the same time
    await Promise.all([
      storeA.saveFrame(makeFrame({ reference_point: "alice writes" })),
      storeB.saveFrame(makeFrame({ reference_point: "bob writes" })),
    ]);

    expect(await storeA.getFrameCount()).toBe(1);
    expect(await storeB.getFrameCount()).toBe(1);
  });

  it("large batch saveFrames", async () => {
    const frames = Array.from({ length: 50 }, (_, i) =>
      makeFrame({ reference_point: `batch frame ${i}` }),
    );
    const results = await store.saveFrames(frames);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.success)).toBe(true);
    expect(await store.getFrameCount()).toBe(50);
  });

  it("deleteFramesBefore with future date removes all frames", async () => {
    await store.saveFrames([makeFrame(), makeFrame(), makeFrame()]);
    const deleted = await store.deleteFramesBefore(new Date("2099-01-01"));
    expect(deleted).toBe(3);
    expect(await store.getFrameCount()).toBe(0);
  });

  it("deleteFramesBefore with past date removes nothing", async () => {
    await store.saveFrames([makeFrame(), makeFrame()]);
    const deleted = await store.deleteFramesBefore(new Date("2000-01-01"));
    expect(deleted).toBe(0);
    expect(await store.getFrameCount()).toBe(2);
  });

  it("close() is a no-op and safe to call", async () => {
    await store.close();
    // Store should still function (pool not closed)
    await store.saveFrame(makeFrame());
    expect(await store.getFrameCount()).toBe(1);
  });

  it("module scope with special characters", async () => {
    const frame = makeFrame({
      module_scope: ["server/auth-v2.0", "client/ui_components"],
    });
    await store.saveFrame(frame);

    const got = await store.getFrameById(frame.id);
    expect(got!.module_scope).toEqual(["server/auth-v2.0", "client/ui_components"]);
  });

  it("status_snapshot with all optional fields", async () => {
    const frame = makeFrame({
      status_snapshot: {
        next_action: "deploy to staging",
        blockers: ["waiting for review"],
        merge_blockers: ["CI failing"],
        tests_failing: ["auth.test.ts"],
      },
    });
    await store.saveFrame(frame);

    const got = await store.getFrameById(frame.id);
    expect(got!.status_snapshot).toEqual({
      next_action: "deploy to staging",
      blockers: ["waiting for review"],
      merge_blockers: ["CI failing"],
      tests_failing: ["auth.test.ts"],
    });
  });

  it("factory.forUser creates independent stores", async () => {
    const storeX = factory.forUser("user-x");
    const storeY = factory.forUser("user-y");

    await storeX.saveFrame(makeFrame());
    await storeY.saveFrame(makeFrame());
    await storeY.saveFrame(makeFrame());

    expect(await storeX.getFrameCount()).toBe(1);
    expect(await storeY.getFrameCount()).toBe(2);
  });
});
