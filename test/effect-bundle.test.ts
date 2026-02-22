/**
 * effect-bundle.test.ts — Smoke tests for effect bundle route + adapter
 *
 * Verifies:
 * - Route returns 200 with valid structure
 * - Bundle has non-empty intents + officers
 * - Adapter converts bundle to Maps correctly
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adaptEffectBundle,
  fetchEffectBundle,
  EffectBundleManager,
  getPhraseMapCoverage,
  normalizePhrase,
  type EffectBundleResponse,
} from "../web/src/lib/effect-bundle-adapter.js";

// Helper to create a minimal valid bundle
function createMockBundle(): EffectBundleResponse {
  return {
    schemaVersion: "1.0.0",
    intents: [
      {
        id: "grinding",
        name: "Grinding",
        description: "PvE hostile battles",
        defaultContext: {
          targetKind: "hostile",
          engagement: "attacking",
          targetTags: ["pve"],
        },
        effectWeights: {
          damage_dealt: 3.0,
          weapon_damage: 2.5,
          crit_chance: 2.0,
        },
      },
    ],
    officers: {
      "kirk-001": {
        id: "kirk-001",
        name: "Kirk",
        abilities: [
          {
            id: "kirk-cm",
            slot: "cm",
            name: "Captain Maneuver",
            rawText: "Increase damage dealt by 30%",
            isInert: false,
            effects: [
              {
                id: "kirk-cm-dmg",
                effectKey: "damage_dealt",
                magnitude: 0.3,
                unit: "percent",
                stacking: "additive",
                applicableTargetKinds: ["hostile"],
                applicableTargetTags: [],
                conditions: [],
              },
            ],
          },
          {
            id: "kirk-oa",
            slot: "oa",
            name: "Officer Ability",
            rawText: "Increase weapon damage by 20%",
            isInert: false,
            effects: [
              {
                id: "kirk-oa-weap",
                effectKey: "weapon_damage",
                magnitude: 0.2,
                unit: "percent",
                stacking: "additive",
                applicableTargetKinds: ["hostile"],
                applicableTargetTags: [],
                conditions: [],
              },
            ],
          },
        ],
      },
    },
  };
}

describe("EffectBundleAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adapts a valid bundle to indexed Maps", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    expect(adapted.schemaVersion).toBe("1.0.0");
    expect(adapted.intentWeights.size).toBeGreaterThan(2);
    expect(adapted.officerAbilities.size).toBe(1);
    expect(adapted.intents.size).toBeGreaterThan(2);
  });

  it("uses canonical finite intent weights", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const weights = adapted.intentWeights.get("hostile_grinding");
    expect(weights).toEqual({
      damage_dealt: 1,
      weapon_damage: 0.8,
      crit_chance: 0.6,
      crit_damage: 0.6,
      mitigation: 0.9,
      hull_health: 0.4,
      shield_health: 0.4,
      dodge: 0.2,
    });
  });

  it("applies canonical starter intent vectors from data artifacts", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    expect(adapted.intentWeights.get("hostile_grinding")).toEqual({
      damage_dealt: 1,
      weapon_damage: 0.8,
      crit_chance: 0.6,
      crit_damage: 0.6,
      mitigation: 0.9,
      hull_health: 0.4,
      shield_health: 0.4,
      dodge: 0.2,
    });

    expect(adapted.intents.get("pvp_station_hit")?.defaultContext.targetKind).toBe("station");
    expect(adapted.intents.get("pvp_station_hit")?.defaultContext.targetTags).toContain("station");
  });

  it("indexes officer abilities with effects", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities).toBeDefined();
    expect(abilities!.length).toBe(2);

    // Check first ability (CM)
    const cm = abilities![0];
    expect(cm.slot).toBe("cm");
    expect(cm.effects).toHaveLength(1);
    expect(cm.effects[0].effectKey).toBe("damage_dealt");
    expect(cm.effects[0].magnitude).toBe(0.3);
  });

  it("indexes canonical intents with default context", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const intent = adapted.intents.get("hostile_grinding");
    expect(intent).toBeDefined();
    expect(intent!.name).toBe("Hostile Grinding (v0)");
    expect(intent!.defaultContext?.targetKind).toBe("hostile");
    expect(intent!.defaultContext?.targetTags).toEqual(["pve"]);
  });

  it("handles abilities with no effects", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities.push({
      id: "kirk-inert",
      slot: "bda",
      name: "Inert",
      rawText: null,
      isInert: true,
      effects: [],
    });

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities).toHaveLength(3);
    expect(abilities![2].isInert).toBe(true);
    expect(abilities![2].effects).toHaveLength(0);
  });

  it("preserves effects with null magnitude", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].magnitude = null;

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities![0].effects[0].magnitude).toBeNull();
  });

  it("converts condition objects correctly", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].conditions.push({
      conditionKey: "requires_attacking",
      params: null,
    });

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    const effect = abilities![0].effects[0];
    expect(effect.conditions).toHaveLength(1);
    expect(effect.conditions[0].conditionKey).toBe("requires_attacking");
    expect(effect.conditions[0].params).toBeNull();
  });

  it("tracks mapping telemetry and issues for unmapped ability text", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities.push({
      id: "kirk-unmapped",
      slot: "oa",
      name: "Unknown",
      rawText: "Does mysterious things under odd moonlight",
      isInert: false,
      effects: [],
    });

    const adapted = adaptEffectBundle(raw);

    expect(adapted.mappingTelemetry.totalAbilities).toBe(3);
    expect(adapted.mappingTelemetry.mappedAbilities).toBe(2);
    expect(adapted.mappingTelemetry.topUnmappedAbilityPhrases[0]).toContain("mysterious things");
    expect(adapted.mappingIssues.some((issue) => issue.type === "unmapped_ability_text")).toBe(true);
  });

  it("emits unknown_magnitude mapping issues and counts", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].magnitude = null;

    const adapted = adaptEffectBundle(raw);
    expect(adapted.mappingTelemetry.unknownMagnitudeEffects).toBe(1);
    expect(adapted.mappingIssues.some((issue) => issue.type === "unknown_magnitude")).toBe(true);
  });

  it("emits unknown_effect_key mapping issues and counts", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].effectKey = "mystery_effect_key";

    const adapted = adaptEffectBundle(raw);
    expect(adapted.mappingTelemetry.unknownEffectKeyCount).toBe(1);
    expect(adapted.mappingIssues.some((issue) => issue.type === "unknown_effect_key")).toBe(true);
  });

  it("fetchEffectBundle unwraps AX success envelope", async () => {
    const raw = createMockBundle();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, data: raw, meta: { requestId: "r1" } }),
    } as Response);

    const result = await fetchEffectBundle();
    expect(result.intents[0]?.id).toBe("grinding");
    expect(result.officers["kirk-001"]?.name).toBe("Kirk");
  });

  it("fetchEffectBundle throws for malformed envelope data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, data: { schemaVersion: "1.0.0", intents: null, officers: {} } }),
    } as Response);

    await expect(fetchEffectBundle()).rejects.toThrow(/malformed effect bundle payload/i);
  });
});

describe("#139 phrase-map coverage", () => {
  it("normalizes punctuation and spacing deterministically", () => {
    expect(normalizePhrase("  Non Player,   Station-Hit!! ")).toBe("non-player station-hit");
  });

  it("reports mapped/unmapped coverage from canonical phrase-map artifact", () => {
    const coverage = getPhraseMapCoverage(
      [
        "when fighting hostiles",
        "against players",
        "maximize anomaly scans",
      ],
    );

    expect(coverage.totalPhrases).toBe(3);
    expect(coverage.mappedPhrases).toBe(2);
    expect(coverage.mappedPercent).toBeCloseTo(66.7, 1);
    expect(coverage.topUnmappedPhrases[0]).toContain("maximize anomaly scans");
  });
});

// ─── EffectBundleManager lifecycle ──────────────────────────

describe("EffectBundleManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchSuccess(raw: EffectBundleResponse) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, data: raw, meta: { requestId: "r1" } }),
    } as Response);
  }

  it("load() fetches and caches the bundle", async () => {
    const raw = createMockBundle();
    mockFetchSuccess(raw);
    const mgr = new EffectBundleManager();

    expect(mgr.get()).toBeNull();
    expect(mgr.isLoading()).toBe(false);

    const result = await mgr.load();
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.intentWeights.size).toBeGreaterThan(2);
    expect(mgr.get()).toBe(result);
    expect(mgr.hasError()).toBe(false);
  });

  it("load() returns cached data on second call without re-fetching", async () => {
    const raw = createMockBundle();
    mockFetchSuccess(raw);
    const mgr = new EffectBundleManager();

    const first = await mgr.load();
    const second = await mgr.load();
    expect(first).toBe(second);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("load() surfaces fetch errors via hasError/getError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const mgr = new EffectBundleManager();

    await expect(mgr.load()).rejects.toThrow("network down");
    expect(mgr.hasError()).toBe(true);
    expect(mgr.getError()?.message).toBe("network down");
    expect(mgr.get()).toBeNull();
  });

  it("concurrent load() calls share one fetch and resolve together", async () => {
    const raw = createMockBundle();
    mockFetchSuccess(raw);
    const mgr = new EffectBundleManager();

    const [a, b, c] = await Promise.all([mgr.load(), mgr.load(), mgr.load()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("concurrent load() calls all reject on error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const mgr = new EffectBundleManager();

    const results = await Promise.allSettled([mgr.load(), mgr.load(), mgr.load()]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
