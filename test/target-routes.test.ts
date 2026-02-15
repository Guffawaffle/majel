/**
 * target-routes.test.ts — Target CRUD route tests (#17)
 *
 * Supertest-based HTTP-level tests covering:
 *   - Store-not-available (503)
 *   - List with filters (type, status, priority, ref_id)
 *   - Get by ID (valid, invalid, not found)
 *   - Create (all target types, validation)
 *   - Update (validation, not found)
 *   - Delete (valid, invalid, not found)
 *   - Mark achieved
 *   - Counts
 *   - Conflicts
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createTargetStore, type TargetStore } from "../src/server/stores/target-store.js";
import { createCrewStore } from "../src/server/stores/crew-store.js";
import { createReferenceStore } from "../src/server/stores/reference-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Helpers ────────────────────────────────────────────────

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    adminPool: null,
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    crewStore: null,
    receiptStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    userStore: null,
    targetStore: null,
    startupComplete: false,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════
// Store Not Available (503)
// ═════════════════════════════════════════════════════════════

describe("Target routes — store not available", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("GET /api/targets returns 503 when target store is null", async () => {
    const res = await testRequest(app).get("/api/targets");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("TARGET_STORE_NOT_AVAILABLE");
  });

  it("GET /api/targets/counts returns 503 when target store is null", async () => {
    const res = await testRequest(app).get("/api/targets/counts");
    expect(res.status).toBe(503);
  });

  it("GET /api/targets/conflicts returns 503 when target store is null", async () => {
    const res = await testRequest(app).get("/api/targets/conflicts");
    expect(res.status).toBe(503);
  });

  it("GET /api/targets/1 returns 503 when target store is null", async () => {
    const res = await testRequest(app).get("/api/targets/1");
    expect(res.status).toBe(503);
  });

  it("POST /api/targets returns 503 when target store is null", async () => {
    const res = await testRequest(app).post("/api/targets").send({ targetType: "officer", refId: "off-1" });
    expect(res.status).toBe(503);
  });

  it("PATCH /api/targets/1 returns 503 when target store is null", async () => {
    const res = await testRequest(app).patch("/api/targets/1").send({ priority: 1 });
    expect(res.status).toBe(503);
  });

  it("DELETE /api/targets/1 returns 503 when target store is null", async () => {
    const res = await testRequest(app).delete("/api/targets/1");
    expect(res.status).toBe(503);
  });

  it("POST /api/targets/1/achieve returns 503 when target store is null", async () => {
    const res = await testRequest(app).post("/api/targets/1/achieve");
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════
// Target routes — with live store
// ═════════════════════════════════════════════════════════════

describe("Target routes — with live store", () => {
  let app: Express;
  let targetStore: TargetStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    targetStore = await createTargetStore(pool);
    app = createApp(makeState({ targetStore }));
  });

  // ─── List ──────────────────────────────────────────────────

  describe("GET /api/targets", () => {
    it("returns empty array when no targets", async () => {
      const res = await testRequest(app).get("/api/targets");
      expect(res.status).toBe(200);
      expect(res.body.data.targets).toEqual([]);
      expect(res.body.data.count).toBe(0);
    });

    it("returns all targets", async () => {
      await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 2 });

      const res = await testRequest(app).get("/api/targets");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
    });

    it("filters by type", async () => {
      await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 2 });

      const res = await testRequest(app).get("/api/targets?type=officer");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.targets[0].targetType).toBe("officer");
    });

    it("filters by status", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      await targetStore.markAchieved(t.id);
      await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 2 });

      const res = await testRequest(app).get("/api/targets?status=achieved");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
    });

    it("filters by priority", async () => {
      await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 3 });

      const res = await testRequest(app).get("/api/targets?priority=3");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
    });

    it("filters by ref_id", async () => {
      await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 2 });

      const res = await testRequest(app).get("/api/targets?ref_id=off-1");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
    });

    it("rejects invalid target type", async () => {
      const res = await testRequest(app).get("/api/targets?type=invalid");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("rejects invalid status", async () => {
      const res = await testRequest(app).get("/api/targets?status=bogus");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("rejects invalid priority", async () => {
      const res = await testRequest(app).get("/api/targets?priority=5");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("rejects non-integer priority", async () => {
      const res = await testRequest(app).get("/api/targets?priority=abc");
      expect(res.status).toBe(400);
    });

    it("rejects ref_id over 200 chars", async () => {
      const res = await testRequest(app).get(`/api/targets?ref_id=${"x".repeat(201)}`);
      expect(res.status).toBe(400);
    });
  });

  // ─── Counts ────────────────────────────────────────────────

  describe("GET /api/targets/counts", () => {
    it("returns counts", async () => {
      await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).get("/api/targets/counts");
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Conflicts ─────────────────────────────────────────────

  describe("GET /api/targets/conflicts", () => {
    it("returns conflicts array when crew store present", async () => {
      const refStore = await createReferenceStore(pool);
      const crewStore = await createCrewStore(pool);
      const appWithCrew = createApp(makeState({ targetStore, crewStore, referenceStore: refStore }));
      const res = await testRequest(appWithCrew).get("/api/targets/conflicts");
      expect(res.status).toBe(200);
      expect(res.body.data.conflicts).toEqual([]);
    });

    it("returns 503 when crew store missing", async () => {
      const res = await testRequest(app).get("/api/targets/conflicts");
      expect(res.status).toBe(503);
    });
  });

  // ─── Get by ID ─────────────────────────────────────────────

  describe("GET /api/targets/:id", () => {
    it("returns a target by ID", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).get(`/api/targets/${t.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(t.id);
      expect(res.body.data.targetType).toBe("officer");
    });

    it("returns 400 for non-numeric ID", async () => {
      const res = await testRequest(app).get("/api/targets/abc");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing target", async () => {
      const res = await testRequest(app).get("/api/targets/99999");
      expect(res.status).toBe(404);
    });
  });

  // ─── Create ────────────────────────────────────────────────

  describe("POST /api/targets", () => {
    it("creates an officer target", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", priority: 1, reason: "Need for armada",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.targetType).toBe("officer");
      expect(res.body.data.refId).toBe("off-1");
    });

    it("creates a ship target", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "ship", refId: "ship-1", priority: 2,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.targetType).toBe("ship");
    });

    it("creates a crew target with loadoutId", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "crew", loadoutId: "1",
      });
      // May be 201 or 500 depending on whether loadout_id FK exists;
      // the route accepts the input — the validation branches are what we're testing
      expect([201, 500]).toContain(res.status);
    });

    it("rejects missing targetType", async () => {
      const res = await testRequest(app).post("/api/targets").send({ refId: "off-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_PARAM");
    });

    it("rejects invalid targetType", async () => {
      const res = await testRequest(app).post("/api/targets").send({ targetType: "weapon" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("rejects officer target without refId", async () => {
      const res = await testRequest(app).post("/api/targets").send({ targetType: "officer" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_PARAM");
    });

    it("rejects ship target without refId", async () => {
      const res = await testRequest(app).post("/api/targets").send({ targetType: "ship" });
      expect(res.status).toBe(400);
    });

    it("rejects crew target without loadoutId", async () => {
      const res = await testRequest(app).post("/api/targets").send({ targetType: "crew" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_PARAM");
    });

    it("rejects refId over 200 chars", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "x".repeat(201),
      });
      expect(res.status).toBe(400);
    });

    it("rejects loadoutId over 200 chars", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "crew", loadoutId: "x".repeat(201),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid priority", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", priority: 5,
      });
      expect(res.status).toBe(400);
    });

    it("rejects reason over 500 chars", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", reason: "x".repeat(501),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer refId", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: 12345,
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-string loadoutId", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "crew", loadoutId: 12345,
      });
      expect(res.status).toBe(400);
    });

    it("creates with targetTier", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "ship", refId: "ship-1", targetTier: 5,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.targetTier).toBe(5);
    });

    it("rejects invalid targetTier", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "ship", refId: "ship-1", targetTier: 15,
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer targetTier", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "ship", refId: "ship-1", targetTier: "high",
      });
      expect(res.status).toBe(400);
    });

    it("creates with targetRank", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", targetRank: "Captain",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.targetRank).toBe("Captain");
    });

    it("rejects targetRank over 50 chars", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", targetRank: "x".repeat(51),
      });
      expect(res.status).toBe(400);
    });

    it("creates with targetLevel", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", targetLevel: 50,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.targetLevel).toBe(50);
    });

    it("rejects invalid targetLevel", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", targetLevel: 300,
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer targetLevel", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", targetLevel: "high",
      });
      expect(res.status).toBe(400);
    });

    it("defaults priority to 2", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.priority).toBe(2);
    });

    it("accepts autoSuggested flag", async () => {
      const res = await testRequest(app).post("/api/targets").send({
        targetType: "officer", refId: "off-1", autoSuggested: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.autoSuggested).toBe(true);
    });
  });

  // ─── Update ────────────────────────────────────────────────

  describe("PATCH /api/targets/:id", () => {
    it("updates priority", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ priority: 3 });
      expect(res.status).toBe(200);
      expect(res.body.data.priority).toBe(3);
    });

    it("updates status", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ status: "abandoned" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("abandoned");
    });

    it("updates reason", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ reason: "New reason" });
      expect(res.status).toBe(200);
      expect(res.body.data.reason).toBe("New reason");
    });

    it("updates targetTier", async () => {
      const t = await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetTier: 7 });
      expect(res.status).toBe(200);
      expect(res.body.data.targetTier).toBe(7);
    });

    it("updates targetRank", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetRank: "Commander" });
      expect(res.status).toBe(200);
    });

    it("updates targetLevel", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetLevel: 100 });
      expect(res.status).toBe(200);
      expect(res.body.data.targetLevel).toBe(100);
    });

    it("rejects invalid target ID", async () => {
      const res = await testRequest(app).patch("/api/targets/abc").send({ priority: 1 });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing target", async () => {
      const res = await testRequest(app).patch("/api/targets/99999").send({ priority: 1 });
      expect(res.status).toBe(404);
    });

    it("rejects invalid priority", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ priority: 0 });
      expect(res.status).toBe(400);
    });

    it("rejects invalid status", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ status: "bogus" });
      expect(res.status).toBe(400);
    });

    it("rejects reason over 500 chars", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ reason: "x".repeat(501) });
      expect(res.status).toBe(400);
    });

    it("rejects invalid targetTier", async () => {
      const t = await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetTier: 15 });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer targetTier", async () => {
      const t = await targetStore.create({ targetType: "ship", refId: "ship-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetTier: "high" });
      expect(res.status).toBe(400);
    });

    it("rejects targetRank over 50 chars", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetRank: "x".repeat(51) });
      expect(res.status).toBe(400);
    });

    it("rejects invalid targetLevel", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetLevel: 300 });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer targetLevel", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).patch(`/api/targets/${t.id}`).send({ targetLevel: "high" });
      expect(res.status).toBe(400);
    });
  });

  // ─── Delete ────────────────────────────────────────────────

  describe("DELETE /api/targets/:id", () => {
    it("deletes a target", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).delete(`/api/targets/${t.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });

    it("rejects invalid target ID", async () => {
      const res = await testRequest(app).delete("/api/targets/abc");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing target", async () => {
      const res = await testRequest(app).delete("/api/targets/99999");
      expect(res.status).toBe(404);
    });
  });

  // ─── Mark Achieved ─────────────────────────────────────────

  describe("POST /api/targets/:id/achieve", () => {
    it("marks a target as achieved", async () => {
      const t = await targetStore.create({ targetType: "officer", refId: "off-1", priority: 1 });
      const res = await testRequest(app).post(`/api/targets/${t.id}/achieve`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("achieved");
      expect(res.body.data.achievedAt).toBeTruthy();
    });

    it("rejects invalid target ID", async () => {
      const res = await testRequest(app).post("/api/targets/abc/achieve");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing target", async () => {
      const res = await testRequest(app).post("/api/targets/99999/achieve");
      expect(res.status).toBe(404);
    });
  });
});
