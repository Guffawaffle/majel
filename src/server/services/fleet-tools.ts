/**
 * fleet-tools.ts — Gemini Function Calling Tools (ADR-007 Phase C)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Defines fleet intelligence tools that Gemini can call during conversation.
 * Phase 1: read-only tools (safe, no confirmation needed).
 * Phase 2 (future): mutation tools with confirmation flow.
 *
 * Architecture:
 * - Tool declarations follow the OpenAPI 3.0 schema format required by Gemini
 * - executeFleetTool() dispatches calls to the appropriate store method
 * - ToolContext holds store references injected at engine creation time
 */

import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import { log } from "../logger.js";

import type { ReferenceStore } from "../stores/reference-store.js";
import type { OverlayStore } from "../stores/overlay-store.js";
import type { LoadoutStore } from "../stores/loadout-store.js";

// ─── Tool Context ───────────────────────────────────────────

/**
 * Stores required by fleet tools. Injected at engine creation time.
 * All fields are optional — tools gracefully degrade when stores are unavailable.
 */
export interface ToolContext {
  referenceStore?: ReferenceStore | null;
  overlayStore?: OverlayStore | null;
  loadoutStore?: LoadoutStore | null;
}

// ─── Tool Declarations ──────────────────────────────────────

/**
 * Phase 1 read-only tools. Safe to call without confirmation.
 *
 * Tool naming: snake_case, verb_noun pattern, max 64 chars.
 * Descriptions guide the model on WHEN to call each tool.
 */
export const FLEET_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_fleet_overview",
    description:
      "Get a high-level summary of the Admiral's fleet state: " +
      "counts of officers, ships, overlays (owned/targeted), loadouts, and docks. " +
      "Call this when the Admiral asks about their fleet size, status, or general overview.",
    // No parameters
  },
  {
    name: "search_officers",
    description:
      "Search for officers by name (partial match, case-insensitive). " +
      "Call this when the Admiral asks about a specific officer or wants to find officers matching a name.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Officer name or partial name to search for (e.g. 'Kirk', 'Spock', 'SNW')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_ships",
    description:
      "Search for ships by name (partial match, case-insensitive). " +
      "Call this when the Admiral asks about a specific ship or wants to find ships matching a name.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Ship name or partial name to search for (e.g. 'Enterprise', 'Kumari', 'Voyager')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_officer_detail",
    description:
      "Get full details for a specific officer: reference data (abilities, rarity, group) " +
      "merged with the Admiral's overlay (ownership, level, rank, targeting). " +
      "Call this when the Admiral asks for detailed info about a particular officer they've already identified.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        officer_id: {
          type: SchemaType.STRING,
          description: "The officer's reference ID (from search results or prior context)",
        },
      },
      required: ["officer_id"],
    },
  },
  {
    name: "get_ship_detail",
    description:
      "Get full details for a specific ship: reference data (class, grade, faction, rarity) " +
      "merged with the Admiral's overlay (ownership, tier, level, targeting). " +
      "Call this when the Admiral asks for detailed info about a particular ship they've already identified.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ship_id: {
          type: SchemaType.STRING,
          description: "The ship's reference ID (from search results or prior context)",
        },
      },
      required: ["ship_id"],
    },
  },
  {
    name: "list_docks",
    description:
      "List all drydock assignments with their active loadouts. " +
      "Call this when the Admiral asks about their dock configuration, what's in each dock, " +
      "or which ships are currently assigned to docks.",
    // No parameters
  },
  {
    name: "get_officer_conflicts",
    description:
      "Find officers assigned to multiple active loadouts simultaneously — " +
      "a scheduling conflict that means they can only serve one crew at a time. " +
      "Call this when the Admiral asks about crew conflicts, double-booked officers, " +
      "or wants to validate their fleet plan.",
    // No parameters
  },
  {
    name: "validate_plan",
    description:
      "Run full plan validation: checks dock assignments, officer conflicts, " +
      "empty loadouts, and other fleet plan issues. Returns a structured validation report. " +
      "Call this when the Admiral asks to validate their plan, check for problems, " +
      "or wants an overall health check of their fleet setup.",
    // No parameters
  },
];

// ─── Tool Executor ──────────────────────────────────────────

/** Maximum results for search tools to avoid overwhelming the model context. */
const SEARCH_LIMIT = 20;

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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Tool Implementations ───────────────────────────────────

async function getFleetOverview(ctx: ToolContext): Promise<object> {
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

  if (ctx.loadoutStore) {
    const loadoutCounts = await ctx.loadoutStore.counts();
    overview.loadouts = {
      total: loadoutCounts.loadouts,
      docks: loadoutCounts.docks,
      planItems: loadoutCounts.planItems,
      intents: loadoutCounts.intents,
    };
  }

  return overview;
}

async function searchOfficers(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to import wiki data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const officers = await ctx.referenceStore.searchOfficers(query);
  const results = officers.slice(0, SEARCH_LIMIT).map((o) => ({
    id: o.id,
    name: o.name,
    rarity: o.rarity,
    group: o.groupName,
    captainManeuver: o.captainManeuver,
    officerAbility: o.officerAbility,
  }));

  return {
    results,
    totalFound: officers.length,
    truncated: officers.length > SEARCH_LIMIT,
  };
}

async function searchShips(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to import wiki data first." };
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
  }));

  return {
    results,
    totalFound: ships.length,
    truncated: ships.length > SEARCH_LIMIT,
  };
}

async function getOfficerDetail(officerId: string, ctx: ToolContext): Promise<object> {
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
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
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

async function getShipDetail(shipId: string, ctx: ToolContext): Promise<object> {
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

async function listDocks(ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  const docks = await ctx.loadoutStore.listDocks();
  const results = docks.map((d) => ({
    dockNumber: d.dockNumber,
    label: d.label,
    notes: d.notes,
    assignment: d.assignment
      ? {
          planItemId: d.assignment.id,
          intentKey: d.assignment.intentKey,
          label: d.assignment.label,
          loadoutId: d.assignment.loadoutId,
          loadoutName: d.assignment.loadoutName,
          shipName: d.assignment.shipName,
          isActive: d.assignment.isActive,
        }
      : null,
  }));

  return { docks: results };
}

async function getOfficerConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  const conflicts = await ctx.loadoutStore.getOfficerConflicts();
  return {
    conflicts: conflicts.map((c) => ({
      officerId: c.officerId,
      officerName: c.officerName,
      appearances: c.appearances.map((a) => ({
        planItemId: a.planItemId,
        planItemLabel: a.planItemLabel,
        intentKey: a.intentKey,
        dockNumber: a.dockNumber,
        source: a.source,
        loadoutName: a.loadoutName,
      })),
    })),
    totalConflicts: conflicts.length,
  };
}

async function validatePlan(ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  const validation = await ctx.loadoutStore.validatePlan();
  return {
    valid: validation.valid,
    dockConflicts: validation.dockConflicts,
    officerConflicts: validation.officerConflicts.map((c) => ({
      officerId: c.officerId,
      officerName: c.officerName,
      appearances: c.appearances.length,
    })),
    unassignedLoadouts: validation.unassignedLoadouts,
    unassignedDocks: validation.unassignedDocks,
    warnings: validation.warnings,
  };
}
