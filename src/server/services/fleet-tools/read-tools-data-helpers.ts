import type { ToolContext } from "./declarations.js";
import type { ResearchNodeRecord } from "../../stores/research-store.js";

export interface BattleDamageEvent {
  amount: number;
  type: string | null;
  sourceOfficerId: string | null;
  sourceAbility: string | null;
}

export interface BattleRound {
  round: number;
  damageReceived: BattleDamageEvent[];
  damageDealt: BattleDamageEvent[];
  abilityTriggers: string[];
  hullAfter: number | null;
  shieldAfter: number | null;
  destroyed: boolean;
}

export interface ParsedBattleLog {
  battleId: string | null;
  mode: string | null;
  attackerOfficers: string[];
  defenderOfficers: string[];
  rounds: BattleRound[];
}

export function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function computeLatestResearchTimestamp(nodes: ResearchNodeRecord[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const timestamps = [node.capturedAt, node.stateUpdatedAt, node.updatedAt]
      .map((value) => toIsoOrNull(value))
      .filter((value): value is string => value !== null);
    for (const timestamp of timestamps) {
      const ms = Date.parse(timestamp);
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms;
      }
    }
  }
  if (!Number.isFinite(latestMs)) {
    return null;
  }
  return new Date(latestMs).toISOString();
}

export function parseJsonOrFallback<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function parseBattleDamageEvents(value: unknown): BattleDamageEvent[] {
  if (!Array.isArray(value)) return [];
  const events: BattleDamageEvent[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const amount = toFiniteNumber(record.amount) ?? 0;
    const type = typeof record.type === "string" && record.type.trim() ? record.type.trim().toLowerCase() : null;
    const sourceOfficerId = typeof record.source_officer_id === "string"
      ? record.source_officer_id.trim()
      : typeof record.sourceOfficerId === "string"
        ? record.sourceOfficerId.trim()
        : null;
    const sourceAbility = typeof record.source_ability === "string"
      ? record.source_ability.trim()
      : typeof record.sourceAbility === "string"
        ? record.sourceAbility.trim()
        : null;
    events.push({ amount, type, sourceOfficerId, sourceAbility });
  }
  return events;
}

export function parseBattleLog(input: unknown): ParsedBattleLog | null {
  const payload = typeof input === "string" ? parseJsonOrFallback<unknown>(input, null) : input;
  if (!payload || typeof payload !== "object") return null;
  const log = payload as Record<string, unknown>;
  const roundsRaw = Array.isArray(log.rounds) ? log.rounds : [];
  const rounds: BattleRound[] = [];

  for (let index = 0; index < roundsRaw.length; index += 1) {
    const row = roundsRaw[index];
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const abilitySource = record.ability_triggers ?? record.abilityTriggers;
    rounds.push({
      round: toFiniteNumber(record.round) ?? index + 1,
      damageReceived: parseBattleDamageEvents(record.damage_received ?? record.damageReceived),
      damageDealt: parseBattleDamageEvents(record.damage_dealt ?? record.damageDealt),
      abilityTriggers: Array.isArray(abilitySource)
        ? abilitySource
          .filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry: string) => entry.trim())
        : [],
      hullAfter: toFiniteNumber(record.hull_after ?? record.hullAfter),
      shieldAfter: toFiniteNumber(record.shield_after ?? record.shieldAfter),
      destroyed: Boolean(record.destroyed) || (toFiniteNumber(record.hull_after ?? record.hullAfter) ?? 1) <= 0,
    });
  }

  if (rounds.length === 0) return null;

  const attackerOfficers = Array.isArray(log.attacker_officers)
    ? log.attacker_officers
    : Array.isArray(log.attackerOfficers)
      ? log.attackerOfficers
      : [];
  const defenderOfficers = Array.isArray(log.defender_officers)
    ? log.defender_officers
    : Array.isArray(log.defenderOfficers)
      ? log.defenderOfficers
      : [];

  return {
    battleId: typeof log.battle_id === "string"
      ? log.battle_id
      : typeof log.battleId === "string"
        ? log.battleId
        : null,
    mode: typeof log.mode === "string" ? log.mode : null,
    attackerOfficers: attackerOfficers.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0),
    defenderOfficers: defenderOfficers.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0),
    rounds,
  };
}

export async function mapOfficerIdsToAbilities(officerIds: string[], ctx: ToolContext): Promise<Array<Record<string, unknown>>> {
  if (!ctx.referenceStore || officerIds.length === 0) return [];
  const results: Array<Record<string, unknown>> = [];
  for (const officerId of officerIds) {
    const officer = await ctx.referenceStore.getOfficer(officerId);
    if (!officer) continue;
    results.push({
      officerId,
      name: officer.name,
      officerAbility: officer.officerAbility,
      captainManeuver: officer.captainManeuver,
    });
  }
  return results;
}

export function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
