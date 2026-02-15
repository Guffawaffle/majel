/**
 * plan-solver.ts — Greedy Priority Queue Plan Solver (ADR-025)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Constraint satisfaction engine that takes active plan items, available docks,
 * and loadout data to produce optimal dock assignments with explanations.
 *
 * Algorithm: Greedy Priority Queue (v1)
 * 1. Sort active plan items by priority (ascending = highest priority first)
 * 2. For each plan item, assign to the first available dock
 * 3. Track officer consumption — once assigned to a higher-priority item,
 *    an officer is unavailable for lower-priority ones
 * 4. Produce explanations for every decision
 *
 * Key requirement: the solver EXPLAINS, it doesn't just assign.
 *
 * Migrated from LoadoutStore/loadout-types (ADR-022) to CrewStore/crew-types (ADR-025).
 */

import type {
  PlanItem,
  Dock,
  Loadout,
  LoadoutWithRefs,
  OfficerConflict,
} from "../types/crew-types.js";

// ─── Types ──────────────────────────────────────────────────

/** Solver assignment result (ADR-025 shape) */
export interface SolverAssignment {
  planItemId: number;
  planItemLabel: string | null;
  loadoutId: number | null;
  loadoutName: string | null;
  dockNumber: number | null;
  action: "assigned" | "queued" | "conflict" | "unchanged";
  explanation: string;
}

/** Full solver result with explanations and validation. */
export interface SolverResult {
  assignments: SolverAssignment[];
  applied: boolean;
  conflicts: OfficerConflict[];
  summary: string;
  warnings: string[];
}

interface CrewStoreSlice {
  listPlanItems(filters?: { active?: boolean }): Promise<PlanItem[]>;
  listDocks(): Promise<Dock[]>;
  listLoadouts(filters?: { active?: boolean }): Promise<Loadout[]>;
  getLoadout(id: number): Promise<LoadoutWithRefs | null>;
  getEffectiveDockState(): Promise<{ conflicts: OfficerConflict[] }>;
  updatePlanItem(id: number, fields: {
    dockNumber?: number | null;
    loadoutId?: number | null;
    isActive?: boolean;
  }): Promise<PlanItem | null>;
}

interface SolverOptions {
  /** Apply assignments to DB (default: false = dry run) */
  apply?: boolean;
}

// ─── Solver ─────────────────────────────────────────────────

/**
 * Run the greedy priority queue solver.
 *
 * @param store — crew store for data access + writes
 * @param opts — { apply: true } to write assignments to DB
 * @returns SolverResult with assignments, explanations, and summary
 */
export async function solvePlan(
  store: CrewStoreSlice,
  opts: SolverOptions = {},
): Promise<SolverResult> {
  const apply = opts.apply === true;

  // 1. Fetch all active plan items, docks, and loadout data
  const [planItems, docks, allLoadouts] = await Promise.all([
    store.listPlanItems({ active: true }),
    store.listDocks(),
    store.listLoadouts(),
  ]);

  // 2. Sort plan items by priority (ascending = highest priority first)
  const sorted = [...planItems].sort((a, b) => a.priority - b.priority);

  // 3. Build available dock set (all dock numbers, initially all free)
  const dockNumbers = docks.map(d => d.dockNumber);
  const availableDocks = new Set(dockNumbers);
  const usedOfficers = new Set<string>();
  const assignments: SolverAssignment[] = [];
  const warnings: string[] = [];

  // Build loadout→bridge officer mapping (need full refs for conflict detection)
  const loadoutBridgeMap = new Map<number, string[]>();
  for (const l of allLoadouts) {
    const full = await store.getLoadout(l.id);
    if (full?.bridgeCore) {
      loadoutBridgeMap.set(l.id, full.bridgeCore.members.map(m => m.officerId));
    }
  }

  // 4. Greedy assignment loop
  for (const pi of sorted) {
    const label = pi.label || `Plan item #${pi.id}`;
    const loadout = allLoadouts.find(l => l.id === pi.loadoutId);
    const loadoutName = loadout?.name || null;

    // Check for officer conflicts in this plan item's loadout
    const memberOfficerIds = pi.loadoutId
      ? (loadoutBridgeMap.get(pi.loadoutId) || [])
      : [];
    const conflictingOfficers = memberOfficerIds.filter(oid => usedOfficers.has(oid));

    if (conflictingOfficers.length > 0) {
      assignments.push({
        planItemId: pi.id,
        planItemLabel: label,
        loadoutId: pi.loadoutId,
        loadoutName,
        dockNumber: null,
        action: "conflict",
        explanation: `Cannot assign ${label} — officer conflict: ${conflictingOfficers.join(", ")} already assigned to higher-priority loadout(s). Suggestion: swap officers or run sequentially.`,
      });

      warnings.push(`Officer conflict on ${label}: ${conflictingOfficers.join(", ")}`);
      continue;
    }

    // No dock needed for away teams (dockNumber already null by design)
    if (pi.dockNumber == null && (pi.awayOfficers?.length ?? 0) > 0) {
      // Away team — no dock assignment needed
      memberOfficerIds.forEach(oid => usedOfficers.add(oid));
      assignments.push({
        planItemId: pi.id,
        planItemLabel: label,
        loadoutId: pi.loadoutId,
        loadoutName,
        dockNumber: null,
        action: "unchanged",
        explanation: `${label} is an away team mission — no dock required.`,
      });
      continue;
    }

    // Try to assign a dock
    if (pi.dockNumber != null && availableDocks.has(pi.dockNumber)) {
      // Already has a valid dock assignment — keep it
      availableDocks.delete(pi.dockNumber);
      memberOfficerIds.forEach(oid => usedOfficers.add(oid));
      assignments.push({
        planItemId: pi.id,
        planItemLabel: label,
        loadoutId: pi.loadoutId,
        loadoutName,
        dockNumber: pi.dockNumber,
        action: "unchanged",
        explanation: `${label} keeps Dock ${pi.dockNumber} (already assigned, priority #${pi.priority}).`,
      });
      continue;
    }

    // Need a dock — find first available
    const freeDock = findFirstAvailableDock(availableDocks, dockNumbers);

    if (freeDock != null) {
      availableDocks.delete(freeDock);
      memberOfficerIds.forEach(oid => usedOfficers.add(oid));

      const changed = freeDock !== pi.dockNumber;
      assignments.push({
        planItemId: pi.id,
        planItemLabel: label,
        loadoutId: pi.loadoutId,
        loadoutName,
        dockNumber: freeDock,
        action: changed ? "assigned" : "unchanged",
        explanation: changed
          ? `Assigned ${label} to Dock ${freeDock} (priority #${pi.priority}, dock available).`
          : `${label} stays at Dock ${freeDock}.`,
      });

      // Apply to DB if requested
      if (apply && changed) {
        await store.updatePlanItem(pi.id, { dockNumber: freeDock });
      }
    } else {
      // No docks available
      assignments.push({
        planItemId: pi.id,
        planItemLabel: label,
        loadoutId: pi.loadoutId,
        loadoutName,
        dockNumber: null,
        action: "queued",
        explanation: `Queued ${label} — no dock available (lower priority than ${sorted.length - availableDocks.size} active loadouts). Consider adding more docks or reducing active plan items.`,
      });

      warnings.push(`No dock for ${label} — queued`);
    }
  }

  // 5. Post-solve conflict check
  const effectiveState = apply
    ? await store.getEffectiveDockState()
    : null;
  const conflicts = effectiveState?.conflicts ?? [];

  // 6. Build summary
  const assigned = assignments.filter(a => a.action === "assigned").length;
  const unchanged = assignments.filter(a => a.action === "unchanged").length;
  const queued = assignments.filter(a => a.action === "queued").length;
  const conflicted = assignments.filter(a => a.action === "conflict").length;

  const parts = [];
  if (assigned) parts.push(`${assigned} assigned`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (queued) parts.push(`${queued} queued`);
  if (conflicted) parts.push(`${conflicted} conflict(s)`);

  const summary = apply
    ? `Solver applied: ${parts.join(", ")}.`
    : `Solver preview: ${parts.join(", ")}. Use apply=true to execute.`;

  return {
    assignments,
    applied: apply,
    conflicts,
    summary,
    warnings,
  };
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Find the first available dock number from the ordered list.
 */
function findFirstAvailableDock(
  available: Set<number>,
  ordered: number[],
): number | null {
  for (const n of ordered) {
    if (available.has(n)) return n;
  }
  return null;
}
