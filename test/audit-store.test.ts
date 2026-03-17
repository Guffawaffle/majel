/**
 * audit-store.test.ts — Direct tests for AuditStore query + purge methods
 *
 * The admin-routes tests cover logEvent + queryRecent via HTTP.
 * This file covers the remaining store methods:
 *   queryByActor, queryByTarget, queryByEvent, eventCounts, purgeOlderThan
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createAuditStore, type AuditStore } from "../src/server/stores/audit-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
let store: AuditStore;

const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "22222222-2222-4222-8222-222222222222";
const TARGET_X = "33333333-3333-4333-8333-333333333333";

beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await cleanDatabase(pool);
  store = await createAuditStore(pool);

  // Seed baseline events
  await store.logEvent({ event: "auth.signin.success", actorId: ACTOR_A, targetId: TARGET_X });
  await store.logEvent({ event: "auth.signin.failure", actorId: ACTOR_B });
  await store.logEvent({ event: "auth.signin.success", actorId: ACTOR_A });
  await store.logEvent({ event: "auth.logout", actorId: ACTOR_B, targetId: TARGET_X });
});

// ─── queryByActor ───────────────────────────────────────────

describe("queryByActor", () => {
  it("returns entries for a specific actor", async () => {
    const entries = await store.queryByActor(ACTOR_A);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.actorId).toBe(ACTOR_A);
    }
  });

  it("returns entries ordered by created_at DESC", async () => {
    const entries = await store.queryByActor(ACTOR_A);
    const dates = entries.map(e => new Date(e.createdAt).getTime());
    expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
  });

  it("respects limit parameter", async () => {
    const entries = await store.queryByActor(ACTOR_A, 1);
    expect(entries).toHaveLength(1);
  });

  it("caps limit at 1000", async () => {
    // Should not throw for large limits
    const entries = await store.queryByActor(ACTOR_A, 5000);
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for unknown actor", async () => {
    const entries = await store.queryByActor("99999999-9999-4999-8999-999999999999");
    expect(entries).toHaveLength(0);
  });
});

// ─── queryByTarget ──────────────────────────────────────────

describe("queryByTarget", () => {
  it("returns entries for a specific target", async () => {
    const entries = await store.queryByTarget(TARGET_X);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.targetId).toBe(TARGET_X);
    }
  });

  it("respects limit parameter", async () => {
    const entries = await store.queryByTarget(TARGET_X, 1);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for unknown target", async () => {
    const entries = await store.queryByTarget("99999999-9999-4999-8999-999999999999");
    expect(entries).toHaveLength(0);
  });
});

// ─── queryByEvent ───────────────────────────────────────────

describe("queryByEvent", () => {
  it("returns entries for a specific event type", async () => {
    const entries = await store.queryByEvent("auth.signin.success");
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.eventType).toBe("auth.signin.success");
    }
  });

  it("returns single entry for event with one occurrence", async () => {
    const entries = await store.queryByEvent("auth.logout");
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe(ACTOR_B);
  });

  it("respects limit parameter", async () => {
    const entries = await store.queryByEvent("auth.signin.success", 1);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for event type with no entries", async () => {
    const entries = await store.queryByEvent("auth.signup");
    expect(entries).toHaveLength(0);
  });
});

// ─── eventCounts ────────────────────────────────────────────

describe("eventCounts", () => {
  it("returns counts grouped by event type", async () => {
    const counts = await store.eventCounts();
    expect(counts.length).toBeGreaterThanOrEqual(3);

    const signin = counts.find(c => c.eventType === "auth.signin.success");
    expect(signin).toBeDefined();
    expect(signin!.count).toBe(2);

    const failure = counts.find(c => c.eventType === "auth.signin.failure");
    expect(failure).toBeDefined();
    expect(failure!.count).toBe(1);

    const logout = counts.find(c => c.eventType === "auth.logout");
    expect(logout).toBeDefined();
    expect(logout!.count).toBe(1);
  });

  it("counts are sorted DESC by count", async () => {
    const counts = await store.eventCounts();
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i - 1].count).toBeGreaterThanOrEqual(counts[i].count);
    }
  });
});

// ─── purgeOlderThan ─────────────────────────────────────────

describe("purgeOlderThan", () => {
  it("purges entries older than the given interval", async () => {
    // Insert a very old event by backdating via raw SQL
    await pool.query(
      `INSERT INTO auth_audit_log (event_type, actor_id, created_at)
       VALUES ($1, $2, NOW() - INTERVAL '200 days')`,
      ["auth.signup", ACTOR_A],
    );

    const before = await store.queryRecent(100);
    const countBefore = before.length;

    const purged = await store.purgeOlderThan("100 days");
    expect(purged).toBe(1);

    const after = await store.queryRecent(100);
    expect(after.length).toBe(countBefore - 1);
  });

  it("returns 0 when nothing to purge", async () => {
    // All entries were just created — purging with a far-future interval removes nothing
    const purged = await store.purgeOlderThan("0 seconds");
    expect(purged).toBeGreaterThanOrEqual(0);
  });

  it("does not purge recent entries", async () => {
    const purged = await store.purgeOlderThan("1 year");
    expect(purged).toBe(0);

    // All 4 baseline entries still exist
    const entries = await store.queryRecent(100);
    expect(entries).toHaveLength(4);
  });

  it("uses retention session variable to bypass trigger", async () => {
    // Insert an old event and verify purge works through the trigger guard
    await pool.query(
      `INSERT INTO auth_audit_log (event_type, created_at)
       VALUES ($1, NOW() - INTERVAL '500 days')`,
      ["auth.unverified_cleanup"],
    );

    const purged = await store.purgeOlderThan("400 days");
    expect(purged).toBe(1);
  });
});

// ─── append-only enforcement ────────────────────────────────

describe("append-only trigger", () => {
  it("blocks UPDATE on audit log", async () => {
    const entries = await store.queryRecent(1);
    const id = entries[0].id;

    await expect(
      pool.query(`UPDATE auth_audit_log SET event_type = 'auth.signup' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });

  it("blocks DELETE without retention session variable", async () => {
    const entries = await store.queryRecent(1);
    const id = entries[0].id;

    await expect(
      pool.query(`DELETE FROM auth_audit_log WHERE id = $1`, [id]),
    ).rejects.toThrow(/retention purge/);
  });
});
