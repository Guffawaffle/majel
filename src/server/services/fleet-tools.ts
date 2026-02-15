/**
 * fleet-tools.ts — Gemini Function Calling Tools (ADR-007 Phase C, ADR-010 Phase 6)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Defines fleet intelligence tools that Gemini can call during conversation.
 * Phase 1: read-only reference & fleet tools (safe, no confirmation needed).
 * Phase 2: drydock management tools — data gathering + analysis (#11).
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

  // ─── Phase 2: Drydock Management Tools (ADR-010 §6) ────────

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
      "Get full details for a specific loadout: ship, crew members (bridge + below deck), " +
      "intent keys, tags, notes. Call when examining a specific crew configuration.",
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
      "and existing loadouts for this ship. " +
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
      "active loadouts with crew, plan items, officer conflicts, and validation report. " +
      "Use your STFC knowledge to suggest fleet-wide improvements, " +
      "identify suboptimal crew choices, and recommend changes.",
    // No parameters — gathers everything
  },
  {
    name: "resolve_conflict",
    description:
      "Gather context to help resolve an officer conflict: the conflicting officer's full details, " +
      "all loadouts they appear in, and alternative officers from the same group or similar rarity. " +
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
      "Shows which loadouts lose a crew member and which plan items are affected. " +
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
    // Phase 2: Drydock management tools
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

// ─── Phase 2: Drydock Management Implementations ────────────

async function listOwnedOfficers(ctx: ToolContext): Promise<object> {
  if (!ctx.overlayStore) {
    return { error: "Overlay system not available. The Admiral may need to set up ownership data first." };
  }
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to import wiki data first." };
  }

  const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
  const officers = await Promise.all(
    overlays.map(async (overlay) => {
      const ref = await ctx.referenceStore!.getOfficer(overlay.refId);
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
    }),
  );

  const results = officers.filter(Boolean);
  return {
    officers: results,
    totalOwned: results.length,
  };
}

async function getLoadoutDetail(loadoutId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }
  if (!loadoutId || isNaN(loadoutId)) {
    return { error: "Valid loadout ID is required." };
  }

  const loadout = await ctx.loadoutStore.getLoadout(loadoutId);
  if (!loadout) {
    return { error: `Loadout not found: ${loadoutId}` };
  }

  return {
    id: loadout.id,
    name: loadout.name,
    shipId: loadout.shipId,
    shipName: loadout.shipName,
    priority: loadout.priority,
    isActive: loadout.isActive,
    intentKeys: loadout.intentKeys,
    tags: loadout.tags,
    notes: loadout.notes,
    members: loadout.members.map((m) => ({
      officerId: m.officerId,
      officerName: m.officerName,
      roleType: m.roleType,
      slot: m.slot,
    })),
  };
}

async function listPlanItems(ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  const items = await ctx.loadoutStore.listPlanItems();
  return {
    planItems: items.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      intentLabel: p.intentLabel,
      dockNumber: p.dockNumber,
      dockLabel: p.dockLabel,
      loadoutId: p.loadoutId,
      loadoutName: p.loadoutName,
      shipId: p.shipId,
      shipName: p.shipName,
      priority: p.priority,
      isActive: p.isActive,
      members: p.members.map((m) => ({
        officerId: m.officerId,
        officerName: m.officerName,
        roleType: m.roleType,
        slot: m.slot,
      })),
      awayMembers: p.awayMembers.map((a) => ({
        officerId: a.officerId,
        officerName: a.officerName,
      })),
    })),
    totalItems: items.length,
  };
}

async function listIntents(category: string | undefined, ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  const filters = category ? { category } : undefined;
  const intents = await ctx.loadoutStore.listIntents(filters);
  return {
    intents: intents.map((i) => ({
      key: i.key,
      label: i.label,
      category: i.category,
      description: i.description,
      icon: i.icon,
      isBuiltin: i.isBuiltin,
    })),
    totalIntents: intents.length,
  };
}

async function findLoadoutsForIntent(intentKey: string, ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.loadoutStore.findLoadoutsForIntent(intentKey);
  return {
    intentKey,
    loadouts: loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      shipName: l.shipName,
      isActive: l.isActive,
      members: l.members.map((m) => ({
        officerId: m.officerId,
        officerName: m.officerName,
        roleType: m.roleType,
        slot: m.slot,
      })),
    })),
    totalLoadouts: loadouts.length,
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
  if (intentKey && ctx.loadoutStore) {
    const intentData = await ctx.loadoutStore.getIntent(intentKey);
    if (intentData) {
      intent = {
        key: intentData.key,
        label: intentData.label,
        category: intentData.category,
        description: intentData.description,
      };
    }
  }

  // 3. Get all owned officers with abilities (the Admiral's available roster)
  const ownedOfficers: Array<Record<string, unknown>> = [];
  if (ctx.overlayStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const resolved = await Promise.all(
      overlays.map(async (overlay) => {
        const ref = await ctx.referenceStore!.getOfficer(overlay.refId);
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
      }),
    );
    ownedOfficers.push(...resolved.filter(Boolean) as Array<Record<string, unknown>>);
  }

  // 4. Get existing loadouts for this ship (show what's already configured)
  const existingLoadouts: Array<Record<string, unknown>> = [];
  if (ctx.loadoutStore) {
    const loadouts = await ctx.loadoutStore.listLoadouts({ shipId });
    existingLoadouts.push(
      ...loadouts.map((l) => ({
        id: l.id,
        name: l.name,
        isActive: l.isActive,
        intentKeys: l.intentKeys,
        members: l.members.map((m) => ({
          officerId: m.officerId,
          officerName: m.officerName,
          roleType: m.roleType,
          slot: m.slot,
        })),
      })),
    );
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
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }

  // Gather comprehensive fleet state in parallel
  const [docks, planItems, conflicts, validation, loadouts] = await Promise.all([
    ctx.loadoutStore.listDocks(),
    ctx.loadoutStore.listPlanItems(),
    ctx.loadoutStore.getOfficerConflicts(),
    ctx.loadoutStore.validatePlan(),
    ctx.loadoutStore.listLoadouts(),
  ]);

  return {
    docks: docks.map((d) => ({
      dockNumber: d.dockNumber,
      label: d.label,
      assignment: d.assignment
        ? {
            planItemId: d.assignment.id,
            loadoutName: d.assignment.loadoutName,
            shipName: d.assignment.shipName,
            intentKey: d.assignment.intentKey,
          }
        : null,
    })),
    loadouts: loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipName: l.shipName,
      isActive: l.isActive,
      intentKeys: l.intentKeys,
      memberCount: l.members.length,
      members: l.members.map((m) => ({
        officerName: m.officerName,
        roleType: m.roleType,
        slot: m.slot,
      })),
    })),
    planItems: planItems.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutName: p.loadoutName,
      shipName: p.shipName,
      isActive: p.isActive,
    })),
    conflicts: conflicts.map((c) => ({
      officerName: c.officerName,
      appearances: c.appearances.length,
      locations: c.appearances.map((a) => a.loadoutName ?? a.planItemLabel),
    })),
    validation: {
      valid: validation.valid,
      dockConflicts: validation.dockConflicts.length,
      officerConflicts: validation.officerConflicts.length,
      warnings: validation.warnings,
    },
    totalDocks: docks.length,
    totalLoadouts: loadouts.length,
    totalPlanItems: planItems.length,
    totalConflicts: conflicts.length,
  };
}

async function resolveConflict(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  // 1. Get the conflicting officer's details
  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  // 2. Get their conflicts
  const allConflicts = await ctx.loadoutStore.getOfficerConflicts();
  const conflict = allConflicts.find((c) => c.officerId === officerId) ?? null;

  // 3. Find alternative officers from the same group or similar rarity
  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.referenceStore.listOfficers({ groupName: officer.groupName });
    for (const alt of groupOfficers) {
      if (alt.id === officerId) continue;
      // Check if owned
      let owned = false;
      if (ctx.overlayStore) {
        const overlay = await ctx.overlayStore.getOfficerOverlay(alt.id);
        owned = overlay?.ownershipState === "owned";
      }
      alternatives.push({
        id: alt.id,
        name: alt.name,
        rarity: alt.rarity,
        group: alt.groupName,
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned,
      });
    }
  }

  // 4. Get cascade preview (what breaks if this officer is removed)
  const preview = await ctx.loadoutStore.previewDeleteOfficer(officerId);

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
          appearances: conflict.appearances.map((a) => ({
            planItemLabel: a.planItemLabel,
            intentKey: a.intentKey,
            dockNumber: a.dockNumber,
            source: a.source,
            loadoutName: a.loadoutName,
          })),
        }
      : null,
    alternatives,
    cascadePreview: {
      loadoutMemberships: preview.loadoutMemberships,
      awayMemberships: preview.awayMemberships,
    },
  };
}

async function whatIfRemoveOfficer(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.loadoutStore) {
    return { error: "Loadout system not available." };
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

  const preview = await ctx.loadoutStore.previewDeleteOfficer(officerId);

  return {
    officerId,
    officerName,
    loadoutMemberships: preview.loadoutMemberships.map((l) => ({
      loadoutId: l.loadoutId,
      loadoutName: l.loadoutName,
      shipName: l.shipName,
    })),
    awayMemberships: preview.awayMemberships.map((a) => ({
      planItemId: a.planItemId,
      planItemLabel: a.planItemLabel,
    })),
    totalAffectedLoadouts: preview.loadoutMemberships.length,
    totalAffectedAwayTeams: preview.awayMemberships.length,
    totalAffected: preview.loadoutMemberships.length + preview.awayMemberships.length,
  };
}
