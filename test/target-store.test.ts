/**
 * target-store.test.ts — Integration tests for target/goal tracking store (#17)
 *
 * Covers:
 * - Schema creation (CREATE TABLE IF NOT EXISTS)
 * - CRUD operations for all three target types
 * - Filter queries (type, status, priority, refId)
 * - Mark achieved workflow
 * - Counts by type and status
 * - Validation constraints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createTargetStore, type TargetStore, type Target } from "../src/server/stores/target-store.js";

let pool: Pool;
let store: TargetStore;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanDatabase(pool);
  store = await createTargetStore(pool);
});

// ─── Schema ─────────────────────────────────────────────────

describe("schema", () => {
  it("creates targets table on init", async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'targets' ORDER BY ordinal_position`,
    );
    const cols = result.rows.map((r: Record<string, unknown>) => r.column_name);
    expect(cols).toContain("id");
    expect(cols).toContain("target_type");
    expect(cols).toContain("ref_id");
    expect(cols).toContain("loadout_id");
    expect(cols).toContain("target_tier");
    expect(cols).toContain("target_rank");
    expect(cols).toContain("target_level");
    expect(cols).toContain("reason");
    expect(cols).toContain("priority");
    expect(cols).toContain("status");
    expect(cols).toContain("auto_suggested");
    expect(cols).toContain("created_at");
    expect(cols).toContain("updated_at");
    expect(cols).toContain("achieved_at");
  });

  it("is idempotent (double init)", async () => {
    const store2 = await createTargetStore(pool);
    const { total } = await store2.counts();
    expect(total).toBe(0);
    store2.close();
  });
});

// ─── Create ─────────────────────────────────────────────────

describe("create", () => {
  it("creates an officer target", async () => {
    const target = await store.create({
      targetType: "officer",
      refId: "wiki:officer:1",
      targetRank: "Captain",
      reason: "Completes TOS Bridge trio",
      priority: 1,
    });
    expect(target.id).toBeGreaterThan(0);
    expect(target.targetType).toBe("officer");
    expect(target.refId).toBe("wiki:officer:1");
    expect(target.targetRank).toBe("Captain");
    expect(target.reason).toBe("Completes TOS Bridge trio");
    expect(target.priority).toBe(1);
    expect(target.status).toBe("active");
    expect(target.autoSuggested).toBe(false);
    expect(target.achievedAt).toBeNull();
  });

  it("creates a ship target", async () => {
    const target = await store.create({
      targetType: "ship",
      refId: "wiki:ship:1",
      targetTier: 8,
      reason: "Need G4 Explorer",
    });
    expect(target.targetType).toBe("ship");
    expect(target.refId).toBe("wiki:ship:1");
    expect(target.targetTier).toBe(8);
  });

  it("creates a crew target", async () => {
    // First create a loadout reference (just use a number since FK not enforced)
    const target = await store.create({
      targetType: "crew",
      loadoutId: 42,
      reason: "Need PMC mining crew",
      priority: 2,
    });
    expect(target.targetType).toBe("crew");
    expect(target.loadoutId).toBe(42);
  });

  it("creates an auto-suggested target", async () => {
    const target = await store.create({
      targetType: "officer",
      refId: "wiki:officer:99",
      reason: "Model-suggested: missing key crew member",
      autoSuggested: true,
    });
    expect(target.autoSuggested).toBe(true);
  });

  it("defaults priority to 2 and status to active", async () => {
    const target = await store.create({
      targetType: "ship",
      refId: "wiki:ship:5",
    });
    expect(target.priority).toBe(2);
    expect(target.status).toBe("active");
  });
});

// ─── Read ───────────────────────────────────────────────────

describe("get", () => {
  it("retrieves a target by ID", async () => {
    const created = await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    const found = await store.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.targetType).toBe("officer");
  });

  it("returns null for nonexistent ID", async () => {
    const found = await store.get(99999);
    expect(found).toBeNull();
  });
});

describe("list", () => {
  let t1: Target, t2: Target, t3: Target;

  beforeEach(async () => {
    t1 = await store.create({ targetType: "officer", refId: "wiki:officer:1", priority: 1 });
    t2 = await store.create({ targetType: "ship", refId: "wiki:ship:1", priority: 2 });
    t3 = await store.create({ targetType: "crew", loadoutId: 10, priority: 3 });
  });

  it("lists all targets", async () => {
    const targets = await store.list();
    expect(targets).toHaveLength(3);
  });

  it("filters by target type", async () => {
    const officers = await store.list({ targetType: "officer" });
    expect(officers).toHaveLength(1);
    expect(officers[0].id).toBe(t1.id);
  });

  it("filters by status", async () => {
    await store.markAchieved(t1.id);
    const active = await store.list({ status: "active" });
    expect(active).toHaveLength(2);
    const achieved = await store.list({ status: "achieved" });
    expect(achieved).toHaveLength(1);
    expect(achieved[0].id).toBe(t1.id);
  });

  it("filters by priority", async () => {
    const high = await store.list({ priority: 1 });
    expect(high).toHaveLength(1);
    expect(high[0].id).toBe(t1.id);
  });

  it("filters by refId", async () => {
    const byRef = await store.list({ refId: "wiki:ship:1" });
    expect(byRef).toHaveLength(1);
    expect(byRef[0].id).toBe(t2.id);
  });

  it("combines multiple filters", async () => {
    const filtered = await store.list({ targetType: "officer", status: "active" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].targetType).toBe("officer");
  });

  it("sorts by priority ascending, then created_at descending", async () => {
    const targets = await store.list();
    expect(targets[0].priority).toBe(1);
    expect(targets[2].priority).toBe(3);
  });
});

describe("listByRef", () => {
  it("finds all targets for a reference ID", async () => {
    await store.create({ targetType: "officer", refId: "wiki:officer:1", targetRank: "Rank1" });
    await store.create({ targetType: "officer", refId: "wiki:officer:1", targetLevel: 50 });
    await store.create({ targetType: "officer", refId: "wiki:officer:2" });

    const targets = await store.listByRef("wiki:officer:1");
    expect(targets).toHaveLength(2);
  });

  it("returns empty array for unknown ref", async () => {
    const targets = await store.listByRef("nonexistent");
    expect(targets).toHaveLength(0);
  });
});

// ─── Update ─────────────────────────────────────────────────

describe("update", () => {
  it("updates target fields", async () => {
    const target = await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    const updated = await store.update(target.id, {
      targetRank: "Commander",
      targetLevel: 45,
      reason: "Needs Commander rank for bridge",
      priority: 1,
    });
    expect(updated).not.toBeNull();
    expect(updated!.targetRank).toBe("Commander");
    expect(updated!.targetLevel).toBe(45);
    expect(updated!.reason).toBe("Needs Commander rank for bridge");
    expect(updated!.priority).toBe(1);
  });

  it("updates status to abandoned", async () => {
    const target = await store.create({ targetType: "ship", refId: "wiki:ship:1" });
    const updated = await store.update(target.id, { status: "abandoned" });
    expect(updated!.status).toBe("abandoned");
  });

  it("returns null for nonexistent ID", async () => {
    const updated = await store.update(99999, { reason: "nope" });
    expect(updated).toBeNull();
  });

  it("preserves unchanged fields", async () => {
    const target = await store.create({
      targetType: "officer",
      refId: "wiki:officer:1",
      reason: "Original reason",
      priority: 1,
    });
    const updated = await store.update(target.id, { targetLevel: 50 });
    expect(updated!.reason).toBe("Original reason");
    expect(updated!.priority).toBe(1);
  });
});

// ─── Delete ─────────────────────────────────────────────────

describe("delete", () => {
  it("deletes a target", async () => {
    const target = await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    const deleted = await store.delete(target.id);
    expect(deleted).toBe(true);
    const found = await store.get(target.id);
    expect(found).toBeNull();
  });

  it("returns false for nonexistent ID", async () => {
    const deleted = await store.delete(99999);
    expect(deleted).toBe(false);
  });
});

// ─── Mark Achieved ──────────────────────────────────────────

describe("markAchieved", () => {
  it("sets status and achievedAt timestamp", async () => {
    const target = await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    const achieved = await store.markAchieved(target.id);
    expect(achieved).not.toBeNull();
    expect(achieved!.status).toBe("achieved");
    expect(achieved!.achievedAt).not.toBeNull();
    // achievedAt should be a valid ISO timestamp
    expect(new Date(achieved!.achievedAt!).getTime()).not.toBeNaN();
  });

  it("returns null for nonexistent ID", async () => {
    const result = await store.markAchieved(99999);
    expect(result).toBeNull();
  });
});

// ─── Counts ─────────────────────────────────────────────────

describe("counts", () => {
  it("returns counts by status and type", async () => {
    await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    await store.create({ targetType: "officer", refId: "wiki:officer:2" });
    await store.create({ targetType: "ship", refId: "wiki:ship:1" });
    const crew = await store.create({ targetType: "crew", loadoutId: 10 });
    await store.markAchieved(crew.id);

    const counts = await store.counts();
    expect(counts.total).toBe(4);
    expect(counts.active).toBe(3);
    expect(counts.achieved).toBe(1);
    expect(counts.abandoned).toBe(0);
    expect(counts.byType.officer).toBe(2);
    expect(counts.byType.ship).toBe(1);
    expect(counts.byType.crew).toBe(1);
  });

  it("returns all zeros on empty table", async () => {
    const counts = await store.counts();
    expect(counts.total).toBe(0);
    expect(counts.active).toBe(0);
    expect(counts.byType.officer).toBe(0);
  });
});

// ─── Constraints ────────────────────────────────────────────

describe("constraints", () => {
  it("rejects invalid target type", async () => {
    await expect(
      store.create({ targetType: "invalid" as never }),
    ).rejects.toThrow();
  });

  it("rejects priority out of range", async () => {
    await expect(
      store.create({ targetType: "officer", refId: "wiki:officer:1", priority: 0 }),
    ).rejects.toThrow();
    await expect(
      store.create({ targetType: "officer", refId: "wiki:officer:1", priority: 4 }),
    ).rejects.toThrow();
  });

  it("rejects invalid status on update", async () => {
    const target = await store.create({ targetType: "officer", refId: "wiki:officer:1" });
    await expect(
      store.update(target.id, { status: "invalid" as never }),
    ).rejects.toThrow();
  });
});
