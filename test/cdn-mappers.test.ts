/**
 * cdn-mappers.test.ts — Tests for CDN data mappers
 *
 * Covers: toTitleCase, sanitizeHtml, formatAbilityDescription,
 *         mapCdnShipToReferenceInput, mapCdnOfficerToReferenceInput
 */

import { describe, it, expect } from "vitest";
import {
  toTitleCase,
  sanitizeHtml,
  formatAbilityDescription,
  mapCdnShipToReferenceInput,
  mapCdnOfficerToReferenceInput,
  mapCdnResearchToReferenceInput,
  mapCdnBuildingToReferenceInput,
  mapCdnHostileToReferenceInput,
  mapCdnConsumableToReferenceInput,
  mapCdnSystemToReferenceInput,
  type CdnShipSummaryForMapping,
  type CdnShipDetailForMapping,
  type CdnOfficerSummaryForMapping,
  type CdnOfficerDetailForMapping,
  type OfficerAbilityText,
  type CdnResearchSummary,
  type CdnBuildingSummary,
  type CdnHostileSummary,
  type CdnConsumableSummary,
  type CdnSystemSummary,
} from "../src/server/services/cdn-mappers.js";

// ─── toTitleCase ────────────────────────────────────────────

describe("toTitleCase", () => {
  it("returns empty/falsy input unchanged", () => {
    expect(toTitleCase("")).toBe("");
  });

  it("capitalizes a simple word", () => {
    expect(toTitleCase("kirk")).toBe("Kirk");
  });

  it("title-cases multiple words", () => {
    expect(toTitleCase("james tiberius kirk")).toBe("James Tiberius Kirk");
  });

  it("preserves USS token", () => {
    expect(toTitleCase("uss enterprise")).toBe("USS Enterprise");
  });

  it("preserves U.S.S. token", () => {
    expect(toTitleCase("u.s.s. enterprise")).toBe("U.S.S. Enterprise");
  });

  it("preserves ISS token", () => {
    expect(toTitleCase("iss enterprise")).toBe("ISS Enterprise");
  });

  it("preserves I.S.S. token", () => {
    expect(toTitleCase("i.s.s. enterprise")).toBe("I.S.S. Enterprise");
  });

  it("preserves NCC token", () => {
    expect(toTitleCase("ncc 1701")).toBe("NCC 1701");
  });

  it("handles hyphenated names", () => {
    expect(toTitleCase("d'vak")).toBe("D'Vak");
  });

  it("normalizes extra whitespace between words", () => {
    expect(toTitleCase("uss   enterprise")).toBe("USS Enterprise");
  });
});

// ─── sanitizeHtml ───────────────────────────────────────────

describe("sanitizeHtml", () => {
  it("passes allowed tags through unchanged", () => {
    expect(sanitizeHtml("<b>bold</b>")).toBe("<b>bold</b>");
    expect(sanitizeHtml("<i>italic</i>")).toBe("<i>italic</i>");
    expect(sanitizeHtml("<em>emphasis</em>")).toBe("<em>emphasis</em>");
    expect(sanitizeHtml("<strong>strong</strong>")).toBe("<strong>strong</strong>");
  });

  it("strips disallowed tags", () => {
    expect(sanitizeHtml("<script>alert(1)</script>")).toBe("alert(1)");
    expect(sanitizeHtml("<div>content</div>")).toBe("content");
    expect(sanitizeHtml("<span>text</span>")).toBe("text");
  });

  it("strips disallowed tags while preserving allowed ones", () => {
    expect(sanitizeHtml("<div><b>bold</b></div>")).toBe("<b>bold</b>");
  });

  it("handles text with no tags", () => {
    expect(sanitizeHtml("plain text")).toBe("plain text");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeHtml("  hello  ")).toBe("hello");
  });
});

// ─── formatAbilityDescription ───────────────────────────────

describe("formatAbilityDescription", () => {
  it("returns null for null/undefined description", () => {
    expect(formatAbilityDescription(null, [], false)).toBeNull();
    expect(formatAbilityDescription(undefined, [], false)).toBeNull();
  });

  it("returns description as-is when no placeholders", () => {
    expect(formatAbilityDescription("Increases attack", null, false)).toBe("Increases attack");
  });

  it("substitutes value placeholders", () => {
    const values = [{ value: 50, chance: 1 }];
    expect(formatAbilityDescription("Boosts attack by {0}", values, false)).toBe("Boosts attack by 50");
  });

  it("formats percentage values when isPercentage is true", () => {
    const values = [{ value: 0.25, chance: 1 }];
    expect(formatAbilityDescription("Boosts by {0}", values, true)).toBe("Boosts by 25%");
  });

  it("formats percentage values when format string includes %", () => {
    const values = [{ value: 0.15, chance: 1 }];
    expect(formatAbilityDescription("Boosts by {0:%}", values, false)).toBe("Boosts by 15%");
  });

  it("auto-detects percentage for values between 0 and 1", () => {
    const values = [{ value: 0.5, chance: 1 }];
    expect(formatAbilityDescription("Boosts by {0}", values, false)).toBe("Boosts by 50%");
  });

  it("uses chance instead of value when chance is not 1", () => {
    const values = [{ value: 100, chance: 0.3 }];
    expect(formatAbilityDescription("{0} chance", values, false)).toBe("30% chance");
  });

  it("leaves placeholder when index is out of range", () => {
    const values = [{ value: 10, chance: 1 }];
    expect(formatAbilityDescription("Values: {0} and {5}", values, false)).toBe("Values: 10 and {5}");
  });

  it("handles multiple placeholders", () => {
    const values = [
      { value: 100, chance: 1 },
      { value: 200, chance: 1 },
    ];
    expect(formatAbilityDescription("{0} to {1}", values, false)).toBe("100 to 200");
  });

  it("strips disallowed HTML and normalizes whitespace", () => {
    const result = formatAbilityDescription("<div>Boosts  attack   power</div>", null, false);
    expect(result).toBe("Boosts attack power");
  });

  it("formats fractional non-percentage values to 2 decimal places", () => {
    const values = [{ value: 3.456, chance: 1 }];
    expect(formatAbilityDescription("{0} units", values, false)).toBe("3.46 units");
  });

  it("formats fractional percentage values to 1 decimal place", () => {
    const values = [{ value: 0.333, chance: 1 }];
    expect(formatAbilityDescription("{0}", values, true)).toBe("33.3%");
  });
});

// ─── mapCdnShipToReferenceInput ─────────────────────────────

describe("mapCdnShipToReferenceInput", () => {
  const baseShip: CdnShipSummaryForMapping = {
    id: 101,
    loca_id: 1001,
    hull_type: 3,
    grade: 2,
    rarity: 1,
  };

  const baseOptions = {
    ship: baseShip,
    detail: null,
    shipNameMap: new Map([[1001, "uss enterprise"]]),
    shipAbilityNameMap: new Map<number, string>(),
    shipAbilityDescMap: new Map<number, string>(),
    hullTypeLabels: { 3: "Explorer" } as Record<number, string>,
    rarityLabels: { 1: "common" } as Record<number, string>,
    factionLabels: {} as Record<number, string>,
  };

  it("maps a minimal ship with title-cased name", () => {
    const result = mapCdnShipToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:ship:101");
    expect(result.name).toBe("USS Enterprise");
    expect(result.shipClass).toBe("Explorer");
    expect(result.rarity).toBe("common");
    expect(result.grade).toBe(2);
    expect(result.source).toBe("cdn:game-data");
    expect(result.faction).toBeNull();
    expect(result.ability).toBeNull();
  });

  it("falls back to Ship <id> when name not in map", () => {
    const opts = { ...baseOptions, shipNameMap: new Map<number, string>() };
    const result = mapCdnShipToReferenceInput(opts);
    expect(result.name).toBe("Ship 101");
  });

  it("maps faction when present and valid", () => {
    const opts = {
      ...baseOptions,
      ship: { ...baseShip, faction: { id: 5 } },
      factionLabels: { 5: "Federation" } as Record<number, string>,
    };
    const result = mapCdnShipToReferenceInput(opts);
    expect(result.faction).toBe("Federation");
  });

  it("ignores faction with id -1", () => {
    const opts = {
      ...baseOptions,
      ship: { ...baseShip, faction: { id: -1 } },
      factionLabels: { [-1]: "None" } as Record<number, string>,
    };
    const result = mapCdnShipToReferenceInput(opts);
    expect(result.faction).toBeNull();
  });

  it("includes detail fields when detail is provided", () => {
    const detail: CdnShipDetailForMapping = {
      build_time_in_seconds: 3600,
      max_tier: 5,
      max_level: 50,
      officer_bonus: { attack: 10 },
      crew_slots: [{ type: "bridge" }],
      build_cost: [{ resource: "tritanium", amount: 100 }],
      levels: [{ level: 1 }],
      tiers: [{ tier: 1 }],
      blueprints_required: 50,
    };
    const result = mapCdnShipToReferenceInput({ ...baseOptions, detail });
    expect(result.buildTimeInSeconds).toBe(3600);
    expect(result.maxTier).toBe(5);
    expect(result.maxLevel).toBe(50);
    expect(result.officerBonus).toEqual({ attack: 10 });
    expect(result.crewSlots).toEqual([{ type: "bridge" }]);
    expect(result.blueprintsRequired).toBe(50);
  });

  it("maps ship ability from detail", () => {
    const detail: CdnShipDetailForMapping = {
      ability: [{ value_is_percentage: true, values: [{ value: 0.1, chance: 1 }] }],
    };
    const opts = {
      ...baseOptions,
      detail,
      shipAbilityNameMap: new Map([[1001, "Warp Drive"]]),
      shipAbilityDescMap: new Map([[1001, "Increases warp speed"]]),
    };
    const result = mapCdnShipToReferenceInput(opts);
    expect(result.ability).toEqual({
      name: "Warp Drive",
      description: "Increases warp speed",
      valueIsPercentage: true,
      values: [{ value: 0.1, chance: 1 }],
    });
  });

  it("uses string rarity directly when provided as string", () => {
    const opts = {
      ...baseOptions,
      ship: { ...baseShip, rarity: "Epic" },
    };
    const result = mapCdnShipToReferenceInput(opts);
    expect(result.rarity).toBe("epic");
  });

  it("prefers detail maxTier over ship maxTier", () => {
    const detail: CdnShipDetailForMapping = { max_tier: 8 };
    const ship = { ...baseShip, max_tier: 5 };
    const result = mapCdnShipToReferenceInput({ ...baseOptions, ship, detail });
    expect(result.maxTier).toBe(8);
  });

  it("falls back to ship maxTier when detail lacks it", () => {
    const ship = { ...baseShip, max_tier: 5 };
    const result = mapCdnShipToReferenceInput({ ...baseOptions, ship });
    expect(result.maxTier).toBe(5);
  });
});

// ─── mapCdnOfficerToReferenceInput ──────────────────────────

describe("mapCdnOfficerToReferenceInput", () => {
  const baseOfficer: CdnOfficerSummaryForMapping = {
    id: 201,
    loca_id: 2001,
    rarity: 3,
    class: 1,
  };

  const baseOptions = {
    officer: baseOfficer,
    detail: null,
    rarityLabels: { 3: "rare" } as Record<number, string>,
    officerClassLabels: { 1: "Command" } as Record<number, string>,
    factionLabels: {} as Record<number, string>,
    officerNameMap: new Map([[2001, "James T. Kirk"]]),
    officerAbilityTextMap: new Map<number, OfficerAbilityText>(),
    factionNameMap: new Map<number, string>(),
    traitNameMap: new Map<number, string>(),
    formatAbilityDescription,
  };

  it("maps a minimal officer", () => {
    const result = mapCdnOfficerToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:officer:201");
    expect(result.name).toBe("James T. Kirk");
    expect(result.rarity).toBe("rare");
    expect(result.groupName).toBe("Command");
    expect(result.source).toBe("cdn:game-data");
    expect(result.faction).toBeNull();
    expect(result.abilities).toBeNull();
  });

  it("falls back to Officer <id> when name not in map", () => {
    const opts = { ...baseOptions, officerNameMap: new Map<number, string>() };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.name).toBe("Officer 201");
  });

  it("maps faction from labels", () => {
    const officer = { ...baseOfficer, faction: { id: 5, loca_id: 5001 } };
    const opts = {
      ...baseOptions,
      officer,
      factionLabels: { 5: "Federation" } as Record<number, string>,
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.faction).toEqual({ id: 5, name: "Federation" });
  });

  it("falls back to factionNameMap when factionLabels miss", () => {
    const officer = { ...baseOfficer, faction: { id: 5, loca_id: 5001 } };
    const opts = {
      ...baseOptions,
      officer,
      factionNameMap: new Map([[5001, "Klingon Empire"]]),
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.faction).toEqual({ id: 5, name: "Klingon Empire" });
  });

  it("maps captain maneuver ability text", () => {
    const officer: CdnOfficerSummaryForMapping = {
      ...baseOfficer,
      captain_ability: { loca_id: 3001, value_is_percentage: true, values: [{ value: 0.2, chance: 1 }] },
    };
    const abilityText: OfficerAbilityText = {
      name: "Inspire",
      description: "Increases all crew stats by {0}",
      shortDescription: "Boosts crew by {0}",
    };
    const opts = {
      ...baseOptions,
      officer,
      officerAbilityTextMap: new Map([[3001, abilityText]]),
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.captainManeuver).toBe("Boosts crew by 20%");
    expect(result.abilities).not.toBeNull();
    expect((result.abilities as Record<string, unknown>).captainManeuver).toBeDefined();
  });

  it("maps officer ability and below deck ability", () => {
    const officer: CdnOfficerSummaryForMapping = {
      ...baseOfficer,
      ability: { loca_id: 3002, value_is_percentage: false, values: [{ value: 50, chance: 1 }] },
      below_decks_ability: { loca_id: 3003, value_is_percentage: false, values: [{ value: 30, chance: 1 }] },
    };
    const opts = {
      ...baseOptions,
      officer,
      officerAbilityTextMap: new Map<number, OfficerAbilityText>([
        [3002, { name: "Shield Boost", description: "Adds {0} shields", shortDescription: "+{0} shields" }],
        [3003, { name: "Hull Repair", description: "Repairs {0} hull", shortDescription: "+{0} hull" }],
      ]),
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.officerAbility).toBe("+50 shields");
    expect(result.belowDeckAbility).toBe("+30 hull");
    const abilities = result.abilities as Record<string, Record<string, unknown>>;
    expect(abilities.officerAbility.name).toBe("Shield Boost");
    expect(abilities.belowDeckAbility.name).toBe("Hull Repair");
  });

  it("maps trait config from detail", () => {
    const detail: CdnOfficerDetailForMapping = {
      trait_config: {
        progression: [
          { required_rank: 1, trait_id: 10 },
          { required_rank: 3, trait_id: 20 },
        ],
      },
    };
    const opts = {
      ...baseOptions,
      detail,
      traitNameMap: new Map([[10, "Brave"], [20, "Tactical"]]),
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.traitConfig).toEqual({
      progression: [
        { requiredRank: 1, traitId: 10, traitName: "Brave" },
        { requiredRank: 3, traitId: 20, traitName: "Tactical" },
      ],
    });
  });

  it("maps synergy_id and max_rank", () => {
    const officer = { ...baseOfficer, synergy_id: 42, max_rank: 5 };
    const result = mapCdnOfficerToReferenceInput({ ...baseOptions, officer });
    expect(result.synergyId).toBe(42);
    expect(result.maxRank).toBe(5);
  });

  it("prefers detail ability values over summary values", () => {
    const officer: CdnOfficerSummaryForMapping = {
      ...baseOfficer,
      captain_ability: { loca_id: 3001, value_is_percentage: true, values: [{ value: 0.1, chance: 1 }] },
    };
    const detail: CdnOfficerDetailForMapping = {
      captain_ability: { values: [{ value: 0.5, chance: 1 }] },
    };
    const abilityText: OfficerAbilityText = {
      name: "Inspire",
      description: "Boosts by {0}",
      shortDescription: "Boosts by {0}",
    };
    const opts = {
      ...baseOptions,
      officer,
      detail,
      officerAbilityTextMap: new Map([[3001, abilityText]]),
    };
    const result = mapCdnOfficerToReferenceInput(opts);
    expect(result.captainManeuver).toBe("Boosts by 50%");
  });
});

// ─── mapCdnResearchToReferenceInput ──────────────────────

describe("mapCdnResearchToReferenceInput", () => {
  const baseResearch: CdnResearchSummary = {
    id: 4001,
    loca_id: 5001,
    unlock_level: 10,
    max_level: 40,
    research_tree: { id: 1, loca_id: 6001, type: 1 },
    buffs: [{ stat: "attack", value: 5 }],
  };

  const baseOptions = {
    research: baseResearch,
    nameMap: new Map([[5001, "improved hull armor"]]),
    treeNameMap: new Map([[6001, "combat research"]]),
  };

  it("maps a research entry with title-cased name and tree", () => {
    const result = mapCdnResearchToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:research:4001");
    expect(result.name).toBe("Improved Hull Armor");
    expect(result.researchTree).toBe("combat research");
    expect(result.unlockLevel).toBe(10);
    expect(result.maxLevel).toBe(40);
    expect(result.buffs).toEqual([{ stat: "attack", value: 5 }]);
    expect(result.source).toBe("cdn:game-data");
    expect(result.gameId).toBe(4001);
  });

  it("falls back to Research <id> when name not in map", () => {
    const opts = { ...baseOptions, nameMap: new Map<number, string>() };
    const result = mapCdnResearchToReferenceInput(opts);
    expect(result.name).toBe("Research 4001");
  });

  it("maps tree name as null when tree loca_id not in map", () => {
    const opts = { ...baseOptions, treeNameMap: new Map<number, string>() };
    const result = mapCdnResearchToReferenceInput(opts);
    expect(result.researchTree).toBeNull();
  });

  it("maps row/col from research data", () => {
    const opts = { ...baseOptions, research: { ...baseResearch, row: 3, column: 5 } };
    const result = mapCdnResearchToReferenceInput(opts);
    expect(result.row).toBe(3);
    expect(result.col).toBe(5);
  });

  it("defaults row/col to null when absent", () => {
    const result = mapCdnResearchToReferenceInput(baseOptions);
    expect(result.row).toBeNull();
    expect(result.col).toBeNull();
  });

  it("maps requirements from first_level_requirements", () => {
    const research = { ...baseResearch, first_level_requirements: [{ type: "ops", level: 10 }] };
    const result = mapCdnResearchToReferenceInput({ ...baseOptions, research });
    expect(result.requirements).toEqual([{ type: "ops", level: 10 }]);
  });
});

// ─── mapCdnBuildingToReferenceInput ──────────────────────

describe("mapCdnBuildingToReferenceInput", () => {
  const baseBuilding: CdnBuildingSummary = {
    id: 2001,
    max_level: 50,
    unlock_level: 5,
    buffs: [{ stat: "defense", value: 10 }],
  };

  const baseOptions = {
    building: baseBuilding,
    nameMap: new Map([[2001, "operations center"]]),
  };

  it("maps a building with title-cased name", () => {
    const result = mapCdnBuildingToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:building:2001");
    expect(result.name).toBe("Operations Center");
    expect(result.maxLevel).toBe(50);
    expect(result.unlockLevel).toBe(5);
    expect(result.buffs).toEqual([{ stat: "defense", value: 10 }]);
    expect(result.source).toBe("cdn:game-data");
    expect(result.gameId).toBe(2001);
  });

  it("falls back to Building <id> when name not in map", () => {
    const opts = { ...baseOptions, nameMap: new Map<number, string>() };
    const result = mapCdnBuildingToReferenceInput(opts);
    expect(result.name).toBe("Building 2001");
  });

  it("maps requirements when present", () => {
    const building = { ...baseBuilding, first_level_requirements: [{ type: "ops", level: 3 }] };
    const result = mapCdnBuildingToReferenceInput({ ...baseOptions, building });
    expect(result.requirements).toEqual([{ type: "ops", level: 3 }]);
  });

  it("defaults requirements to null when absent", () => {
    const result = mapCdnBuildingToReferenceInput(baseOptions);
    expect(result.requirements).toBeNull();
  });
});

// ─── mapCdnHostileToReferenceInput ───────────────────────

describe("mapCdnHostileToReferenceInput", () => {
  const baseHostile: CdnHostileSummary = {
    id: 3001,
    loca_id: 7001,
    faction: { id: 5, loca_id: null },
    level: 28,
    ship_type: 1,
    hull_type: 2,
    rarity: 3,
    strength: 150000,
    systems: [100, 200],
    warp: 50,
    resources: [{ type: "parsteel", amount: 500 }],
  };

  const baseOptions = {
    hostile: baseHostile,
    nameMap: new Map([[7001, "klingon battlecruiser"]]),
    factionLabels: { 5: "Klingon Empire" } as Record<number, string>,
  };

  it("maps a hostile with all fields", () => {
    const result = mapCdnHostileToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:hostile:3001");
    expect(result.name).toBe("Klingon Battlecruiser");
    expect(result.faction).toBe("Klingon Empire");
    expect(result.level).toBe(28);
    expect(result.shipType).toBe(1);
    expect(result.hullType).toBe(2);
    expect(result.rarity).toBe(3);
    expect(result.strength).toBe(150000);
    expect(result.systems).toEqual(["100", "200"]);
    expect(result.warp).toBe(50);
    expect(result.resources).toEqual([{ type: "parsteel", amount: 500 }]);
    expect(result.source).toBe("cdn:game-data");
    expect(result.gameId).toBe(3001);
  });

  it("falls back to Hostile <id> when name not in map", () => {
    const opts = { ...baseOptions, nameMap: new Map<number, string>() };
    const result = mapCdnHostileToReferenceInput(opts);
    expect(result.name).toBe("Hostile 3001");
  });

  it("maps faction as null when faction id is -1", () => {
    const hostile = { ...baseHostile, faction: { id: -1, loca_id: null } };
    const result = mapCdnHostileToReferenceInput({ ...baseOptions, hostile });
    expect(result.faction).toBeNull();
  });

  it("maps faction as null when faction id missing from labels", () => {
    const opts = { ...baseOptions, factionLabels: {} as Record<number, string> };
    const result = mapCdnHostileToReferenceInput(opts);
    expect(result.faction).toBeNull();
  });
});

// ─── mapCdnConsumableToReferenceInput ────────────────────

describe("mapCdnConsumableToReferenceInput", () => {
  const baseConsumable: CdnConsumableSummary = {
    id: 9001,
    loca_id: 8001,
    rarity: "rare",
    grade: 3,
    requires_slot: true,
    buff: { stat: "attack", value: 15 },
    duration_seconds: 3600,
    category: 2,
  };

  const baseOptions = {
    consumable: baseConsumable,
    nameMap: new Map([[8001, "attack boost"]]),
  };

  it("maps a consumable with all fields", () => {
    const result = mapCdnConsumableToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:consumable:9001");
    expect(result.name).toBe("Attack Boost");
    expect(result.rarity).toBe("rare");
    expect(result.grade).toBe(3);
    expect(result.requiresSlot).toBe(true);
    expect(result.buff).toEqual({ stat: "attack", value: 15 });
    expect(result.durationSeconds).toBe(3600);
    expect(result.category).toBe("2");
    expect(result.source).toBe("cdn:game-data");
    expect(result.gameId).toBe(9001);
  });

  it("falls back to Consumable <id> when name not in map", () => {
    const opts = { ...baseOptions, nameMap: new Map<number, string>() };
    const result = mapCdnConsumableToReferenceInput(opts);
    expect(result.name).toBe("Consumable 9001");
  });

  it("maps null buff when buff is null", () => {
    const consumable = { ...baseConsumable, buff: null };
    const result = mapCdnConsumableToReferenceInput({ ...baseOptions, consumable });
    expect(result.buff).toBeNull();
  });
});

// ─── mapCdnSystemToReferenceInput ────────────────────────

describe("mapCdnSystemToReferenceInput", () => {
  const baseSystem: CdnSystemSummary = {
    id: 6001,
    est_warp: 25,
    is_deep_space: false,
    faction: [5, 6],
    level: 30,
    coords_x: 100,
    coords_y: 200,
    has_mines: true,
    has_planets: true,
    has_missions: false,
    mine_resources: [{ type: "parsteel" }],
    hostiles: [{}, {}, {}],
    node_sizes: [{ size: "large" }],
  };

  const baseOptions = {
    system: baseSystem,
    nameMap: new Map([[6001, "sol system"]]),
    factionLabels: { 5: "Federation", 6: "Klingon Empire" } as Record<number, string>,
  };

  it("maps a system with all fields", () => {
    const result = mapCdnSystemToReferenceInput(baseOptions);
    expect(result.id).toBe("cdn:system:6001");
    expect(result.name).toBe("Sol System");
    expect(result.estWarp).toBe(25);
    expect(result.isDeepSpace).toBe(false);
    expect(result.factions).toEqual(["Federation", "Klingon Empire"]);
    expect(result.level).toBe(30);
    expect(result.coordsX).toBe(100);
    expect(result.coordsY).toBe(200);
    expect(result.hasMines).toBe(true);
    expect(result.hasPlanets).toBe(true);
    expect(result.hasMissions).toBe(false);
    expect(result.mineResources).toEqual([{ type: "parsteel" }]);
    expect(result.hostileCount).toBe(3);
    expect(result.nodeSizes).toEqual([{ size: "large" }]);
    expect(result.source).toBe("cdn:game-data");
    expect(result.gameId).toBe(6001);
  });

  it("falls back to System <id> when name not in map", () => {
    const opts = { ...baseOptions, nameMap: new Map<number, string>() };
    const result = mapCdnSystemToReferenceInput(opts);
    expect(result.name).toBe("System 6001");
  });

  it("maps factions as null when faction array is empty", () => {
    const system = { ...baseSystem, faction: [] };
    const result = mapCdnSystemToReferenceInput({ ...baseOptions, system });
    expect(result.factions).toBeNull();
  });

  it("derives hostile count from hostiles array length", () => {
    const system = { ...baseSystem, hostiles: [{}, {}, {}, {}, {}] };
    const result = mapCdnSystemToReferenceInput({ ...baseOptions, system });
    expect(result.hostileCount).toBe(5);
  });

  it("maps hazard level when present", () => {
    const system = { ...baseSystem, hazard_level: 3 };
    const result = mapCdnSystemToReferenceInput({ ...baseOptions, system });
    expect(result.hazardLevel).toBe(3);
  });

  it("defaults hazard level to null when absent", () => {
    const result = mapCdnSystemToReferenceInput(baseOptions);
    expect(result.hazardLevel).toBeNull();
  });

  it("uses raw faction id as string when labels are missing", () => {
    const opts = { ...baseOptions, factionLabels: {} as Record<number, string> };
    const result = mapCdnSystemToReferenceInput(opts);
    expect(result.factions).toEqual(["5", "6"]);
  });
});
