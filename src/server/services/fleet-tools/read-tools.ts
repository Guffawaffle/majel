/**
 * fleet-tools/read-tools.ts — Read-Only Tool Barrel (ADR-039)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Thin re-export barrel. Implementation lives in domain modules:
 *   read-tools-catalog.ts      — fleet overview, search, detail
 *   read-tools-dock.ts         — docks, officer conflicts, fleet analysis
 *   read-tools-crew.ts         — owned officers, loadouts, crew suggestions
 *   read-tools-planning.ts     — plan validation, plan items, intents
 *   read-tools-progression.ts  — research, inventory, upgrade path, ETA, true power
 *   read-tools-context.ts      — active events, away teams, faction standings
 *   read-tools-targets.ts      — targets, experience metrics, conflict detection
 *   read-tools-game-reference.ts — game reference search and detail
 *   read-tools-formatting.ts   — shared formatting/name-resolution helpers
 */

// ── Pre-existing extracted helpers (re-exported for tool-registry) ───
export { __resetWebLookupStateForTests, webLookup } from "./read-tools-web-lookup.js";
export { analyzeBattleLog, suggestCounter } from "./read-tools-battle-tools.js";
export { suggestTargets } from "./read-tools-target-suggestions.js";

// ── Catalog ─────────────────────────────────────────────────
export { getFleetOverview, searchOfficers, searchShips, getOfficerDetail, getShipDetail } from "./read-tools-catalog.js";

// ── Dock / Fleet ────────────────────────────────────────────
export { listDocks, getOfficerConflicts, analyzeFleet } from "./read-tools-dock.js";

// ── Planning ────────────────────────────────────────────────
export { validatePlan, listPlanItems, listIntents } from "./read-tools-planning.js";

// ── Crew composition ────────────────────────────────────────
export { listOwnedOfficers, getLoadoutDetail, findLoadoutsForIntent, suggestCrew, resolveConflict, whatIfRemoveOfficer } from "./read-tools-crew.js";

// ── Progression ─────────────────────────────────────────────
export { listResearch, listInventory, calculateUpgradePath, estimateAcquisitionTime, calculateTruePower } from "./read-tools-progression.js";

// ── Context ─────────────────────────────────────────────────
export { listActiveEvents, listAwayTeams, getFactionStanding } from "./read-tools-context.js";

// ── Targets / Goals ─────────────────────────────────────────
export { listTargets, getAgentExperienceMetrics, detectConflicts } from "./read-tools-targets.js";

// ── Game Reference ──────────────────────────────────────────
export { searchGameReference, getGameReference } from "./read-tools-game-reference.js";
