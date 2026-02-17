/**
 * fleet-tools/index.ts — Barrel & Dispatcher
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Re-exports public API (ToolContext, FLEET_TOOL_DECLARATIONS, executeFleetTool).
 * Contains the dispatcher that routes tool calls to read or mutation implementations.
 */

import { log } from "../../logger.js";
import type { ToolContext } from "./declarations.js";

// Re-export public surface
export { FLEET_TOOL_DECLARATIONS, type ToolContext } from "./declarations.js";

// ─── Read tool implementations ──────────────────────────────
import {
  getFleetOverview,
  searchOfficers,
  searchShips,
  getOfficerDetail,
  getShipDetail,
  listDocks,
  getOfficerConflicts,
  validatePlan,
  listOwnedOfficers,
  getLoadoutDetail,
  listPlanItems,
  listIntents,
  findLoadoutsForIntent,
  suggestCrew,
  analyzeFleet,
  resolveConflict,
  whatIfRemoveOfficer,
  listTargets,
  suggestTargets,
  detectConflicts,
} from "./read-tools.js";

// ─── Mutation tool implementations ──────────────────────────
import {
  createBridgeCoreTool,
  createLoadoutTool,
  activatePresetTool,
  setReservationTool,
  createVariantTool,
  getEffectiveStateTool,
  createTargetTool,
  updateTargetTool,
  completeTargetTool,
} from "./mutate-tools.js";

// ─── Dispatcher ─────────────────────────────────────────────

/**
 * Execute a fleet tool by name with the given arguments.
 *
 * Returns a plain object suitable for FunctionResponse.response.
 * Errors are caught and returned as { error: string } — never thrown —
 * so the model can gracefully inform the Admiral.
 */
export async function executeFleetTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  const startTime = Date.now();

  try {
    const result = await dispatchTool(name, args, ctx);
    const durationMs = Date.now() - startTime;
    log.gemini.debug({ tool: name, durationMs }, "tool:execute");
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log.gemini.warn({ tool: name, durationMs, err: message }, "tool:error");
    return { error: `Tool execution failed: ${message}` };
  }
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  switch (name) {
    case "get_fleet_overview":
      return getFleetOverview(ctx);
    case "search_officers":
      return searchOfficers(String(args.query ?? ""), ctx);
    case "search_ships":
      return searchShips(String(args.query ?? ""), ctx);
    case "get_officer_detail":
      return getOfficerDetail(String(args.officer_id ?? ""), ctx);
    case "get_ship_detail":
      return getShipDetail(String(args.ship_id ?? ""), ctx);
    case "list_docks":
      return listDocks(ctx);
    case "get_officer_conflicts":
      return getOfficerConflicts(ctx);
    case "validate_plan":
      return validatePlan(ctx);
    // Phase 2: Crew composition tools
    case "list_owned_officers":
      return listOwnedOfficers(ctx);
    case "get_loadout_detail":
      return getLoadoutDetail(Number(args.loadout_id), ctx);
    case "list_plan_items":
      return listPlanItems(ctx);
    case "list_intents":
      return listIntents(args.category as string | undefined, ctx);
    case "find_loadouts_for_intent":
      return findLoadoutsForIntent(String(args.intent_key ?? ""), ctx);
    case "suggest_crew":
      return suggestCrew(String(args.ship_id ?? ""), args.intent_key as string | undefined, ctx);
    case "analyze_fleet":
      return analyzeFleet(ctx);
    case "resolve_conflict":
      return resolveConflict(String(args.officer_id ?? ""), ctx);
    case "what_if_remove_officer":
      return whatIfRemoveOfficer(String(args.officer_id ?? ""), ctx);
    // Target/goal tracking tools
    case "list_targets":
      return listTargets(args.target_type as string | undefined, args.status as string | undefined, ctx);
    case "suggest_targets":
      return suggestTargets(ctx);
    case "detect_target_conflicts":
      return detectConflicts(ctx);
    // Target mutation tools (#80)
    case "create_target":
      return createTargetTool(args, ctx);
    case "update_target":
      return updateTargetTool(args, ctx);
    case "complete_target":
      return completeTargetTool(args, ctx);
    // ADR-025 mutation tools
    case "create_bridge_core":
      return createBridgeCoreTool(args, ctx);
    case "create_loadout":
      return createLoadoutTool(args, ctx);
    case "activate_preset":
      return activatePresetTool(Number(args.preset_id), ctx);
    case "set_reservation":
      return setReservationTool(args, ctx);
    case "create_variant":
      return createVariantTool(args, ctx);
    case "get_effective_state":
      return getEffectiveStateTool(ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
