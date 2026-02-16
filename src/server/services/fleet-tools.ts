/**
 * fleet-tools.ts — Gemini Function Calling Tools (ADR-007 Phase C, ADR-025)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Defines fleet intelligence tools that Gemini can call during conversation.
 * Phase 1: read-only reference & fleet tools (safe, no confirmation needed).
 * Phase 2: crew composition tools — data gathering + analysis (#11).
 * Phase 3 (future): mutation tools with confirmation flow.
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
import type { CrewStore } from "../stores/crew-store.js";
import type { TargetStore } from "../stores/target-store.js";
import { detectTargetConflicts } from "./target-conflicts.js";
import { SEED_INTENTS, type SeedIntent, type BridgeSlot, type VariantPatch } from "../types/crew-types.js";

// ─── Tool Context ───────────────────────────────────────────

/**
 * Stores required by fleet tools. Injected at engine creation time.
 * All fields are optional — tools gracefully degrade when stores are unavailable.
 */
export interface ToolContext {
  referenceStore?: ReferenceStore | null;
  overlayStore?: OverlayStore | null;
  crewStore?: CrewStore | null;
  targetStore?: TargetStore | null;
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
      "counts of officers, ships, overlays (owned/targeted), bridge cores, loadouts, docks, " +
      "fleet presets (active preset name), and reservations. " +
      "Call this when the Admiral asks about their fleet size, status, or general overview.",
    // No parameters
  },
  {
    name: "search_officers",
    description:
      "Search for officers by name (partial match, case-insensitive). " +
      "Returns matching officers with reservation status (if reserved/locked). " +
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
      "List all drydock assignments showing the effective state from getEffectiveDockState(). " +
      "Shows resolved loadouts with BridgeCore members, BelowDeckPolicy, variant patches, " +
      "and source (preset vs manual). " +
      "Call this when the Admiral asks about their dock configuration, what's in each dock, " +
      "or which ships are currently assigned to docks.",
    // No parameters
  },
  {
    name: "get_officer_conflicts",
    description:
      "Find officers assigned to multiple active loadouts simultaneously — " +
      "a scheduling conflict that means they can only serve one crew at a time. " +
      "Uses the new plan_items schema for conflict detection. " +
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

  // ─── Phase 2: Crew Composition Tools (ADR-025) ─────────

  // Data gathering tools — provide model with structured fleet intelligence

  {
    name: "list_owned_officers",
    description:
      "List all officers the Admiral owns, with abilities and overlay data (level, rank, power). " +
      "Call this when suggesting crews, analyzing fleet composition, or checking available officers. " +
      "Returns merged reference + overlay data for each owned officer.",
    // No parameters
  },
  {
    name: "get_loadout_detail",
    description:
      "Get full details for a specific loadout: ship, resolved BridgeCore (captain + bridge officers), " +
      "BelowDeckPolicy (mode + spec), intent keys, tags, notes, and available variants. " +
      "Call when examining a specific crew configuration.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        loadout_id: {
          type: SchemaType.INTEGER,
          description: "Loadout ID to get details for",
        },
      },
      required: ["loadout_id"],
    },
  },
  {
    name: "list_plan_items",
    description:
      "List all plan items (active objectives) with full context: assigned loadout, dock, " +
      "intent, crew members, away team members. " +
      "Call when analyzing the fleet plan or checking dock assignments.",
    // No parameters — returns all plan items with context
  },
  {
    name: "list_intents",
    description:
      "List available activity intents from the intent catalog. " +
      "Intents categorize what a loadout is built for: mining, combat, utility, or custom. " +
      "Call when the Admiral asks about available activities or when suggesting loadout purposes.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        category: {
          type: SchemaType.STRING,
          description: "Filter by category: mining, combat, utility, or custom. Omit for all categories.",
        },
      },
    },
  },
  {
    name: "find_loadouts_for_intent",
    description:
      "Find all loadouts tagged for a specific activity intent (e.g. 'pvp', 'mining-lat', 'grinding'). " +
      "Returns loadouts with full crew details. " +
      "Call when the Admiral asks what crews they have for a specific activity.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        intent_key: {
          type: SchemaType.STRING,
          description: "Intent key to search for (e.g. 'pvp', 'grinding', 'mining-lat')",
        },
      },
      required: ["intent_key"],
    },
  },

  // Analysis tools — gather comprehensive context for model-assisted reasoning

  {
    name: "suggest_crew",
    description:
      "Gather all context needed to suggest an optimal crew for a ship and activity. " +
      "Returns: ship details, intent info, all owned officers with abilities, " +
      "existing loadouts for this ship, and officer reservations (locked officers are unavailable). " +
      "Can suggest BridgeCore creation, BelowDeckPolicy selection, and variant creation. " +
      "Use your STFC knowledge to recommend the best captain + bridge + below-deck officers " +
      "from the Admiral's available roster.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ship_id: {
          type: SchemaType.STRING,
          description: "Ship reference ID to build a crew for",
        },
        intent_key: {
          type: SchemaType.STRING,
          description: "Activity intent key (e.g. 'pvp', 'grinding', 'mining-lat'). Optional — helps narrow recommendations.",
        },
      },
      required: ["ship_id"],
    },
  },
  {
    name: "analyze_fleet",
    description:
      "Gather comprehensive fleet state for optimization analysis: all docks with assignments, " +
      "active loadouts with crew, plan items, officer conflicts, fleet presets, " +
      "variants, reservations, and validation report. " +
      "Aware of presets (active preset name), variants (dock-level patches), and reservations. " +
      "Use your STFC knowledge to suggest fleet-wide improvements, " +
      "identify suboptimal crew choices, and recommend changes.",
    // No parameters — gathers everything
  },
  {
    name: "resolve_conflict",
    description:
      "Gather context to help resolve an officer conflict: the conflicting officer's full details, " +
      "all loadouts they appear in, alternative officers from the same group or similar rarity, " +
      "and reservation status (locked officers cannot be reassigned). " +
      "Handles reservation conflicts — hard-locked officers are flagged. " +
      "Use your STFC knowledge to suggest which loadout should keep this officer " +
      "and which substitutes work best for the others.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        officer_id: {
          type: SchemaType.STRING,
          description: "The conflicting officer's reference ID",
        },
      },
      required: ["officer_id"],
    },
  },
  {
    name: "what_if_remove_officer",
    description:
      "Preview cascade effects of removing an officer from all loadouts and away teams. " +
      "Shows which BridgeCores lose a member, which loadouts are affected, " +
      "and which variant bridge patches reference this officer. " +
      "Call when the Admiral considers reassigning an officer or wants to understand dependencies.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        officer_id: {
          type: SchemaType.STRING,
          description: "Officer reference ID to preview removal for",
        },
      },
      required: ["officer_id"],
    },
  },

  // ─── Target/Goal Tracking Tools (#17) ─────────────────────

  {
    name: "list_targets",
    description:
      "List the Admiral's active targets/goals: officers to acquire, ships to build, " +
      "crews to assemble. Includes priority, status, and reason for each target. " +
      "Call when the Admiral asks about their goals, priorities, or what to work toward.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        target_type: {
          type: SchemaType.STRING,
          description: "Filter by type: officer, ship, or crew. Omit for all types.",
        },
        status: {
          type: SchemaType.STRING,
          description: "Filter by status: active, achieved, or abandoned. Default: active.",
        },
      },
    },
  },
  {
    name: "suggest_targets",
    description:
      "Gather comprehensive fleet state to suggest new acquisition and progression targets. " +
      "Returns: fleet overview, owned officers/ships with levels, current loadouts, " +
      "existing targets, and active conflicts. " +
      "Use your STFC knowledge to identify gaps, recommend acquisitions, " +
      "suggest upgrades with high ROI, and propose meta crew compositions the Admiral is missing.",
    // No parameters — gathers everything needed for analysis
  },

  // ─── Resource Conflict Detection (#18) ─────────────────────

  {
    name: "detect_target_conflicts",
    description:
      "Detect resource conflicts across the Admiral's active targets. " +
      "Finds: officer contention (same officer in multiple crew targets), " +
      "dock slot contention (same dock needed by multiple targets), " +
      "cascade effects (officer upgrades affecting multiple loadouts). " +
      "Each conflict includes severity (blocking/competing/informational) and suggestions. " +
      "Call when the Admiral asks about conflicts, bottlenecks, or resource competition.",
    // No parameters — analyzes all active targets automatically
  },

  // ─── ADR-025 Mutation Tools (Phase 3) ─────────────────────

  {
    name: "create_bridge_core",
    description:
      "Create a new BridgeCore — a named trio of captain + bridge_1 + bridge_2 officers. " +
      "BridgeCores are reusable across loadouts. " +
      "Call when the Admiral asks to create a crew trio or save a bridge crew configuration.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Name for the bridge core (e.g. 'SNW Exploration Trio', 'PvP Kirk Crew')",
        },
        captain: {
          type: SchemaType.STRING,
          description: "Officer reference ID for the captain slot",
        },
        bridge_1: {
          type: SchemaType.STRING,
          description: "Officer reference ID for bridge slot 1",
        },
        bridge_2: {
          type: SchemaType.STRING,
          description: "Officer reference ID for bridge slot 2",
        },
        notes: {
          type: SchemaType.STRING,
          description: "Optional notes about this bridge core",
        },
      },
      required: ["name", "captain", "bridge_1", "bridge_2"],
    },
  },
  {
    name: "create_loadout",
    description:
      "Create a new loadout — a named ship+crew configuration that can be assigned to a dock. " +
      "A loadout links a ship to a BridgeCore and optionally a BelowDeckPolicy. " +
      "Call when the Admiral asks to save a crew configuration for a ship.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ship_id: {
          type: SchemaType.STRING,
          description: "Ship reference ID for this loadout",
        },
        name: {
          type: SchemaType.STRING,
          description: "Name for the loadout (e.g. 'Kumari Mining', 'Enterprise PvP')",
        },
        bridge_core_id: {
          type: SchemaType.INTEGER,
          description: "BridgeCore ID to assign (from list_bridge_cores or create_bridge_core)",
        },
        below_deck_policy_id: {
          type: SchemaType.INTEGER,
          description: "BelowDeckPolicy ID to assign (optional)",
        },
        intent_keys: {
          type: SchemaType.STRING,
          description: "Comma-separated intent keys (e.g. 'mining-lat,mining-gas')",
        },
        notes: {
          type: SchemaType.STRING,
          description: "Optional notes about this loadout",
        },
      },
      required: ["ship_id", "name"],
    },
  },
  {
    name: "activate_preset",
    description:
      "Look up a fleet preset and return a guided action for the Admiral to activate it in the UI. " +
      "This is a fleet-wide change (deactivates all other presets), so Aria provides instructions " +
      "rather than executing directly. Tell the Admiral to use Fleet Ops → Presets tab to activate.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        preset_id: {
          type: SchemaType.INTEGER,
          description: "Fleet preset ID to look up",
        },
      },
      required: ["preset_id"],
    },
  },
  {
    name: "set_reservation",
    description:
      "Set or clear an officer reservation. Reserved officers are flagged in crew suggestions. " +
      "Locked reservations (hard lock) prevent the officer from being auto-assigned by the solver. " +
      "Soft reservations generate warnings but don't block assignment. " +
      "Call when the Admiral wants to reserve an officer for a specific purpose or release a reservation.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        officer_id: {
          type: SchemaType.STRING,
          description: "Officer reference ID to reserve/unreserve",
        },
        reserved_for: {
          type: SchemaType.STRING,
          description: "What the officer is reserved for (e.g. 'PvP Enterprise crew', 'Borg armada'). Set to empty to clear.",
        },
        locked: {
          type: SchemaType.STRING,
          description: "Whether this is a hard lock ('true') or soft reservation ('false'). Default: false.",
        },
        notes: {
          type: SchemaType.STRING,
          description: "Optional notes about this reservation",
        },
      },
      required: ["officer_id", "reserved_for"],
    },
  },
  {
    name: "create_variant",
    description:
      "Create a variant on an existing loadout — a named patch that swaps bridge officers, " +
      "changes below-deck policy, or adjusts intent keys without modifying the base loadout. " +
      "Variants allow 'Swarm Swap' or 'PvP Bridge Swap' configurations that share the same base ship. " +
      "Call when the Admiral wants a variant crew for an existing loadout.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        loadout_id: {
          type: SchemaType.INTEGER,
          description: "Base loadout ID to create a variant for",
        },
        name: {
          type: SchemaType.STRING,
          description: "Name for the variant (e.g. 'Swarm Swap', 'PvP Bridge')",
        },
        captain: {
          type: SchemaType.STRING,
          description: "Replacement captain officer ID (optional — omit to keep base captain)",
        },
        bridge_1: {
          type: SchemaType.STRING,
          description: "Replacement bridge_1 officer ID (optional — omit to keep base)",
        },
        bridge_2: {
          type: SchemaType.STRING,
          description: "Replacement bridge_2 officer ID (optional — omit to keep base)",
        },
        notes: {
          type: SchemaType.STRING,
          description: "Optional notes about this variant",
        },
      },
      required: ["loadout_id", "name"],
    },
  },
  {
    name: "get_effective_state",
    description:
      "Get the fully resolved dock state — the single source of truth for what's in each dock. " +
      "Shows resolved loadouts with BridgeCore names, BelowDeckPolicy modes, variant patches, " +
      "away teams, officer conflicts, and source attribution (preset vs manual). " +
      "Call when the Admiral asks about the current fleet state, what's running, or dock assignments.",
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

async function searchOfficers(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to import wiki data first." };
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
      captainManeuver: o.captainManeuver,
      officerAbility: o.officerAbility,
      ...(res ? { reservation: { reservedFor: res.reservedFor, locked: res.locked } } : {}),
    };
  });

  return {
    results,
    totalFound: officers.length,
    truncated: officers.length > SEARCH_LIMIT,
  };
}

async function searchShips(query: string, ctx: ToolContext): Promise<object> {
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

async function getOfficerConflicts(ctx: ToolContext): Promise<object> {
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

async function validatePlan(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  // Use effective dock state as the validation source (ADR-025)
  const state = await ctx.crewStore.getEffectiveDockState();
  const planItems = await ctx.crewStore.listPlanItems({ active: true });

  // Derive validation from effective state
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

async function listOwnedOfficers(ctx: ToolContext): Promise<object> {
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

async function getLoadoutDetail(loadoutId: number, ctx: ToolContext): Promise<object> {
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

  // Fetch variants for this loadout
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

async function listPlanItems(ctx: ToolContext): Promise<object> {
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

async function listIntents(category: string | undefined, _ctx: ToolContext): Promise<object> {
  // Intent catalog is a static seed set in ADR-025
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

async function findLoadoutsForIntent(intentKey: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.crewStore.listLoadouts({ intentKey });
  // Resolve full details for each loadout
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

async function suggestCrew(
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

  // 1. Get ship details
  const ship = await ctx.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  // 2. Get intent details if provided
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

  // 3. Get all owned officers with abilities (batch — avoids N+1)
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
        captainManeuver: ref.captainManeuver,
        officerAbility: ref.officerAbility,
        belowDeckAbility: ref.belowDeckAbility,
        level: overlay.level,
        rank: overlay.rank,
      });
    }
  }

  // 4. Get existing loadouts for this ship (batch fetch)
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

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
    },
    intent,
    ownedOfficers,
    existingLoadouts,
    totalOwnedOfficers: ownedOfficers.length,
  };
}

async function analyzeFleet(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  // Gather comprehensive fleet state in parallel
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

async function resolveConflict(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  // 1. Get the conflicting officer's details
  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  // 1b. Check reservation status
  const reservation = await ctx.crewStore.getReservation(officerId);

  // 2. Get their conflicts from effective state
  const state = await ctx.crewStore.getEffectiveDockState();
  const conflict = state.conflicts.find((c) => c.officerId === officerId) ?? null;

  // 3. Find alternative officers from the same group or similar rarity
  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.referenceStore.listOfficers({ groupName: officer.groupName });
    // Batch-fetch overlays for all group officers
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
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned: overlayMap.get(alt.id) ?? false,
      });
    }
  }

  // 4. Get loadouts that use this officer (batch fetch via getLoadoutsByIds)
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

async function whatIfRemoveOfficer(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  // Get officer name for context
  let officerName: string | null = null;
  if (ctx.referenceStore) {
    const officer = await ctx.referenceStore.getOfficer(officerId);
    officerName = officer?.name ?? null;
  }

  // Find all loadouts containing this officer via bridge core (batch fetch)
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

  // Find plan items with this officer in away teams
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

async function listTargets(
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
  else filters.status = "active"; // Default to active targets

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

async function suggestTargets(ctx: ToolContext): Promise<object> {
  const result: Record<string, unknown> = {};

  // 1. Fleet overview
  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    result.catalogSize = { officers: refCounts.officers, ships: refCounts.ships };
  }

  // 2. Owned officers with abilities (batch fetch)
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
          captainManeuver: ref.captainManeuver,
          officerAbility: ref.officerAbility,
          belowDeckAbility: ref.belowDeckAbility,
          level: overlay.level,
          rank: overlay.rank,
        };
      })
      .filter(Boolean);
  }

  // 3. Owned ships with tiers (batch fetch)
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
          tier: overlay.tier ?? ref.tier,
          level: overlay.level,
        };
      })
      .filter(Boolean);
  }

  // 4. Current loadouts summary
  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts();
    result.loadouts = loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      intentKeys: l.intentKeys,
    }));
  }

  // 5. Existing targets
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

  // 6. Officer conflicts
  if (ctx.crewStore) {
    const state = await ctx.crewStore.getEffectiveDockState();
    result.officerConflicts = state.conflicts.map((c) => ({
      officerId: c.officerId,
      locationCount: c.locations.length,
    }));
  }

  // 7. Targeted but not yet structured (overlay targets without structured goals)
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

async function detectConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const conflicts = await detectTargetConflicts(ctx.targetStore, ctx.crewStore);

  // Group by type for readability
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

// ─── ADR-025 Mutation Tool Implementations ──────────────────

async function createBridgeCoreTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const name = String(args.name ?? "").trim();
  const captain = String(args.captain ?? "").trim();
  const bridge1 = String(args.bridge_1 ?? "").trim();
  const bridge2 = String(args.bridge_2 ?? "").trim();
  const notes = args.notes ? String(args.notes).trim() : undefined;

  if (!name) return { error: "Name is required." };
  if (!captain || !bridge1 || !bridge2) return { error: "All three bridge slots are required: captain, bridge_1, bridge_2." };

  const members: Array<{ officerId: string; slot: BridgeSlot }> = [
    { officerId: captain, slot: "captain" },
    { officerId: bridge1, slot: "bridge_1" },
    { officerId: bridge2, slot: "bridge_2" },
  ];

  const core = await ctx.crewStore.createBridgeCore(name, members, notes);
  return {
    created: true,
    bridgeCore: {
      id: core.id,
      name: core.name,
      members: core.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
    },
  };
}

async function createLoadoutTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const shipId = String(args.ship_id ?? "").trim();
  const name = String(args.name ?? "").trim();
  if (!shipId) return { error: "Ship ID is required." };
  if (!name) return { error: "Name is required." };

  const fields: {
    shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
    intentKeys?: string[]; notes?: string;
  } = { shipId, name };

  if (args.bridge_core_id != null) fields.bridgeCoreId = Number(args.bridge_core_id);
  if (args.below_deck_policy_id != null) fields.belowDeckPolicyId = Number(args.below_deck_policy_id);
  if (args.intent_keys) fields.intentKeys = String(args.intent_keys).split(",").map((k) => k.trim()).filter(Boolean);
  if (args.notes) fields.notes = String(args.notes).trim();

  const loadout = await ctx.crewStore.createLoadout(fields);
  return {
    created: true,
    loadout: {
      id: loadout.id,
      name: loadout.name,
      shipId: loadout.shipId,
    },
  };
}

async function activatePresetTool(presetId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!presetId || isNaN(presetId)) {
    return { error: "Valid preset ID is required." };
  }

  const preset = await ctx.crewStore.getFleetPreset(presetId);
  if (!preset) {
    return { error: `Fleet preset not found: ${presetId}` };
  }

  // Return a guided action instead of executing directly.
  // Fleet-wide mutations require explicit user confirmation in the UI.
  return {
    guidedAction: true,
    actionType: "activate_preset",
    presetId: preset.id,
    presetName: preset.name,
    slotCount: preset.slots.length,
    message: `To activate the "${preset.name}" preset (${preset.slots.length} slots), use the Fleet Ops view → Presets tab → click "Activate" on this preset. This is a fleet-wide change that deactivates all other presets.`,
    uiPath: "/app#fleet-ops/presets",
  };
}

async function setReservationTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const officerId = String(args.officer_id ?? "").trim();
  const reservedFor = String(args.reserved_for ?? "").trim();
  if (!officerId) return { error: "Officer ID is required." };

  // Clear reservation if reservedFor is empty
  if (!reservedFor) {
    const deleted = await ctx.crewStore.deleteReservation(officerId);
    return {
      cleared: true,
      officerId,
      existed: deleted,
    };
  }

  const locked = String(args.locked ?? "false").toLowerCase() === "true";
  const notes = args.notes ? String(args.notes).trim() : undefined;

  const reservation = await ctx.crewStore.setReservation(officerId, reservedFor, locked, notes);
  return {
    set: true,
    reservation: {
      officerId: reservation.officerId,
      reservedFor: reservation.reservedFor,
      locked: reservation.locked,
    },
  };
}

async function createVariantTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const loadoutId = Number(args.loadout_id);
  const name = String(args.name ?? "").trim();
  if (!loadoutId || isNaN(loadoutId)) return { error: "Valid loadout ID is required." };
  if (!name) return { error: "Name is required." };

  // Build variant patch from optional bridge overrides
  const patch: VariantPatch = {};
  const bridgeOverrides: Partial<Record<BridgeSlot, string>> = {};
  if (args.captain) bridgeOverrides.captain = String(args.captain).trim();
  if (args.bridge_1) bridgeOverrides.bridge_1 = String(args.bridge_1).trim();
  if (args.bridge_2) bridgeOverrides.bridge_2 = String(args.bridge_2).trim();
  if (Object.keys(bridgeOverrides).length > 0) patch.bridge = bridgeOverrides;

  const notes = args.notes ? String(args.notes).trim() : undefined;

  const variant = await ctx.crewStore.createVariant(loadoutId, name, patch, notes);
  return {
    created: true,
    variant: {
      id: variant.id,
      baseLoadoutId: variant.baseLoadoutId,
      name: variant.name,
      patch: variant.patch,
    },
  };
}

async function getEffectiveStateTool(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const [state, presets] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listFleetPresets(),
  ]);

  const activePreset = presets.find((p) => p.isActive);

  return {
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
    docks: state.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      loadout: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            name: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    awayTeams: state.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
    totalDocks: state.docks.length,
    totalConflicts: state.conflicts.length,
  };
}
