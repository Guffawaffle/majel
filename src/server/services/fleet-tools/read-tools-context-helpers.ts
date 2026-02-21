import type { ToolContext } from "./declarations.js";
import { parseJsonOrFallback, toIsoTimestamp } from "./read-tools-data-helpers.js";

export interface ActiveEventRecord {
  name: string;
  type: string;
  scoring: Record<string, unknown>;
  startTime: string | null;
  endTime: string | null;
  isActive: boolean;
}

interface AwayTeamRecord {
  officerId: string;
  missionName: string;
  returnTime: string | null;
  isActive: boolean;
}

export interface FactionStandingRecord {
  faction: string;
  reputation: number | null;
  tier: string | null;
  storeAccess: "locked" | "limited" | "open";
}

export interface AwayTeamLock extends AwayTeamRecord {
  source: "settings" | "plan";
}

export function normalizeActiveEvent(raw: unknown): ActiveEventRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;

  const type = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : "general";
  const startTime = toIsoTimestamp(record.start_time ?? record.startTime ?? null);
  const endTime = toIsoTimestamp(record.end_time ?? record.endTime ?? null);
  const now = Date.now();
  const startsOk = !startTime || Date.parse(startTime) <= now;
  const endsOk = !endTime || Date.parse(endTime) > now;
  const scoring = record.scoring && typeof record.scoring === "object"
    ? record.scoring as Record<string, unknown>
    : {};

  return {
    name,
    type,
    scoring,
    startTime,
    endTime,
    isActive: startsOk && endsOk,
  };
}

function normalizeAwayTeam(raw: unknown): AwayTeamRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const officerId = typeof record.officer_id === "string"
    ? record.officer_id.trim()
    : typeof record.officerId === "string"
      ? record.officerId.trim()
      : "";
  const missionName = typeof record.mission_name === "string"
    ? record.mission_name.trim()
    : typeof record.missionName === "string"
      ? record.missionName.trim()
      : "";
  if (!officerId || !missionName) return null;

  const returnTime = toIsoTimestamp(record.return_time ?? record.returnTime ?? null);
  const isActive = returnTime ? Date.parse(returnTime) > Date.now() : true;

  return {
    officerId,
    missionName,
    returnTime,
    isActive,
  };
}

function resolveStoreAccess(reputation: number | null, tier: string | null): "locked" | "limited" | "open" {
  if (typeof tier === "string") {
    const normalized = tier.toLowerCase();
    if (["hostile", "enemy", "locked", "outlaw"].some((token) => normalized.includes(token))) {
      return "locked";
    }
    if (["ally", "admired", "celebrated", "champion", "trusted"].some((token) => normalized.includes(token))) {
      return "open";
    }
  }
  if (reputation == null) return "limited";
  if (reputation < 0) return "locked";
  if (reputation >= 10_000_000) return "open";
  return "limited";
}

export function normalizeFactionStanding(raw: unknown): FactionStandingRecord[] {
  const rows: Array<{ faction: string; reputation: number | null; tier: string | null }> = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const faction = typeof record.faction === "string" ? record.faction.trim() : "";
      if (!faction) continue;
      const reputation = typeof record.reputation === "number" && Number.isFinite(record.reputation)
        ? record.reputation
        : null;
      const tier = typeof record.tier === "string" && record.tier.trim() ? record.tier.trim() : null;
      rows.push({ faction, reputation, tier });
    }
  } else if (raw && typeof raw === "object") {
    for (const [factionKey, value] of Object.entries(raw as Record<string, unknown>)) {
      const faction = factionKey.trim();
      if (!faction) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        rows.push({ faction, reputation: value, tier: null });
        continue;
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const reputation = typeof record.reputation === "number" && Number.isFinite(record.reputation)
          ? record.reputation
          : null;
        const tier = typeof record.tier === "string" && record.tier.trim() ? record.tier.trim() : null;
        rows.push({ faction, reputation, tier });
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    storeAccess: resolveStoreAccess(row.reputation, row.tier),
  }));
}

export async function readUserJsonSetting<T>(
  ctx: ToolContext,
  key: string,
  fallback: T,
): Promise<{ value: T; source: "user" | "system" | "env" | "default" | "unavailable" }> {
  if (!ctx.userSettingsStore || !ctx.userId) {
    return { value: fallback, source: "unavailable" };
  }
  const entry = await ctx.userSettingsStore.getForUser(ctx.userId, key);
  return {
    value: parseJsonOrFallback(entry.value, fallback),
    source: entry.source,
  };
}

export async function getAwayTeamLocks(ctx: ToolContext): Promise<AwayTeamLock[]> {
  const locks: AwayTeamLock[] = [];

  const fromSettings = await readUserJsonSetting<unknown[]>(ctx, "fleet.awayTeams", []);
  for (const raw of fromSettings.value) {
    const normalized = normalizeAwayTeam(raw);
    if (!normalized || !normalized.isActive) continue;
    locks.push({ ...normalized, source: "settings" });
  }

  if (ctx.crewStore) {
    const planItems = await ctx.crewStore.listPlanItems();
    for (const item of planItems) {
      if (!item.isActive || !item.awayOfficers) continue;
      for (const officerId of item.awayOfficers) {
        if (!officerId) continue;
        locks.push({
          officerId,
          missionName: item.label || "Away Team Assignment",
          returnTime: null,
          isActive: true,
          source: "plan",
        });
      }
    }
  }

  return locks;
}