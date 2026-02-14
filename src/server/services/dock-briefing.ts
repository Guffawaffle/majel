/**
 * dock-briefing.ts — Drydock Briefing Builder (ADR-010 §3)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Computes a structured text briefing from dock state for model
 * context injection. Three tiers: status → crew → insights.
 *
 * Extracted from dock-store.ts during ADR-018 Phase 1 migration.
 */

import type {
  DockWithContext,
  DockBriefing,
  OfficerConflict,
  CrewPresetWithMembers,
} from "../types/dock-types.js";

/**
 * Build a multi-tier briefing from dock state.
 *
 * @param docks    All configured docks with context (intents + ships)
 * @param conflicts Detected officer multi-assignment conflicts
 * @param listPresets Callback to query presets by filter
 */
export function buildDockBriefing(
  docks: DockWithContext[],
  conflicts: OfficerConflict[],
  listPresets: (filters: { shipId: string }) => CrewPresetWithMembers[],
): DockBriefing {
  if (docks.length === 0) {
    return { statusLines: [], crewLines: [], conflictLines: [], insights: [], text: "", totalChars: 0 };
  }

  // ── Tier 1: Dock Status Summary ───────────────────────
  const statusLines: string[] = [];
  for (const dock of docks) {
    const label = dock.label ? `"${dock.label}"` : "(unlabeled)";
    const intentTags = dock.intents.length > 0
      ? `[${dock.intents.map((i) => i.key).join(", ")}]`
      : "[no intents]";
    const activeShip = dock.ships.find((s) => s.isActive);
    const shipInfo = activeShip
      ? `${activeShip.shipName} (active)`
      : dock.ships.length > 0
        ? `${dock.ships[0].shipName} (none active)`
        : "empty";
    const n = dock.ships.length;
    statusLines.push(
      `  D${dock.dockNumber} ${label} ${intentTags} → ${shipInfo} | ${n} ship${n !== 1 ? "s" : ""} in rotation`,
    );
  }

  // ── Tier 2: Crew Summary + Conflicts ──────────────────
  const crewLines: string[] = [];
  for (const dock of docks) {
    const activeShip = dock.ships.find((s) => s.isActive);
    if (!activeShip) continue;

    const presets = listPresets({ shipId: activeShip.shipId });
    const relevant = presets.filter((p) =>
      dock.intents.some((i) => i.key === p.intentKey) && p.members.length > 0,
    );

    if (relevant.length > 0) {
      const best = relevant.find((p) => p.isDefault) || relevant[0];
      const crewStr = best.members
        .filter((m) => m.roleType === "bridge")
        .map((m, i) => i === 0 ? `${m.officerName}(cpt)` : m.officerName)
        .join(" · ");
      const suffix = relevant.length > 1 ? ` — ${relevant.length} presets` : "";
      const tagStr = best.tags.length > 0 ? ` [${best.tags.join(", ")}]` : "";
      crewLines.push(`  D${dock.dockNumber} ${activeShip.shipName}: ${crewStr || "(no bridge crew)"}${suffix}${tagStr}`);
    } else {
      crewLines.push(`  D${dock.dockNumber} ${activeShip.shipName}: (no crew preset — model will suggest)`);
    }
  }

  const conflictLines: string[] = [];
  for (const c of conflicts) {
    const locations = c.appearances
      .map((a) => {
        const dockStr = a.dockNumbers.length > 0 ? `D${a.dockNumbers.join(",D")} ` : "";
        return `${dockStr}${a.intentLabel}`;
      })
      .join(", ");
    conflictLines.push(`  ${c.officerName}: [${locations}]`);
  }

  // ── Tier 3: Computed Insights ─────────────────────────
  const insights: string[] = [];

  const intentCounts = new Map<string, number>();
  for (const dock of docks) {
    for (const intent of dock.intents) {
      intentCounts.set(intent.category, (intentCounts.get(intent.category) || 0) + 1);
    }
  }
  for (const [category, count] of intentCounts) {
    if (count > docks.length / 2) {
      insights.push(`- ${count} of ${docks.length} docks assigned to ${category} — consider diversifying if other activities are falling behind`);
    }
  }

  for (const dock of docks) {
    const lbl = dock.label || `Dock ${dock.dockNumber}`;
    if (dock.ships.length === 1) {
      insights.push(`- ${lbl} (D${dock.dockNumber}) has no rotation — single point of failure`);
    }
    if (dock.ships.length > 0 && !dock.ships.some((s) => s.isActive)) {
      insights.push(`- ${lbl} (D${dock.dockNumber}) has ships but none marked active`);
    }
  }

  if (conflicts.length > 0) {
    insights.push(`- ${conflicts.length} officer${conflicts.length !== 1 ? "s" : ""} appear in presets for multiple ships/docks (see conflicts above)`);
  }

  // ── Assemble ──────────────────────────────────────────
  const sections: string[] = [];
  sections.push(`DRYDOCK STATUS (${docks.length} active dock${docks.length !== 1 ? "s" : ""}):`);
  sections.push(statusLines.join("\n"));
  if (crewLines.length > 0) { sections.push(`\nACTIVE CREW:`); sections.push(crewLines.join("\n")); }
  if (conflictLines.length > 0) { sections.push(`\nOFFICER CONFLICTS:`); sections.push(conflictLines.join("\n")); }
  if (insights.length > 0) { sections.push(`\nFLEET NOTES:`); sections.push(insights.join("\n")); }
  const text = sections.join("\n");

  return { statusLines, crewLines, conflictLines, insights, text, totalChars: text.length };
}
