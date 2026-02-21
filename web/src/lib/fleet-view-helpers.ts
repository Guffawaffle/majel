import type {
  BridgeCoreWithMembers,
  CatalogOfficer,
  CatalogShip,
  Dock,
  EffectiveDockState,
  Loadout,
  OfficerConflict,
  OfficerOverlayPatch,
  OfficerReservation,
  ShipOverlayPatch,
} from "./types.js";

export interface FleetCrossRefMaps {
  officerUsedIn: Map<string, string[]>;
  shipUsedIn: Map<string, string[]>;
  officerConflicts: Map<string, OfficerConflict>;
  shipDockMap: Map<string, string>;
  reservationMap: Map<string, OfficerReservation>;
}

export function buildFleetCrossRefMaps(input: {
  cores: BridgeCoreWithMembers[];
  loadouts: Loadout[];
  reservations: OfficerReservation[];
  effective: EffectiveDockState | null;
  docks: Dock[];
}): FleetCrossRefMaps {
  const { cores, loadouts, reservations, effective, docks } = input;

  const officerUsedIn = new Map<string, string[]>();
  for (const core of cores) {
    for (const member of core.members) {
      const list = officerUsedIn.get(member.officerId) ?? [];
      list.push(`Bridge: ${core.name} (${member.slot})`);
      officerUsedIn.set(member.officerId, list);
    }
  }

  const shipUsedIn = new Map<string, string[]>();
  const shipDockMap = new Map<string, string>();
  for (const loadout of loadouts) {
    const label = loadout.name || `Loadout #${loadout.id}`;
    const list = shipUsedIn.get(loadout.shipId) ?? [];
    list.push(label);
    shipUsedIn.set(loadout.shipId, list);
  }

  for (const entry of effective?.docks ?? []) {
    if (!entry.loadout) continue;
    const shipId = entry.loadout.shipId;
    if (!shipId) continue;
    const dock = docks.find((d) => d.dockNumber === entry.dockNumber);
    const label = dock?.label ?? `Dock ${entry.dockNumber}`;
    shipDockMap.set(shipId, label);
  }

  const officerConflicts = new Map<string, OfficerConflict>();
  for (const conflict of effective?.conflicts ?? []) {
    officerConflicts.set(conflict.officerId, conflict);
  }

  const reservationMap = new Map<string, OfficerReservation>();
  for (const reservation of reservations) {
    reservationMap.set(reservation.officerId, reservation);
  }

  return {
    officerUsedIn,
    shipUsedIn,
    officerConflicts,
    shipDockMap,
    reservationMap,
  };
}

export function isFleetOfficer(item: CatalogOfficer | CatalogShip): item is CatalogOfficer {
  return "officerClass" in item;
}

export interface FleetFieldEditResult {
  key: string;
  officerPatch?: OfficerOverlayPatch;
  shipPatch?: ShipOverlayPatch;
}

export function applyFleetFieldEdit(
  item: CatalogOfficer | CatalogShip,
  field: string,
  value: string,
): FleetFieldEditResult {
  const key = `${item.id}-${field}`;
  const numVal = value === "" ? null : Number(value);

  if (isFleetOfficer(item)) {
    if (field === "level") item.userLevel = numVal;
    else if (field === "rank") item.userRank = value || null;
    else if (field === "power") item.userPower = numVal;

    return {
      key,
      officerPatch: {
        level: field === "level" ? numVal : undefined,
        rank: field === "rank" ? (value || null) : undefined,
        power: field === "power" ? numVal : undefined,
      },
    };
  }

  if (field === "tier") item.userTier = numVal;
  else if (field === "level") item.userLevel = numVal;
  else if (field === "power") item.userPower = numVal;

  return {
    key,
    shipPatch: {
      tier: field === "tier" ? numVal : undefined,
      level: field === "level" ? numVal : undefined,
      power: field === "power" ? numVal : undefined,
    },
  };
}
