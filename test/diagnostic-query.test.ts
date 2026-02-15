/**
 * diagnostic-query.test.ts — Tests for AI DB Query Tool
 *
 * Tests the /api/diagnostic/* endpoints: schema introspection,
 * read-only SQL queries, and canned summary.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { testRequest } from "./helpers/test-request.js";
import { createApp, type AppState } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createOverlayStore, type OverlayStore } from "../src/server/stores/overlay-store.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

// ─── Helpers ────────────────────────────────────────────────

let pool: Pool;
let refStore: ReferenceStore;
let overlayStore: OverlayStore;

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    startupComplete: true,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

async function seedData(store: ReferenceStore) {
  await store.upsertOfficer({
    id: "raw:officer:100",
    name: "Kirk",
    rarity: "epic",
    groupName: "Command",
    captainManeuver: "Inspirational",
    officerAbility: "Lead By Example",
    belowDeckAbility: null,
    source: "datamine",
    sourceUrl: null,
    sourcePageId: "100",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  await store.upsertOfficer({
    id: "raw:officer:101",
    name: "Spock",
    rarity: "epic",
    groupName: "Science",
    captainManeuver: "Logical Analysis",
    officerAbility: "Science Officer",
    belowDeckAbility: null,
    source: "datamine",
    sourceUrl: null,
    sourcePageId: "101",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  await store.upsertShip({
    id: "raw:ship:200",
    name: "USS Enterprise",
    shipClass: "Explorer",
    grade: 3,
    rarity: "epic",
    faction: "Federation",
    tier: 8,
    source: "datamine",
    sourceUrl: null,
    sourcePageId: "200",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
}

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await cleanDatabase(pool);
  refStore = await createReferenceStore(pool);
  overlayStore = await createOverlayStore(pool);
});

afterAll(async () => {
  await pool.end();
});

// ═════════════════════════════════════════════════════════════
// Schema Endpoint
// ═════════════════════════════════════════════════════════════

describe("GET /api/diagnostic/schema", () => {
  it("returns table list with columns and row counts", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/schema");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.tables).toBeInstanceOf(Array);
    expect(res.body.data.tables.length).toBeGreaterThanOrEqual(2);

    const officers = res.body.data.tables.find((t: { table: string }) => t.table === "reference_officers");
    expect(officers).toBeDefined();
    expect(officers.rowCount).toBe(2);
    expect(officers.columns.length).toBeGreaterThan(5);
    expect(officers.columns[0]).toHaveProperty("name");
    expect(officers.columns[0]).toHaveProperty("type");
  });

  it("includes indexes", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/schema");

    const officers = res.body.data.tables.find((t: { table: string }) => t.table === "reference_officers");
    expect(officers.indexes.length).toBeGreaterThan(0);
    expect(officers.indexes[0]).toHaveProperty("name");
  });

  it("returns 503 when reference store not available", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/diagnostic/schema");
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════
// Query Endpoint
// ═════════════════════════════════════════════════════════════

describe("GET /api/diagnostic/query", () => {
  it("executes a SELECT query and returns rows", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "SELECT id, name, rarity FROM reference_officers ORDER BY name" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.columns).toEqual(["id", "name", "rarity"]);
    expect(res.body.data.rows).toHaveLength(2);
    expect(res.body.data.rows[0].name).toBe("Kirk");
    expect(res.body.data.rows[1].name).toBe("Spock");
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.durationMs).toBeTypeOf("number");
  });

  it("supports information_schema queries", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'reference_officers'" });

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  it("supports WITH (CTE) queries", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "WITH counts AS (SELECT COUNT(*) AS c FROM reference_officers) SELECT c FROM counts" });

    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].c).toBe("2");
  });

  it("rejects non-SELECT statements", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));

    const dangerous = [
      "INSERT INTO reference_officers (id, name, source, license, attribution, created_at, updated_at) VALUES ('x','x','x','x','x','x','x')",
      "UPDATE reference_officers SET name = 'hacked'",
      "DELETE FROM reference_officers",
      "DROP TABLE reference_officers",
    ];

    for (const sql of dangerous) {
      const res = await testRequest(app)
        .get("/api/diagnostic/query")
        .query({ sql });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
  });

  it("requires sql parameter", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/query");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("enforces row limit", async () => {
    // Seed many officers
    for (let i = 0; i < 15; i++) {
      await refStore.upsertOfficer({
        id: `raw:officer:${1000 + i}`,
        name: `Officer ${i}`,
        rarity: "common",
        groupName: null,
        captainManeuver: null,
        officerAbility: null,
        belowDeckAbility: null,
        source: "test",
        sourceUrl: null,
        sourcePageId: null,
        sourceRevisionId: null,
        sourceRevisionTimestamp: null,
      });
    }

    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "SELECT * FROM reference_officers", limit: "5" });

    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(5);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.totalBeforeLimit).toBe(15);
  });

  it("returns SQL error for malformed queries", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "SELECT * FROM nonexistent_table" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("SQL error");
  });

  it("returns 503 when reference store not available", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app)
      .get("/api/diagnostic/query")
      .query({ sql: "SELECT 1" });
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════
// Summary Endpoint
// ═════════════════════════════════════════════════════════════

describe("GET /api/diagnostic/summary", () => {
  it("returns reference counts and breakdowns", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/summary");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = res.body.data;
    expect(data.reference.officers.total).toBe(2);
    expect(data.reference.ships.total).toBe(1);
    expect(data.reference.officers.byRarity).toBeInstanceOf(Array);
    expect(data.reference.ships.byClass).toBeInstanceOf(Array);
    expect(data.reference.ships.byFaction).toBeInstanceOf(Array);
  });

  it("includes overlay breakdown", async () => {
    await seedData(refStore);
    await overlayStore.setOfficerOverlay({ refId: "raw:officer:100", ownershipState: "owned" });
    await overlayStore.setOfficerOverlay({ refId: "raw:officer:101", ownershipState: "unowned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/summary");

    const overlay = res.body.data.overlay;
    expect(overlay.officers.total).toBe(2);
    expect(overlay.officers.byOwnership).toBeInstanceOf(Array);
    expect(overlay.officers.byOwnership.length).toBeGreaterThan(0);
  });

  it("includes sample data", async () => {
    await seedData(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore, pool }));
    const res = await testRequest(app).get("/api/diagnostic/summary");

    expect(res.body.data.samples.officers).toBeInstanceOf(Array);
    expect(res.body.data.samples.officers.length).toBeGreaterThan(0);
    expect(res.body.data.samples.officers[0]).toHaveProperty("name");
    expect(res.body.data.samples.ships).toBeInstanceOf(Array);
  });

  it("returns 503 when reference store not available", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/diagnostic/summary");
    expect(res.status).toBe(503);
  });
});
