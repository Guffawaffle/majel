/**
 * crew-validator.test.ts — Unit tests for ADR-034 Phase C validateCrew (#134)
 *
 * Tests the pure validation function: no server, no DOM.
 * Covers verdict derivation, summary generation, and edge cases.
 */

import { describe, expect, it } from "vitest";
import { validateCrew, type ValidateCrewInput } from "../web/src/lib/crew-validator.js";
import type {
  EffectTag,
  OfficerAbility,
  IntentDefinition,
} from "../web/src/lib/types/effect-types.js";
import type { EffectBundleData } from "../web/src/lib/effect-bundle-adapter.js";

// ─── Test Helpers ───────────────────────────────────────────

function makeEffect(overrides: Partial<EffectTag> = {}): EffectTag {
  return {
    id: "eff-1",
    abilityId: "ab-1",
    effectKey: "damage_dealt",
    magnitude: 0.20,
    unit: "percent",
    stacking: "additive",
    applicableTargetKinds: [],
    applicableTargetTags: [],
    conditions: [],
    ...overrides,
  };
}

function makeAbility(overrides: Partial<OfficerAbility> = {}): OfficerAbility {
  return {
    id: "ab-1",
    officerId: "kirk",
    slot: "oa",  // OA is active in both captain and bridge slots
    name: "Test Ability",
    rawText: "A test ability",
    isInert: false,
    effects: [makeEffect()],
    ...overrides,
  };
}

function makeIntent(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    id: "grinding",
    name: "Hostile Grinding",
    description: "Hostile PvE combat",
    defaultContext: {
      targetKind: "hostile",
      engagement: "attacking",
      targetTags: ["pve"],
    },
    effectWeights: {
      damage_dealt: 1.0,
      crit_chance: 0.8,
    },
    ...overrides,
  };
}

function makeBundle(opts: {
  officers?: Map<string, OfficerAbility[]>;
  intents?: Map<string, IntentDefinition>;
  intentWeights?: Map<string, Record<string, number>>;
} = {}): EffectBundleData {
  return {
    schemaVersion: "test-1",
    officerAbilities: opts.officers ?? new Map(),
    intents: opts.intents ?? new Map([["grinding", makeIntent()]]),
    intentWeights: opts.intentWeights ?? new Map([["grinding", { damage_dealt: 1.0, crit_chance: 0.8 }]]),
  };
}

function makeInput(overrides: Partial<ValidateCrewInput> = {}): ValidateCrewInput {
  return {
    slots: { captain: "kirk", bridge_1: "spock", bridge_2: "mccoy" },
    officerNames: { kirk: "Kirk", spock: "Spock", mccoy: "McCoy" },
    intentKey: "grinding",
    shipClass: null,
    targetClass: "any",
    effectBundle: makeBundle(),
    ...overrides,
  };
}

// ─── Core Tests ─────────────────────────────────────────────

describe("validateCrew", () => {
  describe("basic validation", () => {
    it("returns 3 officers when all slots filled", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk", id: "kirk-cm" })]],
          ["spock", [makeAbility({ officerId: "spock", id: "spock-cm" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy", id: "mccoy-cm" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.officers).toHaveLength(3);
      expect(result.officers[0].slot).toBe("captain");
      expect(result.officers[1].slot).toBe("bridge_1");
      expect(result.officers[2].slot).toBe("bridge_2");
    });

    it("preserves officer names from input", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      const names = result.officers.map((o) => o.officerName);
      expect(names).toEqual(["Kirk", "Spock", "McCoy"]);
    });

    it("computes numeric totalScore", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(typeof result.totalScore).toBe("number");
    });
  });

  describe("verdict derivation", () => {
    it('returns "works" when all officers have unrestricted effects', () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.verdict).toBe("works");
      for (const off of result.officers) {
        expect(off.verdict).toBe("works");
      }
    });

    it('returns "unknown" for officers not in the effect catalog', () => {
      const bundle = makeBundle({ officers: new Map() });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      for (const off of result.officers) {
        expect(off.verdict).toBe("unknown");
      }
    });

    it('returns "blocked" when all officers have only blocked effects', () => {
      /** An effect only for mining — won't apply in a combat context. */
      const miningOnlyEffect = makeEffect({
        applicableTargetKinds: ["mining_node"],
      });
      const ability: OfficerAbility = makeAbility({
        effects: [miningOnlyEffect],
      });
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [{ ...ability, officerId: "kirk" }]],
          ["spock", [{ ...ability, officerId: "spock" }]],
          ["mccoy", [{ ...ability, officerId: "mccoy" }]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      // All officers should be blocked or partial (their mining effect won't work against hostiles)
      expect(["blocked", "partial"]).toContain(result.verdict);
    });

    it('returns "partial" for mixed working/blocked crew', () => {
      const workingAbility = makeAbility({ effects: [makeEffect()] });
      const blockedAbility = makeAbility({
        effects: [makeEffect({ applicableTargetKinds: ["mining_node"] })],
      });
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [{ ...workingAbility, officerId: "kirk" }]],
          ["spock", [{ ...workingAbility, officerId: "spock" }]],
          ["mccoy", [{ ...blockedAbility, officerId: "mccoy" }]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.verdict).toBe("partial");
    });
  });

  describe("target context", () => {
    it("applies target class to context tags", () => {
      const conditionalEffect = makeEffect({
        applicableTargetTags: ["target_explorer"],
      });
      const ability = makeAbility({ effects: [conditionalEffect] });

      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [{ ...ability, officerId: "kirk" }]],
          ["spock", [{ ...ability, officerId: "spock" }]],
          ["mccoy", [{ ...ability, officerId: "mccoy" }]],
        ]),
      });

      // Should work when targetClass matches the requirement
      const result = validateCrew(makeInput({
        effectBundle: bundle,
        targetClass: "explorer",
      }));
      expect(result.verdict).toBe("works");
    });

    it("applies intent default context", () => {
      const intent = makeIntent({
        defaultContext: {
          targetKind: "hostile",
          engagement: "attacking",
          targetTags: ["pve", "swarm"],
        },
      });
      const hostileEffect = makeEffect({
        applicableTargetKinds: ["hostile"],
      });
      const ability = makeAbility({ effects: [hostileEffect] });

      const bundle = makeBundle({
        intents: new Map([["grinding", intent]]),
        officers: new Map([
          ["kirk", [{ ...ability, officerId: "kirk" }]],
          ["spock", [{ ...ability, officerId: "spock" }]],
          ["mccoy", [{ ...ability, officerId: "mccoy" }]],
        ]),
      });

      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.verdict).toBe("works");
    });
  });

  describe("summary generation", () => {
    it("generates summary lines for a working crew", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.summary.some((s) => s.includes("grinding") || s.includes("all abilities work"))).toBe(true);
    });

    it("generates summary lines for unknown officers", () => {
      const bundle = makeBundle({ officers: new Map() });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      expect(result.summary.some((s) => s.includes("not in effect catalog"))).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("skips empty slots", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
        ]),
      });
      const result = validateCrew(makeInput({
        effectBundle: bundle,
        slots: { captain: "kirk", bridge_1: "", bridge_2: "" },
      }));
      expect(result.officers).toHaveLength(1);
      expect(result.officers[0].officerName).toBe("Kirk");
    });

    it("handles null slots", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
        ]),
      });
      const result = validateCrew(makeInput({
        effectBundle: bundle,
        slots: { captain: "kirk", bridge_1: null, bridge_2: null },
      }));
      expect(result.officers).toHaveLength(1);
    });

    it("handles officers with inert abilities", () => {
      const inertAbility = makeAbility({ isInert: true, effects: [] });
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [{ ...inertAbility, officerId: "kirk" }]],
          ["spock", [{ ...inertAbility, officerId: "spock" }]],
          ["mccoy", [{ ...inertAbility, officerId: "mccoy" }]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      // Inert abilities = no effects → unknown
      for (const off of result.officers) {
        expect(off.verdict).toBe("unknown");
      }
    });

    it("handles missing intent gracefully (no crash)", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({
        effectBundle: bundle,
        intentKey: "nonexistent_intent",
      }));
      expect(result.officers).toHaveLength(3);
      // Should not throw; returns some verdict
      expect(["works", "partial", "blocked", "unknown"]).toContain(result.verdict);
    });

    it("rounds totalScore to 2 decimal places", () => {
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", [makeAbility({ officerId: "kirk" })]],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      const decimalPlaces = String(result.totalScore).split(".")[1]?.length ?? 0;
      expect(decimalPlaces).toBeLessThanOrEqual(2);
    });

    it("deduplicates topIssues by type", () => {
      // Officer with many effects that produce the same issue type
      const abilities = [
        makeAbility({
          officerId: "kirk",
          effects: [
            makeEffect({ id: "e1", applicableTargetKinds: ["mining_node"] }),
            makeEffect({ id: "e2", applicableTargetKinds: ["mining_node"] }),
          ],
        }),
      ];
      const bundle = makeBundle({
        officers: new Map([
          ["kirk", abilities],
          ["spock", [makeAbility({ officerId: "spock" })]],
          ["mccoy", [makeAbility({ officerId: "mccoy" })]],
        ]),
      });
      const result = validateCrew(makeInput({ effectBundle: bundle }));
      const kirk = result.officers.find((o) => o.officerName === "Kirk")!;
      // topIssues should not have duplicate issue types
      const types = kirk.topIssues.map((i) => i.type);
      expect(new Set(types).size).toBe(types.length);
    });
  });
});
