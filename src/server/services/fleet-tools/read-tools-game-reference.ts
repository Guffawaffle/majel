/**
 * read-tools-game-reference.ts — Game reference search and detail tools
 */

import type { ToolEnv } from "./declarations.js";
import { resolveSystemMineResources, resolveHostileSystems, annotateBuildCostResources } from "./read-tools-formatting.js";

type ReferenceCategory = "research" | "building" | "hostile" | "consumable" | "system";

export async function searchGameReference(
  category: ReferenceCategory,
  query: string,
  limit: number,
  ctx: ToolEnv,
  filters?: {
    minLevel?: number;
    maxLevel?: number;
    faction?: string;
    hullType?: number;
    isDeepSpace?: boolean;
  },
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }

  const hasFilters = filters != null && (
    filters.minLevel != null ||
    filters.maxLevel != null ||
    filters.faction != null ||
    filters.hullType != null ||
    filters.isDeepSpace != null
  );

  if (!query.trim() && !hasFilters) {
    return { error: "Search query is required." };
  }

  const cap = Math.min(Math.max(1, limit), 50);

  switch (category) {
    case "research": {
      const rows = await ctx.deps.referenceStore.searchResearch(query);
      const results = rows.slice(0, cap).map((r) => ({
        id: r.id, name: r.name, researchTree: r.researchTree,
        unlockLevel: r.unlockLevel, maxLevel: r.maxLevel,
      }));
      return { category, results, totalFound: rows.length, truncated: rows.length > cap };
    }
    case "building": {
      const rows = await ctx.deps.referenceStore.searchBuildings(query);
      const results = rows.slice(0, cap).map((b) => ({
        id: b.id, name: b.name,
        maxLevel: b.maxLevel, unlockLevel: b.unlockLevel,
      }));
      return { category, results, totalFound: rows.length, truncated: rows.length > cap };
    }
    case "hostile": {
      const useFilter = filters != null && (
        filters.minLevel != null || filters.maxLevel != null ||
        filters.faction != null || filters.hullType != null
      );
      const rows = useFilter
        ? await ctx.deps.referenceStore.filterHostiles({
            name: query || undefined,
            minLevel: filters!.minLevel,
            maxLevel: filters!.maxLevel,
            faction: filters!.faction,
            hullType: filters!.hullType,
          })
        : await ctx.deps.referenceStore.searchHostiles(query);
      const results = rows.slice(0, cap).map((h) => ({
        id: h.id, name: h.name, faction: h.faction,
        level: h.level, shipType: h.shipType, hullType: h.hullType,
        rarity: h.rarity, strength: h.strength,
        spawnSystemCount: h.systems?.length ?? 0,
      }));
      return { category, results, totalFound: rows.length, truncated: rows.length > cap };
    }
    case "consumable": {
      const rows = await ctx.deps.referenceStore.searchConsumables(query);
      const results = rows.slice(0, cap).map((c) => ({
        id: c.id, name: c.name, rarity: c.rarity, grade: c.grade,
        category: c.category, durationSeconds: c.durationSeconds,
        requiresSlot: c.requiresSlot,
      }));
      return { category, results, totalFound: rows.length, truncated: rows.length > cap };
    }
    case "system": {
      const useFilter = filters != null && (
        filters.minLevel != null || filters.maxLevel != null ||
        filters.faction != null || filters.isDeepSpace != null
      );
      const rows = useFilter
        ? await ctx.deps.referenceStore.filterSystems({
            name: query || undefined,
            minLevel: filters!.minLevel,
            maxLevel: filters!.maxLevel,
            faction: filters!.faction,
            isDeepSpace: filters!.isDeepSpace,
          })
        : await ctx.deps.referenceStore.searchSystems(query);
      const results = rows.slice(0, cap).map((s) => ({
        id: s.id, name: s.name, level: s.level, estWarp: s.estWarp,
        isDeepSpace: s.isDeepSpace, factions: s.factions,
        hasMines: s.hasMines, hasPlanets: s.hasPlanets,
        mineResources: resolveSystemMineResources(s.mineResources, ctx),
      }));
      return { category, results, totalFound: rows.length, truncated: rows.length > cap };
    }
    default:
      return { error: `Unknown category: ${category}` };
  }
}

export async function getGameReference(
  category: ReferenceCategory,
  id: string,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!id.trim()) {
    return { error: "ID is required." };
  }

  switch (category) {
    case "research": {
      const row = await ctx.deps.referenceStore.getResearch(id);
      if (!row) return { error: `Research not found: ${id}` };
      return { reference: row };
    }
    case "building": {
      const row = await ctx.deps.referenceStore.getBuilding(id);
      if (!row) return { error: `Building not found: ${id}` };
      return { reference: row };
    }
    case "hostile": {
      const row = await ctx.deps.referenceStore.getHostile(id);
      if (!row) return { error: `Hostile not found: ${id}` };
      const resolvedSystems = await resolveHostileSystems(row.systems, ctx);
      return {
        reference: {
          ...row,
          systems: resolvedSystems.names,
          systemRefs: resolvedSystems.refs,
        },
      };
    }
    case "consumable": {
      const row = await ctx.deps.referenceStore.getConsumable(id);
      if (!row) return { error: `Consumable not found: ${id}` };
      return { reference: row };
    }
    case "system": {
      const row = await ctx.deps.referenceStore.getSystem(id);
      if (!row) return { error: `System not found: ${id}` };
      const resolved = {
        ...row,
        mineResources: resolveSystemMineResources(row.mineResources, ctx),
      };
      return { reference: resolved };
    }
    default:
      return { error: `Unknown category: ${category}` };
  }
}

export async function getScrapYields(
  shipId: string,
  level: number | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "ship_id is required." };
  }

  const ship = await ctx.deps.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  if (!ship.scrap || ship.scrap.length === 0) {
    return {
      shipId: ship.id,
      shipName: ship.name,
      scrapAvailable: false,
      message: "No scrap yield data available for this ship.",
    };
  }

  const baseScrap = ship.baseScrap
    ? annotateBuildCostResources(ship.baseScrap, ctx)
    : null;

  if (level != null) {
    const entry = ship.scrap.find((e) => {
      const rec = e as Record<string, unknown>;
      return rec.level === level;
    });
    if (!entry) {
      const maxLevel = ship.scrap.length;
      return {
        error: `No scrap entry at level ${level}. Ship has scrap data for levels 1–${maxLevel}.`,
      };
    }
    const annotated = annotateBuildCostResources([entry], ctx);
    return {
      shipId: ship.id,
      shipName: ship.name,
      scrapLevel: ship.scrapLevel,
      requestedLevel: level,
      scrapEntry: Array.isArray(annotated) ? annotated[0] : annotated,
      baseScrap,
    };
  }

  // Return full scrap array
  const annotatedScrap = annotateBuildCostResources(ship.scrap, ctx);
  return {
    shipId: ship.id,
    shipName: ship.name,
    scrapLevel: ship.scrapLevel,
    totalLevels: ship.scrap.length,
    scrapByLevel: annotatedScrap,
    baseScrap,
  };
}
