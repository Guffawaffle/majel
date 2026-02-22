/**
 * effect-routes.test.ts — Route integration tests for Effect Bundle API (ADR-034 #132)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tests the /api/effects/bundle endpoint with mocked stores using supertest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeReadyState } from "./helpers/make-state.js";
import type { EffectStore } from "../src/server/stores/effect-store.js";
import type { ReferenceStore } from "../src/server/stores/reference-store.js";
import type { Express } from "express";

// ─── Mock Factories ─────────────────────────────────────────

function createMockEffectStore(overrides: Partial<EffectStore> = {}): EffectStore {
  return {
    listTargetKinds: vi.fn().mockResolvedValue(["hostile", "player_ship"]),
    listTargetTags: vi.fn().mockResolvedValue(["pve", "pvp"]),
    listShipClasses: vi.fn().mockResolvedValue(["explorer", "interceptor"]),
    listEffectKeys: vi.fn().mockResolvedValue([]),
    listConditionKeys: vi.fn().mockResolvedValue([]),
    listIssueTypes: vi.fn().mockResolvedValue([]),
    getOfficerAbilities: vi.fn().mockResolvedValue([]),
    getOfficerAbilitiesBulk: vi.fn().mockResolvedValue(new Map()),
    getIntent: vi.fn().mockResolvedValue(null),
    listIntents: vi.fn().mockResolvedValue([]),
    listIntentsFull: vi.fn().mockResolvedValue([]),
    getIntentWeights: vi.fn().mockResolvedValue({}),
    getIntentDefaultContext: vi.fn().mockResolvedValue(null),
    seedTaxonomy: vi.fn().mockResolvedValue({ inserted: 0, skipped: 0 }),
    seedAbilityCatalog: vi.fn().mockResolvedValue({ inserted: 0, skipped: 0 }),
    seedIntents: vi.fn().mockResolvedValue({ inserted: 0, skipped: 0 }),
    counts: vi.fn().mockResolvedValue({
      taxonomyTargetKinds: 0, taxonomyTargetTags: 0, taxonomyEffectKeys: 0,
      taxonomyConditionKeys: 0, taxonomyIssueTypes: 0, catalogAbilities: 0,
      catalogEffects: 0, intentDefs: 0, intentWeights: 0,
    }),
    close: vi.fn(),
    ...overrides,
  };
}

function createMockReferenceStore(overrides: Partial<ReferenceStore> = {}): ReferenceStore {
  return {
    listOfficers: vi.fn().mockResolvedValue([]),
    listShips: vi.fn().mockResolvedValue([]),
    getOfficer: vi.fn().mockResolvedValue(null),
    getShip: vi.fn().mockResolvedValue(null),
    upsertOfficers: vi.fn().mockResolvedValue(0),
    upsertShips: vi.fn().mockResolvedValue(0),
    counts: vi.fn().mockResolvedValue({ officers: 0, ships: 0 }),
    purgeLegacyEntries: vi.fn().mockResolvedValue({ officers: 0, ships: 0 }),
    close: vi.fn(),
    ...overrides,
  } as unknown as ReferenceStore;
}

// ─── Tests ──────────────────────────────────────────────────

describe("GET /api/effects/bundle", () => {
  let app: Express;

  describe("store not available", () => {
    beforeEach(() => {
      app = createApp(makeReadyState());
    });

    it("returns 503 when effect store is null", async () => {
      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("EFFECT_STORE_NOT_AVAILABLE");
    });

    it("returns 503 when reference store is null but effect store exists", async () => {
      const effectStore = createMockEffectStore();
      app = createApp(makeReadyState({ effectStore, referenceStore: null }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("REFERENCE_STORE_NOT_AVAILABLE");
    });
  });

  describe("with empty stores", () => {
    beforeEach(() => {
      const effectStore = createMockEffectStore();
      const referenceStore = createMockReferenceStore();
      app = createApp(makeReadyState({ effectStore, referenceStore }));
    });

    it("returns 200 with valid bundle structure", async () => {
      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.schemaVersion).toBe("1.0.0");
      expect(res.body.data.intents).toEqual([]);
      expect(res.body.data.officers).toEqual({});
    });
  });

  describe("with populated stores", () => {
    it("returns intents with weights and default context", async () => {
      const effectStore = createMockEffectStore({
        listIntentsFull: vi.fn().mockResolvedValue([
          {
            id: "grinding",
            name: "Grinding",
            description: "PvE hostile battles",
            defaultContext: {
              intentId: "grinding",
              targetKind: "hostile",
              engagement: "attacking",
              targetTagsJson: JSON.stringify(["pve"]),
              shipClass: null,
            },
            effectWeights: [
              { effectKey: "damage_dealt", weight: 3.0 },
              { effectKey: "weapon_damage", weight: 2.5 },
            ],
          },
        ]),
      });
      const referenceStore = createMockReferenceStore();
      app = createApp(makeReadyState({ effectStore, referenceStore }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);

      const bundle = res.body.data;
      expect(bundle.intents).toHaveLength(1);
      expect(bundle.intents[0].id).toBe("grinding");
      expect(bundle.intents[0].defaultContext).toEqual({
        targetKind: "hostile",
        engagement: "attacking",
        targetTags: ["pve"],
      });
      expect(bundle.intents[0].effectWeights).toEqual({
        damage_dealt: 3.0,
        weapon_damage: 2.5,
      });
    });

    it("returns officers with abilities and effects", async () => {
      const effectStore = createMockEffectStore({
        getOfficerAbilitiesBulk: vi.fn().mockResolvedValue(
          new Map([
            ["kirk-001", [
              {
                id: "kirk-cm",
                officerId: "kirk-001",
                slot: "cm",
                name: "Captain Maneuver",
                rawText: "Increase damage dealt",
                isInert: false,
                effects: [
                  {
                    id: "kirk-cm-dmg",
                    abilityId: "kirk-cm",
                    effectKey: "damage_dealt",
                    magnitude: 0.3,
                    unit: "percent",
                    stacking: "additive",
                    targetKinds: ["hostile"],
                    targetTags: [],
                    conditions: [],
                  },
                ],
              },
            ]],
          ]),
        ),
      });
      const referenceStore = createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([
          { id: "kirk-001", name: "Kirk" },
        ]),
      });
      app = createApp(makeReadyState({ effectStore, referenceStore }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);

      const bundle = res.body.data;
      expect(bundle.officers["kirk-001"]).toBeDefined();
      expect(bundle.officers["kirk-001"].name).toBe("Kirk");
      expect(bundle.officers["kirk-001"].abilities).toHaveLength(1);

      const cm = bundle.officers["kirk-001"].abilities[0];
      expect(cm.slot).toBe("cm");
      expect(cm.isInert).toBe(false);
      expect(cm.effects).toHaveLength(1);
      expect(cm.effects[0].effectKey).toBe("damage_dealt");
      expect(cm.effects[0].magnitude).toBe(0.3);
      expect(cm.effects[0].applicableTargetKinds).toEqual(["hostile"]);
      expect(cm.effects[0].conditions).toEqual([]);
    });

    it("returns officers with no abilities as empty ability arrays", async () => {
      const effectStore = createMockEffectStore();
      const referenceStore = createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([
          { id: "unknown-001", name: "Unknown" },
        ]),
      });
      app = createApp(makeReadyState({ effectStore, referenceStore }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);

      const bundle = res.body.data;
      expect(bundle.officers["unknown-001"]).toBeDefined();
      expect(bundle.officers["unknown-001"].abilities).toEqual([]);
    });

    it("handles intents with null default context", async () => {
      const effectStore = createMockEffectStore({
        listIntentsFull: vi.fn().mockResolvedValue([
          {
            id: "custom",
            name: "Custom",
            description: "User-defined",
            defaultContext: null,
            effectWeights: [{ effectKey: "damage_dealt", weight: 1.0 }],
          },
        ]),
      });
      const referenceStore = createMockReferenceStore();
      app = createApp(makeReadyState({ effectStore, referenceStore }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);

      const intent = res.body.data.intents[0];
      expect(intent.defaultContext).toBeNull();
    });

    it("includes conditions with params on effects", async () => {
      const effectStore = createMockEffectStore({
        getOfficerAbilitiesBulk: vi.fn().mockResolvedValue(
          new Map([
            ["ivanov-001", [
              {
                id: "iv-oa",
                officerId: "ivanov-001",
                slot: "oa",
                name: "OA",
                rawText: null,
                isInert: false,
                effects: [
                  {
                    id: "iv-oa-arm",
                    abilityId: "iv-oa",
                    effectKey: "armor",
                    magnitude: 0.1,
                    unit: "percent",
                    stacking: "additive",
                    targetKinds: [],
                    targetTags: [],
                    conditions: [
                      { conditionKey: "requires_defending", params: null },
                      { conditionKey: "requires_ship_class", params: { class: "explorer" } },
                    ],
                  },
                ],
              },
            ]],
          ]),
        ),
      });
      const referenceStore = createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([
          { id: "ivanov-001", name: "Ivanov" },
        ]),
      });
      app = createApp(makeReadyState({ effectStore, referenceStore }));

      const res = await testRequest(app).get("/api/effects/bundle");
      expect(res.status).toBe(200);

      const effect = res.body.data.officers["ivanov-001"].abilities[0].effects[0];
      expect(effect.conditions).toHaveLength(2);
      expect(effect.conditions[0]).toEqual({ conditionKey: "requires_defending", params: null });
      expect(effect.conditions[1]).toEqual({ conditionKey: "requires_ship_class", params: { class: "explorer" } });
    });
  });
});

describe("GET /api/effects/objectives", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeReadyState());
  });

  it("returns canonical objectives even when stores are unavailable", async () => {
    const res = await testRequest(app).get("/api/effects/objectives");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.schemaVersion).toBe("1.0.0");
    expect(Array.isArray(res.body.data.objectives)).toBe(true);
    expect(res.body.data.objectives.length).toBeGreaterThan(2);
    expect(res.body.data.objectives.some((objective: { intentKey: string }) => objective.intentKey === "hostile_grinding")).toBe(true);
  });
});
