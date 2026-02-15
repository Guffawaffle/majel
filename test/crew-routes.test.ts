/**
 * crew-routes.test.ts — ADR-025 Crew Composition API route tests
 *
 * Supertest-based HTTP-level tests covering crew endpoints:
 * BridgeCores, BelowDeckPolicies, Loadout Variants, FleetPresets,
 * OfficerReservations, PlanItems, Docks, EffectiveState.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createCrewStore, type CrewStore } from "../src/server/stores/crew-store.js";
import { createReceiptStore, type ReceiptStore } from "../src/server/stores/receipt-store.js";
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
    adminPool: null,
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    loadoutStore: null,
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

async function seedOfficer(store: ReferenceStore, id: string, name: string) {
  await store.upsertOfficer({ id, name, rarity: "Epic", groupName: "Test", captainManeuver: null, officerAbility: null, belowDeckAbility: null, ...REF_DEFAULTS });
}

async function seedShip(store: ReferenceStore, id: string, name: string) {
  await store.upsertShip({ id, name, shipClass: "Explorer", tier: 3, grade: null, rarity: null, faction: null, ...REF_DEFAULTS });
}

// ═══════════════════════════════════════════════════════════
// Store Not Available (503)
// ═══════════════════════════════════════════════════════════

describe("Crew routes — store not available", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("GET /api/bridge-cores returns 503 when crew store is null", async () => {
    const res = await testRequest(app).get("/api/bridge-cores");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CREW_STORE_NOT_AVAILABLE");
  });

  it("GET /api/below-deck-policies returns 503 when crew store is null", async () => {
    const res = await testRequest(app).get("/api/below-deck-policies");
    expect(res.status).toBe(503);
  });

  it("GET /api/fleet-presets returns 503 when crew store is null", async () => {
    const res = await testRequest(app).get("/api/fleet-presets");
    expect(res.status).toBe(503);
  });

  it("GET /api/officer-reservations returns 503 when crew store is null", async () => {
    const res = await testRequest(app).get("/api/officer-reservations");
    expect(res.status).toBe(503);
  });

  it("GET /api/effective-state returns 503 when crew store is null", async () => {
    const res = await testRequest(app).get("/api/effective-state");
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════
// Receipt routes — store not available (503)
// ═══════════════════════════════════════════════════════════

describe("Receipt routes — store not available", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("GET /api/import/receipts returns 503 when receipt store is null", async () => {
    const res = await testRequest(app).get("/api/import/receipts");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("RECEIPT_STORE_NOT_AVAILABLE");
  });
});

// ═══════════════════════════════════════════════════════════
// Crews routes — with live store
// ═══════════════════════════════════════════════════════════

describe("Crew routes — live store", () => {
  let app: Express;
  let crewStore: CrewStore;
  let receiptStore: ReceiptStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
    receiptStore = await createReceiptStore(pool);
    app = createApp(makeState({ crewStore, receiptStore, referenceStore: refStore }));

    // Seed reference data for FK targets
    await seedOfficer(refStore, "kirk", "Kirk");
    await seedOfficer(refStore, "spock", "Spock");
    await seedOfficer(refStore, "uhura", "Uhura");
    await seedShip(refStore, "enterprise", "Enterprise");
  });

  // ── Bridge Cores ────────────────────────────────────────

  describe("Bridge Cores", () => {
    it("POST creates a bridge core", async () => {
      const res = await testRequest(app)
        .post("/api/bridge-cores")
        .send({ name: "TOS Trio", members: [
          { officerId: "kirk", slot: "captain" },
          { officerId: "spock", slot: "bridge_1" },
        ]});
      expect(res.status).toBe(201);
      expect(res.body.data.bridgeCore.name).toBe("TOS Trio");
      expect(res.body.data.bridgeCore.members).toHaveLength(2);
    });

    it("POST rejects missing name", async () => {
      const res = await testRequest(app)
        .post("/api/bridge-cores")
        .send({ members: [{ officerId: "kirk", slot: "captain" }] });
      expect(res.status).toBe(400);
    });

    it("POST rejects invalid slot", async () => {
      const res = await testRequest(app)
        .post("/api/bridge-cores")
        .send({ name: "Bad", members: [{ officerId: "kirk", slot: "invalid" }] });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Invalid slot");
    });

    it("POST returns 409 on duplicate name", async () => {
      await testRequest(app)
        .post("/api/bridge-cores")
        .send({ name: "Dup", members: [{ officerId: "kirk", slot: "captain" }] });
      const res = await testRequest(app)
        .post("/api/bridge-cores")
        .send({ name: "Dup", members: [{ officerId: "spock", slot: "captain" }] });
      expect(res.status).toBe(409);
    });

    it("GET lists bridge cores", async () => {
      await crewStore.createBridgeCore("Core A", [{ officerId: "kirk", slot: "captain" }]);
      const res = await testRequest(app).get("/api/bridge-cores");
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeCores).toHaveLength(1);
    });

    it("GET /:id returns bridge core with members", async () => {
      const core = await crewStore.createBridgeCore("Core A", [{ officerId: "kirk", slot: "captain" }]);
      const res = await testRequest(app).get(`/api/bridge-cores/${core.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeCore.members).toHaveLength(1);
    });

    it("GET /:id returns 404 for missing core", async () => {
      const res = await testRequest(app).get("/api/bridge-cores/99999");
      expect(res.status).toBe(404);
    });

    it("PATCH updates bridge core", async () => {
      const core = await crewStore.createBridgeCore("Old", [{ officerId: "kirk", slot: "captain" }]);
      const res = await testRequest(app)
        .patch(`/api/bridge-cores/${core.id}`)
        .send({ name: "New" });
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeCore.name).toBe("New");
    });

    it("DELETE removes bridge core", async () => {
      const core = await crewStore.createBridgeCore("Del", [{ officerId: "kirk", slot: "captain" }]);
      const res = await testRequest(app).delete(`/api/bridge-cores/${core.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });

    it("PUT /members sets bridge core members", async () => {
      const core = await crewStore.createBridgeCore("Core", [{ officerId: "kirk", slot: "captain" }]);
      const res = await testRequest(app)
        .put(`/api/bridge-cores/${core.id}/members`)
        .send({ members: [
          { officerId: "spock", slot: "captain" },
          { officerId: "uhura", slot: "bridge_1" },
        ]});
      expect(res.status).toBe(200);
      expect(res.body.data.members).toHaveLength(2);
    });
  });

  // ── Below Deck Policies ─────────────────────────────────

  describe("Below Deck Policies", () => {
    it("POST creates a policy", async () => {
      const res = await testRequest(app)
        .post("/api/below-deck-policies")
        .send({ name: "Default", mode: "stats_then_bda", spec: { pinned: ["kirk"] } });
      expect(res.status).toBe(201);
      expect(res.body.data.belowDeckPolicy.name).toBe("Default");
    });

    it("POST rejects invalid mode", async () => {
      const res = await testRequest(app)
        .post("/api/below-deck-policies")
        .send({ name: "Bad", mode: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Invalid mode");
    });

    it("GET lists policies", async () => {
      await crewStore.createBelowDeckPolicy("P1", "stats_then_bda", {});
      const res = await testRequest(app).get("/api/below-deck-policies");
      expect(res.status).toBe(200);
      expect(res.body.data.belowDeckPolicies).toHaveLength(1);
    });

    it("DELETE removes policy", async () => {
      const policy = await crewStore.createBelowDeckPolicy("Del", "pinned_only", {});
      const res = await testRequest(app).delete(`/api/below-deck-policies/${policy.id}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Crew Loadouts ───────────────────────────────────────

  describe("Crew Loadouts", () => {
    it("POST creates a loadout", async () => {
      const res = await testRequest(app)
        .post("/api/crew/loadouts")
        .send({ shipId: "enterprise", name: "Attack" });
      expect(res.status).toBe(201);
      expect(res.body.data.loadout.name).toBe("Attack");
      expect(res.body.data.loadout.shipId).toBe("enterprise");
    });

    it("POST rejects missing shipId", async () => {
      const res = await testRequest(app)
        .post("/api/crew/loadouts")
        .send({ name: "NoShip" });
      expect(res.status).toBe(400);
    });

    it("GET lists loadouts with filters", async () => {
      await crewStore.createLoadout({ shipId: "enterprise", name: "L1" });
      await crewStore.createLoadout({ shipId: "enterprise", name: "L2", isActive: false });
      const res = await testRequest(app).get("/api/crew/loadouts?active=true");
      expect(res.status).toBe(200);
      expect(res.body.data.loadouts).toHaveLength(1);
    });

    it("GET /:id returns loadout with bridge core and policy", async () => {
      const core = await crewStore.createBridgeCore("BC", [{ officerId: "kirk", slot: "captain" }]);
      const policy = await crewStore.createBelowDeckPolicy("BDP", "stats_then_bda", {});
      const loadout = await crewStore.createLoadout({
        shipId: "enterprise", name: "Full",
        bridgeCoreId: core.id, belowDeckPolicyId: policy.id,
      });
      const res = await testRequest(app).get(`/api/crew/loadouts/${loadout.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.loadout.bridgeCore).toBeTruthy();
      expect(res.body.data.loadout.belowDeckPolicy).toBeTruthy();
    });

    it("PATCH updates a loadout", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Old" });
      const res = await testRequest(app)
        .patch(`/api/crew/loadouts/${loadout.id}`)
        .send({ name: "New", priority: 5 });
      expect(res.status).toBe(200);
      expect(res.body.data.loadout.name).toBe("New");
      expect(res.body.data.loadout.priority).toBe(5);
    });

    it("DELETE removes a loadout", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Del" });
      const res = await testRequest(app).delete(`/api/crew/loadouts/${loadout.id}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Loadout Variants ────────────────────────────────────

  describe("Loadout Variants", () => {
    it("POST creates a variant", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Base" });
      const res = await testRequest(app)
        .post(`/api/crew/loadouts/${loadout.id}/variants`)
        .send({ name: "Mining", patch: { intent_keys: ["mining"] } });
      expect(res.status).toBe(201);
      expect(res.body.data.variant.name).toBe("Mining");
    });

    it("POST rejects invalid patch key", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Base" });
      const res = await testRequest(app)
        .post(`/api/crew/loadouts/${loadout.id}/variants`)
        .send({ name: "Bad", patch: { unknown_key: true } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Unknown patch key");
    });

    it("GET lists variants for a loadout", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Base" });
      await crewStore.createVariant(loadout.id, "V1", { intent_keys: ["mining"] });
      await crewStore.createVariant(loadout.id, "V2", { bridge: { captain: "spock" } });
      const res = await testRequest(app).get(`/api/crew/loadouts/${loadout.id}/variants`);
      expect(res.status).toBe(200);
      expect(res.body.data.variants).toHaveLength(2);
    });

    it("GET /resolve returns resolved loadout", async () => {
      const core = await crewStore.createBridgeCore("RC", [{ officerId: "kirk", slot: "captain" }]);
      const loadout = await crewStore.createLoadout({
        shipId: "enterprise", name: "Base", bridgeCoreId: core.id,
      });
      const variant = await crewStore.createVariant(loadout.id, "Override", {
        bridge: { captain: "spock" },
      });
      const res = await testRequest(app)
        .get(`/api/crew/loadouts/${loadout.id}/variants/${variant.id}/resolve`);
      expect(res.status).toBe(200);
      expect(res.body.data.resolvedLoadout.bridge.captain).toBe("spock");
    });

    it("DELETE removes a variant", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "Base" });
      const variant = await crewStore.createVariant(loadout.id, "V1", {});
      const res = await testRequest(app).delete(`/api/crew/loadouts/variants/${variant.id}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Fleet Presets ───────────────────────────────────────

  describe("Fleet Presets", () => {
    it("POST creates a preset", async () => {
      const res = await testRequest(app)
        .post("/api/fleet-presets")
        .send({ name: "War Fleet" });
      expect(res.status).toBe(201);
      expect(res.body.data.fleetPreset.name).toBe("War Fleet");
    });

    it("GET lists presets with slots", async () => {
      await crewStore.createFleetPreset("Preset A");
      const res = await testRequest(app).get("/api/fleet-presets");
      expect(res.status).toBe(200);
      expect(res.body.data.fleetPresets).toHaveLength(1);
      expect(res.body.data.fleetPresets[0].slots).toBeDefined();
    });

    it("POST /activate activates a preset", async () => {
      const preset = await crewStore.createFleetPreset("Activate Me");
      const res = await testRequest(app)
        .post(`/api/fleet-presets/${preset.id}/activate`);
      expect(res.status).toBe(200);
      expect(res.body.data.activated).toBe(true);
    });

    it("PUT /slots sets preset slots", async () => {
      const preset = await crewStore.createFleetPreset("Slots");
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "L1" });
      const dock = await crewStore.upsertDock(1, { label: "Dock 1" });
      const res = await testRequest(app)
        .put(`/api/fleet-presets/${preset.id}/slots`)
        .send({ slots: [{ dockNumber: dock.dockNumber, loadoutId: loadout.id }] });
      expect(res.status).toBe(200);
      expect(res.body.data.slots).toHaveLength(1);
    });
  });

  // ── Officer Reservations ────────────────────────────────

  describe("Officer Reservations", () => {
    it("PUT sets a reservation", async () => {
      const res = await testRequest(app)
        .put("/api/officer-reservations/kirk")
        .send({ reservedFor: "Bridge Core A" });
      expect(res.status).toBe(200);
      expect(res.body.data.reservation.reservedFor).toBe("Bridge Core A");
    });

    it("PUT rejects missing reservedFor", async () => {
      const res = await testRequest(app)
        .put("/api/officer-reservations/kirk")
        .send({});
      expect(res.status).toBe(400);
    });

    it("GET lists reservations", async () => {
      await crewStore.setReservation("kirk", "Core A");
      const res = await testRequest(app).get("/api/officer-reservations");
      expect(res.status).toBe(200);
      expect(res.body.data.reservations).toHaveLength(1);
    });

    it("DELETE removes a reservation", async () => {
      await crewStore.setReservation("kirk", "Core A");
      const res = await testRequest(app).delete("/api/officer-reservations/kirk");
      expect(res.status).toBe(200);
    });
  });

  // ── Docks ───────────────────────────────────────────────

  describe("Crew Docks", () => {
    it("PUT creates/upserts a dock", async () => {
      const res = await testRequest(app)
        .put("/api/crew/docks/1")
        .send({ label: "Alpha" });
      expect(res.status).toBe(200);
      expect(res.body.data.dock.dockNumber).toBe(1);
    });

    it("GET lists docks", async () => {
      await crewStore.upsertDock(1, { label: "A" });
      await crewStore.upsertDock(2, { label: "B" });
      const res = await testRequest(app).get("/api/crew/docks");
      expect(res.status).toBe(200);
      expect(res.body.data.docks).toHaveLength(2);
    });

    it("DELETE removes a dock", async () => {
      await crewStore.upsertDock(1, { label: "Del" });
      const res = await testRequest(app).delete("/api/crew/docks/1");
      expect(res.status).toBe(200);
    });
  });

  // ── Plan Items ──────────────────────────────────────────

  describe("Crew Plan Items", () => {
    it("POST creates a plan item with awayOfficers", async () => {
      const res = await testRequest(app)
        .post("/api/crew/plan")
        .send({ label: "Away Mission", awayOfficers: ["kirk", "spock"] });
      expect(res.status).toBe(201);
      expect(res.body.data.planItem.awayOfficers).toEqual(["kirk", "spock"]);
    });

    it("POST rejects no loadout/variant/away", async () => {
      const res = await testRequest(app)
        .post("/api/crew/plan")
        .send({ label: "Empty" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Exactly one");
    });

    it("POST rejects multiple of loadout/variant/away", async () => {
      const loadout = await crewStore.createLoadout({ shipId: "enterprise", name: "L" });
      const res = await testRequest(app)
        .post("/api/crew/plan")
        .send({ loadoutId: loadout.id, awayOfficers: ["kirk"] });
      expect(res.status).toBe(400);
    });

    it("GET lists plan items with filter", async () => {
      await crewStore.createPlanItem({ awayOfficers: ["kirk"], isActive: true });
      await crewStore.createPlanItem({ awayOfficers: ["spock"], isActive: false });
      const res = await testRequest(app).get("/api/crew/plan?active=true");
      expect(res.status).toBe(200);
      expect(res.body.data.planItems).toHaveLength(1);
    });
  });

  // ── Effective State ─────────────────────────────────────

  describe("Effective State", () => {
    it("GET returns empty effective state", async () => {
      const res = await testRequest(app).get("/api/effective-state");
      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState.docks).toEqual([]);
      expect(res.body.data.effectiveState.awayTeams).toEqual([]);
      expect(res.body.data.effectiveState.conflicts).toEqual([]);
    });

    it("GET returns effective state with plan items", async () => {
      const core = await crewStore.createBridgeCore("EC", [{ officerId: "kirk", slot: "captain" }]);
      const loadout = await crewStore.createLoadout({
        shipId: "enterprise", name: "L", bridgeCoreId: core.id,
      });
      const dock = await crewStore.upsertDock(1, { label: "D1" });
      await crewStore.createPlanItem({
        loadoutId: loadout.id, dockNumber: dock.dockNumber,
      });
      const res = await testRequest(app).get("/api/effective-state");
      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState.docks).toHaveLength(1);
      expect(res.body.data.effectiveState.docks[0].loadout.name).toBe("L");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Receipt routes — with live store
// ═══════════════════════════════════════════════════════════

describe("Receipt routes — live store", () => {
  let app: Express;
  let receiptStore: ReceiptStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    receiptStore = await createReceiptStore(pool);
    app = createApp(makeState({ receiptStore }));
  });

  it("GET /api/import/receipts lists receipts", async () => {
    await receiptStore.createReceipt({ sourceType: "auto_seed", layer: "reference" });
    const res = await testRequest(app).get("/api/import/receipts");
    expect(res.status).toBe(200);
    expect(res.body.data.receipts).toHaveLength(1);
  });

  it("GET /api/import/receipts/:id returns receipt detail", async () => {
    const receipt = await receiptStore.createReceipt({
      sourceType: "catalog_clicks", layer: "ownership",
      changeset: { updated: [{ id: "kirk" }] },
    });
    const res = await testRequest(app).get(`/api/import/receipts/${receipt.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.sourceType).toBe("catalog_clicks");
  });

  it("GET /api/import/receipts/:id returns 404 for missing", async () => {
    const res = await testRequest(app).get("/api/import/receipts/99999");
    expect(res.status).toBe(404);
  });

  it("POST /api/import/receipts/:id/undo returns undo info", async () => {
    const receipt = await receiptStore.createReceipt({
      sourceType: "catalog_clicks", layer: "ownership",
      inverse: { updated: [{ id: "kirk", revert: true }] },
    });
    const res = await testRequest(app).post(`/api/import/receipts/${receipt.id}/undo`);
    expect(res.status).toBe(200);
    expect(res.body.data.undo.success).toBe(true);
  });

  it("POST /api/import/receipts/:id/resolve moves items", async () => {
    const receipt = await receiptStore.createReceipt({
      sourceType: "file_import", layer: "reference",
      unresolved: [{ name: "unknown_officer" }],
    });
    const res = await testRequest(app)
      .post(`/api/import/receipts/${receipt.id}/resolve`)
      .send({ resolvedItems: [{ name: "unknown_officer" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.unresolved).toBeNull();
  });

  it("POST /api/import/receipts/:id/resolve rejects missing array", async () => {
    const receipt = await receiptStore.createReceipt({
      sourceType: "file_import", layer: "reference",
    });
    const res = await testRequest(app)
      .post(`/api/import/receipts/${receipt.id}/resolve`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("GET /api/import/receipts filters by layer", async () => {
    await receiptStore.createReceipt({ sourceType: "auto_seed", layer: "reference" });
    await receiptStore.createReceipt({ sourceType: "catalog_clicks", layer: "ownership" });
    const res = await testRequest(app).get("/api/import/receipts?layer=reference");
    expect(res.status).toBe(200);
    expect(res.body.data.receipts).toHaveLength(1);
    expect(res.body.data.receipts[0].layer).toBe("reference");
  });
});
