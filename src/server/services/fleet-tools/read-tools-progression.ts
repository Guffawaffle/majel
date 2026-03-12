/**
 * read-tools-progression.ts — Research, inventory, upgrade path, ETA, true power
 */

import type { ToolEnv } from "./declarations.js";
import type { InventoryCategory } from "../../stores/inventory-store.js";
import { hullTypeLabel } from "../game-enums.js";
import {
  calculateResearchAdvisory,
  normalizePercentValue,
  extractRelevantBuffs,
} from "./read-tools-research-helpers.js";
import {
  normalizeToken,
  extractTierRequirements,
  inferDefaultDailyRate,
  resolveOverrideDailyRate,
} from "./read-tools-upgrade-helpers.js";

const ETA_CONFIDENCE_THRESHOLD = 0.75;

export async function listResearch(
  tree: string | undefined,
  includeCompleted: boolean | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.researchStore) {
    return { error: "Research store not available. Sync research data first." };
  }

  const result = await ctx.deps.researchStore.listByTree({
    tree: tree?.trim() || undefined,
    includeCompleted: includeCompleted ?? true,
  });
  const counts = await ctx.deps.researchStore.counts();

  return {
    trees: result,
    summary: {
      totalTrees: result.length,
      totalNodes: counts.nodes,
      totalCompleted: counts.completed,
      treeFilter: tree?.trim() || null,
      includeCompleted: includeCompleted ?? true,
    },
  };
}

export async function listInventory(
  category: string | undefined,
  query: string | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.inventoryStore) {
    return { error: "Inventory store not available." };
  }

  const normalizedCategory = category?.trim().toLowerCase() as InventoryCategory | undefined;
  const categories = new Set(["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"]);
  if (normalizedCategory && !categories.has(normalizedCategory)) {
    return { error: `Invalid category '${category}'.` };
  }

  const grouped = await ctx.deps.inventoryStore.listByCategory({
    category: normalizedCategory,
    q: query?.trim() || undefined,
  });
  const counts = await ctx.deps.inventoryStore.counts();

  return {
    categories: grouped,
    summary: {
      totalItems: counts.items,
      totalCategories: counts.categories,
      activeCategoryFilter: normalizedCategory ?? null,
      query: query?.trim() || null,
    },
  };
}

export async function calculateUpgradePath(
  shipId: string,
  targetTier: number | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.deps.inventoryStore) {
    return { error: "Inventory store not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.deps.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.deps.overlayStore ? await ctx.deps.overlayStore.getShipOverlay(shipId) : null;
  const currentTier = overlay?.tier ?? ship.tier ?? 0;
  const maxTier = ship.maxTier ?? 15;
  const resolvedTargetTier = targetTier == null ? currentTier + 1 : targetTier;

  if (!Number.isInteger(resolvedTargetTier) || resolvedTargetTier < 1) {
    return { error: "target_tier must be a positive integer." };
  }
  if (resolvedTargetTier > maxTier) {
    return { error: `target_tier exceeds ship max tier (${maxTier}).` };
  }
  if (resolvedTargetTier <= currentTier) {
    return { error: `target_tier (${resolvedTargetTier}) must be above current tier (${currentTier}).` };
  }

  const tierRequirements = extractTierRequirements(ship.tiers, currentTier, resolvedTargetTier);

  const allInventoryItems = await ctx.deps.inventoryStore.listItems();
  const inventoryByKey = new Map<string, number>();
  for (const item of allInventoryItems) {
    const key = normalizeToken(item.name);
    inventoryByKey.set(key, (inventoryByKey.get(key) ?? 0) + item.quantity);
  }

  const requirementRows = tierRequirements.map((requirement) => {
    const inventoryMatchQty =
      inventoryByKey.get(normalizeToken(requirement.name))
      ?? (requirement.resourceId ? inventoryByKey.get(normalizeToken(requirement.resourceId)) : undefined)
      ?? 0;
    const required = Math.round(requirement.amount);
    const available = Math.max(0, Math.round(inventoryMatchQty));
    const gap = Math.max(0, required - available);
    return {
      key: requirement.key,
      name: requirement.name,
      resourceId: requirement.resourceId,
      required,
      available,
      gap,
      ready: gap === 0,
    };
  });

  const totalRequired = requirementRows.reduce((sum, row) => sum + row.required, 0);
  const totalAvailable = requirementRows.reduce((sum, row) => sum + Math.min(row.required, row.available), 0);
  const totalGap = requirementRows.reduce((sum, row) => sum + row.gap, 0);
  const coveragePct = totalRequired === 0 ? 0 : Math.round((totalAvailable / totalRequired) * 100);

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      currentTier,
      targetTier: resolvedTargetTier,
      maxTier,
      rarity: ship.rarity,
      shipClass: ship.shipClass,
    },
    requirements: requirementRows,
    summary: {
      requirementCount: requirementRows.length,
      totalRequired,
      totalAvailable,
      totalGap,
      coveragePct,
      fullyReady: totalGap === 0 && requirementRows.length > 0,
    },
    assumptions: [
      "Upgrade path uses available ship tier component build_cost data.",
      "Inventory matching uses normalized resource names/IDs and may miss unmapped resources.",
    ],
  };
}

export async function estimateAcquisitionTime(
  shipId: string,
  targetTier: number | undefined,
  dailyIncome: Record<string, unknown> | undefined,
  ctx: ToolEnv,
): Promise<object> {
  const upgradeResult = await calculateUpgradePath(shipId, targetTier, ctx) as Record<string, unknown>;
  if (upgradeResult.error) {
    return upgradeResult;
  }

  const requirements = (upgradeResult.requirements as Array<Record<string, unknown>> | undefined) ?? [];
  const overrideEntries = Object.entries(dailyIncome ?? {})
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .map(([key, value]) => [normalizeToken(key), Number(value)] as const);
  const overrides = new Map<string, number>(overrideEntries);

  const perResource = requirements
    .filter((entry) => Number(entry.gap ?? 0) > 0)
    .map((entry) => {
      const name = String(entry.name ?? "unknown_resource");
      const resourceId = entry.resourceId == null ? null : String(entry.resourceId);

      const dailyRate =
        resolveOverrideDailyRate(name, resourceId, overrides)
        ?? inferDefaultDailyRate(name);

      const gap = Number(entry.gap ?? 0);
      const days = dailyRate > 0 ? Math.ceil((gap / dailyRate) * 10) / 10 : null;

      return {
        name,
        resourceId,
        gap,
        dailyRate,
        days,
        blocked: days === null,
      };
    })
    .sort((left, right) => right.gap - left.gap);

  const blocking = perResource.filter((entry) => entry.blocked);
  const nonBlocked = perResource.filter((entry) => !entry.blocked && entry.days != null);
  const estimatedDays = nonBlocked.length > 0 ? Math.max(...nonBlocked.map((entry) => Number(entry.days))) : null;

  const hasBlocking = blocking.length > 0;
  const hasOverrides = overrides.size > 0;
  const confidenceScoreRaw = hasBlocking
    ? 0.45
    : 0.6
      + (hasOverrides ? 0.15 : 0)
      + (perResource.length > 0 && perResource.length <= 3 ? 0.1 : 0)
      + (nonBlocked.length === perResource.length && perResource.length > 0 ? 0.05 : 0);
  const confidenceScore = Math.max(0, Math.min(1, Math.round(confidenceScoreRaw * 100) / 100));
  const numericEtaAllowed = estimatedDays != null && confidenceScore >= ETA_CONFIDENCE_THRESHOLD;
  const qualitativeGuidance = numericEtaAllowed
    ? null
    : hasBlocking
      ? "ETA confidence is low due to blocking resource rates; focus on unblocking daily income before trusting numeric timelines."
      : "Current data confidence is below numeric ETA threshold; use qualitative pacing until more corrected rate data is available.";

  return {
    ship: upgradeResult.ship,
    target: {
      targetTier: (upgradeResult.ship as Record<string, unknown>).targetTier,
    },
    perResource,
    summary: {
      resourcesWithGap: perResource.length,
      blockingResources: blocking.length,
      estimatedDays: numericEtaAllowed ? estimatedDays : null,
      feasible: blocking.length === 0 && estimatedDays !== null,
      overrideCount: overrides.size,
      etaMode: numericEtaAllowed ? "numeric" : "qualitative",
      confidenceScore,
      confidenceThreshold: ETA_CONFIDENCE_THRESHOLD,
      qualitativeGuidance,
    },
    assumptions: [
      "Uses calculate_upgrade_path gap output as baseline.",
      "Daily rates default by resource keyword unless overridden in daily_income.",
    ],
  };
}

export async function calculateTruePower(
  shipId: string,
  intentKey: string | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.deps.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.deps.overlayStore ? await ctx.deps.overlayStore.getShipOverlay(shipId) : null;
  const basePower = overlay?.power ?? null;

  const nodes = ctx.deps.researchStore ? await ctx.deps.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(nodes);
  const relevantBuffs = extractRelevantBuffs(nodes, intentKey);

  let multiplierPct = 0;
  let flatBonus = 0;
  for (const buff of relevantBuffs) {
    if (buff.unit === "percent") {
      multiplierPct += normalizePercentValue(buff.value) * 100;
      continue;
    }
    if (buff.unit === "multiplier") {
      multiplierPct += (buff.value - 1) * 100;
      continue;
    }
    if (buff.unit === "flat") {
      flatBonus += buff.value;
    }
  }

  const effectiveMultiplier = 1 + multiplierPct / 100;
  const calculatedPower =
    basePower === null
      ? null
      : Math.max(0, Math.round(basePower * effectiveMultiplier + flatBonus));

  const assumptions: string[] = [];
  if (basePower === null) {
    assumptions.push("ship_overlay_power_missing");
  }
  if (!ctx.deps.researchStore) {
    assumptions.push("research_store_unavailable");
  }
  if (researchAdvisory.priority === "low") {
    assumptions.push("research_low_confidence_advisory_only");
  }

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      hullType: hullTypeLabel(ship.hullType),
      rarity: ship.rarity,
      tier: ship.tier,
    },
    intentKey: intentKey ?? null,
    basePower,
    calculatedPower,
    researchImpact: {
      relevantBuffs: relevantBuffs.length,
      multiplierPct: Math.round(multiplierPct * 100) / 100,
      flatBonus: Math.round(flatBonus * 100) / 100,
      effectiveMultiplier: Math.round(effectiveMultiplier * 10000) / 10000,
      sampleBuffs: relevantBuffs.slice(0, 8).map((buff) => ({
        nodeId: buff.nodeId,
        nodeName: buff.nodeName,
        metric: buff.metric,
        value: buff.value,
        unit: buff.unit,
      })),
    },
    researchAdvisory,
    assumptions,
  };
}
