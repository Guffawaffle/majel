/**
 * crew-validation.test.ts — Crew Route Validation Edge Cases
 *
 * Tests every uncovered validation branch in crews.ts routes:
 * - Invalid IDs (NaN parseInt)
 * - Name/notes/label length limits
 * - Member array limits and field validation
 * - Dock number validation
 * - Plan item validation (priority, dockNumber, source, XOR check)
 * - PATCH validation branches
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { createCrewStore, type CrewStore } from "../src/server/stores/crew-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createTestPool, truncatePublicTables, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

import { makeReadyState, makeConfig } from "./helpers/make-state.js";

const ADMIN_TOKEN = "test-crew-validation";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    ...overrides,
  });
}

const bearer = `Bearer ${ADMIN_TOKEN}`;

// ─── Helpers ────────────────────────────────────────────────
const REF_DEFAULTS = {
  source: "test", sourceUrl: null, sourcePageId: null,
  sourceRevisionId: null, sourceRevisionTimestamp: null,
};

async function seedOfficer(store: ReferenceStore, id: string) {
  await store.upsertOfficer({
    id, name: `Officer ${id}`, rarity: "Epic", groupName: "Test",
    captainManeuver: null, officerAbility: null, belowDeckAbility: null,
    ...REF_DEFAULTS,
  });
}

async function seedShip(store: ReferenceStore, id: string) {
  await store.upsertShip({
    id, name: `Ship ${id}`, shipClass: "Explorer", tier: 3,
    grade: null, rarity: null, faction: null, ...REF_DEFAULTS,
  });
}

// ═══════════════════════════════════════════════════════════
// Bridge Core Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — bridge core validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedOfficer(refStore, "o1");
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:id rejects NaN", async () => {
    const res = await testRequest(app).get("/api/bridge-cores/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("POST rejects name > 200", async () => {
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "x".repeat(201), members: [{ officerId: "o1", slot: "captain" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("200");
  });

  it("POST rejects notes > 2000", async () => {
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "Core", notes: "x".repeat(2001), members: [{ officerId: "o1", slot: "captain" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("2000");
  });

  it("POST rejects members > 20", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ officerId: `o${i}`, slot: "captain" }));
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "Big", members: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("20");
  });

  it("POST rejects member missing officerId", async () => {
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "Bad", members: [{ slot: "captain" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("officerId");
  });

  it("POST rejects member officerId > 200", async () => {
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "Bad", members: [{ officerId: "x".repeat(201), slot: "captain" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("200");
  });

  it("POST rejects invalid slot", async () => {
    const res = await testRequest(app).post("/api/bridge-cores").set("Authorization", bearer)
      .send({ name: "Bad", members: [{ officerId: "o1", slot: "navigator" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("slot");
  });

  it("PATCH rejects name > 200", async () => {
    const res = await testRequest(app).patch("/api/bridge-cores/1").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects notes > 2000", async () => {
    const res = await testRequest(app).patch("/api/bridge-cores/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH NaN ID → 400", async () => {
    const res = await testRequest(app).patch("/api/bridge-cores/abc").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("DELETE NaN ID → 400", async () => {
    const res = await testRequest(app).delete("/api/bridge-cores/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("PUT /members rejects non-array", async () => {
    const res = await testRequest(app).put("/api/bridge-cores/1/members").set("Authorization", bearer)
      .send({ members: "not-array" });
    expect(res.status).toBe(400);
  });

  it("PUT /members rejects > 20 members", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ officerId: `o${i}`, slot: "captain" }));
    const res = await testRequest(app).put("/api/bridge-cores/1/members").set("Authorization", bearer)
      .send({ members: tooMany });
    expect(res.status).toBe(400);
  });

  it("PUT /members rejects member missing officerId", async () => {
    const res = await testRequest(app).put("/api/bridge-cores/1/members").set("Authorization", bearer)
      .send({ members: [{ slot: "captain" }] });
    expect(res.status).toBe(400);
  });

  it("PUT /members rejects officerId > 200", async () => {
    const res = await testRequest(app).put("/api/bridge-cores/1/members").set("Authorization", bearer)
      .send({ members: [{ officerId: "x".repeat(201), slot: "captain" }] });
    expect(res.status).toBe(400);
  });

  it("PUT /members rejects invalid slot", async () => {
    const res = await testRequest(app).put("/api/bridge-cores/1/members").set("Authorization", bearer)
      .send({ members: [{ officerId: "o1", slot: "fake" }] });
    expect(res.status).toBe(400);
  });

  it("PUT /members NaN ID → 400", async () => {
    const res = await testRequest(app).put("/api/bridge-cores/abc/members").set("Authorization", bearer)
      .send({ members: [] });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Below Deck Policy Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — below deck policy validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:id NaN → 400", async () => {
    const res = await testRequest(app).get("/api/below-deck-policies/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:id not found → 404", async () => {
    const res = await testRequest(app).get("/api/below-deck-policies/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("POST rejects name > 200", async () => {
    const res = await testRequest(app).post("/api/below-deck-policies").set("Authorization", bearer)
      .send({ name: "x".repeat(201), mode: "balanced" });
    expect(res.status).toBe(400);
  });

  it("POST rejects notes > 2000", async () => {
    const res = await testRequest(app).post("/api/below-deck-policies").set("Authorization", bearer)
      .send({ name: "P", mode: "balanced", notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("POST rejects invalid mode", async () => {
    const res = await testRequest(app).post("/api/below-deck-policies").set("Authorization", bearer)
      .send({ name: "P", mode: "invalid" });
    expect(res.status).toBe(400);
  });

  it("POST rejects spec as non-object", async () => {
    const res = await testRequest(app).post("/api/below-deck-policies").set("Authorization", bearer)
      .send({ name: "P", mode: "stats_then_bda", spec: "not-object" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("spec");
  });

  it("POST rejects spec as null", async () => {
    const res = await testRequest(app).post("/api/below-deck-policies").set("Authorization", bearer)
      .send({ name: "P", mode: "stats_then_bda", spec: null });
    expect(res.status).toBe(400);
  });

  it("PATCH NaN ID → 400", async () => {
    const res = await testRequest(app).patch("/api/below-deck-policies/abc").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects name > 200", async () => {
    const res = await testRequest(app).patch("/api/below-deck-policies/1").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects notes > 2000", async () => {
    const res = await testRequest(app).patch("/api/below-deck-policies/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects invalid mode", async () => {
    const res = await testRequest(app).patch("/api/below-deck-policies/1").set("Authorization", bearer)
      .send({ mode: "invalid" });
    expect(res.status).toBe(400);
  });

  it("PATCH not found → 404", async () => {
    const res = await testRequest(app).patch("/api/below-deck-policies/999").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("DELETE NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/below-deck-policies/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/below-deck-policies/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Loadout Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — loadout validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedShip(refStore, "ship1");
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:id NaN → 400", async () => {
    const res = await testRequest(app).get("/api/crew/loadouts/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:id not found → 404", async () => {
    const res = await testRequest(app).get("/api/crew/loadouts/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("POST rejects missing shipId", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ name: "L1" });
    expect(res.status).toBe(400);
  });

  it("POST rejects non-string shipId", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ shipId: 42, name: "L1" });
    expect(res.status).toBe(400);
  });

  it("POST rejects missing name", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ shipId: "ship1" });
    expect(res.status).toBe(400);
  });

  it("POST rejects non-string name", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ shipId: "ship1", name: 42 });
    expect(res.status).toBe(400);
  });

  it("POST rejects name > 200", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ shipId: "ship1", name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("POST rejects notes > 2000", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts").set("Authorization", bearer)
      .send({ shipId: "ship1", name: "L1", notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH NaN ID → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/abc").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects name > 200", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/1").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects notes > 2000", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH not found → 404", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/999").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("DELETE NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/crew/loadouts/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/crew/loadouts/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Variant Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — variant validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:loadoutId/variants NaN → 400", async () => {
    const res = await testRequest(app).get("/api/crew/loadouts/abc/variants").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("POST variant NaN loadoutId → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/abc/variants").set("Authorization", bearer)
      .send({ name: "V", patch: {} });
    expect(res.status).toBe(400);
  });

  it("POST variant missing name → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/1/variants").set("Authorization", bearer)
      .send({ patch: {} });
    expect(res.status).toBe(400);
  });

  it("POST variant name > 200 → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/1/variants").set("Authorization", bearer)
      .send({ name: "x".repeat(201), patch: {} });
    expect(res.status).toBe(400);
  });

  it("POST variant notes > 2000 → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/1/variants").set("Authorization", bearer)
      .send({ name: "V", patch: {}, notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("POST variant missing patch → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/1/variants").set("Authorization", bearer)
      .send({ name: "V" });
    expect(res.status).toBe(400);
  });

  it("POST variant non-object patch → 400", async () => {
    const res = await testRequest(app).post("/api/crew/loadouts/1/variants").set("Authorization", bearer)
      .send({ name: "V", patch: "string" });
    expect(res.status).toBe(400);
  });

  it("PATCH variant NaN ID → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/variants/abc").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH variant name > 200 → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/variants/1").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH variant notes > 2000 → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/variants/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH variant not found → 404", async () => {
    const res = await testRequest(app).patch("/api/crew/loadouts/variants/999").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("DELETE variant NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/crew/loadouts/variants/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE variant not found → 404", async () => {
    const res = await testRequest(app).delete("/api/crew/loadouts/variants/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("GET /resolve NaN loadoutId → 400", async () => {
    const res = await testRequest(app).get("/api/crew/loadouts/abc/variants/1/resolve").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /resolve NaN variantId → 400", async () => {
    const res = await testRequest(app).get("/api/crew/loadouts/1/variants/abc/resolve").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Dock Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — dock validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:num NaN → 400", async () => {
    const res = await testRequest(app).get("/api/crew/docks/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:num < 1 → 400", async () => {
    const res = await testRequest(app).get("/api/crew/docks/0").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:num not found → 404", async () => {
    const res = await testRequest(app).get("/api/crew/docks/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("PUT NaN → 400", async () => {
    const res = await testRequest(app).put("/api/crew/docks/abc").set("Authorization", bearer).send({});
    expect(res.status).toBe(400);
  });

  it("PUT < 1 → 400", async () => {
    const res = await testRequest(app).put("/api/crew/docks/0").set("Authorization", bearer).send({});
    expect(res.status).toBe(400);
  });

  it("PUT label > 200 → 400", async () => {
    const res = await testRequest(app).put("/api/crew/docks/1").set("Authorization", bearer)
      .send({ label: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PUT notes > 2000 → 400", async () => {
    const res = await testRequest(app).put("/api/crew/docks/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("DELETE NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/crew/docks/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE < 1 → 400", async () => {
    const res = await testRequest(app).delete("/api/crew/docks/0").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/crew/docks/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Fleet Preset Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — fleet preset validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:id NaN → 400", async () => {
    const res = await testRequest(app).get("/api/fleet-presets/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:id not found → 404", async () => {
    const res = await testRequest(app).get("/api/fleet-presets/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("POST name > 200 → 400", async () => {
    const res = await testRequest(app).post("/api/fleet-presets").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("POST notes > 2000 → 400", async () => {
    const res = await testRequest(app).post("/api/fleet-presets").set("Authorization", bearer)
      .send({ name: "P", notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("POST missing name → 400", async () => {
    const res = await testRequest(app).post("/api/fleet-presets").set("Authorization", bearer).send({});
    expect(res.status).toBe(400);
  });

  it("PATCH NaN → 400", async () => {
    const res = await testRequest(app).patch("/api/fleet-presets/abc").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH name > 200 → 400", async () => {
    const res = await testRequest(app).patch("/api/fleet-presets/1").set("Authorization", bearer)
      .send({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH notes > 2000 → 400", async () => {
    const res = await testRequest(app).patch("/api/fleet-presets/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH not found → 404", async () => {
    const res = await testRequest(app).patch("/api/fleet-presets/999").set("Authorization", bearer)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("DELETE NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/fleet-presets/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/fleet-presets/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("PUT /slots NaN → 400", async () => {
    const res = await testRequest(app).put("/api/fleet-presets/abc/slots").set("Authorization", bearer)
      .send({ slots: [] });
    expect(res.status).toBe(400);
  });

  it("PUT /slots non-array → 400", async () => {
    const res = await testRequest(app).put("/api/fleet-presets/1/slots").set("Authorization", bearer)
      .send({ slots: "not-array" });
    expect(res.status).toBe(400);
  });

  it("PUT /slots > 50 → 400", async () => {
    const slots = Array.from({ length: 51 }, () => ({ loadoutId: 1 }));
    const res = await testRequest(app).put("/api/fleet-presets/1/slots").set("Authorization", bearer)
      .send({ slots });
    expect(res.status).toBe(400);
  });

  it("POST /activate NaN → 400", async () => {
    const res = await testRequest(app).post("/api/fleet-presets/abc/activate").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("POST /activate not found → 404", async () => {
    const res = await testRequest(app).post("/api/fleet-presets/999/activate").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Plan Item Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — plan item validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("GET /:id NaN → 400", async () => {
    const res = await testRequest(app).get("/api/crew/plan/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("GET /:id not found → 404", async () => {
    const res = await testRequest(app).get("/api/crew/plan/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  it("POST label > 200 → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ label: "x".repeat(201), awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST notes > 2000 → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001), awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid priority (0) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ priority: 0, awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid priority (101) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ priority: 101, awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid priority (non-integer) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ priority: 1.5, awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid priority (string) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ priority: "high", awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid dockNumber (0) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ dockNumber: 0, awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid dockNumber (non-integer) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ dockNumber: 1.5, awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST invalid dockNumber (string) → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ dockNumber: "two", awayOfficers: ["o1"] });
    expect(res.status).toBe(400);
  });

  it("POST XOR: none of loadoutId/variantId/awayOfficers → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Exactly one");
  });

  it("POST XOR: both loadoutId + variantId → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ loadoutId: 1, variantId: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Exactly one");
  });

  it("POST invalid source → 400", async () => {
    const res = await testRequest(app).post("/api/crew/plan").set("Authorization", bearer)
      .send({ awayOfficers: ["o1"], source: "auto" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("source");
  });

  it("PATCH NaN → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/abc").set("Authorization", bearer)
      .send({ label: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH label > 200 → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/1").set("Authorization", bearer)
      .send({ label: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH notes > 2000 → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/1").set("Authorization", bearer)
      .send({ notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("PATCH invalid priority → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/1").set("Authorization", bearer)
      .send({ priority: 0 });
    expect(res.status).toBe(400);
  });

  it("PATCH invalid dockNumber → 400", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/1").set("Authorization", bearer)
      .send({ dockNumber: -1 });
    expect(res.status).toBe(400);
  });

  it("PATCH not found → 404", async () => {
    const res = await testRequest(app).patch("/api/crew/plan/999").set("Authorization", bearer)
      .send({ label: "X" });
    expect(res.status).toBe(404);
  });

  it("DELETE NaN → 400", async () => {
    const res = await testRequest(app).delete("/api/crew/plan/abc").set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/crew/plan/999").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Officer Reservation Validation
// ═══════════════════════════════════════════════════════════

describe("Crew routes — officer reservation validation", () => {
  let app: Express;
  let crewStore: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    crewStore = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    app = createApp(makeState({ crewStore, referenceStore: refStore, startupComplete: true }));
  });

  it("PUT missing reservedFor → 400", async () => {
    const res = await testRequest(app).put("/api/officer-reservations/o1").set("Authorization", bearer)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("reservedFor");
  });

  it("PUT non-string reservedFor → 400", async () => {
    const res = await testRequest(app).put("/api/officer-reservations/o1").set("Authorization", bearer)
      .send({ reservedFor: 42 });
    expect(res.status).toBe(400);
  });

  it("PUT notes > 2000 → 400", async () => {
    const res = await testRequest(app).put("/api/officer-reservations/o1").set("Authorization", bearer)
      .send({ reservedFor: "crew1", notes: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("DELETE not found → 404", async () => {
    const res = await testRequest(app).delete("/api/officer-reservations/nonexistent").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });
});
