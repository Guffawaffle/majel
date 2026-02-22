/**
 * effect-evaluator.test.ts — Unit tests for ADR-034 evaluateEffect() (#132)
 *
 * Tests the pure evaluator function: no DB, no server context.
 * Covers all evaluation paths: works, conditional, blocked, and edge cases.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateEffect,
  evaluateAbility,
  evaluateOfficer,
} from "../web/src/lib/effect-evaluator.js";
import type {
  EffectTag,
  TargetContext,
  OfficerAbility,
} from "../web/src/lib/types/effect-types.js";

// ─── Test Helpers ───────────────────────────────────────────

function makeEffect(overrides: Partial<EffectTag> = {}): EffectTag {
  return {
    id: "test-effect",
    abilityId: "test-ability",
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

function makeContext(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    targetKind: "hostile",
    engagement: "attacking",
    targetTags: ["pve"],
    ...overrides,
  };
}

function makeAbility(overrides: Partial<OfficerAbility> = {}): OfficerAbility {
  return {
    id: "test-ability",
    officerId: "test-officer",
    slot: "oa",
    name: "Test Ability",
    rawText: "Test ability description",
    isInert: false,
    effects: [makeEffect()],
    ...overrides,
  };
}

// ─── evaluateEffect ─────────────────────────────────────────

describe("evaluateEffect", () => {
  describe("basic evaluation", () => {
    it("returns works for an unrestricted effect", () => {
      const result = evaluateEffect(makeEffect(), makeContext());
      expect(result.status).toBe("works");
      expect(result.applicabilityMultiplier).toBe(1.0);
      expect(result.issues).toHaveLength(0);
    });

    it("returns the correct effectKey", () => {
      const result = evaluateEffect(
        makeEffect({ effectKey: "crit_chance" }),
        makeContext(),
      );
      expect(result.effectKey).toBe("crit_chance");
    });
  });

  describe("target kind restrictions", () => {
    it("returns works when target kind matches", () => {
      const effect = makeEffect({ applicableTargetKinds: ["hostile"] });
      const result = evaluateEffect(effect, makeContext({ targetKind: "hostile" }));
      expect(result.status).toBe("works");
    });

    it("returns blocked when target kind does not match", () => {
      const effect = makeEffect({ applicableTargetKinds: ["hostile"] });
      const result = evaluateEffect(effect, makeContext({ targetKind: "player_ship" }));
      expect(result.status).toBe("blocked");
      expect(result.applicabilityMultiplier).toBe(0.0);
      expect(result.issues[0]?.type).toBe("not_applicable_to_target_kind");
    });

    it("allows any of multiple target kinds", () => {
      const effect = makeEffect({ applicableTargetKinds: ["hostile", "armada_target"] });
      const result = evaluateEffect(effect, makeContext({ targetKind: "armada_target" }));
      expect(result.status).toBe("works");
    });

    it("blocks when none of multiple target kinds match", () => {
      const effect = makeEffect({ applicableTargetKinds: ["hostile", "armada_target"] });
      const result = evaluateEffect(effect, makeContext({ targetKind: "station" }));
      expect(result.status).toBe("blocked");
    });

    it("treats empty applicableTargetKinds as unrestricted", () => {
      const effect = makeEffect({ applicableTargetKinds: [] });
      const result = evaluateEffect(effect, makeContext({ targetKind: "station" }));
      expect(result.status).toBe("works");
    });
  });

  describe("target tag restrictions", () => {
    it("returns works when required tags are present", () => {
      const effect = makeEffect({ applicableTargetTags: ["swarm"] });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "swarm"] }));
      expect(result.status).toBe("works");
    });

    it("returns blocked when required tags are missing", () => {
      const effect = makeEffect({ applicableTargetTags: ["swarm"] });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("blocked");
      expect(result.issues[0]?.type).toBe("missing_required_target_tag");
    });

    it("requires all tags when multiple are specified", () => {
      const effect = makeEffect({ applicableTargetTags: ["swarm", "pve"] });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("blocked");
    });

    it("works when all required tags are present", () => {
      const effect = makeEffect({ applicableTargetTags: ["swarm", "pve"] });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "swarm", "borg"] }));
      expect(result.status).toBe("works");
    });
  });

  describe("engagement conditions", () => {
    it("requires_attacking passes when attacking", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_attacking", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "attacking" }));
      expect(result.status).toBe("works");
    });

    it("requires_attacking passes when engagement is any", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_attacking", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "any" }));
      expect(result.status).toBe("works");
    });

    it("requires_attacking is conditional when defending", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_attacking", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "defending" }));
      expect(result.status).toBe("conditional");
      expect(result.applicabilityMultiplier).toBe(0.5);
    });

    it("requires_defending passes when defending", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_defending", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "defending" }));
      expect(result.status).toBe("works");
    });

    it("requires_defending passes when engagement is any", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_defending", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "any" }));
      expect(result.status).toBe("works");
    });

    it("requires_defending is conditional when attacking", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_defending", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ engagement: "attacking" }));
      expect(result.status).toBe("conditional");
    });
  });

  describe("mode conditions", () => {
    it("requires_pvp passes with pvp tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_pvp", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pvp"] }));
      expect(result.status).toBe("works");
    });

    it("requires_pvp is conditional without pvp tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_pvp", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("conditional");
    });

    it("requires_pve passes with pve tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_pve", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("works");
    });

    it("requires_station_target passes for station", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_station_target", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetKind: "station" }));
      expect(result.status).toBe("works");
    });

    it("requires_station_target is conditional for non-station", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_station_target", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetKind: "hostile" }));
      expect(result.status).toBe("conditional");
    });

    it("requires_armada_target passes for armada_target", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_armada_target", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetKind: "armada_target" }));
      expect(result.status).toBe("works");
    });
  });

  describe("ship class conditions", () => {
    it("requires_ship_class passes when ship class matches", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_ship_class", params: { class: "explorer" } }],
      });
      const ctx = makeContext({
        shipContext: { shipClass: "explorer" },
      });
      const result = evaluateEffect(effect, ctx);
      expect(result.status).toBe("works");
    });

    it("requires_ship_class blocked when ship class differs", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_ship_class", params: { class: "explorer" } }],
      });
      const ctx = makeContext({
        shipContext: { shipClass: "interceptor" },
      });
      const result = evaluateEffect(effect, ctx);
      expect(result.status).toBe("blocked");
      expect(result.issues[0]?.type).toBe("missing_required_ship_class");
    });

    it("requires_target_ship_class passes when target has class tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_target_ship_class", params: { class: "explorer" } }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "target_explorer"] }));
      expect(result.status).toBe("works");
    });

    it("requires_target_ship_class blocked when target lacks class tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_target_ship_class", params: { class: "explorer" } }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("blocked");
    });
  });

  describe("tag conditions", () => {
    it("requires_target_tag passes when tag present", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_target_tag", params: { tag: "borg" } }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "borg"] }));
      expect(result.status).toBe("works");
    });

    it("requires_target_tag blocks when tag missing", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_target_tag", params: { tag: "borg" } }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("blocked");
    });

    it("requires_ship_tag passes when ship has tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_ship_tag", params: { tag: "ship_borg" } }],
      });
      const ctx = makeContext({
        shipContext: { shipClass: "explorer", shipTags: ["ship_borg"] },
      });
      const result = evaluateEffect(effect, ctx);
      expect(result.status).toBe("works");
    });

    it("requires_ship_tag blocks when ship lacks tag", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "requires_ship_tag", params: { tag: "ship_borg" } }],
      });
      const ctx = makeContext({
        shipContext: { shipClass: "explorer", shipTags: [] },
      });
      const result = evaluateEffect(effect, ctx);
      expect(result.status).toBe("blocked");
    });
  });

  describe("timing/runtime conditions", () => {
    it("at_combat_start is works (always triggers)", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "at_combat_start", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("works");
    });

    it("at_round_start is works (always triggers)", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "at_round_start", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("works");
    });

    it("when_weapons_fire is works (always triggers)", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_weapons_fire", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("works");
    });

    it("per_round_stacking is works (always triggers)", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "per_round_stacking", params: { maxStacks: "5" } }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("works");
    });

    it("when_shields_depleted is conditional", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_shields_depleted", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("conditional");
      expect(result.issues[0]?.type).toBe("missing_required_status");
    });

    it("when_hull_breached is conditional", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_hull_breached", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("conditional");
    });

    it("when_burning is conditional", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_burning", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("conditional");
    });

    it("when_target_burning is works if target_burning tag present", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_target_burning", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "target_burning"] }));
      expect(result.status).toBe("works");
    });

    it("when_target_burning is conditional if target_burning tag absent", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_target_burning", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve"] }));
      expect(result.status).toBe("conditional");
    });

    it("when_target_hull_breached is works if tag present", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "when_target_hull_breached", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetTags: ["pve", "target_hull_breached"] }));
      expect(result.status).toBe("works");
    });

    it("below_health_threshold is conditional", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "below_health_threshold", params: { threshold: "30" } }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("conditional");
    });
  });

  describe("unknown conditions", () => {
    it("unknown condition is conditional", () => {
      const effect = makeEffect({
        conditions: [{ conditionKey: "some_future_condition", params: null }],
      });
      const result = evaluateEffect(effect, makeContext());
      expect(result.status).toBe("conditional");
      expect(result.issues[0]?.type).toBe("unknown_condition");
    });
  });

  describe("multiple conditions/restrictions", () => {
    it("blocker + conditional = blocked (highest severity wins)", () => {
      const effect = makeEffect({
        applicableTargetKinds: ["hostile"],
        conditions: [{ conditionKey: "when_shields_depleted", params: null }],
      });
      // Target kind matches (works) + shields depleted (conditional) → conditional
      const result = evaluateEffect(effect, makeContext({ targetKind: "hostile" }));
      expect(result.status).toBe("conditional");
    });

    it("blocked target kind overrides other conditions", () => {
      const effect = makeEffect({
        applicableTargetKinds: ["hostile"],
        conditions: [{ conditionKey: "at_combat_start", params: null }],
      });
      const result = evaluateEffect(effect, makeContext({ targetKind: "player_ship" }));
      expect(result.status).toBe("blocked");
    });

    it("multiple blockers produce multiple issues", () => {
      const effect = makeEffect({
        applicableTargetKinds: ["hostile"],
        applicableTargetTags: ["swarm"],
      });
      const result = evaluateEffect(effect, makeContext({
        targetKind: "player_ship",
        targetTags: ["pvp"],
      }));
      expect(result.status).toBe("blocked");
      expect(result.issues.length).toBe(2);
    });
  });
});

// ─── evaluateAbility ────────────────────────────────────────

describe("evaluateAbility", () => {
  it("returns empty effects for inert abilities", () => {
    const ability = makeAbility({ isInert: true });
    const result = evaluateAbility(ability, makeContext());
    expect(result.isInert).toBe(true);
    expect(result.effects).toHaveLength(0);
  });

  it("evaluates all effects of an ability", () => {
    const ability = makeAbility({
      effects: [
        makeEffect({ id: "e1", effectKey: "damage_dealt" }),
        makeEffect({ id: "e2", effectKey: "crit_chance" }),
      ],
    });
    const result = evaluateAbility(ability, makeContext());
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.effectKey).toBe("damage_dealt");
    expect(result.effects[1]?.effectKey).toBe("crit_chance");
  });

  it("preserves slot and abilityId", () => {
    const ability = makeAbility({ id: "my-ability", slot: "cm" });
    const result = evaluateAbility(ability, makeContext());
    expect(result.abilityId).toBe("my-ability");
    expect(result.slot).toBe("cm");
  });
});

// ─── evaluateOfficer ────────────────────────────────────────

describe("evaluateOfficer", () => {
  const grindingWeights: Record<string, number> = {
    damage_dealt: 3.0,
    weapon_damage: 2.5,
    crit_chance: 2.0,
    crit_damage: 2.0,
    mitigation: 1.5,
    armor: 1.5,
    hull_health: 1.0,
    shield_health: 1.0,
    officer_attack: 1.0,
    officer_defense: 0.8,
    officer_health: 0.8,
    dodge: 0.5,
  };

  it("scores Kirk highly for hostile grinding as captain (CM + OA)", () => {
    const kirkCm = makeAbility({
      id: "kirk:cm",
      slot: "cm",
      effects: [
        makeEffect({
          id: "kirk:cm:dmg",
          effectKey: "damage_dealt",
          magnitude: 0.30,
          applicableTargetKinds: ["hostile"],
        }),
      ],
    });
    const kirkOa = makeAbility({
      id: "kirk:oa",
      slot: "oa",
      effects: [
        makeEffect({
          id: "kirk:oa:weap",
          effectKey: "weapon_damage",
          magnitude: 0.20,
          applicableTargetKinds: ["hostile"],
        }),
      ],
    });

    const ctx = makeContext({ targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] });
    const result = evaluateOfficer("kirk", [kirkCm, kirkOa], ctx, grindingWeights, "captain");

    // CM: 0.30 × 3.0 × 1.0 = 0.90
    // OA: 0.20 × 2.5 × 1.0 = 0.50
    expect(result.totalScore).toBeCloseTo(1.40);
    expect(result.issues).toHaveLength(0);
  });

  it("scores Kirk lower as bridge (OA only, no CM)", () => {
    const kirkCm = makeAbility({
      id: "kirk:cm",
      slot: "cm",
      effects: [
        makeEffect({
          id: "kirk:cm:dmg",
          effectKey: "damage_dealt",
          magnitude: 0.30,
          applicableTargetKinds: ["hostile"],
        }),
      ],
    });
    const kirkOa = makeAbility({
      id: "kirk:oa",
      slot: "oa",
      effects: [
        makeEffect({
          id: "kirk:oa:weap",
          effectKey: "weapon_damage",
          magnitude: 0.20,
          applicableTargetKinds: ["hostile"],
        }),
      ],
    });

    const ctx = makeContext({ targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] });
    const result = evaluateOfficer("kirk", [kirkCm, kirkOa], ctx, grindingWeights, "bridge");

    // Only OA: 0.20 × 2.5 × 1.0 = 0.50
    expect(result.totalScore).toBeCloseTo(0.50);
  });

  it("scores Sulu near-zero for hostile grinding (dodge = low weight, wrong target kind for hostiles)", () => {
    const suluCm = makeAbility({
      id: "sulu:cm",
      slot: "cm",
      effects: [
        makeEffect({
          id: "sulu:cm:dodge",
          effectKey: "dodge",
          magnitude: 0.20,
          applicableTargetKinds: [], // universal
          conditions: [{ conditionKey: "at_combat_start", params: null }],
        }),
      ],
    });
    const suluOa = makeAbility({
      id: "sulu:oa",
      slot: "oa",
      effects: [
        makeEffect({
          id: "sulu:oa:weap",
          effectKey: "weapon_damage",
          magnitude: 0.10,
          conditions: [{ conditionKey: "requires_attacking", params: null }],
        }),
      ],
    });

    const ctx = makeContext({ targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] });
    const result = evaluateOfficer("sulu", [suluCm, suluOa], ctx, grindingWeights, "captain");

    // CM: dodge 0.20 × 0.5 × 1.0 = 0.10
    // OA: weapon_damage 0.10 × 2.5 × 1.0 = 0.25
    expect(result.totalScore).toBeCloseTo(0.35);
    // Kirk (1.40) >>> Sulu (0.35) for grinding — that's the fix!
  });

  it("blocks effects for wrong target kind", () => {
    const changCm = makeAbility({
      id: "chang:cm",
      slot: "cm",
      effects: [
        makeEffect({
          id: "chang:cm:crit",
          effectKey: "crit_damage",
          magnitude: 0.30,
          applicableTargetKinds: ["player_ship"],
        }),
      ],
    });

    const ctx = makeContext({ targetKind: "hostile" });
    const result = evaluateOfficer("chang", [changCm], ctx, grindingWeights, "captain");

    expect(result.totalScore).toBe(0);
    expect(result.issues.some((i) => i.type === "not_applicable_to_target_kind")).toBe(true);
  });

  it("gives zero contribution for effects with zero intent weight", () => {
    const ability = makeAbility({
      effects: [
        makeEffect({
          effectKey: "warp_range",
          magnitude: 0.30,
        }),
      ],
    });

    const ctx = makeContext();
    const result = evaluateOfficer("uhura", [ability], ctx, grindingWeights, "bridge");

    // warp_range ∉ grindingWeights → weight = 0
    expect(result.totalScore).toBe(0);
  });

  it("halves contribution for conditional effects", () => {
    const ability = makeAbility({
      slot: "cm",
      effects: [
        makeEffect({
          effectKey: "hull_repair",
          magnitude: 0.10,
          conditions: [{ conditionKey: "when_shields_depleted", params: null }],
        }),
      ],
    });

    const weights = { hull_repair: 2.0 };
    const ctx = makeContext();
    const result = evaluateOfficer("scotty", [ability], ctx, weights, "captain");

    // 0.10 × 2.0 × 0.5 = 0.10
    expect(result.totalScore).toBeCloseTo(0.10);
  });
});

// ─── Golden Tests (ADR-034 Acceptance Criteria) ─────────────

describe("golden tests: Kirk/Spock/McCoy vs Sulu/Spock/Ivanov for grinding", () => {
  const grindingWeights: Record<string, number> = {
    damage_dealt: 3.0,
    weapon_damage: 2.5,
    crit_chance: 2.0,
    crit_damage: 2.0,
    mitigation: 1.5,
    armor: 1.5,
    hull_health: 1.0,
    shield_health: 1.0,
    officer_attack: 1.0,
    officer_defense: 0.8,
    officer_health: 0.8,
    dodge: 0.5,
  };

  const hostileCtx = makeContext({ targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] });

  function makeKirkAbilities(): OfficerAbility[] {
    return [
      makeAbility({
        id: "kirk:cm", slot: "cm",
        effects: [makeEffect({ id: "k:cm:d", effectKey: "damage_dealt", magnitude: 0.30, applicableTargetKinds: ["hostile"] })],
      }),
      makeAbility({
        id: "kirk:oa", slot: "oa",
        effects: [makeEffect({ id: "k:oa:w", effectKey: "weapon_damage", magnitude: 0.20, applicableTargetKinds: ["hostile"] })],
      }),
    ];
  }

  function makeSpockAbilities(): OfficerAbility[] {
    return [
      makeAbility({
        id: "spock:cm", slot: "cm",
        effects: [makeEffect({ id: "s:cm:c", effectKey: "crit_chance", magnitude: 0.25, applicableTargetKinds: ["hostile"] })],
      }),
      makeAbility({
        id: "spock:oa", slot: "oa",
        effects: [
          makeEffect({ id: "s:oa:a", effectKey: "officer_attack", magnitude: 0.15, applicableTargetKinds: ["hostile"] }),
          makeEffect({ id: "s:oa:d", effectKey: "officer_defense", magnitude: 0.15, applicableTargetKinds: ["hostile"] }),
          makeEffect({ id: "s:oa:h", effectKey: "officer_health", magnitude: 0.15, applicableTargetKinds: ["hostile"] }),
        ],
      }),
    ];
  }

  function makeMcCoyAbilities(): OfficerAbility[] {
    return [
      makeAbility({
        id: "mccoy:cm", slot: "cm",
        effects: [makeEffect({ id: "m:cm:h", effectKey: "hull_health", magnitude: 0.25, applicableTargetKinds: ["hostile"] })],
      }),
      makeAbility({
        id: "mccoy:oa", slot: "oa",
        effects: [makeEffect({
          id: "m:oa:m", effectKey: "mitigation", magnitude: 0.15, applicableTargetKinds: ["hostile"],
          conditions: [{ conditionKey: "at_round_start", params: null }],
        })],
      }),
    ];
  }

  function makeSuluAbilities(): OfficerAbility[] {
    return [
      makeAbility({
        id: "sulu:cm", slot: "cm",
        effects: [makeEffect({
          id: "su:cm:d", effectKey: "dodge", magnitude: 0.20,
          conditions: [{ conditionKey: "at_combat_start", params: null }],
        })],
      }),
      makeAbility({
        id: "sulu:oa", slot: "oa",
        effects: [makeEffect({
          id: "su:oa:w", effectKey: "weapon_damage", magnitude: 0.10,
          conditions: [{ conditionKey: "requires_attacking", params: null }],
        })],
      }),
    ];
  }

  function makeIvanovAbilities(): OfficerAbility[] {
    return [
      makeAbility({
        id: "ivanov:cm", slot: "cm",
        effects: [makeEffect({
          id: "iv:cm:w", effectKey: "weapon_damage", magnitude: 0.10,
          conditions: [{ conditionKey: "at_round_start", params: null }],
        })],
      }),
      makeAbility({
        id: "ivanov:oa", slot: "oa",
        effects: [makeEffect({
          id: "iv:oa:a", effectKey: "armor", magnitude: 0.10,
          conditions: [{ conditionKey: "requires_defending", params: null }],
        })],
      }),
    ];
  }

  it("Kirk scores higher than Sulu as captain for hostile grinding", () => {
    const kirkScore = evaluateOfficer("kirk", makeKirkAbilities(), hostileCtx, grindingWeights, "captain");
    const suluScore = evaluateOfficer("sulu", makeSuluAbilities(), hostileCtx, grindingWeights, "captain");
    expect(kirkScore.totalScore).toBeGreaterThan(suluScore.totalScore);
  });

  it("McCoy scores higher than Ivanov as bridge for hostile grinding", () => {
    const mccoyScore = evaluateOfficer("mccoy", makeMcCoyAbilities(), hostileCtx, grindingWeights, "bridge");
    const ivanovScore = evaluateOfficer("ivanov", makeIvanovAbilities(), hostileCtx, grindingWeights, "bridge");
    expect(mccoyScore.totalScore).toBeGreaterThan(ivanovScore.totalScore);
  });

  it("Kirk+Spock+McCoy trio total exceeds Sulu+Spock+Ivanov", () => {
    const kirkTotal = evaluateOfficer("kirk", makeKirkAbilities(), hostileCtx, grindingWeights, "captain");
    const spockBridge1 = evaluateOfficer("spock", makeSpockAbilities(), hostileCtx, grindingWeights, "bridge");
    const mccoyBridge2 = evaluateOfficer("mccoy", makeMcCoyAbilities(), hostileCtx, grindingWeights, "bridge");
    const goodTrio = kirkTotal.totalScore + spockBridge1.totalScore + mccoyBridge2.totalScore;

    const suluTotal = evaluateOfficer("sulu", makeSuluAbilities(), hostileCtx, grindingWeights, "captain");
    const spockBridge1b = evaluateOfficer("spock", makeSpockAbilities(), hostileCtx, grindingWeights, "bridge");
    const ivanovBridge2 = evaluateOfficer("ivanov", makeIvanovAbilities(), hostileCtx, grindingWeights, "bridge");
    const badTrio = suluTotal.totalScore + spockBridge1b.totalScore + ivanovBridge2.totalScore;

    expect(goodTrio).toBeGreaterThan(badTrio);
  });
});
