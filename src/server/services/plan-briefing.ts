/**
 * plan-briefing.ts — Plan-Centric Model Context Briefing (ADR-025)
 *
 * 3-tier computed summary injected into Gemini system prompt:
 *   Tier 1: Active plan summary (one line per dock + away teams)
 *   Tier 2: Crew detail + conflict report
 *   Tier 3: Computed insights (unassigned loadouts, missing objectives, double-bookings)
 *
 * Migrated from LoadoutStore (ADR-022) to CrewStore (ADR-025).
 */

import type { CrewStore } from "../stores/crew-store.js";
import type {
  PlanItem, OfficerConflict, EffectiveDockEntry, EffectiveAwayTeam,
} from "../types/crew-types.js";

// ─── Types ──────────────────────────────────────────────────

export interface PlanBriefing {
  /** Detail level: 1 = summary, 2 = crew detail, 3 = insights */
  tier: 1 | 2 | 3;
  /** Human-readable briefing text for model context */
  text: string;
  /** Token-budget estimate (rough char count) */
  totalChars: number;
  /** Structured data for API consumers */
  summary: {
    activePlanItems: number;
    dockedItems: number;
    awayTeams: number;
    loadoutsInUse: number;
    officerConflicts: number;
    validationWarnings: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────

function formatPlanLine(item: PlanItem): string {
  const parts: string[] = [];
  const label = item.label || item.intentKey || "Unnamed task";
  parts.push(label);
  if (item.dockNumber !== null) {
    parts.push(`Dock ${item.dockNumber}`);
  }
  if (item.loadoutId !== null) {
    parts.push(`Loadout #${item.loadoutId}`);
  }
  return parts.join(" → ");
}

function formatDockEntry(entry: EffectiveDockEntry): string {
  const parts: string[] = [`Dock ${entry.dockNumber}`];
  if (entry.loadout) {
    parts.push(`${entry.loadout.name} (ship: ${entry.loadout.shipId})`);
    const bridge = entry.loadout.bridge;
    const crew = [bridge.captain, bridge.bridge_1, bridge.bridge_2].filter(Boolean);
    if (crew.length > 0) {
      parts.push(`bridge: ${crew.join(", ")}`);
    }
  } else {
    parts.push("(empty)");
  }
  if (entry.intentKeys.length > 0) {
    parts.push(`[${entry.intentKeys.join(", ")}]`);
  }
  return parts.join(" — ");
}

function formatConflict(c: OfficerConflict): string {
  const locations = c.locations.map((loc) => {
    const slot = loc.slot ? ` (${loc.slot})` : "";
    return `${loc.entityName}${slot}`;
  });
  return `  ⚠ ${c.officerId}: ${locations.join(" × ")}`;
}

// ─── Builder ────────────────────────────────────────────────

export async function buildPlanBriefing(
  store: CrewStore,
  tier: 1 | 2 | 3 = 1,
): Promise<PlanBriefing> {
  const [planItems, effectiveState] = await Promise.all([
    store.listPlanItems({ active: true }),
    tier >= 2 ? store.getEffectiveDockState() : Promise.resolve(null),
  ]);

  const conflicts = effectiveState?.conflicts ?? [];
  const dockEntries = effectiveState?.docks ?? [];
  const awayTeams = effectiveState?.awayTeams ?? [];

  const dockedItems = planItems.filter((i) => i.dockNumber !== null);
  const awayPlanItems = planItems.filter(
    (i) => i.dockNumber === null && (i.awayOfficers?.length ?? 0) > 0,
  );
  const loadoutIds = new Set(
    planItems.filter((i) => i.loadoutId !== null).map((i) => i.loadoutId),
  );

  const sections: string[] = [];

  // ── Tier 1: Summary ──
  sections.push("=== Active Plan ===");

  if (planItems.length === 0) {
    sections.push("No active plan items. The Admiral hasn't set up a plan yet.");
  } else {
    if (dockedItems.length > 0) {
      sections.push("Docked:");
      for (const item of dockedItems) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
    if (awayPlanItems.length > 0) {
      sections.push("Away teams:");
      for (const item of awayPlanItems) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
    const queued = planItems.filter(
      (i) => i.dockNumber === null && !(i.awayOfficers?.length),
    );
    if (queued.length > 0) {
      sections.push("Queued (not yet assigned):");
      for (const item of queued) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
  }

  // ── Tier 2: Crew Detail + Conflicts ──
  if (tier >= 2 && effectiveState) {
    if (dockEntries.length > 0) {
      sections.push("");
      sections.push("=== Dock State ===");
      for (const entry of dockEntries) {
        sections.push(`  ${formatDockEntry(entry)}`);
      }
    }

    if (awayTeams.length > 0) {
      sections.push("");
      sections.push("=== Away Teams ===");
      for (const at of awayTeams) {
        sections.push(`  ${at.label || "Away team"}: ${at.officers.join(", ")}`);
      }
    }

    if (conflicts.length > 0) {
      sections.push("");
      sections.push("=== Officer Conflicts ===");
      for (const c of conflicts) {
        sections.push(formatConflict(c));
      }
    }
  }

  // ── Tier 3: Insights ──
  if (tier >= 3) {
    const insights: string[] = [];

    // Unassigned plan items (have loadout but no dock)
    const unassigned = planItems.filter(
      (i) => i.loadoutId !== null && i.dockNumber === null && !(i.awayOfficers?.length),
    );
    if (unassigned.length > 0) {
      const labels = unassigned.map((u) => u.label || `#${u.id}`);
      insights.push(`  📋 Plan items without dock: ${labels.join(", ")}`);
    }

    // Plan items with no loadout or away officers
    const emptyPlan = planItems.filter(
      (i) => i.loadoutId === null && !(i.awayOfficers?.length),
    );
    if (emptyPlan.length > 0) {
      const labels = emptyPlan.map((u) => u.label || `#${u.id}`);
      insights.push(`  🚢 Plan items without loadout: ${labels.join(", ")}`);
    }

    // Empty docks
    const emptyDocks = dockEntries.filter((d) => !d.loadout);
    if (emptyDocks.length > 0) {
      insights.push(`  ℹ Empty docks: ${emptyDocks.map((d) => d.dockNumber).join(", ")}`);
    }

    if (insights.length > 0) {
      sections.push("");
      sections.push("=== Plan Insights ===");
      sections.push(...insights);
    } else if (conflicts.length === 0) {
      sections.push("");
      sections.push("=== Plan Insights ===");
      sections.push("  ✅ Plan is valid — no conflicts or missing assignments");
    }
  }

  const text = sections.join("\n");

  return {
    tier,
    text,
    totalChars: text.length,
    summary: {
      activePlanItems: planItems.length,
      dockedItems: dockedItems.length,
      awayTeams: awayPlanItems.length,
      loadoutsInUse: loadoutIds.size,
      officerConflicts: conflicts.length,
      validationWarnings: 0,
    },
  };
}
