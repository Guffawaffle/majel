import type { OwnershipState } from "../../stores/overlay-store.js";
import type { ReceiptSourceType } from "../../stores/receipt-store.js";

export interface SyncOverlayOfficerInput {
  refId: string;
  level?: number | null;
  rank?: string | null;
  power?: number | null;
  owned?: boolean;
  tier?: number | null;
}

export interface SyncOverlayShipInput {
  refId: string;
  tier?: number | null;
  level?: number | null;
  power?: number | null;
  owned?: boolean;
}

export interface SyncOverlayDockInput {
  number?: number;
  shipId?: string;
  loadoutId?: number;
}

export interface MajelGameExport {
  version: string;
  exportDate?: string;
  source?: string;
  officers?: SyncOverlayOfficerInput[];
  ships?: SyncOverlayShipInput[];
  docks?: SyncOverlayDockInput[];
}

export function parseMajelGameExport(args: Record<string, unknown>): { data?: MajelGameExport; error?: string } {
  const directPayload = args.export;
  const stringPayload = args.payload_json;
  const manualUpdates = args.manual_updates;

  let rawData: unknown = directPayload;
  if (!rawData && typeof stringPayload === "string") {
    try {
      rawData = JSON.parse(stringPayload);
    } catch {
      return { error: "payload_json is not valid JSON." };
    }
  }

  if (!rawData && (typeof manualUpdates === "string" || Array.isArray(manualUpdates))) {
    rawData = { version: "1.0", source: "manual" };
  }

  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return { error: "Provide a MajelGameExport in export (object) or payload_json (string)." };
  }

  const parsed = rawData as MajelGameExport;
  if (!parsed.version || typeof parsed.version !== "string") {
    return { error: "MajelGameExport.version is required and must be a string." };
  }
  if (parsed.version !== "1.0") {
    return { error: `Unsupported MajelGameExport.version '${parsed.version}'. Supported version is '1.0'.` };
  }
  if (parsed.officers != null && !Array.isArray(parsed.officers)) {
    return { error: "MajelGameExport.officers must be an array when provided." };
  }
  if (parsed.ships != null && !Array.isArray(parsed.ships)) {
    return { error: "MajelGameExport.ships must be an array when provided." };
  }
  if (parsed.docks != null && !Array.isArray(parsed.docks)) {
    return { error: "MajelGameExport.docks must be an array when provided." };
  }

  for (const officer of parsed.officers ?? []) {
    if (!officer || typeof officer !== "object") {
      return { error: "Each MajelGameExport.officers entry must be an object." };
    }
    if (!officer.refId || typeof officer.refId !== "string") {
      return { error: "Each officer entry requires refId (string)." };
    }
    if (officer.owned != null && typeof officer.owned !== "boolean") {
      return { error: `Officer ${officer.refId}: owned must be boolean when provided.` };
    }
    if (officer.level != null && (!Number.isInteger(officer.level) || officer.level < 0 || officer.level > 100)) {
      return { error: `Officer ${officer.refId}: level must be an integer between 0 and 100.` };
    }
    if (officer.power != null && (!Number.isInteger(officer.power) || officer.power < 0)) {
      return { error: `Officer ${officer.refId}: power must be a non-negative integer.` };
    }
    if (officer.tier != null && (!Number.isInteger(officer.tier) || officer.tier < 0 || officer.tier > 20)) {
      return { error: `Officer ${officer.refId}: tier must be an integer between 0 and 20.` };
    }
    if (officer.rank != null && typeof officer.rank !== "string" && !Number.isInteger(officer.rank)) {
      return { error: `Officer ${officer.refId}: rank must be string or integer when provided.` };
    }
  }

  for (const ship of parsed.ships ?? []) {
    if (!ship || typeof ship !== "object") {
      return { error: "Each MajelGameExport.ships entry must be an object." };
    }
    if (!ship.refId || typeof ship.refId !== "string") {
      return { error: "Each ship entry requires refId (string)." };
    }
    if (ship.owned != null && typeof ship.owned !== "boolean") {
      return { error: `Ship ${ship.refId}: owned must be boolean when provided.` };
    }
    if (ship.tier != null && (!Number.isInteger(ship.tier) || ship.tier < 0 || ship.tier > 20)) {
      return { error: `Ship ${ship.refId}: tier must be an integer between 0 and 20.` };
    }
    if (ship.level != null && (!Number.isInteger(ship.level) || ship.level < 0 || ship.level > 100)) {
      return { error: `Ship ${ship.refId}: level must be an integer between 0 and 100.` };
    }
    if (ship.power != null && (!Number.isInteger(ship.power) || ship.power < 0)) {
      return { error: `Ship ${ship.refId}: power must be a non-negative integer.` };
    }
  }

  for (const dock of parsed.docks ?? []) {
    if (!dock || typeof dock !== "object") {
      return { error: "Each MajelGameExport.docks entry must be an object." };
    }
    if (dock.number != null && (!Number.isInteger(dock.number) || dock.number < 1 || dock.number > 20)) {
      return { error: "Each dock.number must be an integer between 1 and 20 when provided." };
    }
    if (dock.shipId != null && typeof dock.shipId !== "string") {
      return { error: "Each dock.shipId must be a string when provided." };
    }
    if (dock.loadoutId != null && (!Number.isInteger(dock.loadoutId) || dock.loadoutId < 1)) {
      return { error: "Each dock.loadoutId must be a positive integer when provided." };
    }
  }

  return { data: parsed };
}

export function normalizeOfficerRefId(refId: string): string {
  const trimmed = refId.trim();
  if (/^cdn:officer:\d+$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d+$/.test(trimmed)) return `cdn:officer:${trimmed}`;
  return trimmed;
}

export function normalizeShipRefId(refId: string): string {
  const trimmed = refId.trim();
  if (/^cdn:ship:\d+$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d+$/.test(trimmed)) return `cdn:ship:${trimmed}`;
  return trimmed;
}

export function ownershipFromOwnedFlag(owned: boolean | undefined): OwnershipState | undefined {
  if (owned == null) return undefined;
  return owned ? "owned" : "unowned";
}

export function syncOverlaySourceType(source: string | undefined): ReceiptSourceType {
  if (!source) return "file_import";
  const normalized = source.trim().toLowerCase();
  if (normalized === "manual") return "guided_setup";
  if (normalized === "stfc-space" || normalized === "command-center") return "community_export";
  return "file_import";
}

export function parseExportDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function manualUpdateTexts(args: Record<string, unknown>): string[] {
  const raw = args.manual_updates;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|an|a)\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function parseExceptionNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const normalized = raw
    .replace(/\band\b/gi, ",")
    .replace(/&/g, ",")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^['"“”‘’]|['"“”‘’]$/g, "").trim())
    .filter(Boolean);
  return normalized;
}

const MIN_SUBSTR_LEN = 3;

export function isExcludedName(name: string, excluded: string[]): boolean {
  if (excluded.length === 0) return false;
  const normalizedName = normalizeEntityName(name);
  if (!normalizedName) return false;
  return excluded.some((entry) => {
    const normalizedExcl = normalizeEntityName(entry);
    if (!normalizedExcl) return false;
    if (normalizedName === normalizedExcl) return true;
    if (normalizedExcl.length >= MIN_SUBSTR_LEN && normalizedName.includes(normalizedExcl)) return true;
    if (normalizedName.length >= MIN_SUBSTR_LEN && normalizedExcl.includes(normalizedName)) return true;
    return false;
  });
}

export function inferOfficerLevelFromMaxRank(maxRank: number | null): number | null {
  if (maxRank == null || !Number.isInteger(maxRank) || maxRank < 1) return null;
  return maxRank * 10;
}
