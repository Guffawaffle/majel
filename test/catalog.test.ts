/**
 * catalog.test.ts — Integration tests for Catalog API routes (ADR-016 Phase 2)
 *
 * Tests the reference catalog browsing endpoints and overlay CRUD/bulk operations.
 * Uses real SQLite stores (reference + overlay) in temp directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/reference-store.js";
import { createOverlayStore, type OverlayStore } from "../src/server/overlay-store.js";
import { bootstrapConfig } from "../src/server/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ────────────────────────────────────────────────

let tmpDir: string;
let refStore: ReferenceStore;
let overlayStore: OverlayStore;

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    geminiEngine: null,
    memoryService: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    startupComplete: true,
    config: bootstrapConfig(),
    ...overrides,
  };
}

function seedOfficers(store: ReferenceStore) {
  store.upsertOfficer({
    id: "wiki:officer:100",
    name: "Kirk",
    rarity: "epic",
    groupName: "Command",
    captainManeuver: "Inspirational",
    officerAbility: "Lead By Example",
    belowDeckAbility: null,
    source: "stfc-fandom-wiki",
    sourceUrl: null,
    sourcePageId: "100",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  store.upsertOfficer({
    id: "wiki:officer:101",
    name: "Spock",
    rarity: "epic",
    groupName: "Science",
    captainManeuver: "Logical Analysis",
    officerAbility: "Science Officer",
    belowDeckAbility: null,
    source: "stfc-fandom-wiki",
    sourceUrl: null,
    sourcePageId: "101",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  store.upsertOfficer({
    id: "wiki:officer:102",
    name: "Uhura",
    rarity: "rare",
    groupName: "Command",
    captainManeuver: "Frequencies Open",
    officerAbility: "Comm Officer",
    belowDeckAbility: null,
    source: "stfc-fandom-wiki",
    sourceUrl: null,
    sourcePageId: "102",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
}

function seedShips(store: ReferenceStore) {
  store.upsertShip({
    id: "wiki:ship:200",
    name: "USS Enterprise",
    shipClass: "Explorer",
    grade: 3,
    rarity: "epic",
    faction: "Federation",
    tier: 8,
    source: "stfc-fandom-wiki",
    sourceUrl: null,
    sourcePageId: "200",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
  store.upsertShip({
    id: "wiki:ship:201",
    name: "USS Saladin",
    shipClass: "Interceptor",
    grade: 2,
    rarity: "rare",
    faction: "Federation",
    tier: 5,
    source: "stfc-fandom-wiki",
    sourceUrl: null,
    sourcePageId: "201",
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-catalog-test-"));
  const dbPath = path.join(tmpDir, "reference.db");
  refStore = createReferenceStore(dbPath);
  overlayStore = createOverlayStore(dbPath);
});

afterEach(() => {
  refStore.close();
  overlayStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════
// Reference Catalog — Officers
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/officers", () => {
  it("returns empty array when no officers exist", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.officers).toEqual([]);
    expect(res.body.data.count).toBe(0);
  });

  it("lists all officers", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    const names = res.body.data.officers.map((o: { name: string }) => o.name);
    expect(names).toContain("Kirk");
    expect(names).toContain("Spock");
    expect(names).toContain("Uhura");
  });

  it("searches officers by name", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers?q=kirk");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Kirk");
  });

  it("filters officers by rarity", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers?rarity=rare");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Uhura");
  });

  it("filters officers by group", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers?group=Command");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("returns 503 when reference store unavailable", async () => {
    const app = createApp(makeState({ referenceStore: null }));
    const res = await request(app).get("/api/catalog/officers");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});

describe("GET /api/catalog/officers/:id", () => {
  it("returns a single officer", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers/wiki:officer:100");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Kirk");
    expect(res.body.data.rarity).toBe("epic");
  });

  it("returns 404 for unknown officer", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers/wiki:officer:999");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Reference Catalog — Ships
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/ships", () => {
  it("lists all ships", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("filters ships by faction", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships?faction=Federation");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it("filters ships by class", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships?class=Explorer");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.ships[0].name).toBe("USS Enterprise");
  });

  it("searches ships by name", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships?q=saladin");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.ships[0].name).toBe("USS Saladin");
  });
});

describe("GET /api/catalog/ships/:id", () => {
  it("returns a single ship", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships/wiki:ship:200");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("USS Enterprise");
    expect(res.body.data.shipClass).toBe("Explorer");
  });

  it("returns 404 for unknown ship", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/ships/wiki:ship:999");
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Counts
// ═══════════════════════════════════════════════════════════

describe("GET /api/catalog/counts", () => {
  it("returns reference and overlay counts", async () => {
    seedOfficers(refStore);
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/counts");
    expect(res.status).toBe(200);
    expect(res.body.data.reference.officers).toBe(3);
    expect(res.body.data.reference.ships).toBe(2);
    expect(res.body.data.overlay.officers).toBeDefined();
    expect(res.body.data.overlay.ships).toBeDefined();
  });

  it("returns zero counts when stores are null", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api/catalog/counts");
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
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers/merged");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    // All should have unowned ownership by default
    for (const o of res.body.data.officers) {
      expect(o.ownershipState).toBe("unowned");
      expect(o.target).toBe(false);
    }
  });

  it("merges overlay state correctly", async () => {
    seedOfficers(refStore);
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:100", ownershipState: "owned", target: true });
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:101", ownershipState: "unowned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app).get("/api/catalog/officers/merged");
    expect(res.status).toBe(200);

    const kirk = res.body.data.officers.find((o: { id: string }) => o.id === "wiki:officer:100");
    expect(kirk.ownershipState).toBe("owned");
    expect(kirk.target).toBe(true);

    const spock = res.body.data.officers.find((o: { id: string }) => o.id === "wiki:officer:101");
    expect(spock.ownershipState).toBe("unowned");
    expect(spock.target).toBe(false);

    const uhura = res.body.data.officers.find((o: { id: string }) => o.id === "wiki:officer:102");
    expect(uhura.ownershipState).toBe("unowned");
  });

  it("filters merged by ownership state", async () => {
    seedOfficers(refStore);
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:100", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).get("/api/catalog/officers/merged?ownership=owned");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.officers[0].name).toBe("Kirk");
  });

  it("filters merged by target", async () => {
    seedOfficers(refStore);
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:101", target: true });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const targeted = await request(app).get("/api/catalog/officers/merged?target=true");
    expect(targeted.body.data.count).toBe(1);
    expect(targeted.body.data.officers[0].name).toBe("Spock");

    const notTargeted = await request(app).get("/api/catalog/officers/merged?target=false");
    expect(notTargeted.body.data.count).toBe(2);
  });

  it("combines search + overlay filter", async () => {
    seedOfficers(refStore);
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:100", ownershipState: "owned" });
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:102", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).get("/api/catalog/officers/merged?group=Command&ownership=owned");
    expect(res.status).toBe(200);
    // Kirk (owned, Command) and Uhura (owned, Command)
    expect(res.body.data.count).toBe(2);
  });
});

describe("GET /api/catalog/ships/merged", () => {
  it("returns ships with overlay state", async () => {
    seedShips(refStore);
    overlayStore.setShipOverlay({ refId: "wiki:ship:200", ownershipState: "owned", target: true });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).get("/api/catalog/ships/merged");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);

    const enterprise = res.body.data.ships.find((s: { id: string }) => s.id === "wiki:ship:200");
    expect(enterprise.ownershipState).toBe("owned");
    expect(enterprise.target).toBe(true);
  });

  it("filters by ownership and class", async () => {
    seedShips(refStore);
    overlayStore.setShipOverlay({ refId: "wiki:ship:200", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).get("/api/catalog/ships/merged?class=Explorer&ownership=owned");
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
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/officers/wiki:officer:100/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(200);
    expect(res.body.data.ownershipState).toBe("owned");
  });

  it("sets target flag", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/officers/wiki:officer:100/overlay")
      .send({ target: true });
    expect(res.status).toBe(200);
    expect(res.body.data.target).toBe(true);
  });

  it("rejects invalid ownership state", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/officers/wiki:officer:100/overlay")
      .send({ ownershipState: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 404 for non-existent reference officer", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/officers/wiki:officer:999/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(404);
  });

  it("returns 503 when overlay store unavailable", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore: null }));
    const res = await request(app)
      .patch("/api/catalog/officers/wiki:officer:100/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/catalog/officers/:id/overlay", () => {
  it("deletes an officer overlay", async () => {
    seedOfficers(refStore);
    overlayStore.setOfficerOverlay({ refId: "wiki:officer:100", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).delete("/api/catalog/officers/wiki:officer:100/overlay");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    // Verify it's gone
    const overlay = overlayStore.getOfficerOverlay("wiki:officer:100");
    expect(overlay).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Overlay CRUD — Ships
// ═══════════════════════════════════════════════════════════

describe("PATCH /api/catalog/ships/:id/overlay", () => {
  it("sets ship ownership and target", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/ships/wiki:ship:200/overlay")
      .send({ ownershipState: "owned", target: true });
    expect(res.status).toBe(200);
    expect(res.body.data.ownershipState).toBe("owned");
  });

  it("returns 404 for non-existent reference ship", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .patch("/api/catalog/ships/wiki:ship:999/overlay")
      .send({ ownershipState: "owned" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/catalog/ships/:id/overlay", () => {
  it("deletes a ship overlay", async () => {
    seedShips(refStore);
    overlayStore.setShipOverlay({ refId: "wiki:ship:200", ownershipState: "owned" });
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));

    const res = await request(app).delete("/api/catalog/ships/wiki:ship:200/overlay");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Bulk Overlay Operations
// ═══════════════════════════════════════════════════════════

describe("POST /api/catalog/officers/bulk-overlay", () => {
  it("bulk sets ownership for multiple officers", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({
        refIds: ["wiki:officer:100", "wiki:officer:101"],
        ownershipState: "owned",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);
    expect(res.body.data.refIds).toBe(2);

    // Verify
    const kirk = overlayStore.getOfficerOverlay("wiki:officer:100");
    expect(kirk?.ownershipState).toBe("owned");
    const spock = overlayStore.getOfficerOverlay("wiki:officer:101");
    expect(spock?.ownershipState).toBe("owned");
  });

  it("bulk sets target for multiple officers", async () => {
    seedOfficers(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({
        refIds: ["wiki:officer:100", "wiki:officer:102"],
        target: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);
  });

  it("rejects empty refIds array", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({ refIds: [], ownershipState: "owned" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid ownership state in bulk", async () => {
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/officers/bulk-overlay")
      .send({ refIds: ["wiki:officer:100"], ownershipState: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/catalog/ships/bulk-overlay", () => {
  it("bulk sets ownership for multiple ships", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/ships/bulk-overlay")
      .send({
        refIds: ["wiki:ship:200", "wiki:ship:201"],
        ownershipState: "unowned",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);

    const enterprise = overlayStore.getShipOverlay("wiki:ship:200");
    expect(enterprise?.ownershipState).toBe("unowned");
  });

  it("bulk sets both ownership and target in one call", async () => {
    seedShips(refStore);
    const app = createApp(makeState({ referenceStore: refStore, overlayStore }));
    const res = await request(app)
      .post("/api/catalog/ships/bulk-overlay")
      .send({
        refIds: ["wiki:ship:200"],
        ownershipState: "owned",
        target: true,
      });
    expect(res.status).toBe(200);
    // Should count both ownership and target updates
    expect(res.body.data.updated).toBeGreaterThan(0);
  });
});
