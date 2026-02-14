/**
 * plan-briefing.ts — Plan-Centric Model Context Briefing (ADR-022 Phase 2).
 *
 * 3-tier computed summary injected into Gemini system prompt:
 *   Tier 1: Active plan summary (one line per dock + away teams)
 *   Tier 2: Crew detail + conflict report
 *   Tier 3: Computed insights (unassigned loadouts, missing objectives, double-bookings)
 *
 * Replaces dock-briefing.ts (ADR-010).
 */

import type { LoadoutStore, PlanItemWithContext, OfficerConflict, PlanValidation } from "../stores/loadout-store.js";

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

function formatPlanLine(item: PlanItemWithContext): string {
  const parts: string[] = [];
  const label = item.label || item.intentLabel || "Unnamed task";
  parts.push(label);
  if (item.loadoutName && item.shipName) {
    parts.push(`${item.shipName} (${item.loadoutName})`);
  } else if (item.loadoutName) {
    parts.push(item.loadoutName);
  }
  if (item.dockNumber !== null) {
    parts.push(`Dock ${item.dockNumber}${item.dockLabel ? ` "${item.dockLabel}"` : ""}`);
  }
  return parts.join(" → ");
}

function formatCrewDetail(item: PlanItemWithContext): string {
  const lines: string[] = [];
  if (item.members.length > 0) {
    const bridge = item.members.filter(m => m.roleType === "bridge");
    const belowDeck = item.members.filter(m => m.roleType === "below_deck");
    if (bridge.length > 0) {
      lines.push(`    Bridge: ${bridge.map(m => m.officerName || m.officerId).join(", ")}`);
    }
    if (belowDeck.length > 0) {
      lines.push(`    Below deck: ${belowDeck.map(m => m.officerName || m.officerId).join(", ")}`);
    }
  }
  if (item.awayMembers.length > 0) {
    lines.push(`    Away team: ${item.awayMembers.map(m => m.officerName || m.officerId).join(", ")}`);
  }
  return lines.join("\n");
}

function formatConflict(c: OfficerConflict): string {
  const locations = c.appearances.map(a => {
    const where = a.dockNumber !== null ? `Dock ${a.dockNumber}` : "away team";
    return `${a.planItemLabel || "unknown"} (${where}, ${a.source})`;
  });
  return `  ⚠ ${c.officerName}: ${locations.join(" × ")}`;
}

function formatInsights(validation: PlanValidation, items: PlanItemWithContext[]): string[] {
  const insights: string[] = [];

  if (validation.dockConflicts.length > 0) {
    for (const dc of validation.dockConflicts) {
      insights.push(`  ❌ Dock ${dc.dockNumber} over-assigned: ${dc.labels.join(", ")}`);
    }
  }

  if (validation.unassignedLoadouts.length > 0) {
    const labels = validation.unassignedLoadouts.map(u => u.label || `#${u.planItemId}`);
    insights.push(`  📋 Plan items without dock assignment: ${labels.join(", ")}`);
  }

  if (validation.unassignedDocks.length > 0) {
    const labels = validation.unassignedDocks.map(u => u.label || `#${u.planItemId}`);
    insights.push(`  🚢 Plan items without loadout: ${labels.join(", ")}`);
  }

  // Find inactive loadouts that have plan items (might be forgotten)
  const inactiveInPlan = items.filter(i => i.isActive && i.loadoutId !== null);
  const loadoutIdsInPlan = new Set(inactiveInPlan.map(i => i.loadoutId));
  if (loadoutIdsInPlan.size === 0 && items.length > 0) {
    insights.push("  ℹ No loadouts assigned to any plan items");
  }

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      insights.push(`  ⚠ ${w}`);
    }
  }

  return insights;
}

// ─── Builder ────────────────────────────────────────────────

export async function buildPlanBriefing(
  store: LoadoutStore,
  tier: 1 | 2 | 3 = 1,
): Promise<PlanBriefing> {
  const [allItems, conflicts, validation] = await Promise.all([
    store.listPlanItems({ active: true }),
    tier >= 2 ? store.getOfficerConflicts() : Promise.resolve([]),
    tier >= 3 ? store.validatePlan() : Promise.resolve(null),
  ]);

  const dockedItems = allItems.filter(i => i.dockNumber !== null);
  const awayTeams = allItems.filter(i => i.dockNumber === null && i.awayMembers.length > 0);
  const loadoutIds = new Set(allItems.filter(i => i.loadoutId !== null).map(i => i.loadoutId));

  const sections: string[] = [];

  // ── Tier 1: Summary ──
  sections.push("=== Active Plan ===");

  if (allItems.length === 0) {
    sections.push("No active plan items. The Admiral hasn't set up a plan yet.");
  } else {
    if (dockedItems.length > 0) {
      sections.push("Docked:");
      for (const item of dockedItems) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
    if (awayTeams.length > 0) {
      sections.push("Away teams:");
      for (const item of awayTeams) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
    const undockedNoAway = allItems.filter(i => i.dockNumber === null && i.awayMembers.length === 0);
    if (undockedNoAway.length > 0) {
      sections.push("Queued (not yet assigned):");
      for (const item of undockedNoAway) {
        sections.push(`  ${formatPlanLine(item)}`);
      }
    }
  }

  // ── Tier 2: Crew Detail + Conflicts ──
  if (tier >= 2 && allItems.length > 0) {
    sections.push("");
    sections.push("=== Crew Detail ===");
    for (const item of allItems) {
      const crewDetail = formatCrewDetail(item);
      if (crewDetail) {
        sections.push(`  ${formatPlanLine(item)}`);
        sections.push(crewDetail);
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
  if (tier >= 3 && validation) {
    const insights = formatInsights(validation, allItems);
    if (insights.length > 0) {
      sections.push("");
      sections.push("=== Plan Insights ===");
      sections.push(...insights);
    } else if (validation.valid) {
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
      activePlanItems: allItems.length,
      dockedItems: dockedItems.length,
      awayTeams: awayTeams.length,
      loadoutsInUse: loadoutIds.size,
      officerConflicts: conflicts.length,
      validationWarnings: validation?.warnings.length ?? 0,
    },
  };
}
