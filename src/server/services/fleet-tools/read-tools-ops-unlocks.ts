/**
 * read-tools-ops-unlocks.ts — check_ops_unlocks fleet tool (ADR-044, #214)
 *
 * Three-way distinction:
 * 1. No unlocks at queried level → empty buildings, no note
 * 2. Building data unavailable → note: "Building reference data not loaded."
 * 3. No further boundary above current ops → note: "No further unlock boundaries..."
 */

import type { ToolEnv } from "./declarations.js";

export async function checkOpsUnlocks(
  opsLevel: number | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }

  const refCounts = await ctx.deps.referenceStore.counts();
  const hasBuildingData = (refCounts?.buildings ?? 0) > 0;

  // ── Exact level query ─────────────────────────────────
  if (opsLevel != null) {
    if (!hasBuildingData) {
      return {
        queryType: "exact_level",
        opsLevel,
        buildings: [],
        buildingCount: 0,
        note: "Building reference data not loaded.",
      };
    }

    const rows = await ctx.deps.referenceStore.listBuildingsAtOps({ exactLevel: opsLevel, limit: 50 });
    return {
      queryType: "exact_level",
      opsLevel,
      buildings: rows.map((b) => ({ name: b.name, maxLevel: b.maxLevel })),
      buildingCount: rows.length,
    };
  }

  // ── Next boundary query (ops_level omitted) ───────────
  let currentOpsLevel = 1;
  if (ctx.deps.userSettingsStore) {
    const entry = await ctx.deps.userSettingsStore.getForUser(ctx.userId, "fleet.opsLevel");
    currentOpsLevel = Number(entry.value) || 1;
  }

  if (!hasBuildingData) {
    return {
      queryType: "next_boundary",
      opsLevel: currentOpsLevel,
      currentOpsLevel,
      buildings: [],
      buildingCount: 0,
      note: "Building reference data not loaded.",
    };
  }

  const above = await ctx.deps.referenceStore.listBuildingsAtOps({ aboveLevel: currentOpsLevel, limit: 50 });
  if (above.length === 0) {
    return {
      queryType: "next_boundary",
      opsLevel: currentOpsLevel,
      currentOpsLevel,
      buildings: [],
      buildingCount: 0,
      note: `No further unlock boundaries found above Ops ${currentOpsLevel}.`,
    };
  }

  const nextLevel = above[0].unlockLevel!;
  const atNextLevel = above.filter((b) => b.unlockLevel === nextLevel);
  return {
    queryType: "next_boundary",
    opsLevel: nextLevel,
    currentOpsLevel,
    buildings: atNextLevel.map((b) => ({ name: b.name, maxLevel: b.maxLevel })),
    buildingCount: atNextLevel.length,
  };
}
