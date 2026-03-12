/**
 * read-tools-context.ts — Active events, away teams, faction standings
 */

import type { ToolEnv } from "./declarations.js";
import {
  normalizeActiveEvent,
  normalizeFactionStanding,
  readUserJsonSetting,
  getAwayTeamLocks,
  type ActiveEventRecord,
} from "./read-tools-context-helpers.js";

export async function listActiveEvents(ctx: ToolEnv): Promise<object> {
  const eventsData = await readUserJsonSetting<unknown[]>(ctx, "fleet.activeEvents", []);
  const events = eventsData.value
    .map((row) => normalizeActiveEvent(row))
    .filter((row): row is ActiveEventRecord => row !== null)
    .sort((left, right) => {
      const leftStart = left.startTime ? Date.parse(left.startTime) : Number.POSITIVE_INFINITY;
      const rightStart = right.startTime ? Date.parse(right.startTime) : Number.POSITIVE_INFINITY;
      return leftStart - rightStart;
    });

  return {
    events,
    totalEvents: events.length,
    totalActiveEvents: events.filter((event) => event.isActive).length,
    source: eventsData.source,
    note: eventsData.source === "unavailable"
      ? "User settings store unavailable; returning empty event context."
      : undefined,
  };
}

export async function listAwayTeams(ctx: ToolEnv): Promise<object> {
  const locks = await getAwayTeamLocks(ctx);

  return {
    awayTeams: locks.map((entry) => ({
      officer_id: entry.officerId,
      mission_name: entry.missionName,
      return_time: entry.returnTime,
      source: entry.source,
    })),
    lockedOfficerIds: Array.from(new Set(locks.map((entry) => entry.officerId))).sort(),
    totalAssignments: locks.length,
  };
}

export async function getFactionStanding(
  faction: string | undefined,
  ctx: ToolEnv,
): Promise<object> {
  const standingsData = await readUserJsonSetting<unknown>(ctx, "fleet.factionStandings", {});
  let standings = normalizeFactionStanding(standingsData.value);

  const filter = faction?.trim().toLowerCase();
  if (filter) {
    standings = standings.filter((row) => row.faction.toLowerCase().includes(filter));
  }

  return {
    standings,
    totalStandings: standings.length,
    source: standingsData.source,
  };
}
