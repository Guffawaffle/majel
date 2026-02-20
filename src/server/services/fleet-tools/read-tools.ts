/**
 * fleet-tools/read-tools.ts — Read-Only Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * All read-only fleet intelligence tools. Safe to call without confirmation.
 * Covers: fleet overview, search, details, docks, conflicts, crew composition,
 * targets, and analysis.
 */

import type { ToolContext } from "./declarations.js";
import { detectTargetConflicts } from "../target-conflicts.js";
import { SEED_INTENTS, type SeedIntent } from "../../types/crew-types.js";
import { hullTypeLabel, officerClassLabel } from "../game-enums.js";
import type { ResearchBuff, ResearchNodeRecord } from "../../stores/research-store.js";
import type { InventoryCategory } from "../../stores/inventory-store.js";

/** Maximum results for search tools to avoid overwhelming the model context. */
const SEARCH_LIMIT = 20;
const RESEARCH_STALE_DAYS = 7;

type ResearchPriority = "none" | "low" | "medium";

interface ResearchAdvisory {
  status: "none" | "sparse" | "partial" | "strong";
  priority: ResearchPriority;
  confidencePct: number;
  reasons: string[];
  summary: {
    totalNodes: number;
    totalTrees: number;
    completedNodes: number;
    completionPct: number;
    lastUpdatedAt: string | null;
    daysSinceUpdate: number | null;
    stale: boolean;
  };
  recommendedUsage: string;
}

function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function computeLatestResearchTimestamp(nodes: ResearchNodeRecord[]): string | null {
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

function calculateResearchAdvisory(nodes: ResearchNodeRecord[]): ResearchAdvisory {
  const totalNodes = nodes.length;
  const trees = new Set(nodes.map((node) => node.tree));
  const completedNodes = nodes.filter((node) => node.completed).length;
  const completionRatio = totalNodes > 0 ? completedNodes / totalNodes : 0;
  const completionPct = Math.round(completionRatio * 1000) / 10;
  const lastUpdatedAt = computeLatestResearchTimestamp(nodes);
  const daysSinceUpdate = lastUpdatedAt
    ? Math.round(((Date.now() - Date.parse(lastUpdatedAt)) / 86_400_000) * 10) / 10
    : null;
  const stale = daysSinceUpdate !== null && daysSinceUpdate > RESEARCH_STALE_DAYS;

  const reasons: string[] = [];
  if (totalNodes === 0) {
    reasons.push("no_research_data");
  }
  if (totalNodes > 0 && totalNodes < 10) {
    reasons.push("sparse_node_coverage");
  }
  if (trees.size > 0 && trees.size < 2) {
    reasons.push("limited_tree_coverage");
  }
  if (stale) {
    reasons.push("stale_snapshot");
  }

  const breadthScore = Math.min(1, totalNodes / 40);
  const completionScore = completionRatio;
  const freshnessScore = daysSinceUpdate === null ? 0.4 : Math.max(0, 1 - Math.max(0, daysSinceUpdate - 1) / 28);
  const confidencePct = Math.round((breadthScore * 0.6 + completionScore * 0.2 + freshnessScore * 0.2) * 100);

  if (totalNodes === 0) {
    return {
      status: "none",
      priority: "none",
      confidencePct: 0,
      reasons,
      summary: {
        totalNodes,
        totalTrees: trees.size,
        completedNodes,
        completionPct,
        lastUpdatedAt,
        daysSinceUpdate,
        stale,
      },
      recommendedUsage: "Research effects unavailable. Use base roster/ship context only.",
    };
  }

  let status: ResearchAdvisory["status"] = "partial";
  let priority: ResearchPriority = "medium";
  if (confidencePct < 45 || reasons.includes("sparse_node_coverage") || reasons.includes("limited_tree_coverage")) {
    status = "sparse";
    priority = "low";
  } else if (confidencePct >= 80 && !stale) {
    status = "strong";
  }

  return {
    status,
    priority,
    confidencePct,
    reasons,
    summary: {
      totalNodes,
      totalTrees: trees.size,
      completedNodes,
      completionPct,
      lastUpdatedAt,
      daysSinceUpdate,
      stale,
    },
    recommendedUsage:
      priority === "low"
        ? "Treat research bonuses as advisory only; prioritize base officer/ship fit."
        : "Research bonuses are reliable enough to influence tie-breakers and optimization.",
  };
}

function normalizePercentValue(value: number): number {
  if (Math.abs(value) > 1) {
    return value / 100;
  }
  return value;
}

function metricMatchesIntent(metric: string, intentKey: string | undefined): boolean {
  const normalized = metric.toLowerCase();
  const generic = ["attack", "weapon", "hull", "shield", "defense", "mitigation", "crit", "health", "officer"];
  const combat = ["pvp", "armada", "hostile", "combat", "damage", "impulse", "base"];
  const mining = ["mining", "cargo", "protected", "opc"];

  const matchesAny = (keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword));

  if (!intentKey) {
    return matchesAny(generic) || matchesAny(combat);
  }

  if (intentKey.startsWith("mining")) {
    return matchesAny(generic) || matchesAny(mining);
  }

  return matchesAny(generic) || matchesAny(combat);
}

function extractRelevantBuffs(nodes: ResearchNodeRecord[], intentKey: string | undefined): Array<ResearchBuff & { nodeId: string; nodeName: string }> {
  const buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }> = [];

  for (const node of nodes) {
    if (!node.completed && node.level <= 0) continue;
    for (const buff of node.buffs) {
      if (!metricMatchesIntent(buff.metric, intentKey)) continue;
      buffs.push({ ...buff, nodeId: node.nodeId, nodeName: node.name });
    }
  }

  return buffs;
}

function formatBuffValue(buff: ResearchBuff): string {
  if (buff.unit === "percent") {
    const percentValue = normalizePercentValue(buff.value) * 100;
    return percentValue % 1 === 0 ? `${percentValue}%` : `${percentValue.toFixed(1)}%`;
  }
  if (buff.unit === "multiplier") {
    return `${buff.value.toFixed(3)}x`;
  }
  return Number.isInteger(buff.value) ? String(buff.value) : buff.value.toFixed(2);
}

function buildResearchCitations(
  buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }>,
  limit = 6,
): Array<{ nodeId: string; nodeName: string; metric: string; value: string; citation: string }> {
  return buffs.slice(0, limit).map((buff) => {
    const value = formatBuffValue(buff);
    const citation = `${buff.nodeName} (${buff.nodeId}) adds ${value} ${buff.metric}`;
    return {
      nodeId: buff.nodeId,
      nodeName: buff.nodeName,
      metric: buff.metric,
      value,
      citation,
    };
  });
}

interface UpgradeRequirement {
  key: string;
  resourceId: string | null;
  name: string;
  amount: number;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function extractBuildCostEntries(raw: unknown): UpgradeRequirement[] {
  if (!Array.isArray(raw)) return [];
  const requirements: UpgradeRequirement[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;

    const amount = toNumberOrNull(item.amount ?? item.value ?? item.quantity);
    if (amount == null || amount <= 0) continue;

    const idValue = item.resource_id ?? item.resourceId ?? item.id ?? item.type ?? null;
    const resourceId = idValue == null ? null : String(idValue);

    const name = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : resourceId
        ? `resource:${resourceId}`
        : "unknown_resource";

    const key = normalizeToken(resourceId ?? name);
    requirements.push({ key, resourceId, name, amount });
  }

  return requirements;
}

function aggregateRequirements(entries: UpgradeRequirement[]): UpgradeRequirement[] {
  const totals = new Map<string, UpgradeRequirement>();
  for (const entry of entries) {
    const existing = totals.get(entry.key);
    if (!existing) {
      totals.set(entry.key, { ...entry });
      continue;
    }
    existing.amount += entry.amount;
  }
  return Array.from(totals.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function extractTierRequirements(
  tiers: Record<string, unknown>[] | null,
  fromTierExclusive: number,
  toTierInclusive: number,
): UpgradeRequirement[] {
  if (!tiers || tiers.length === 0) return [];

  const requirements: UpgradeRequirement[] = [];
  for (const tierEntry of tiers) {
    const tierValue = toNumberOrNull((tierEntry as Record<string, unknown>).tier);
    if (tierValue == null) continue;
    if (tierValue <= fromTierExclusive || tierValue > toTierInclusive) continue;

    const components = (tierEntry as Record<string, unknown>).components;
    if (!Array.isArray(components)) continue;

    for (const component of components) {
      if (!component || typeof component !== "object") continue;
      const buildCost = (component as Record<string, unknown>).build_cost
        ?? (component as Record<string, unknown>).buildCost;
      requirements.push(...extractBuildCostEntries(buildCost));
    }
  }

  return aggregateRequirements(requirements);
}

// ─── Phase 1: Core Read Tools ───────────────────────────────

export async function getFleetOverview(ctx: ToolContext): Promise<object> {
  const overview: Record<string, unknown> = {};

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    overview.referenceCatalog = {
      officers: refCounts.officers,
      ships: refCounts.ships,
    };
  }

  if (ctx.overlayStore) {
    const overlayCounts = await ctx.overlayStore.counts();
    overview.overlays = {
      officers: overlayCounts.officers,
      ships: overlayCounts.ships,
    };
  }

  if (ctx.crewStore) {
    const [loadouts, docks, planItems, bridgeCores, presets, reservations] = await Promise.all([
      ctx.crewStore.listLoadouts(),
      ctx.crewStore.listDocks(),
      ctx.crewStore.listPlanItems(),
      ctx.crewStore.listBridgeCores(),
      ctx.crewStore.listFleetPresets(),
      ctx.crewStore.listReservations(),
    ]);
    const activePreset = presets.find((p) => p.isActive);
    overview.crew = {
      loadouts: loadouts.length,
      docks: docks.length,
      planItems: planItems.length,
      bridgeCores: bridgeCores.length,
      fleetPresets: presets.length,
      activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
      reservations: reservations.length,
      lockedReservations: reservations.filter((r) => r.locked).length,
    };
  }

  return overview;
}

export async function searchOfficers(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const officers = await ctx.referenceStore.searchOfficers(query);
  // Fetch reservations if crew store is available
  const reservations = ctx.crewStore ? await ctx.crewStore.listReservations() : [];
  const reservationMap = new Map(reservations.map((r) => [r.officerId, r]));

  const results = officers.slice(0, SEARCH_LIMIT).map((o) => {
    const res = reservationMap.get(o.id);
    return {
      id: o.id,
      name: o.name,
      rarity: o.rarity,
      group: o.groupName,
      officerClass: officerClassLabel(o.officerClass),
      captainManeuver: o.captainManeuver,
      officerAbility: o.officerAbility,
      ...(o.faction ? { faction: (o.faction as Record<string, unknown>).name ?? null } : {}),
      ...(res ? { reservation: { reservedFor: res.reservedFor, locked: res.locked } } : {}),
    };
  });

  return {
    results,
    totalFound: officers.length,
    truncated: officers.length > SEARCH_LIMIT,
  };
}

export async function searchShips(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const ships = await ctx.referenceStore.searchShips(query);
  const results = ships.slice(0, SEARCH_LIMIT).map((s) => ({
    id: s.id,
    name: s.name,
    shipClass: s.shipClass,
    grade: s.grade,
    rarity: s.rarity,
    faction: s.faction,
    tier: s.tier,
    hullType: hullTypeLabel(s.hullType),
    maxTier: s.maxTier,
  }));

  return {
    results,
    totalFound: ships.length,
    truncated: ships.length > SEARCH_LIMIT,
  };
}

export async function getOfficerDetail(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
      maxRank: officer.maxRank,
      synergyId: officer.synergyId,
      abilities: officer.abilities,
      traitConfig: officer.traitConfig,
      source: officer.source,
    },
  };

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getOfficerOverlay(officerId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        level: overlay.level,
        rank: overlay.rank,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

export async function getShipDetail(shipId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      tier: ship.tier,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      maxLevel: ship.maxLevel,
      blueprintsRequired: ship.blueprintsRequired,
      buildRequirements: ship.buildRequirements,
      tiers: ship.tiers,
      buildTimeInSeconds: ship.buildTimeInSeconds,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
      ability: ship.ability,
      source: ship.source,
    },
  };

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getShipOverlay(shipId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        tier: overlay.tier,
        level: overlay.level,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

export async function listDocks(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  const results = state.docks.map((d) => ({
    dockNumber: d.dockNumber,
    intentKeys: d.intentKeys,
    source: d.source,
    variantPatch: d.variantPatch,
    assignment: d.loadout
      ? {
          loadoutId: d.loadout.loadoutId,
          loadoutName: d.loadout.name,
          shipId: d.loadout.shipId,
          bridge: d.loadout.bridge,
          belowDeckPolicy: d.loadout.belowDeckPolicy
            ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
            : null,
        }
      : null,
  }));

  return { docks: results };
}

export async function getOfficerConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  return {
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityId: loc.entityId,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
    totalConflicts: state.conflicts.length,
  };
}

export async function validatePlan(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  const planItems = await ctx.crewStore.listPlanItems({ active: true });

  const emptyDocks = state.docks.filter((d) => !d.loadout);
  const unassignedPlanItems = planItems.filter((p) => p.dockNumber == null && !p.awayOfficers?.length);

  return {
    valid: state.conflicts.length === 0 && unassignedPlanItems.length === 0,
    officerConflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.length,
    })),
    emptyDocks: emptyDocks.map((d) => d.dockNumber),
    unassignedPlanItems: unassignedPlanItems.map((p) => ({
      planItemId: p.id,
      label: p.label,
    })),
    totalDocks: state.docks.length,
    totalPlanItems: planItems.length,
    totalConflicts: state.conflicts.length,
  };
}

// ─── Phase 2: Crew Composition Implementations ──────────────

export async function listOwnedOfficers(ctx: ToolContext): Promise<object> {
  if (!ctx.overlayStore) {
    return { error: "Overlay system not available. The Admiral may need to set up ownership data first." };
  }
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }

  const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });

  // Batch-fetch all reference officers (avoids N+1 per overlay)
  const allOfficers = await ctx.referenceStore.listOfficers();
  const refMap = new Map(allOfficers.map(o => [o.id, o]));

  const officers = overlays.map((overlay) => {
    const ref = refMap.get(overlay.refId);
    if (!ref) return null;
    return {
      id: ref.id,
      name: ref.name,
      rarity: ref.rarity,
      group: ref.groupName,
      officerClass: officerClassLabel(ref.officerClass),
      faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: ref.captainManeuver,
      officerAbility: ref.officerAbility,
      belowDeckAbility: ref.belowDeckAbility,
      level: overlay.level,
      rank: overlay.rank,
      power: overlay.power,
    };
  });

  const results = officers.filter(Boolean);
  return {
    officers: results,
    totalOwned: results.length,
  };
}

export async function getLoadoutDetail(loadoutId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!loadoutId || isNaN(loadoutId)) {
    return { error: "Valid loadout ID is required." };
  }

  const loadout = await ctx.crewStore.getLoadout(loadoutId);
  if (!loadout) {
    return { error: `Loadout not found: ${loadoutId}` };
  }

  const variants = await ctx.crewStore.listVariants(loadoutId);

  return {
    id: loadout.id,
    name: loadout.name,
    shipId: loadout.shipId,
    priority: loadout.priority,
    isActive: loadout.isActive,
    intentKeys: loadout.intentKeys,
    tags: loadout.tags,
    notes: loadout.notes,
    bridgeCore: loadout.bridgeCore
      ? {
          id: loadout.bridgeCore.id,
          name: loadout.bridgeCore.name,
          members: loadout.bridgeCore.members.map((m) => ({
            officerId: m.officerId,
            slot: m.slot,
          })),
        }
      : null,
    belowDeckPolicy: loadout.belowDeckPolicy
      ? {
          id: loadout.belowDeckPolicy.id,
          name: loadout.belowDeckPolicy.name,
          mode: loadout.belowDeckPolicy.mode,
          spec: loadout.belowDeckPolicy.spec,
        }
      : null,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      patch: v.patch,
      notes: v.notes,
    })),
  };
}

export async function listPlanItems(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const items = await ctx.crewStore.listPlanItems();
  return {
    planItems: items.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      variantId: p.variantId,
      priority: p.priority,
      isActive: p.isActive,
      source: p.source,
      awayOfficers: p.awayOfficers,
    })),
    totalItems: items.length,
  };
}

export async function listIntents(category: string | undefined, _ctx: ToolContext): Promise<object> {
  let intents = SEED_INTENTS;
  if (category) {
    intents = intents.filter((i: SeedIntent) => i.category === category);
  }
  return {
    intents: intents.map((i: SeedIntent) => ({
      key: i.key,
      label: i.label,
      category: i.category,
      description: i.description,
      icon: i.icon,
    })),
    totalIntents: intents.length,
  };
}

export async function listResearch(
  tree: string | undefined,
  includeCompleted: boolean | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.researchStore) {
    return { error: "Research store not available. Sync research data first." };
  }

  const result = await ctx.researchStore.listByTree({
    tree: tree?.trim() || undefined,
    includeCompleted: includeCompleted ?? true,
  });
  const counts = await ctx.researchStore.counts();

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
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.inventoryStore) {
    return { error: "Inventory store not available." };
  }

  const normalizedCategory = category?.trim().toLowerCase() as InventoryCategory | undefined;
  const categories = new Set(["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"]);
  if (normalizedCategory && !categories.has(normalizedCategory)) {
    return { error: `Invalid category '${category}'.` };
  }

  const grouped = await ctx.inventoryStore.listByCategory({
    category: normalizedCategory,
    q: query?.trim() || undefined,
  });
  const counts = await ctx.inventoryStore.counts();

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
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.inventoryStore) {
    return { error: "Inventory store not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.overlayStore ? await ctx.overlayStore.getShipOverlay(shipId) : null;
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

  const allInventoryItems = await ctx.inventoryStore.listItems();
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

function inferDefaultDailyRate(requirementName: string): number {
  const normalized = requirementName.toLowerCase();
  if (normalized.includes("ore")) return 120;
  if (normalized.includes("gas")) return 100;
  if (normalized.includes("crystal")) return 80;
  if (normalized.includes("part")) return 40;
  if (normalized.includes("blueprint")) return 8;
  if (normalized.includes("latinum") || normalized.includes("credit")) return 60;
  return 50;
}

function resolveOverrideDailyRate(
  requirementName: string,
  resourceId: string | null,
  overrides: Map<string, number>,
): number | undefined {
  const requirementKey = normalizeToken(requirementName);
  const direct = overrides.get(requirementKey);
  if (direct != null) return direct;

  if (resourceId) {
    const byId = overrides.get(normalizeToken(resourceId));
    if (byId != null) return byId;
  }

  for (const [key, value] of overrides.entries()) {
    if (requirementKey.includes(key) || key.includes(requirementKey)) {
      return value;
    }
  }

  return undefined;
}

export async function estimateAcquisitionTime(
  shipId: string,
  targetTier: number | undefined,
  dailyIncome: Record<string, unknown> | undefined,
  ctx: ToolContext,
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

  return {
    ship: upgradeResult.ship,
    target: {
      targetTier: (upgradeResult.ship as Record<string, unknown>).targetTier,
    },
    perResource,
    summary: {
      resourcesWithGap: perResource.length,
      blockingResources: blocking.length,
      estimatedDays,
      feasible: blocking.length === 0 && estimatedDays !== null,
      overrideCount: overrides.size,
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
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  const overlay = ctx.overlayStore ? await ctx.overlayStore.getShipOverlay(shipId) : null;
  const basePower = overlay?.power ?? null;

  const nodes = ctx.researchStore ? await ctx.researchStore.listNodes() : [];
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
  if (!ctx.researchStore) {
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

export async function findLoadoutsForIntent(intentKey: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.crewStore.listLoadouts({ intentKey });
  const detailed = await Promise.all(
    loadouts.map(async (l) => {
      const full = await ctx.crewStore!.getLoadout(l.id);
      return {
        id: l.id,
        name: l.name,
        shipId: l.shipId,
        isActive: l.isActive,
        bridgeCore: full?.bridgeCore
          ? {
              name: full.bridgeCore.name,
              members: full.bridgeCore.members.map((m) => ({
                officerId: m.officerId,
                slot: m.slot,
              })),
            }
          : null,
      };
    }),
  );

  return {
    intentKey,
    loadouts: detailed,
    totalLoadouts: detailed.length,
  };
}

export async function suggestCrew(
  shipId: string,
  intentKey: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  let intent: { key: string; label: string; category: string; description: string | null } | null = null;
  if (intentKey) {
    const match = SEED_INTENTS.find((i: SeedIntent) => i.key === intentKey);
    if (match) {
      intent = {
        key: match.key,
        label: match.label,
        category: match.category,
        description: match.description,
      };
    }
  }

  const ownedOfficers: Array<Record<string, unknown>> = [];
  if (ctx.overlayStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    for (const overlay of overlays) {
      const ref = refMap.get(overlay.refId);
      if (!ref) continue;
      ownedOfficers.push({
        id: ref.id,
        name: ref.name,
        rarity: ref.rarity,
        group: ref.groupName,
        officerClass: officerClassLabel(ref.officerClass),
        faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
        captainManeuver: ref.captainManeuver,
        officerAbility: ref.officerAbility,
        belowDeckAbility: ref.belowDeckAbility,
        level: overlay.level,
        rank: overlay.rank,
      });
    }
  }

  const existingLoadouts: Array<Record<string, unknown>> = [];
  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts({ shipId });
    const loadoutIds = loadouts.map(l => l.id);
    const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
    for (const l of loadouts) {
      const full = fullMap.get(l.id);
      existingLoadouts.push({
        id: l.id,
        name: l.name,
        isActive: l.isActive,
        intentKeys: l.intentKeys,
        bridgeCore: full?.bridgeCore
          ? full.bridgeCore.members.map((m) => ({
              officerId: m.officerId,
              slot: m.slot,
            }))
          : [],
      });
    }
  }

  const researchNodes = ctx.researchStore ? await ctx.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(researchNodes);
  const relevantResearchBuffs = extractRelevantBuffs(researchNodes, intentKey);
  const researchCitations = buildResearchCitations(relevantResearchBuffs);

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
    },
    intent,
    ownedOfficers,
    existingLoadouts,
    totalOwnedOfficers: ownedOfficers.length,
    researchContext: {
      ...researchAdvisory,
      relevantBuffCount: relevantResearchBuffs.length,
      citations: researchCitations,
      note:
        researchAdvisory.priority === "low"
          ? "Research data is sparse/stale; use only as a secondary signal."
          : "Research data coverage is sufficient to refine recommendations.",
    },
    recommendationHints: {
      prioritizeBaseFit: researchAdvisory.priority !== "medium",
      useResearchAsTiebreaker: researchAdvisory.priority === "low",
      useResearchInCoreScoring: researchAdvisory.priority === "medium",
      citationRequirement:
        researchCitations.length > 0
          ? "When referencing research in rationale, cite by nodeName + nodeId from researchContext.citations."
          : "No research citations available; avoid claiming specific research bonuses.",
    },
  };
}

export async function analyzeFleet(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const [effectiveState, planItems, loadouts, presets, reservations] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listPlanItems(),
    ctx.crewStore.listLoadouts(),
    ctx.crewStore.listFleetPresets(),
    ctx.crewStore.listReservations(),
  ]);

  const activePreset = presets.find((p) => p.isActive);

  return {
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name, slots: activePreset.slots.length } : null,
    docks: effectiveState.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      assignment: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            loadoutName: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    loadouts: loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      isActive: l.isActive,
      intentKeys: l.intentKeys,
    })),
    planItems: planItems.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      isActive: p.isActive,
      source: p.source,
    })),
    awayTeams: effectiveState.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: effectiveState.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => loc.entityName),
      locationCount: c.locations.length,
    })),
    totalDocks: effectiveState.docks.length,
    totalLoadouts: loadouts.length,
    totalPlanItems: planItems.length,
    totalConflicts: effectiveState.conflicts.length,
    reservations: reservations.map((r) => ({
      officerId: r.officerId,
      reservedFor: r.reservedFor,
      locked: r.locked,
    })),
    totalReservations: reservations.length,
  };
}

export async function resolveConflict(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const reservation = await ctx.crewStore.getReservation(officerId);

  const state = await ctx.crewStore.getEffectiveDockState();
  const conflict = state.conflicts.find((c) => c.officerId === officerId) ?? null;

  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.referenceStore.listOfficers({ groupName: officer.groupName });
    const altIds = groupOfficers.filter(a => a.id !== officerId).map(a => a.id);
    const overlayMap = new Map<string, boolean>();
    if (ctx.overlayStore && altIds.length > 0) {
      const ownedOverlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
      const ownedSet = new Set(ownedOverlays.map(o => o.refId));
      for (const id of altIds) overlayMap.set(id, ownedSet.has(id));
    }
    for (const alt of groupOfficers) {
      if (alt.id === officerId) continue;
      alternatives.push({
        id: alt.id,
        name: alt.name,
        rarity: alt.rarity,
        group: alt.groupName,
        officerClass: officerClassLabel(alt.officerClass),
        faction: alt.faction ? (alt.faction as Record<string, unknown>).name ?? null : null,
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned: overlayMap.get(alt.id) ?? false,
      });
    }
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  return {
    officer: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
    },
    conflict: conflict
      ? {
          locations: conflict.locations.map((loc) => ({
            type: loc.type,
            entityName: loc.entityName,
            slot: loc.slot,
          })),
        }
      : null,
    alternatives,
    affectedLoadouts,
    reservation: reservation
      ? { reservedFor: reservation.reservedFor, locked: reservation.locked }
      : null,
  };
}

export async function whatIfRemoveOfficer(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  let officerName: string | null = null;
  if (ctx.referenceStore) {
    const officer = await ctx.referenceStore.getOfficer(officerId);
    officerName = officer?.name ?? null;
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  const planItems = await ctx.crewStore.listPlanItems();
  const affectedAwayTeams = planItems
    .filter((p) => p.awayOfficers?.includes(officerId))
    .map((p) => ({
      planItemId: p.id,
      planItemLabel: p.label,
    }));

  return {
    officerId,
    officerName,
    affectedLoadouts,
    affectedAwayTeams,
    totalAffectedLoadouts: affectedLoadouts.length,
    totalAffectedAwayTeams: affectedAwayTeams.length,
    totalAffected: affectedLoadouts.length + affectedAwayTeams.length,
  };
}

// ─── Target/Goal Tracking Implementations ───────────────────

export async function listTargets(
  targetType: string | undefined,
  status: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }

  const filters: Record<string, unknown> = {};
  if (targetType) filters.targetType = targetType;
  if (status) filters.status = status;
  else filters.status = "active";

  const targets = await ctx.targetStore.list(
    Object.keys(filters).length > 0 ? filters as never : undefined,
  );

  return {
    targets: targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      targetTier: t.targetTier,
      targetRank: t.targetRank,
      targetLevel: t.targetLevel,
      reason: t.reason,
      priority: t.priority,
      status: t.status,
      autoSuggested: t.autoSuggested,
      achievedAt: t.achievedAt,
    })),
    totalTargets: targets.length,
  };
}

export async function suggestTargets(ctx: ToolContext): Promise<object> {
  const result: Record<string, unknown> = {};

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    result.catalogSize = { officers: refCounts.officers, ships: refCounts.ships };
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    result.ownedOfficers = overlays
      .map((overlay) => {
        const ref = refMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          rarity: ref.rarity,
          group: ref.groupName,
          officerClass: officerClassLabel(ref.officerClass),
          faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
          captainManeuver: ref.captainManeuver,
          officerAbility: ref.officerAbility,
          belowDeckAbility: ref.belowDeckAbility,
          level: overlay.level,
          rank: overlay.rank,
        };
      })
      .filter(Boolean);
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listShipOverlays({ ownershipState: "owned" });
    const allShips = await ctx.referenceStore.listShips();
    const shipMap = new Map(allShips.map(s => [s.id, s]));
    result.ownedShips = overlays
      .map((overlay) => {
        const ref = shipMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          shipClass: ref.shipClass,
          grade: ref.grade,
          rarity: ref.rarity,
          faction: ref.faction,
          hullType: hullTypeLabel(ref.hullType),
          tier: overlay.tier ?? ref.tier,
          level: overlay.level,
        };
      })
      .filter(Boolean);
  }

  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts();
    result.loadouts = loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      intentKeys: l.intentKeys,
    }));
  }

  if (ctx.targetStore) {
    const targets = await ctx.targetStore.list({ status: "active" } as never);
    result.existingTargets = targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      reason: t.reason,
      priority: t.priority,
    }));
  }

  if (ctx.crewStore) {
    const state = await ctx.crewStore.getEffectiveDockState();
    result.officerConflicts = state.conflicts.map((c) => ({
      officerId: c.officerId,
      locationCount: c.locations.length,
    }));
  }

  if (ctx.overlayStore) {
    const targetedOfficers = await ctx.overlayStore.listOfficerOverlays({ target: true });
    const targetedShips = await ctx.overlayStore.listShipOverlays({ target: true });
    result.overlayTargets = {
      officers: targetedOfficers.length,
      ships: targetedShips.length,
    };
  }

  return result;
}

export async function detectConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const conflicts = await detectTargetConflicts(ctx.targetStore, ctx.crewStore);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const c of conflicts) {
    byType[c.conflictType] = (byType[c.conflictType] ?? 0) + 1;
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
  }

  return {
    conflicts: conflicts.map((c) => ({
      conflictType: c.conflictType,
      severity: c.severity,
      resource: c.resource,
      description: c.description,
      suggestion: c.suggestion,
      targetA: c.targetA,
      targetB: c.targetB,
    })),
    summary: {
      totalConflicts: conflicts.length,
      byType,
      bySeverity,
    },
  };
}
