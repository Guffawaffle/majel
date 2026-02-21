import type { CreateReferenceOfficerInput, CreateReferenceShipInput } from "../stores/reference-store.js";

interface AbilityValue {
  value: number;
  chance: number;
}

const ALLOWED_HTML_TAGS = new Set(["i", "b", "em", "strong"]);

export interface OfficerAbilityText {
  name: string;
  description: string;
  shortDescription: string;
}

export interface CdnShipSummaryForMapping {
  id: number;
  loca_id: number;
  hull_type: number;
  grade: number | null;
  rarity: number | string;
  faction?: { id?: number | null } | null;
  max_tier?: number | null;
  build_requirements?: unknown;
  blueprints_required?: number | null;
}

export interface CdnShipDetailForMapping {
  ability?: Array<{ value_is_percentage?: boolean; values?: unknown }>;
  build_time_in_seconds?: number | null;
  max_tier?: number | null;
  max_level?: number | null;
  officer_bonus?: Record<string, unknown> | null;
  crew_slots?: Record<string, unknown>[] | null;
  build_cost?: Record<string, unknown>[] | null;
  levels?: Record<string, unknown>[] | null;
  tiers?: Record<string, unknown>[] | null;
  build_requirements?: Record<string, unknown>[] | null;
  blueprints_required?: number | null;
}

export interface CdnOfficerAbilityRefForMapping {
  loca_id?: number | null;
  value_is_percentage?: boolean;
  values?: AbilityValue[] | null;
}

export interface CdnOfficerSummaryForMapping {
  id: number;
  loca_id: number;
  rarity: number;
  class: number;
  faction?: { id?: number | null; loca_id?: number | null } | null;
  captain_ability?: CdnOfficerAbilityRefForMapping | null;
  ability?: CdnOfficerAbilityRefForMapping | null;
  below_decks_ability?: CdnOfficerAbilityRefForMapping | null;
  synergy_id?: number | null;
  max_rank?: number | null;
}

export interface CdnOfficerDetailForMapping {
  captain_ability?: { values?: AbilityValue[] | null } | null;
  ability?: { values?: AbilityValue[] | null } | null;
  below_decks_ability?: { values?: AbilityValue[] | null } | null;
  trait_config?: { progression: Array<{ required_rank: number; trait_id: number }> } | null;
  max_rank?: number | null;
}

const UPPERCASE_TOKENS: Record<string, string> = {
  "u.s.s.": "U.S.S.",
  "i.s.s.": "I.S.S.",
  "uss": "USS",
  "iss": "ISS",
  "ncc": "NCC",
};

export function toTitleCase(name: string): string {
  if (!name) return name;
  return name
    .split(/\s+/)
    .map((token) => {
      const lower = token.toLowerCase();
      if (UPPERCASE_TOKENS[lower]) return UPPERCASE_TOKENS[lower];
      return lower.replace(/(?:^|(?<=['.-]))\S/g, (ch) => ch.toUpperCase());
    })
    .join(" ");
}

export function sanitizeHtml(text: string): string {
  return text.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tagName: string) => {
    return ALLOWED_HTML_TAGS.has(tagName.toLowerCase()) ? match : "";
  }).trim();
}

export function formatAbilityDescription(
  description: string | null | undefined,
  values: AbilityValue[] | null | undefined,
  isPercentage: boolean,
): string | null {
  if (!description) return null;

  let formatted = description;
  if (values && values.length > 0) {
    formatted = formatted.replace(/\{(\d+)(?::([^}]+))?\}/g, (match, indexStr, format) => {
      const index = Number.parseInt(indexStr, 10);
      if (Number.isNaN(index) || index < 0 || index >= values.length) return match;

      const entry = values[index];
      const rawValue = entry.chance !== 1 ? entry.chance : entry.value;
      const formatAsPercent = (typeof format === "string" && format.includes("%"))
        || isPercentage
        || (rawValue > 0 && rawValue < 1);

      if (formatAsPercent) {
        const percentValue = rawValue * 100;
        return percentValue % 1 === 0 ? `${percentValue}%` : `${percentValue.toFixed(1)}%`;
      }
      return rawValue % 1 === 0 ? String(rawValue) : rawValue.toFixed(2);
    });
  }

  const sanitized = sanitizeHtml(formatted).replace(/\s+/g, " ").trim();
  return sanitized;
}

interface ShipMapperOptions {
  ship: CdnShipSummaryForMapping;
  detail: CdnShipDetailForMapping | null;
  shipNameMap: Map<number, string>;
  shipAbilityNameMap: Map<number, string>;
  shipAbilityDescMap: Map<number, string>;
  hullTypeLabels: Record<number, string>;
  rarityLabels: Record<number, string>;
  factionLabels: Record<number, string>;
}

export function mapCdnShipToReferenceInput(options: ShipMapperOptions): CreateReferenceShipInput {
  const {
    ship,
    detail,
    shipNameMap,
    shipAbilityNameMap,
    shipAbilityDescMap,
    hullTypeLabels,
    rarityLabels,
    factionLabels,
  } = options;

  const rawName = shipNameMap.get(ship.loca_id) ?? `Ship ${ship.id}`;
  const name = toTitleCase(rawName);
  const factionId = ship.faction?.id ?? null;
  const factionName = factionId != null && factionId !== -1 ? (factionLabels[factionId] ?? null) : null;
  const hullTypeName = hullTypeLabels[ship.hull_type] ?? null;
  const rarityStr = typeof ship.rarity === "string" ? ship.rarity.toLowerCase() : (rarityLabels[ship.rarity] ?? null);

  let ability: Record<string, unknown> | null = null;
  if (detail?.ability?.[0]) {
    const entry = detail.ability[0];
    ability = {
      name: shipAbilityNameMap.get(ship.loca_id) ?? null,
      description: shipAbilityDescMap.get(ship.loca_id) ?? null,
      valueIsPercentage: entry.value_is_percentage,
      values: entry.values,
    };
  }

  return {
    id: `cdn:ship:${ship.id}`,
    name,
    shipClass: hullTypeName,
    grade: ship.grade,
    rarity: rarityStr,
    faction: factionName,
    tier: null,
    ability,
    warpRange: null,
    link: `cdn:ship:${ship.id}`,
    hullType: ship.hull_type,
    buildTimeInSeconds: detail?.build_time_in_seconds ?? null,
    maxTier: detail?.max_tier ?? ship.max_tier ?? null,
    maxLevel: detail?.max_level ?? null,
    officerBonus: detail?.officer_bonus ?? null,
    crewSlots: detail?.crew_slots ?? null,
    buildCost: detail?.build_cost ?? null,
    levels: detail?.levels ?? null,
    tiers: detail?.tiers ?? null,
    buildRequirements: detail?.build_requirements
      ?? (ship.build_requirements as Record<string, unknown>[] | null | undefined)
      ?? null,
    blueprintsRequired: detail?.blueprints_required ?? ship.blueprints_required ?? null,
    gameId: ship.id,
    source: "cdn:game-data",
    sourceUrl: null,
    sourcePageId: null,
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  };
}

interface OfficerMapperOptions {
  officer: CdnOfficerSummaryForMapping;
  detail: CdnOfficerDetailForMapping | null;
  rarityLabels: Record<number, string>;
  officerClassLabels: Record<number, string>;
  factionLabels: Record<number, string>;
  officerNameMap: Map<number, string>;
  officerAbilityTextMap: Map<number, OfficerAbilityText>;
  factionNameMap: Map<number, string>;
  traitNameMap: Map<number, string>;
  formatAbilityDescription: (
    description: string | null | undefined,
    values: AbilityValue[] | null | undefined,
    isPercentage: boolean,
  ) => string | null;
}

export function mapCdnOfficerToReferenceInput(options: OfficerMapperOptions): CreateReferenceOfficerInput {
  const {
    officer,
    detail,
    rarityLabels,
    officerClassLabels,
    factionLabels,
    officerNameMap,
    officerAbilityTextMap,
    factionNameMap,
    traitNameMap,
    formatAbilityDescription,
  } = options;

  const name = officerNameMap.get(officer.loca_id) ?? `Officer ${officer.id}`;
  const factionId = officer.faction?.id ?? null;
  const factionName = factionId != null
    ? (factionLabels[factionId] ?? factionNameMap.get(officer.faction?.loca_id ?? -1) ?? null)
    : null;
  const rarityStr = rarityLabels[officer.rarity] ?? String(officer.rarity);
  const className = officerClassLabels[officer.class] ?? null;

  const cmText = officer.captain_ability?.loca_id != null ? officerAbilityTextMap.get(officer.captain_ability.loca_id) : null;
  const oaText = officer.ability?.loca_id != null ? officerAbilityTextMap.get(officer.ability.loca_id) : null;
  const bdText = officer.below_decks_ability?.loca_id != null ? officerAbilityTextMap.get(officer.below_decks_ability.loca_id) : null;

  const cmValues = detail?.captain_ability?.values ?? officer.captain_ability?.values ?? null;
  const oaValues = detail?.ability?.values ?? officer.ability?.values ?? null;
  const bdValues = detail?.below_decks_ability?.values ?? officer.below_decks_ability?.values ?? null;

  const cmDesc = formatAbilityDescription(
    cmText?.shortDescription ?? cmText?.description,
    cmValues,
    officer.captain_ability?.value_is_percentage ?? false,
  );
  const oaDesc = formatAbilityDescription(
    oaText?.shortDescription ?? oaText?.description,
    oaValues,
    officer.ability?.value_is_percentage ?? false,
  );
  const bdDesc = formatAbilityDescription(
    bdText?.shortDescription ?? bdText?.description,
    bdValues,
    officer.below_decks_ability?.value_is_percentage ?? false,
  );

  const abilities: Record<string, unknown> = {};
  if (officer.captain_ability) {
    abilities.captainManeuver = {
      name: cmText?.name ?? null,
      description: formatAbilityDescription(cmText?.description, cmValues, officer.captain_ability.value_is_percentage ?? false),
      shortDescription: cmDesc,
      valueIsPercentage: officer.captain_ability.value_is_percentage,
      values: cmValues,
    };
  }
  if (officer.ability) {
    abilities.officerAbility = {
      name: oaText?.name ?? null,
      description: formatAbilityDescription(oaText?.description, oaValues, officer.ability.value_is_percentage ?? false),
      shortDescription: oaDesc,
      valueIsPercentage: officer.ability.value_is_percentage,
      values: oaValues,
    };
  }
  if (officer.below_decks_ability) {
    abilities.belowDeckAbility = {
      name: bdText?.name ?? null,
      description: formatAbilityDescription(bdText?.description, bdValues, officer.below_decks_ability.value_is_percentage ?? false),
      shortDescription: bdDesc,
      valueIsPercentage: officer.below_decks_ability.value_is_percentage,
      values: bdValues,
    };
  }

  let traitConfig: Record<string, unknown> | null = null;
  if (detail?.trait_config) {
    traitConfig = {
      progression: detail.trait_config.progression.map((entry) => ({
        requiredRank: entry.required_rank,
        traitId: entry.trait_id,
        traitName: traitNameMap.get(entry.trait_id) ?? null,
      })),
    };
  }

  return {
    id: `cdn:officer:${officer.id}`,
    name,
    rarity: rarityStr,
    groupName: className,
    captainManeuver: cmDesc,
    officerAbility: oaDesc,
    belowDeckAbility: bdDesc,
    abilities: Object.keys(abilities).length > 0 ? abilities : null,
    tags: null,
    officerGameId: officer.id,
    officerClass: officer.class,
    faction: factionId != null ? { id: factionId, name: factionName } : null,
    synergyId: officer.synergy_id ?? null,
    maxRank: officer.max_rank ?? detail?.max_rank ?? null,
    traitConfig,
    source: "cdn:game-data",
    sourceUrl: null,
    sourcePageId: null,
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  };
}
