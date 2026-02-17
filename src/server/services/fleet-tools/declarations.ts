/**
 * fleet-tools/declarations.ts — Tool Declarations & Context (ADR-007, ADR-025)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Tool declarations follow the OpenAPI 3.0 schema format required by Gemini.
 * ToolContext holds store references injected at engine creation time.
 */

import { Type, type FunctionDeclaration } from "@google/genai";

import type { ReferenceStore } from "../../stores/reference-store.js";
import type { OverlayStore } from "../../stores/overlay-store.js";
import type { CrewStore } from "../../stores/crew-store.js";
import type { TargetStore } from "../../stores/target-store.js";

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
      "Returns matching officers with class (Command/Science/Engineering), faction, " +
      "abilities, rarity, group, and reservation status. " +
      "Call this when the Admiral asks about a specific officer or wants to find officers matching a name.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
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
      "Returns matching ships with hull type (Explorer/Battleship/Destroyer/Survey), grade, rarity, faction, and max tier. " +
      "Call this when the Admiral asks about a specific ship or wants to find ships matching a name.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Ship name or partial name to search for (e.g. 'Enterprise', 'Kumari', 'Voyager')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_officer_detail",
    description:
      "Get full details for a specific officer: reference data (class, faction, abilities with values, " +
      "rarity, group, synergy, max rank, traits) merged with the Admiral's overlay (ownership, level, rank, targeting). " +
      "Call this when the Admiral asks for detailed info about a particular officer they've already identified.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        officer_id: {
          type: Type.STRING,
          description: "The officer's reference ID (from search results or prior context)",
        },
      },
      required: ["officer_id"],
    },
  },
  {
    name: "get_ship_detail",
    description:
      "Get full details for a specific ship: reference data (hull type, class, grade, faction, rarity, " +
      "max tier/level, build time, officer bonus curves, crew slot unlocks, ship ability) " +
      "merged with the Admiral's overlay (ownership, tier, level, targeting). " +
      "Call this when the Admiral asks for detailed info about a particular ship they've already identified.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
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

  {
    name: "list_owned_officers",
    description:
      "List all officers the Admiral owns, with class (Command/Science/Engineering), faction, " +
      "abilities, and overlay data (level, rank, power). " +
      "Call this when suggesting crews, analyzing fleet composition, or checking available officers. " +
      "Returns merged reference + overlay data for each owned officer.",
    // No parameters
  },
  {
    name: "get_loadout_detail",
    description:
      "Get full details for a specific loadout: ship, resolved BridgeCore (captain + bridge officers), " +
      "BelowDeckPolicy (mode + spec), intent keys, tags, notes, and available variants. " +
      "Call this when examining a specific crew configuration.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        loadout_id: {
          type: Type.INTEGER,
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
      "Call this when analyzing the fleet plan or checking dock assignments.",
    // No parameters — returns all plan items with context
  },
  {
    name: "list_intents",
    description:
      "List available activity intents from the intent catalog. " +
      "Intents categorize what a loadout is built for: mining, combat, utility, or custom. " +
      "Call this when the Admiral asks about available activities or when suggesting loadout purposes.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          enum: ["mining", "combat", "utility", "custom"],
          description: "Filter by category. Omit for all categories.",
        },
      },
    },
  },
  {
    name: "find_loadouts_for_intent",
    description:
      "Find all loadouts tagged for a specific activity intent (e.g. 'pvp', 'mining-lat', 'grinding'). " +
      "Returns loadouts with full crew details. " +
      "Call this when the Admiral asks what crews they have for a specific activity.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        intent_key: {
          type: Type.STRING,
          description: "Intent key to search for (e.g. 'pvp', 'grinding', 'mining-lat')",
        },
      },
      required: ["intent_key"],
    },
  },
  {
    name: "suggest_crew",
    description:
      "Gather all context needed to suggest an optimal crew for a ship and activity. " +
      "Returns: ship details (hull type, officer bonus curves, crew slots), intent info, " +
      "all owned officers with class/faction/abilities, " +
      "existing loadouts for this ship, and officer reservations (locked officers are unavailable). " +
      "Can suggest BridgeCore creation, BelowDeckPolicy selection, and variant creation. " +
      "Use your STFC knowledge to recommend the best captain + bridge + below-deck officers " +
      "from the Admiral's available roster.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "Ship reference ID to build a crew for",
        },
        intent_key: {
          type: Type.STRING,
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
      type: Type.OBJECT,
      properties: {
        officer_id: {
          type: Type.STRING,
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
      "Call this when the Admiral considers reassigning an officer or wants to understand dependencies.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        officer_id: {
          type: Type.STRING,
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
      "Call this when the Admiral asks about their goals, priorities, or what to work toward.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_type: {
          type: Type.STRING,
          enum: ["officer", "ship", "crew"],
          description: "Filter by type. Omit for all types.",
        },
        status: {
          type: Type.STRING,
          enum: ["active", "achieved", "abandoned"],
          description: "Filter by status. Default: active.",
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
      "Call this when the Admiral asks about conflicts, bottlenecks, or resource competition.",
    // No parameters — analyzes all active targets automatically
  },

  // ─── ADR-025 Mutation Tools (Phase 3) ─────────────────────

  {
    name: "create_bridge_core",
    description:
      "Create a new BridgeCore — a named trio of captain + bridge_1 + bridge_2 officers. " +
      "BridgeCores are reusable across loadouts. " +
      "Call this when the Admiral asks to create a crew trio or save a bridge crew configuration.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: "Name for the bridge core (e.g. 'SNW Exploration Trio', 'PvP Kirk Crew')",
        },
        captain: {
          type: Type.STRING,
          description: "Officer reference ID for the captain slot",
        },
        bridge_1: {
          type: Type.STRING,
          description: "Officer reference ID for bridge slot 1",
        },
        bridge_2: {
          type: Type.STRING,
          description: "Officer reference ID for bridge slot 2",
        },
        notes: {
          type: Type.STRING,
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
      "Call this when the Admiral asks to save a crew configuration for a ship.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "Ship reference ID for this loadout",
        },
        name: {
          type: Type.STRING,
          description: "Name for the loadout (e.g. 'Kumari Mining', 'Enterprise PvP')",
        },
        bridge_core_id: {
          type: Type.INTEGER,
          description: "BridgeCore ID to assign (from list_bridge_cores or create_bridge_core)",
        },
        below_deck_policy_id: {
          type: Type.INTEGER,
          description: "BelowDeckPolicy ID to assign (optional)",
        },
        intent_keys: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Intent keys to tag this loadout with (e.g. ['mining-lat', 'mining-gas'])",
        },
        notes: {
          type: Type.STRING,
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
      type: Type.OBJECT,
      properties: {
        preset_id: {
          type: Type.INTEGER,
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
      "Call this when the Admiral wants to reserve an officer for a specific purpose or release a reservation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        officer_id: {
          type: Type.STRING,
          description: "Officer reference ID to reserve/unreserve",
        },
        reserved_for: {
          type: Type.STRING,
          description: "What the officer is reserved for (e.g. 'PvP Enterprise crew', 'Borg armada'). Set to empty to clear.",
        },
        locked: {
          type: Type.BOOLEAN,
          description: "Whether this is a hard lock (true) or soft reservation (false). Default: false.",
        },
        notes: {
          type: Type.STRING,
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
      "Call this when the Admiral wants a variant crew for an existing loadout.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        loadout_id: {
          type: Type.INTEGER,
          description: "Base loadout ID to create a variant for",
        },
        name: {
          type: Type.STRING,
          description: "Name for the variant (e.g. 'Swarm Swap', 'PvP Bridge')",
        },
        captain: {
          type: Type.STRING,
          description: "Replacement captain officer ID (optional — omit to keep base captain)",
        },
        bridge_1: {
          type: Type.STRING,
          description: "Replacement bridge_1 officer ID (optional — omit to keep base)",
        },
        bridge_2: {
          type: Type.STRING,
          description: "Replacement bridge_2 officer ID (optional — omit to keep base)",
        },
        notes: {
          type: Type.STRING,
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
      "Call this when the Admiral asks about the current fleet state, what's running, or dock assignments.",
    // No parameters
  },
];
