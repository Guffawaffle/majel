/**
 * loadout-routes.test.ts — Loadout API route tests (ADR-022 Phase 2)
 *
 * Supertest-based HTTP-level tests covering all ~22 loadout endpoints.
 * Tests against a live PostgreSQL with createApp() + createLoadoutStore().
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createLoadoutStore, type LoadoutStore } from "../src/server/stores/loadout-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Helpers ────────────────────────────────────────────────

const REF_DEFAULTS = {
  source: "test", sourceUrl: null, sourcePageId: null,
  sourceRevisionId: null, sourceRevisionTimestamp: null,
};

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    loadoutStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    userStore: null,
    startupComplete: false,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

async function seedShip(store: ReferenceStore, id: string, name: string) {
  await store.upsertShip({ id, name, shipClass: "Explorer", tier: 3, grade: null, rarity: null, faction: null, ...REF_DEFAULTS });
}

async function seedOfficer(store: ReferenceStore, id: string, name: string) {
  await store.upsertOfficer({ id, name, rarity: "Epic", groupName: "Test Group", captainManeuver: null, officerAbility: null, belowDeckAbility: null, ...REF_DEFAULTS });
}

// ═══════════════════════════════════════════════════════════════
// Store Not Available (503)
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — store not available", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("GET /api/loadouts returns 503 when store is null", async () => {
    const res = await testRequest(app).get("/api/loadouts");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("LOADOUT_STORE_NOT_AVAILABLE");
  });

  it("GET /api/docks returns 503 when store is null", async () => {
    const res = await testRequest(app).get("/api/docks");
    expect(res.status).toBe(503);
  });

  it("GET /api/plan returns 503 when store is null", async () => {
    const res = await testRequest(app).get("/api/plan");
    expect(res.status).toBe(503);
  });

  it("GET /api/intents returns 503 when store is null", async () => {
    const res = await testRequest(app).get("/api/intents");
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════════
// Intents
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Intents", () => {
  let app: Express;
  let store: LoadoutStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    await createReferenceStore(pool); // init schema
    store = await createLoadoutStore(pool);
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("GET /api/intents lists seeded intents", async () => {
    const res = await testRequest(app).get("/api/intents");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(0);
    expect(res.body.data.intents[0]).toHaveProperty("key");
    expect(res.body.data.intents[0]).toHaveProperty("label");
  });

  it("GET /api/intents?category=mining filters by category", async () => {
    const res = await testRequest(app).get("/api/intents?category=mining");
    expect(res.status).toBe(200);
    for (const i of res.body.data.intents) {
      expect(i.category).toBe("mining");
    }
  });

  it("GET /api/intents?category=bogus returns 400", async () => {
    const res = await testRequest(app).get("/api/intents?category=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_CATEGORY");
  });

  it("POST /api/intents creates a custom intent", async () => {
    const res = await testRequest(app).post("/api/intents").send({
      key: "test_custom", label: "Test Custom", category: "custom",
      description: "A test intent", icon: "🧪",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.intent.key).toBe("test_custom");
    expect(res.body.data.intent.isBuiltin).toBe(false);
  });

  it("POST /api/intents rejects missing fields", async () => {
    const res = await testRequest(app).post("/api/intents").send({ key: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("POST /api/intents rejects duplicate key", async () => {
    await testRequest(app).post("/api/intents").send({
      key: "dupe", label: "Dupe", category: "custom",
    });
    const res = await testRequest(app).post("/api/intents").send({
      key: "dupe", label: "Dupe 2", category: "custom",
    });
    expect(res.status).toBe(409);
  });

  it("DELETE /api/intents/:key deletes a custom intent", async () => {
    await testRequest(app).post("/api/intents").send({
      key: "to_delete", label: "Delete Me", category: "custom",
    });
    const res = await testRequest(app).delete("/api/intents/to_delete");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("DELETE /api/intents/:key rejects built-in intents", async () => {
    // First intent from seed should be built-in
    const list = await testRequest(app).get("/api/intents");
    const builtinKey = list.body.data.intents.find((i: { isBuiltin: boolean }) => i.isBuiltin)?.key;
    if (builtinKey) {
      const res = await testRequest(app).delete(`/api/intents/${builtinKey}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BUILTIN_IMMUTABLE");
    }
  });

  it("DELETE /api/intents/:key returns 404 for unknown key", async () => {
    const res = await testRequest(app).delete("/api/intents/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadouts
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Loadout CRUD", () => {
  let app: Express;
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "USS Enterprise");
    await seedShip(refStore, "wiki:ship:2", "USS Voyager");
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("GET /api/loadouts returns empty list initially", async () => {
    const res = await testRequest(app).get("/api/loadouts");
    expect(res.status).toBe(200);
    expect(res.body.data.loadouts).toEqual([]);
    expect(res.body.data.count).toBe(0);
  });

  it("POST /api/loadouts creates a loadout", async () => {
    const res = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "PvP Enterprise",
      intentKeys: ["hostile_grinding"], tags: ["pvp"],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.loadout.name).toBe("PvP Enterprise");
    expect(res.body.data.loadout.shipId).toBe("wiki:ship:1");
    expect(res.body.data.loadout.isActive).toBe(true);
  });

  it("POST /api/loadouts rejects missing fields", async () => {
    const res = await testRequest(app).post("/api/loadouts").send({ name: "No Ship" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("POST /api/loadouts rejects invalid shipId", async () => {
    const res = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:nonexistent", name: "Bad Ship",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("GET /api/loadouts/:id returns a specific loadout", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Test Loadout",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).get(`/api/loadouts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.loadout.id).toBe(id);
    expect(res.body.data.loadout.members).toEqual([]);
  });

  it("GET /api/loadouts/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).get("/api/loadouts/99999");
    expect(res.status).toBe(404);
  });

  it("GET /api/loadouts/:id returns 400 for invalid ID", async () => {
    const res = await testRequest(app).get("/api/loadouts/abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("PATCH /api/loadouts/:id updates a loadout", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Original",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).patch(`/api/loadouts/${id}`).send({
      name: "Updated", priority: 5, isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.loadout.name).toBe("Updated");
    expect(res.body.data.loadout.priority).toBe(5);
    expect(res.body.data.loadout.isActive).toBe(false);
  });

  it("PATCH /api/loadouts/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).patch("/api/loadouts/99999").send({ name: "Nope" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/loadouts/:id deletes a loadout", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "To Delete",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).delete(`/api/loadouts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    // Verify gone
    const get = await testRequest(app).get(`/api/loadouts/${id}`);
    expect(get.status).toBe(404);
  });

  it("DELETE /api/loadouts/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).delete("/api/loadouts/99999");
    expect(res.status).toBe(404);
  });

  it("GET /api/loadouts filters by shipId", async () => {
    await testRequest(app).post("/api/loadouts").send({ shipId: "wiki:ship:1", name: "A" });
    await testRequest(app).post("/api/loadouts").send({ shipId: "wiki:ship:2", name: "B" });

    const res = await testRequest(app).get("/api/loadouts?shipId=wiki:ship:1");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.loadouts[0].name).toBe("A");
  });

  it("GET /api/loadouts filters by active", async () => {
    await testRequest(app).post("/api/loadouts").send({ shipId: "wiki:ship:1", name: "Active" });
    const inactive = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:2", name: "Inactive", isActive: false,
    });
    expect(inactive.status).toBe(201);

    const res = await testRequest(app).get("/api/loadouts?active=true");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.loadouts[0].name).toBe("Active");
  });

  it("GET /api/loadouts/:id/preview-delete returns cascade preview", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Preview Me",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).get(`/api/loadouts/${id}/preview-delete`);
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toHaveProperty("planItems");
    expect(res.body.data.preview).toHaveProperty("memberCount");
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadout Members
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Members", () => {
  let app: Express;
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "Enterprise");
    await seedOfficer(refStore, "wiki:officer:1", "Kirk");
    await seedOfficer(refStore, "wiki:officer:2", "Spock");
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("PUT /api/loadouts/:id/members sets crew", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Crew Test",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).put(`/api/loadouts/${id}/members`).send({
      members: [
        { officerId: "wiki:officer:1", roleType: "bridge", slot: "captain" },
        { officerId: "wiki:officer:2", roleType: "below_deck" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(2);
  });

  it("PUT /api/loadouts/:id/members rejects missing array", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Bad Members",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).put(`/api/loadouts/${id}/members`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("PUT /api/loadouts/:id/members rejects invalid roleType", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Bad Role",
    });
    const id = create.body.data.loadout.id;

    const res = await testRequest(app).put(`/api/loadouts/${id}/members`).send({
      members: [{ officerId: "wiki:officer:1", roleType: "captain" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("PUT /api/loadouts/:id/members returns 404 for nonexistent loadout", async () => {
    const res = await testRequest(app).put("/api/loadouts/99999/members").send({
      members: [{ officerId: "wiki:officer:1", roleType: "bridge" }],
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/loadouts/:id includes members after set", async () => {
    const create = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "With Crew",
    });
    const id = create.body.data.loadout.id;
    await testRequest(app).put(`/api/loadouts/${id}/members`).send({
      members: [{ officerId: "wiki:officer:1", roleType: "bridge", slot: "captain" }],
    });

    const res = await testRequest(app).get(`/api/loadouts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.loadout.members).toHaveLength(1);
    expect(res.body.data.loadout.members[0].officerName).toBe("Kirk");
  });
});

// ═══════════════════════════════════════════════════════════════
// Docks
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Docks", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    await createReferenceStore(pool);
    const store = await createLoadoutStore(pool);
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("GET /api/docks returns empty list initially", async () => {
    const res = await testRequest(app).get("/api/docks");
    expect(res.status).toBe(200);
    expect(res.body.data.docks).toEqual([]);
  });

  it("PUT /api/docks/:num creates or updates a dock", async () => {
    const res = await testRequest(app).put("/api/docks/1").send({
      label: "Main Dock", notes: "Primary berth",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dock.dockNumber).toBe(1);
    expect(res.body.data.dock.label).toBe("Main Dock");
  });

  it("GET /api/docks/:num returns a specific dock", async () => {
    await testRequest(app).put("/api/docks/3").send({ label: "Dock 3" });
    const res = await testRequest(app).get("/api/docks/3");
    expect(res.status).toBe(200);
    expect(res.body.data.dock.dockNumber).toBe(3);
  });

  it("GET /api/docks/:num returns 404 for nonexistent", async () => {
    const res = await testRequest(app).get("/api/docks/99");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/docks/:num deletes a dock", async () => {
    await testRequest(app).put("/api/docks/2").send({ label: "Temp" });
    const res = await testRequest(app).delete("/api/docks/2");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("DELETE /api/docks/:num returns 404 for nonexistent", async () => {
    const res = await testRequest(app).delete("/api/docks/99");
    expect(res.status).toBe(404);
  });

  it("GET /api/docks/:num/preview-delete returns cascade preview", async () => {
    await testRequest(app).put("/api/docks/1").send({ label: "Preview" });
    const res = await testRequest(app).get("/api/docks/1/preview-delete");
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toHaveProperty("planItems");
  });

  it("rejects invalid dock number", async () => {
    const res = await testRequest(app).get("/api/docks/abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Items
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Plan Items", () => {
  let app: Express;
  let loadoutId: number;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const refStore = await createReferenceStore(pool);
    const store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "Enterprise");
    app = createApp(makeState({ loadoutStore: store }));

    // Create a loadout + dock for plan items to reference
    const loadout = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Plan Loadout",
    });
    loadoutId = loadout.body.data.loadout.id;
    await testRequest(app).put("/api/docks/1").send({ label: "Dock 1" });
  });

  it("GET /api/plan returns empty list initially", async () => {
    const res = await testRequest(app).get("/api/plan");
    expect(res.status).toBe(200);
    expect(res.body.data.planItems).toEqual([]);
  });

  it("POST /api/plan creates a plan item", async () => {
    const res = await testRequest(app).post("/api/plan").send({
      label: "Borg Loop", loadoutId, dockNumber: 1, priority: 1, isActive: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.planItem.label).toBe("Borg Loop");
    expect(res.body.data.planItem.loadoutId).toBe(loadoutId);
    expect(res.body.data.planItem.dockNumber).toBe(1);
  });

  it("GET /api/plan/:id returns a specific plan item", async () => {
    const create = await testRequest(app).post("/api/plan").send({
      label: "Mining Run", loadoutId,
    });
    const id = create.body.data.planItem.id;

    const res = await testRequest(app).get(`/api/plan/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.planItem.id).toBe(id);
  });

  it("GET /api/plan/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).get("/api/plan/99999");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/plan/:id updates a plan item", async () => {
    const create = await testRequest(app).post("/api/plan").send({
      label: "Original Plan", loadoutId,
    });
    const id = create.body.data.planItem.id;

    const res = await testRequest(app).patch(`/api/plan/${id}`).send({
      label: "Updated Plan", priority: 10, isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.planItem.label).toBe("Updated Plan");
    expect(res.body.data.planItem.priority).toBe(10);
  });

  it("PATCH /api/plan/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).patch("/api/plan/99999").send({ label: "Nope" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/plan/:id deletes a plan item", async () => {
    const create = await testRequest(app).post("/api/plan").send({
      label: "Delete Me",
    });
    const id = create.body.data.planItem.id;

    const res = await testRequest(app).delete(`/api/plan/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("DELETE /api/plan/:id returns 404 for nonexistent", async () => {
    const res = await testRequest(app).delete("/api/plan/99999");
    expect(res.status).toBe(404);
  });

  it("GET /api/plan filters by active", async () => {
    await testRequest(app).post("/api/plan").send({ label: "Active", isActive: true });
    await testRequest(app).post("/api/plan").send({ label: "Inactive", isActive: false });

    const res = await testRequest(app).get("/api/plan?active=true");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.planItems[0].label).toBe("Active");
  });

  it("GET /api/plan filters by dockNumber", async () => {
    await testRequest(app).post("/api/plan").send({ label: "Docked", dockNumber: 1 });
    await testRequest(app).post("/api/plan").send({ label: "Undocked" });

    const res = await testRequest(app).get("/api/plan?dockNumber=1");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.planItems[0].label).toBe("Docked");
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Away Members
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Away Members", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const refStore = await createReferenceStore(pool);
    const store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "Enterprise");
    await seedOfficer(refStore, "wiki:officer:1", "Kirk");
    await seedOfficer(refStore, "wiki:officer:2", "Spock");
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("PUT /api/plan/:id/away-members sets away team", async () => {
    const item = await testRequest(app).post("/api/plan").send({ label: "Away Mission" });
    const id = item.body.data.planItem.id;

    const res = await testRequest(app).put(`/api/plan/${id}/away-members`).send({
      officerIds: ["wiki:officer:1", "wiki:officer:2"],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.awayMembers).toHaveLength(2);
  });

  it("PUT /api/plan/:id/away-members rejects missing array", async () => {
    const item = await testRequest(app).post("/api/plan").send({ label: "Bad Away" });
    const id = item.body.data.planItem.id;

    const res = await testRequest(app).put(`/api/plan/${id}/away-members`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("PUT /api/plan/:id/away-members returns 404 for nonexistent item", async () => {
    const res = await testRequest(app).put("/api/plan/99999/away-members").send({
      officerIds: ["wiki:officer:1"],
    });
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// Validation, Conflicts, Briefing
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — Plan Validation + Conflicts + Briefing", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const refStore = await createReferenceStore(pool);
    const store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "Enterprise");
    await seedOfficer(refStore, "wiki:officer:1", "Kirk");
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("GET /api/plan/validate returns validation result", async () => {
    const res = await testRequest(app).get("/api/plan/validate");
    expect(res.status).toBe(200);
    expect(res.body.data.validation).toHaveProperty("valid");
    expect(res.body.data.validation).toHaveProperty("dockConflicts");
    expect(res.body.data.validation).toHaveProperty("officerConflicts");
  });

  it("GET /api/plan/conflicts returns officer conflicts", async () => {
    const res = await testRequest(app).get("/api/plan/conflicts");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("conflicts");
    expect(res.body.data.count).toBe(0); // No overlapping officers
  });

  it("GET /api/plan/briefing returns tier 1 briefing", async () => {
    const res = await testRequest(app).get("/api/plan/briefing");
    expect(res.status).toBe(200);
    expect(res.body.data.briefing.tier).toBe(1);
    expect(res.body.data.briefing).toHaveProperty("text");
    expect(res.body.data.briefing).toHaveProperty("totalChars");
    expect(res.body.data.briefing).toHaveProperty("summary");
  });

  it("GET /api/plan/briefing?tier=2 returns tier 2 briefing", async () => {
    const res = await testRequest(app).get("/api/plan/briefing?tier=2");
    expect(res.status).toBe(200);
    expect(res.body.data.briefing.tier).toBe(2);
  });

  it("GET /api/plan/briefing?tier=3 returns tier 3 briefing", async () => {
    const res = await testRequest(app).get("/api/plan/briefing?tier=3");
    expect(res.status).toBe(200);
    expect(res.body.data.briefing.tier).toBe(3);
  });

  it("GET /api/plan/briefing?tier=4 returns 400", async () => {
    const res = await testRequest(app).get("/api/plan/briefing?tier=4");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("briefing reflects active plan items", async () => {
    // Create a loadout, dock, and plan item
    const loadout = await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Enterprise PvP",
    });
    await testRequest(app).put("/api/docks/1").send({ label: "Main" });
    await testRequest(app).post("/api/plan").send({
      label: "Hostile Grinding", loadoutId: loadout.body.data.loadout.id,
      dockNumber: 1, isActive: true,
    });

    const res = await testRequest(app).get("/api/plan/briefing?tier=1");
    expect(res.status).toBe(200);
    expect(res.body.data.briefing.summary.activePlanItems).toBe(1);
    expect(res.body.data.briefing.summary.dockedItems).toBe(1);
    expect(res.body.data.briefing.text).toContain("Hostile Grinding");
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadouts by Intent + Officer Cascade Preview
// ═══════════════════════════════════════════════════════════════

describe("Loadout routes — By Intent + Officer Preview", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const refStore = await createReferenceStore(pool);
    const store = await createLoadoutStore(pool);
    await seedShip(refStore, "wiki:ship:1", "Enterprise");
    await seedOfficer(refStore, "wiki:officer:1", "Kirk");
    app = createApp(makeState({ loadoutStore: store }));
  });

  it("GET /api/loadouts/by-intent/:key returns matching loadouts", async () => {
    await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Miner",
      intentKeys: ["tritanium_mining"],
    });
    await testRequest(app).post("/api/loadouts").send({
      shipId: "wiki:ship:1", name: "Fighter",
      intentKeys: ["hostile_grinding"],
    });

    const res = await testRequest(app).get("/api/loadouts/by-intent/tritanium_mining");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.loadouts[0].name).toBe("Miner");
  });

  it("GET /api/loadouts/officers/:id/preview-delete returns preview", async () => {
    const res = await testRequest(app).get("/api/loadouts/officers/wiki:officer:1/preview-delete");
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toHaveProperty("loadoutMemberships");
    expect(res.body.data.preview).toHaveProperty("awayMemberships");
  });
});
