/**
 * catalog.test.ts — Integration tests for Catalog API routes (ADR-016 Phase 2)
 *
 * Tests the reference catalog browsing endpoints and overlay CRUD/bulk operations.
 * Uses real SQLite stores (reference + overlay) in temp directories.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createOverlayStore, type OverlayStore } from "../src/server/stores/overlay-store.js";
import { makeReadyState as makeState } from "./helpers/make-state.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

// ─── Helpers ────────────────────────────────────────────────

let pool: Pool;
let refStore: ReferenceStore;
let overlayStore: OverlayStore;

beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// makeState imported from ./helpers/make-state.js (makeReadyState)

async function seedOfficers(store: ReferenceStore) {
  await store.upsertOfficer({
    id: "cdn:officer:100",
    name: "Kirk",
    rarity: "epic",
    groupName: "Command",
    captainManeuver: "Inspirational",
    officerAbility: "Lead By Example",
    belowDeckAbility: null,
    source: "gamedata",
    sourceUrl: null,
    sourcePageId: "100",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  await store.upsertOfficer({
    id: "cdn:officer:101",
    name: "Spock",
    rarity: "epic",
    groupName: "Science",
    captainManeuver: "Logical Analysis",
    officerAbility: "Science Officer",
    belowDeckAbility: null,
    source: "gamedata",
    sourceUrl: null,
    sourcePageId: "101",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  await store.upsertOfficer({
    id: "cdn:officer:102",
    name: "Uhura",
    rarity: "rare",
    groupName: "Command",
    captainManeuver: "Frequencies Open",
    officerAbility: "Comm Officer",
    belowDeckAbility: null,
    source: "gamedata",
    sourceUrl: null,
    sourcePageId: "102",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
}

async function seedShips(store: ReferenceStore) {
  await store.upsertShip({
    id: "cdn:ship:200",
    name: "USS Enterprise",
    shipClass: "Explorer",
    grade: 3,
    rarity: "epic",
    faction: "Federation",
    tier: 8,
    source: "gamedata",
    sourceUrl: null,
    sourcePageId: "200",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  await store.upsertShip({
    id: "cdn:ship:201",
    name: "USS Saladin",
    shipClass: "Interceptor",
    grade: 2,
    rarity: "rare",
    faction: "Federation",
    tier: 5,
    source: "gamedata",
    sourceUrl: null,
    sourcePageId: "201",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
}

beforeEach(async () => {
  await cleanDatabase(pool);
  refStore = await createReferenceStore(pool);
  overlayStore = await createOverlayStore(pool);
});

// ═══════════════════════════════════════════════════════════
// Reference Catalog — Officers
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/officers", () => {
  it("returns empty array when no officers exist", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.officers).toEqual([]);
    expect(res.body.data.count).toBe(0);
  });

  it("lists all officers", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    const names = res.body.data.officers.map((o: { name: string }) => o.name);
    expect(names).toContain("Kirk");
    expect(names).toContain("Spock");
    expect(names).toContain("Uhura");
  });

  it("searches officers by name", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers?q=kirk");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Kirk");
  });

  it("filters officers by rarity", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers?rarity=rare");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Uhura");
  });

  it("filters officers by group", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers?group=Command");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("returns 503 when reference store unavailable", async () => {
    const app = createApp(makeState({ referenceStore: null }));
    const res = await testRequest(app).get("/api/catalog/officers");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});

describe("GET /api/catalog/officers/:id", () => {
  it("returns a single officer", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers/cdn:officer:100");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Kirk");
    expect(res.body.data.rarity).toBe("epic");
  });

  it("returns 404 for unknown officer", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers/cdn:officer:999");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Reference Catalog — Ships
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/ships", () => {
  it("lists all ships", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("filters ships by faction", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships?faction=Federation");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("filters ships by class", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships?class=Explorer");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.ships[0].name).toBe("USS Enterprise");
  });

  it("searches ships by name", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships?q=saladin");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.ships[0].name).toBe("USS Saladin");
  });
});

describe("GET /api/catalog/ships/:id", () => {
  it("returns a single ship", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships/cdn:ship:200");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("USS Enterprise");
    expect(res.body.data.shipClass).toBe("Explorer");
  });

  it("returns 404 for unknown ship", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/ships/cdn:ship:999");
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Counts
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/counts", () => {
  it("returns reference and overlay counts", async () => {
    await seedOfficers(refStore);
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/counts");
    expect(res.status).toBe(200);
    expect(res.body.data.reference.officers).toBe(3);
    expect(res.body.data.reference.ships).toBe(2);
    expect(res.body.data.overlay.officers).toBeDefined();
    expect(res.body.data.overlay.ships).toBeDefined();
  });

  it("returns zero counts when stores are null", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/catalog/counts");
    expect(res.status).toBe(200);
    expect(res.body.data.reference.officers).toBe(0);
    expect(res.body.data.reference.ships).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Merged Views
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/officers/merged", () => {
  it("returns officers with default unowned ownership", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers/merged");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    // All should have unowned ownership by default
    for (const o of res.body.data.officers) {
      expect(o.ownershipState).toBe("unowned");
      expect(o.target).toBe(false);
    }
  });

  it("merges overlay state correctly", async () => {
    await seedOfficers(refStore);
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:100", ownershipState: "owned", target: true });
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:101", ownershipState: "unowned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app).get("/api/catalog/officers/merged");
    expect(res.status).toBe(200);

    const kirk = res.body.data.officers.find((o: { id: string }) => o.id === "cdn:officer:100");
    expect(kirk.ownershipState).toBe("owned");
    expect(kirk.target).toBe(true);

    const spock = res.body.data.officers.find((o: { id: string }) => o.id === "cdn:officer:101");
    expect(spock.ownershipState).toBe("unowned");
    expect(spock.target).toBe(false);

    const uhura = res.body.data.officers.find((o: { id: string }) => o.id === "cdn:officer:102");
    expect(uhura.ownershipState).toBe("unowned");
  });

  it("filters merged by ownership state", async () => {
    await seedOfficers(refStore);
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:100", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).get("/api/catalog/officers/merged?ownership=owned");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Kirk");
  });

  it("filters merged by target", async () => {
    await seedOfficers(refStore);
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:101", target: true });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const targeted = await testRequest(app).get("/api/catalog/officers/merged?target=true");
    expect(targeted.body.data.count).toBe(1);
    expect(targeted.body.data.officers[0].name).toBe("Spock");

    const notTargeted = await testRequest(app).get("/api/catalog/officers/merged?target=false");
    expect(notTargeted.body.data.count).toBe(2);
  });

  it("uses OR when both ownership and target filters are active", async () => {
    await seedOfficers(refStore);
    // Kirk is owned (not targeted), Spock is targeted (not owned), Uhura is neither
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:100", ownershipState: "owned" });
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:101", target: true });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).get("/api/catalog/officers/merged?ownership=owned&target=true");
    expect(res.status).toBe(200);
    // OR: Kirk (owned) + Spock (targeted) = 2
    expect(res.body.data.count).toBe(2);
    const names = res.body.data.officers.map((o: { name: string }) => o.name).sort();
    expect(names).toEqual(["Kirk", "Spock"]);
  });

  it("combines search + overlay filter", async () => {
    await seedOfficers(refStore);
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:100", ownershipState: "owned" });
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:102", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).get("/api/catalog/officers/merged?group=Command&ownership=owned");
    expect(res.status).toBe(200);
    // Kirk (owned, Command) and Uhura (owned, Command)
    expect(res.body.data.count).toBe(2);
  });
});

describe("GET /api/catalog/ships/merged", () => {
  it("returns ships with overlay state", async () => {
    await seedShips(refStore);
    await overlayStore.setShipOverlay({ refId: "cdn:ship:200", ownershipState: "owned", target: true });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).get("/api/catalog/ships/merged");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);

    const enterprise = res.body.data.ships.find((s: { id: string }) => s.id === "cdn:ship:200");
    expect(enterprise.ownershipState).toBe("owned");
    expect(enterprise.target).toBe(true);
  });

  it("filters by ownership and class", async () => {
    await seedShips(refStore);
    await overlayStore.setShipOverlay({ refId: "cdn:ship:200", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).get("/api/catalog/ships/merged?class=Explorer&ownership=owned");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.ships[0].name).toBe("USS Enterprise");
  });
});

// ═══════════════════════════════════════════════════════════
// Overlay CRUD — Officers
// ═══════════════════════════════════════════════════════════

describe("PATCH /api/catalog/officers/:id/overlay", () => {
  it("sets ownership state", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/officers/cdn:officer:100/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(200);
    expect(res.body.data.ownershipState).toBe("owned");
  });

  it("sets target flag", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/officers/cdn:officer:100/overlay")
      .send({ target: true });
    expect(res.status).toBe(200);
    expect(res.body.data.target).toBe(true);
  });

  it("rejects invalid ownership state", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/officers/cdn:officer:100/overlay")
      .send({ ownershipState: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 404 for non-existent reference officer", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/officers/cdn:officer:999/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(404);
  });

  it("returns 503 when overlay store unavailable", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore: null }));
    const res = await testRequest(app)
      .patch("/api/catalog/officers/cdn:officer:100/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/catalog/officers/:id/overlay", () => {
  it("deletes an officer overlay", async () => {
    await seedOfficers(refStore);
    await overlayStore.setOfficerOverlay({ refId: "cdn:officer:100", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).delete("/api/catalog/officers/cdn:officer:100/overlay");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    // Verify it's gone
    const overlay = await overlayStore.getOfficerOverlay("cdn:officer:100");
    expect(overlay).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Overlay CRUD — Ships
// ═══════════════════════════════════════════════════════════

describe("PATCH /api/catalog/ships/:id/overlay", () => {
  it("sets ship ownership and target", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/ships/cdn:ship:200/overlay")
      .send({ ownershipState: "owned", target: true });
    expect(res.status).toBe(200);
    expect(res.body.data.ownershipState).toBe("owned");
  });

  it("returns 404 for non-existent reference ship", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .patch("/api/catalog/ships/cdn:ship:999/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/catalog/ships/:id/overlay", () => {
  it("deletes a ship overlay", async () => {
    await seedShips(refStore);
    await overlayStore.setShipOverlay({ refId: "cdn:ship:200", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await testRequest(app).delete("/api/catalog/ships/cdn:ship:200/overlay");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Bulk Overlay Operations
// ═══════════════════════════════════════════════════════════

describe("POST /api/catalog/officers/bulk-overlay", () => {
  it("bulk sets ownership for multiple officers", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({
        refIds: ["cdn:officer:100", "cdn:officer:101"],
        ownershipState: "owned",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);
    expect(res.body.data.refIds).toBe(2);

    // Verify
    const kirk = await overlayStore.getOfficerOverlay("cdn:officer:100");
    expect(kirk?.ownershipState).toBe("owned");
    const spock = await overlayStore.getOfficerOverlay("cdn:officer:101");
    expect(spock?.ownershipState).toBe("owned");
  });

  it("bulk sets target for multiple officers", async () => {
    await seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({
        refIds: ["cdn:officer:100", "cdn:officer:102"],
        target: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);
  });

  it("rejects empty refIds array", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({ refIds: [], ownershipState: "owned" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid ownership state in bulk", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({ refIds: ["cdn:officer:100"], ownershipState: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/catalog/ships/bulk-overlay", () => {
  it("bulk sets ownership for multiple ships", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/ships/bulk-overlay")
      .send({
        refIds: ["cdn:ship:200", "cdn:ship:201"],
        ownershipState: "unowned",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);

    const enterprise = await overlayStore.getShipOverlay("cdn:ship:200");
    expect(enterprise?.ownershipState).toBe("unowned");
  });

  it("bulk sets both ownership and target in one call", async () => {
    await seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await testRequest(app)
      .post("/api/catalog/ships/bulk-overlay")
      .send({
        refIds: ["cdn:ship:200"],
        ownershipState: "owned",
        target: true,
      });
    expect(res.status).toBe(200);
    // Should count both ownership and target updates
    expect(res.body.data.updated).toBeGreaterThan(0);
  });
});
