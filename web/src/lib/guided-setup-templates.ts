import type { CatalogOfficer, CatalogShip, OwnershipState } from "./types.js";

export interface GuidedSetupTemplate {
  key: "mining" | "swarm" | "borg" | "pvp" | "armadas";
  title: string;
  description: string;
  officerNames: string[];
  shipNames: string[];
}

export interface GuidedSetupSuggestion {
  id: string;
  name: string;
  ownershipState: OwnershipState;
  checked: boolean;
}

export const GUIDED_SETUP_TEMPLATES: GuidedSetupTemplate[] = [
  {
    key: "mining",
    title: "Mining",
    description: "Survey and refinery loops.",
    officerNames: ["T'Pring", "Barot", "Helvia", "Domitia", "Stonn"],
    shipNames: ["Envoy", "Horizon", "North Star", "Antares", "Meridian", "D'Vor"],
  },
  {
    key: "swarm",
    title: "Swarm",
    description: "Daily and event swarm grinding.",
    officerNames: ["Pike", "Moreau", "T'Laan", "Jaylah", "Cadet Uhura"],
    shipNames: ["Franklin", "Franklin-A"],
  },
  {
    key: "borg",
    title: "Borg",
    description: "Probe loops and Borg progression.",
    officerNames: ["Five of Eleven", "Seven of Ten", "One of Eleven", "Khan"],
    shipNames: ["Vi'Dar", "Talios"],
  },
  {
    key: "pvp",
    title: "PvP",
    description: "Arena, raiding, and hostile player fights.",
    officerNames: ["Kirk", "Spock", "Khan", "Marcus", "Georgiou", "Sela"],
    shipNames: ["Enterprise", "Saladin", "Augur", "D4", "Jellyfish"],
  },
  {
    key: "armadas",
    title: "Armadas",
    description: "Team armadas and long-form boss events.",
    officerNames: ["Riker", "Beverly", "Kirk", "Spock", "Uhura", "Gorkon"],
    shipNames: ["Enterprise", "Stella", "Sarcophagus"],
  },
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveMatches<T extends { id: string; name: string; ownershipState: OwnershipState }>(
  items: T[],
  wantedNames: Set<string>,
): GuidedSetupSuggestion[] {
  const out: GuidedSetupSuggestion[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const normalized = normalize(item.name);
    const matched = [...wantedNames].some((wanted) => normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized));
    if (!matched || seen.has(item.id)) continue;
    out.push({
      id: item.id,
      name: item.name,
      ownershipState: item.ownershipState,
      checked: item.ownershipState === "owned",
    });
    seen.add(item.id);
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveGuidedSetupSuggestions(
  officers: CatalogOfficer[],
  ships: CatalogShip[],
  selectedTemplateKeys: string[],
): { officers: GuidedSetupSuggestion[]; ships: GuidedSetupSuggestion[] } {
  const selected = GUIDED_SETUP_TEMPLATES.filter((template) => selectedTemplateKeys.includes(template.key));
  const officerNames = new Set(selected.flatMap((template) => template.officerNames.map(normalize)));
  const shipNames = new Set(selected.flatMap((template) => template.shipNames.map(normalize)));

  return {
    officers: resolveMatches(officers, officerNames),
    ships: resolveMatches(ships, shipNames),
  };
}
