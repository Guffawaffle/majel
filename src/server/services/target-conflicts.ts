/**
 * target-conflicts.ts — Resource conflict detection across targets (#18)
 *
 * Phase 1: Static Conflict Graph (pure analysis, no model needed)
 *
 * Detects:
 * 1. Officer contention — same officer needed by multiple crew targets or
 *    by active loadouts AND a crew target
 * 2. Dock contention — multiple crew targets assigned to plan items on the same dock
 * 3. Crew cascade — officer targets whose officer is already in multiple active loadouts
 *
 * Material contention is deferred until cost/material data is imported (stfc.space).
 */

import type { Target, TargetStore } from "../stores/target-store.js";
import type { LoadoutStore } from "../stores/loadout-store.js";
import type {
  LoadoutWithMembers,
  PlanItemWithContext,
  OfficerConflict,
} from "../types/loadout-types.js";

// ─── Types ──────────────────────────────────────────────────

export type ConflictType = "officer" | "slot" | "cascade";
export type Severity = "blocking" | "competing" | "informational";

export interface TargetRef {
  id: number;
  targetType: string;
  refId: string | null;
  loadoutId: number | null;
  reason: string | null;
  priority: number;
}

export interface ResourceConflict {
  conflictType: ConflictType;
  targetA: TargetRef;
  targetB: TargetRef | null;
  resource: string;
  severity: Severity;
  description: string;
  suggestion?: string;
}

// ─── Detection Engine ───────────────────────────────────────

/**
 * Detect resource conflicts across all active targets.
 *
 * Pure analysis — reads fleet state, computes conflicts, returns them.
 * Does not mutate any state.
 */
export async function detectTargetConflicts(
  targetStore: TargetStore,
  loadoutStore: LoadoutStore,
): Promise<ResourceConflict[]> {
  const conflicts: ResourceConflict[] = [];

  // Gather data
  const targets = await targetStore.list({ status: "active" });
  if (targets.length === 0) return conflicts;

  const crewTargets = targets.filter((t) => t.targetType === "crew" && t.loadoutId != null);
  const officerTargets = targets.filter((t) => t.targetType === "officer" && t.refId);

  // Load loadouts for crew targets
  const loadoutMap = new Map<number, LoadoutWithMembers>();
  for (const t of crewTargets) {
    if (t.loadoutId != null && !loadoutMap.has(t.loadoutId)) {
      const loadout = await loadoutStore.getLoadout(t.loadoutId);
      if (loadout) loadoutMap.set(t.loadoutId, loadout);
    }
  }

  // 1. Officer contention between crew targets
  detectOfficerContention(crewTargets, loadoutMap, conflicts);

  // 2. Dock/slot contention between crew targets
  const planItems = await loadoutStore.listPlanItems({ active: true });
  detectDockContention(crewTargets, loadoutMap, planItems, conflicts);

  // 3. Officer cascade — officer targets whose officer is already conflicted
  const officerConflicts = await loadoutStore.getOfficerConflicts();
  detectOfficerCascade(officerTargets, officerConflicts, crewTargets, loadoutMap, conflicts);

  return conflicts;
}

// ─── 1. Officer Contention ──────────────────────────────────

/**
 * Detect when two crew targets share the same officer in their loadouts.
 */
function detectOfficerContention(
  crewTargets: Target[],
  loadoutMap: Map<number, LoadoutWithMembers>,
  conflicts: ResourceConflict[],
): void {
  // Build officer → targets mapping
  const officerToTargets = new Map<string, Array<{ target: Target; roleType: string }>>();

  for (const target of crewTargets) {
    const loadout = target.loadoutId != null ? loadoutMap.get(target.loadoutId) : null;
    if (!loadout) continue;

    for (const member of loadout.members) {
      const key = member.officerId;
      if (!officerToTargets.has(key)) officerToTargets.set(key, []);
      officerToTargets.get(key)!.push({
        target,
        roleType: member.roleType,
      });
    }
  }

  // Emit conflicts for shared officers
  for (const [officerId, entries] of officerToTargets) {
    if (entries.length < 2) continue;

    // Check all pairs
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const loadoutA = a.target.loadoutId != null ? loadoutMap.get(a.target.loadoutId) : null;
        const loadoutB = b.target.loadoutId != null ? loadoutMap.get(b.target.loadoutId) : null;
        const officerName = loadoutA?.members.find((m) => m.officerId === officerId)?.officerName
          ?? loadoutB?.members.find((m) => m.officerId === officerId)?.officerName
          ?? officerId;

        // Both need the same officer as captain → blocking
        // One as captain, one as bridge/below_deck → competing
        // Both below_deck → informational (works if not simultaneous)
        const bothCaptain = a.roleType === "bridge" && b.roleType === "bridge";
        const severity: Severity = bothCaptain ? "blocking" : "competing";

        conflicts.push({
          conflictType: "officer",
          targetA: toRef(a.target),
          targetB: toRef(b.target),
          resource: officerId,
          severity,
          description:
            `Officer ${officerName} is needed by both ` +
            `"${loadoutA?.name ?? `loadout ${a.target.loadoutId}`}" (${a.roleType}) and ` +
            `"${loadoutB?.name ?? `loadout ${b.target.loadoutId}`}" (${b.roleType}).`,
          suggestion: severity === "blocking"
            ? `Find an alternative officer for one of these loadouts. Use resolve_conflict for suggestions.`
            : `These loadouts can coexist if not active simultaneously.`,
        });
      }
    }
  }
}

// ─── 2. Dock Contention ─────────────────────────────────────

/**
 * Detect when two crew targets are assigned to plan items on the same dock.
 */
function detectDockContention(
  crewTargets: Target[],
  loadoutMap: Map<number, LoadoutWithMembers>,
  planItems: PlanItemWithContext[],
  conflicts: ResourceConflict[],
): void {
  // Map loadoutId → plan items with dock numbers
  const loadoutToDocks = new Map<number, Array<{ dockNumber: number; planItemLabel: string | null }>>();
  for (const pi of planItems) {
    if (pi.loadoutId == null || pi.dockNumber == null) continue;
    if (!loadoutToDocks.has(pi.loadoutId)) loadoutToDocks.set(pi.loadoutId, []);
    loadoutToDocks.get(pi.loadoutId)!.push({
      dockNumber: pi.dockNumber,
      planItemLabel: pi.label,
    });
  }

  // Check all crew target pairs for dock overlap
  for (let i = 0; i < crewTargets.length; i++) {
    for (let j = i + 1; j < crewTargets.length; j++) {
      const a = crewTargets[i];
      const b = crewTargets[j];
      if (a.loadoutId == null || b.loadoutId == null) continue;

      const docksA = loadoutToDocks.get(a.loadoutId) ?? [];
      const docksB = loadoutToDocks.get(b.loadoutId) ?? [];

      for (const dA of docksA) {
        for (const dB of docksB) {
          if (dA.dockNumber === dB.dockNumber) {
            const loadoutA = loadoutMap.get(a.loadoutId!);
            const loadoutB = loadoutMap.get(b.loadoutId!);
            conflicts.push({
              conflictType: "slot",
              targetA: toRef(a),
              targetB: toRef(b),
              resource: `dock:${dA.dockNumber}`,
              severity: "blocking",
              description:
                `Dock ${dA.dockNumber} is assigned to both ` +
                `"${loadoutA?.name ?? `loadout ${a.loadoutId}`}" ` +
                `(${dA.planItemLabel ?? "unnamed"}) and ` +
                `"${loadoutB?.name ?? `loadout ${b.loadoutId}`}" ` +
                `(${dB.planItemLabel ?? "unnamed"}).`,
              suggestion: `Move one of these plan items to a different dock.`,
            });
          }
        }
      }
    }
  }
}

// ─── 3. Officer Cascade ─────────────────────────────────────

/**
 * Detect when an officer target references an officer who is already
 * conflicted across active loadouts, or who appears in a crew target's loadout.
 */
function detectOfficerCascade(
  officerTargets: Target[],
  existingConflicts: OfficerConflict[],
  crewTargets: Target[],
  loadoutMap: Map<number, LoadoutWithMembers>,
  conflicts: ResourceConflict[],
): void {
  const conflictedOfficerIds = new Set(existingConflicts.map((c) => c.officerId));

  // Build officer → crew targets (which loadouts use this officer)
  const officerToCrew = new Map<string, Target[]>();
  for (const t of crewTargets) {
    const loadout = t.loadoutId != null ? loadoutMap.get(t.loadoutId) : null;
    if (!loadout) continue;
    for (const m of loadout.members) {
      if (!officerToCrew.has(m.officerId)) officerToCrew.set(m.officerId, []);
      officerToCrew.get(m.officerId)!.push(t);
    }
  }

  for (const target of officerTargets) {
    const officerId = target.refId!;

    // 3a. Officer target + already conflicted in active loadouts
    if (conflictedOfficerIds.has(officerId)) {
      const existingConflict = existingConflicts.find((c) => c.officerId === officerId)!;
      conflicts.push({
        conflictType: "cascade",
        targetA: toRef(target),
        targetB: null,
        resource: officerId,
        severity: "informational",
        description:
          `Officer target "${target.reason ?? officerId}" — ` +
          `this officer already appears in ${existingConflict.appearances.length} active assignments. ` +
          `Upgrading may affect: ${existingConflict.appearances.map((a) => a.loadoutName ?? a.planItemLabel ?? `plan item ${a.planItemId}`).join(", ")}.`,
        suggestion: `Review officer's role across loadouts before investing in upgrades.`,
      });
    }

    // 3b. Officer target + officer used in crew target loadouts
    const crewUses = officerToCrew.get(officerId);
    if (crewUses && crewUses.length > 0) {
      for (const crewTarget of crewUses) {
        const loadout = crewTarget.loadoutId != null ? loadoutMap.get(crewTarget.loadoutId) : null;
        conflicts.push({
          conflictType: "cascade",
          targetA: toRef(target),
          targetB: toRef(crewTarget),
          resource: officerId,
          severity: "informational",
          description:
            `Officer target "${target.reason ?? officerId}" is used in ` +
            `crew target "${loadout?.name ?? `loadout ${crewTarget.loadoutId}`}". ` +
            `Upgrading this officer benefits both targets.`,
          suggestion: `Prioritize this officer upgrade — it has compounding value.`,
        });
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function toRef(t: Target): TargetRef {
  return {
    id: t.id,
    targetType: t.targetType,
    refId: t.refId,
    loadoutId: t.loadoutId,
    reason: t.reason,
    priority: t.priority,
  };
}
