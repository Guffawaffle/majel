import type {
  CatalogOfficer,
  CatalogShip,
  CompositionBelowDeckPolicySuggestion,
  CompositionBridgeCoreSuggestion,
  CompositionLoadoutSuggestion,
  ImportReceipt,
  UnresolvedImportItem,
} from "./types.js";

function rarityScore(value: string | null): number {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("legendary")) return 5;
  if (normalized.includes("epic")) return 4;
  if (normalized.includes("rare")) return 3;
  if (normalized.includes("uncommon")) return 2;
  if (normalized.includes("common")) return 1;
  return 0;
}

function inferIntentFromShipClass(shipClass: string | null): "combat" | "mining" | "hostile" {
  const normalized = String(shipClass ?? "").toLowerCase();
  if (normalized.includes("survey")) return "mining";
  if (normalized.includes("interceptor") || normalized.includes("battleship") || normalized.includes("explorer")) return "combat";
  return "hostile";
}

function policyForIntent(intent: "combat" | "mining" | "hostile", index: number): CompositionBelowDeckPolicySuggestion {
  if (intent === "mining") {
    return {
      key: `policy-mining-${index}`,
      accepted: true,
      name: "Mining BD",
      mode: "stats_then_bda",
      spec: { prefer_modifiers: ["mining_rate", "protected_cargo", "warp_range"], avoid_reserved: true, max_slots: 5 },
    };
  }
  if (intent === "hostile") {
    return {
      key: `policy-hostile-${index}`,
      accepted: true,
      name: "Hostile BD",
      mode: "stats_then_bda",
      spec: { prefer_modifiers: ["damage_vs_hostiles", "critical_damage", "mitigation"], avoid_reserved: true, max_slots: 5 },
    };
  }
  return {
    key: `policy-combat-${index}`,
    accepted: true,
    name: "Combat BD",
    mode: "stats_then_bda",
    spec: { prefer_modifiers: ["attack", "critical_chance", "critical_damage"], avoid_reserved: true, max_slots: 5 },
  };
}

export function buildCompositionSuggestions(officers: CatalogOfficer[], ships: CatalogShip[]): {
  bridgeCores: CompositionBridgeCoreSuggestion[];
  policies: CompositionBelowDeckPolicySuggestion[];
  loadouts: CompositionLoadoutSuggestion[];
} {
  const ownedOfficers = officers.filter((officer) => officer.ownershipState === "owned");
  const ownedShips = ships.filter((ship) => ship.ownershipState === "owned");

  const byGroup = new Map<string, CatalogOfficer[]>();
  for (const officer of ownedOfficers) {
    const groupName = officer.groupName?.trim();
    if (!groupName) continue;
    const key = groupName.toLowerCase();
    const current = byGroup.get(key) ?? [];
    current.push(officer);
    byGroup.set(key, current);
  }

  const bridgeCores: CompositionBridgeCoreSuggestion[] = [];
  const officerById = new Map<string, CatalogOfficer>();
  for (const officer of ownedOfficers) officerById.set(officer.id, officer);

  let bridgeCoreIndex = 0;
  for (const [groupKey, members] of byGroup.entries()) {
    if (members.length < 3) continue;
    const cmCapable = members.filter((officer) => (officer.captainManeuver ?? "").trim().length > 0);
    if (cmCapable.length === 0) continue;

    const sorted = [...members].sort((left, right) => {
      const rarityDiff = rarityScore(right.rarity) - rarityScore(left.rarity);
      if (rarityDiff !== 0) return rarityDiff;
      return (right.userLevel ?? 0) - (left.userLevel ?? 0);
    });
    const captain = [...cmCapable].sort((left, right) => {
      const rarityDiff = rarityScore(right.rarity) - rarityScore(left.rarity);
      if (rarityDiff !== 0) return rarityDiff;
      return (right.userLevel ?? 0) - (left.userLevel ?? 0);
    })[0];

    const remainder = sorted.filter((officer) => officer.id !== captain.id).slice(0, 2);
    if (remainder.length < 2) continue;
    const selected = [captain, ...remainder];

    bridgeCores.push({
      key: `core-${bridgeCoreIndex++}`,
      accepted: true,
      name: `${selected[0].groupName ?? groupKey} Trio`,
      members: [
        { officerId: selected[0].id, officerName: selected[0].name, slot: "captain" },
        { officerId: selected[1].id, officerName: selected[1].name, slot: "bridge_1" },
        { officerId: selected[2].id, officerName: selected[2].name, slot: "bridge_2" },
      ],
    });

    if (bridgeCores.length >= 5) break;
  }

  const intents = [...new Set(ownedShips.map((ship) => inferIntentFromShipClass(ship.shipClass)))];
  const policies = intents.slice(0, 3).map((intent, index) => policyForIntent(intent, index));

  const loadouts: CompositionLoadoutSuggestion[] = [];
  let loadoutIndex = 0;
  for (const core of bridgeCores) {
    const captain = core.members.find((member) => member.slot === "captain");
    const captainOfficer = captain ? officerById.get(captain.officerId) : undefined;
    const captainFaction = String(captainOfficer?.faction?.name ?? "").toLowerCase();

    const scoredShips = [...ownedShips].map((ship) => {
      const intent = inferIntentFromShipClass(ship.shipClass);
      const policy = policies.find((entry) => entry.key.includes(intent));
      let score = 0;
      if (captainFaction.length > 0 && String(ship.faction ?? "").toLowerCase().includes(captainFaction)) score += 5;
      if (intent === "combat" && /interceptor|battleship|explorer/i.test(String(ship.shipClass ?? ""))) score += 3;
      if (intent === "mining" && /survey/i.test(String(ship.shipClass ?? ""))) score += 3;
      if (intent === "hostile") score += 1;
      score += ship.userTier ?? 0;
      return { ship, intent, policyKey: policy?.key, score };
    });

    scoredShips.sort((left, right) => right.score - left.score);
    const selected = scoredShips[0];
    if (!selected) continue;

    loadouts.push({
      key: `loadout-${loadoutIndex++}`,
      accepted: true,
      name: `${selected.ship.name} ${core.name}`,
      shipId: selected.ship.id,
      shipName: selected.ship.name,
      bridgeCoreKey: core.key,
      belowDeckPolicyKey: selected.policyKey,
      intentKeys: [selected.intent],
      tags: ["import-inferred"],
    });
  }

  return { bridgeCores, policies, loadouts };
}

export function unresolvedCount(receipt: ImportReceipt): number {
  return Array.isArray(receipt.unresolved) ? receipt.unresolved.length : 0;
}

export function coerceUnresolved(unresolvedValue: unknown[] | null): UnresolvedImportItem[] {
  if (!Array.isArray(unresolvedValue)) return [];

  return unresolvedValue
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      rowIndex: Number(item.rowIndex ?? -1),
      entityType: (item.entityType === "ship" ? "ship" : "officer") as "officer" | "ship",
      rawValue: String(item.rawValue ?? ""),
      candidates: Array.isArray(item.candidates)
        ? item.candidates
          .filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null)
          .map((candidate) => ({
            id: String(candidate.id ?? ""),
            name: String(candidate.name ?? ""),
            score: Number(candidate.score ?? 0),
          }))
        : [],
    }))
    .filter((item) => item.rawValue.length > 0 && item.rowIndex >= 0);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file payload"));
        return;
      }
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
