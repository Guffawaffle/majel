import type { CatalogOfficer } from "../web/src/lib/types.js";
import type { EffectBundleData } from "../web/src/lib/effect-bundle-adapter.js";
import type { OfficerAbility, EffectTag, TargetContext, IntentDefinition } from "../web/src/lib/types/effect-types.js";

export function makeOfficer(input: Partial<CatalogOfficer> & { id: string; name: string }): CatalogOfficer {
  const { id, name, ...rest } = input;
  return {
    id,
    name,
    rarity: null,
    groupName: null,
    captainManeuver: null,
    officerAbility: null,
    belowDeckAbility: null,
    abilities: null,
    tags: null,
    officerGameId: null,
    officerClass: null,
    faction: null,
    synergyId: null,
    maxRank: null,
    traitConfig: null,
    source: "test",
    ownershipState: "owned",
    target: false,
    userLevel: 30,
    userRank: null,
    userPower: 100,
    targetNote: null,
    targetPriority: null,
    ...rest,
  };
}

/**
 * Build a minimal EffectBundleData for testing.
 */
export function makeEffectBundle(opts: {
  officers: Record<string, OfficerAbility[]>;
  intents: Record<string, { weights: Record<string, number>; ctx?: Partial<TargetContext> }>;
}): EffectBundleData {
  const intentWeights = new Map<string, Record<string, number>>();
  const intents = new Map<string, IntentDefinition>();
  const officerAbilities = new Map<string, OfficerAbility[]>();

  for (const [key, def] of Object.entries(opts.intents)) {
    intentWeights.set(key, def.weights);
    intents.set(key, {
      id: key,
      name: key,
      description: `${key} intent`,
      defaultContext: {
        targetKind: "hostile",
        engagement: "any",
        targetTags: ["pve"],
        ...def.ctx,
      } as TargetContext,
      effectWeights: def.weights,
    });
  }

  for (const [id, abilities] of Object.entries(opts.officers)) {
    officerAbilities.set(id, abilities);
  }

  return { schemaVersion: "1.0.0", intentWeights, officerAbilities, intents };
}

export function makeTestAbility(opts: {
  id: string;
  officerId: string;
  slot: "cm" | "oa" | "bda";
  effects: Partial<EffectTag>[];
  isInert?: boolean;
  rawText?: string | null;
}): OfficerAbility {
  return {
    id: opts.id,
    officerId: opts.officerId,
    slot: opts.slot,
    name: opts.id,
    rawText: opts.rawText ?? null,
    isInert: opts.isInert ?? false,
    effects: opts.effects.map((e, i) => ({
      id: `${opts.id}-e${i}`,
      abilityId: opts.id,
      effectKey: e.effectKey ?? "damage_dealt",
      magnitude: e.magnitude ?? null,
      unit: e.unit ?? null,
      stacking: e.stacking ?? null,
      applicableTargetKinds: e.applicableTargetKinds ?? [],
      applicableTargetTags: e.applicableTargetTags ?? [],
      conditions: e.conditions ?? [],
    })),
  };
}

export const GRINDING_WEIGHTS: Record<string, number> = {
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

export function makeGrindingBundle(): EffectBundleData {
  return makeEffectBundle({
    intents: {
      grinding: {
        weights: GRINDING_WEIGHTS,
        ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
      },
    },
    officers: {
      "o-kirk": [
        makeTestAbility({
          id: "kirk:cm", officerId: "o-kirk", slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.30, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "kirk:oa", officerId: "o-kirk", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.20, applicableTargetKinds: ["hostile"] }],
        }),
      ],
      "o-spock": [
        makeTestAbility({
          id: "spock:cm", officerId: "o-spock", slot: "cm",
          effects: [{ effectKey: "crit_chance", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "spock:oa", officerId: "o-spock", slot: "oa",
          effects: [
            { effectKey: "officer_attack", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
            { effectKey: "officer_defense", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
            { effectKey: "officer_health", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
          ],
        }),
      ],
      "o-mccoy": [
        makeTestAbility({
          id: "mccoy:cm", officerId: "o-mccoy", slot: "cm",
          effects: [{ effectKey: "hull_health", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "mccoy:oa", officerId: "o-mccoy", slot: "oa",
          effects: [{
            effectKey: "mitigation", magnitude: 0.15, applicableTargetKinds: ["hostile"],
            conditions: [{ conditionKey: "at_round_start", params: null }],
          }],
        }),
      ],
      "o-sulu": [
        makeTestAbility({
          id: "sulu:cm", officerId: "o-sulu", slot: "cm",
          effects: [{
            effectKey: "dodge", magnitude: 0.20,
            conditions: [{ conditionKey: "at_combat_start", params: null }],
          }],
        }),
        makeTestAbility({
          id: "sulu:oa", officerId: "o-sulu", slot: "oa",
          effects: [{
            effectKey: "weapon_damage", magnitude: 0.10,
            conditions: [{ conditionKey: "requires_attacking", params: null }],
          }],
        }),
      ],
      "o-ivanov": [
        makeTestAbility({
          id: "ivanov:cm", officerId: "o-ivanov", slot: "cm",
          effects: [{
            effectKey: "weapon_damage", magnitude: 0.10,
            conditions: [{ conditionKey: "at_round_start", params: null }],
          }],
        }),
        makeTestAbility({
          id: "ivanov:oa", officerId: "o-ivanov", slot: "oa",
          effects: [{
            effectKey: "armor", magnitude: 0.10,
            conditions: [{ conditionKey: "requires_defending", params: null }],
          }],
        }),
      ],
    },
  });
}
