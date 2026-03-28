/**
 * tool-registry.ts — Fleet Tool Registry (ADR-039 D7, Stage 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Registers every fleet tool via `defineTool()` with explicit dependency
 * declarations. Replaces the switch-based dispatcher with map lookup.
 *
 * Each entry's `run` adapter mirrors the argument-unpacking logic that
 * previously lived in the `dispatchTool` switch cases.
 */

import { defineTool, ToolRegistry } from "./define-tool.js";

// ─── Read tool implementations ──────────────────────────────
import {
  getFleetOverview,
  searchOfficers,
  searchShips,
  getOfficerDetail,
  getOfficersDetail,
  getShipDetail,
  getShipsDetail,
  listDocks,
  getOfficerConflicts,
  validatePlan,
  listOwnedOfficers,
  getLoadoutDetail,
  listPlanItems,
  listIntents,
  listResearch,
  listInventory,
  listActiveEvents,
  listAwayTeams,
  getFactionStanding,
  webLookup,
  calculateUpgradePath,
  estimateAcquisitionTime,
  calculateTruePower,
  findLoadoutsForIntent,
  suggestCrew,
  analyzeBattleLog,
  suggestCounter,
  analyzeFleet,
  resolveConflict,
  whatIfRemoveOfficer,
  listTargets,
  getAgentExperienceMetrics,
  suggestTargets,
  detectConflicts,
  searchGameReference,
  getGameReference,
  checkOpsUnlocks,
} from "./read-tools.js";

// ─── Mutation tool implementations ──────────────────────────
import {
  syncOverlayTool,
  createBridgeCoreTool,
  createLoadoutTool,
  activatePresetTool,
  setReservationTool,
  createVariantTool,
  getEffectiveStateTool,
  syncResearchTool,
  createTargetTool,
  updateTargetTool,
  completeTargetTool,
  recordTargetDeltaTool,
  recordReminderFeedbackTool,
  recordGoalRestatementTool,
  setShipOverlayTool,
  setOfficerOverlayTool,
  updateInventoryTool,
  assignDockTool,
  updateDockTool,
  removeDockAssignmentTool,
} from "./mutate-tools.js";

// ─── Registry ───────────────────────────────────────────────

export const toolRegistry = new ToolRegistry();

// ── Read tools: fleet overview & search ─────────────────────

toolRegistry.register(defineTool({
  name: "get_fleet_overview",
  deps: ["referenceStore", "overlayStore", "crewStore"],
  run: (_args, env) => getFleetOverview(env),
}));

toolRegistry.register(defineTool({
  name: "search_officers",
  deps: ["referenceStore", "crewStore"],
  run: (args, env) => searchOfficers(String(args.query ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "search_ships",
  deps: ["referenceStore"],
  run: (args, env) => searchShips(String(args.query ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "get_officer_detail",
  deps: ["referenceStore", "overlayStore"],
  run: (args, env) => getOfficerDetail(String(args.officer_id ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "get_officers_detail",
  deps: ["referenceStore", "overlayStore"],
  run: (args, env) => getOfficersDetail(
    Array.isArray(args.officer_ids) ? (args.officer_ids as string[]).map(String) : [],
    env,
  ),
}));

toolRegistry.register(defineTool({
  name: "get_ship_detail",
  deps: ["referenceStore", "overlayStore"],
  run: (args, env) => getShipDetail(String(args.ship_id ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "get_ships_detail",
  deps: ["referenceStore", "overlayStore"],
  run: (args, env) => getShipsDetail(
    Array.isArray(args.ship_ids) ? (args.ship_ids as string[]).map(String) : [],
    env,
  ),
}));

// ── Read tools: crew & dock ─────────────────────────────────

toolRegistry.register(defineTool({
  name: "list_docks",
  deps: ["crewStore", "referenceStore"],
  run: (_args, env) => listDocks(env),
}));

toolRegistry.register(defineTool({
  name: "get_officer_conflicts",
  deps: ["crewStore", "referenceStore"],
  run: (_args, env) => getOfficerConflicts(env),
}));

toolRegistry.register(defineTool({
  name: "validate_plan",
  deps: ["crewStore", "referenceStore"],
  run: (_args, env) => validatePlan(env),
}));

toolRegistry.register(defineTool({
  name: "list_owned_officers",
  deps: ["overlayStore", "referenceStore"],
  run: (_args, env) => listOwnedOfficers(env),
}));

toolRegistry.register(defineTool({
  name: "get_loadout_detail",
  deps: ["crewStore", "referenceStore"],
  run: (args, env) => getLoadoutDetail(Number(args.loadout_id), env),
}));

toolRegistry.register(defineTool({
  name: "list_plan_items",
  deps: ["crewStore"],
  run: (_args, env) => listPlanItems(env),
}));

// ── Read tools: intents, research, inventory, events ────────

toolRegistry.register(defineTool({
  name: "list_intents",
  deps: [],
  run: (args, env) => listIntents(args.category as string | undefined, env),
}));

toolRegistry.register(defineTool({
  name: "list_research",
  deps: ["researchStore"],
  run: (args, env) => listResearch(
    args.tree as string | undefined,
    args.include_completed as boolean | undefined,
    env,
  ),
}));

toolRegistry.register(defineTool({
  name: "list_inventory",
  deps: ["inventoryStore"],
  run: (args, env) => listInventory(args.category as string | undefined, args.query as string | undefined, env),
}));

toolRegistry.register(defineTool({
  name: "list_active_events",
  deps: ["userSettingsStore"],
  run: (_args, env) => listActiveEvents(env),
}));

toolRegistry.register(defineTool({
  name: "list_away_teams",
  deps: ["userSettingsStore"],
  run: (_args, env) => listAwayTeams(env),
}));

toolRegistry.register(defineTool({
  name: "get_faction_standing",
  deps: ["userSettingsStore"],
  run: (args, env) => getFactionStanding(args.faction as string | undefined, env),
}));

// ── Read tools: web lookup ──────────────────────────────────

toolRegistry.register(defineTool({
  name: "web_lookup",
  deps: [],
  run: (args) => webLookup(
    String(args.domain ?? ""),
    String(args.query ?? ""),
    args.entity_type as string | undefined,
  ),
}));

// ── Read tools: ship analysis ───────────────────────────────

toolRegistry.register(defineTool({
  name: "calculate_upgrade_path",
  deps: ["referenceStore", "inventoryStore", "overlayStore"],
  run: (args, env) => calculateUpgradePath(
    String(args.ship_id ?? ""),
    args.target_tier == null ? undefined : Number(args.target_tier),
    env,
  ),
}));

toolRegistry.register(defineTool({
  name: "estimate_acquisition_time",
  deps: ["referenceStore", "inventoryStore", "overlayStore"],
  run: (args, env) => estimateAcquisitionTime(
    String(args.ship_id ?? ""),
    args.target_tier == null ? undefined : Number(args.target_tier),
    args.daily_income as Record<string, unknown> | undefined,
    env,
  ),
}));

toolRegistry.register(defineTool({
  name: "calculate_true_power",
  deps: ["referenceStore", "overlayStore", "researchStore"],
  run: (args, env) => calculateTruePower(String(args.ship_id ?? ""), args.intent_key as string | undefined, env),
}));

// ── Read tools: crew recommendation ─────────────────────────

toolRegistry.register(defineTool({
  name: "find_loadouts_for_intent",
  deps: ["crewStore"],
  run: (args, env) => findLoadoutsForIntent(String(args.intent_key ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "suggest_crew",
  deps: ["referenceStore", "crewStore", "overlayStore", "researchStore"],
  run: (args, env) => suggestCrew(String(args.ship_id ?? ""), args.intent_key as string | undefined, env),
}));

toolRegistry.register(defineTool({
  name: "analyze_battle_log",
  deps: ["researchStore"],
  run: (args, env) => analyzeBattleLog(args.battle_log, env),
}));

toolRegistry.register(defineTool({
  name: "suggest_counter",
  deps: ["overlayStore", "referenceStore"],
  run: (args, env) => suggestCounter(args.battle_log, env),
}));

toolRegistry.register(defineTool({
  name: "analyze_fleet",
  deps: ["crewStore"],
  run: (_args, env) => analyzeFleet(env),
}));

toolRegistry.register(defineTool({
  name: "resolve_conflict",
  deps: ["referenceStore", "crewStore", "overlayStore"],
  run: (args, env) => resolveConflict(String(args.officer_id ?? ""), env),
}));

toolRegistry.register(defineTool({
  name: "what_if_remove_officer",
  deps: ["crewStore", "referenceStore"],
  run: (args, env) => whatIfRemoveOfficer(String(args.officer_id ?? ""), env),
}));

// ── Read tools: targets & goals ─────────────────────────────

toolRegistry.register(defineTool({
  name: "list_targets",
  deps: ["targetStore"],
  run: (args, env) => listTargets(args.target_type as string | undefined, args.status as string | undefined, env),
}));

toolRegistry.register(defineTool({
  name: "get_agent_experience_metrics",
  deps: ["targetStore"],
  run: (_args, env) => getAgentExperienceMetrics(env),
}));

toolRegistry.register(defineTool({
  name: "suggest_targets",
  deps: ["referenceStore", "overlayStore", "crewStore", "targetStore", "inventoryStore"],
  run: (_args, env) => suggestTargets(env),
}));

toolRegistry.register(defineTool({
  name: "detect_target_conflicts",
  deps: ["targetStore", "crewStore"],
  run: (_args, env) => detectConflicts(env),
}));

// ── Read tools: game reference ──────────────────────────────

toolRegistry.register(defineTool({
  name: "search_game_reference",
  deps: ["referenceStore", "resourceDefs"],
  run: (args, env) => searchGameReference(
    String(args.category ?? "") as "research" | "building" | "hostile" | "consumable" | "system",
    String(args.query ?? ""),
    args.limit == null ? 20 : Number(args.limit),
    env,
  ),
}));

toolRegistry.register(defineTool({
  name: "get_game_reference",
  deps: ["referenceStore", "resourceDefs"],
  run: (args, env) => getGameReference(
    String(args.category ?? "") as "research" | "building" | "hostile" | "consumable" | "system",
    String(args.id ?? ""),
    env,
  ),
}));

// ── Read tools: ops unlocks (ADR-044 #214) ──────────────────

toolRegistry.register(defineTool({
  name: "check_ops_unlocks",
  deps: ["referenceStore", "userSettingsStore"],
  run: (args, env) => checkOpsUnlocks(
    args.ops_level == null ? undefined : Number(args.ops_level),
    env,
  ),
}));

// ── Mutation tools: crew management (ADR-025) ───────────────

toolRegistry.register(defineTool({
  name: "create_bridge_core",
  deps: ["crewStore"],
  run: (args, env) => createBridgeCoreTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "create_loadout",
  deps: ["crewStore"],
  run: (args, env) => createLoadoutTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "activate_preset",
  deps: ["crewStore"],
  run: (args, env) => activatePresetTool(Number(args.preset_id), env),
}));

toolRegistry.register(defineTool({
  name: "set_reservation",
  deps: ["crewStore"],
  run: (args, env) => setReservationTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "create_variant",
  deps: ["crewStore"],
  run: (args, env) => createVariantTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "get_effective_state",
  deps: ["crewStore"],
  run: (_args, env) => getEffectiveStateTool(env),
}));

// ── Mutation tools: sync ────────────────────────────────────

toolRegistry.register(defineTool({
  name: "sync_overlay",
  deps: ["overlayStore", "referenceStore", "crewStore", "receiptStore"],
  run: (args, env) => syncOverlayTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "sync_research",
  deps: ["researchStore"],
  run: (args, env) => syncResearchTool(args, env),
}));

// ── Mutation tools: targets (#80) ───────────────────────────

toolRegistry.register(defineTool({
  name: "create_target",
  deps: ["targetStore"],
  run: (args, env) => createTargetTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "update_target",
  deps: ["targetStore"],
  run: (args, env) => updateTargetTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "complete_target",
  deps: ["targetStore"],
  run: (args, env) => completeTargetTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "record_target_delta",
  deps: ["targetStore"],
  run: (args, env) => recordTargetDeltaTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "record_reminder_feedback",
  deps: ["targetStore"],
  run: (args, env) => recordReminderFeedbackTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "record_goal_restatement",
  deps: ["targetStore"],
  run: (args, env) => recordGoalRestatementTool(args, env),
}));

// ── Mutation tools: overlays & inventory ────────────────────

toolRegistry.register(defineTool({
  name: "set_ship_overlay",
  deps: ["overlayStore"],
  run: (args, env) => setShipOverlayTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "set_officer_overlay",
  deps: ["overlayStore"],
  run: (args, env) => setOfficerOverlayTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "update_inventory",
  deps: ["inventoryStore"],
  run: (args, env) => updateInventoryTool(args, env),
}));

// ── Mutation tools: dock assignment ─────────────────────────

toolRegistry.register(defineTool({
  name: "assign_dock",
  deps: ["crewStore"],
  run: (args, env) => assignDockTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "update_dock",
  deps: ["crewStore"],
  run: (args, env) => updateDockTool(args, env),
}));

toolRegistry.register(defineTool({
  name: "remove_dock_assignment",
  deps: ["crewStore"],
  run: (args, env) => removeDockAssignmentTool(args, env),
}));
