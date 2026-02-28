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
import type { ReceiptStore } from "../../stores/receipt-store.js";
import type { ResearchStore } from "../../stores/research-store.js";
import type { InventoryStore } from "../../stores/inventory-store.js";
import type { UserSettingsStore } from "../../stores/user-settings-store.js";

// ─── Tool Context ───────────────────────────────────────────

/**
 * Stores required by fleet tools. Injected per-request via ToolContextFactory.
 * All store fields are optional — tools gracefully degrade when stores are unavailable.
 *
 * userId is required for user-scoped operations (#85).
 * Stores should already be scoped to the user when provided.
 */
export interface ToolContext {
  /** The authenticated user's ID. Required for user-scoped data access. */
  userId: string;
  referenceStore?: ReferenceStore | null;
  overlayStore?: OverlayStore | null;
  crewStore?: CrewStore | null;
  targetStore?: TargetStore | null;
  receiptStore?: ReceiptStore | null;
  researchStore?: ResearchStore | null;
  inventoryStore?: InventoryStore | null;
  userSettingsStore?: UserSettingsStore | null;
}

/**
 * Factory that produces user-scoped ToolContext instances (#85).
 * The GeminiEngine holds this factory and creates a scoped context per chat() call.
 */
export interface ToolContextFactory {
  forUser(userId: string): ToolContext;
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
    name: "list_research",
    description:
      "List Admiral research progression grouped by tree (Combat, Galaxy, Station, etc.), " +
      "including node levels, completion status, and aggregate completion percentages. " +
      "Call this when recommendations should account for research buffs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tree: {
          type: Type.STRING,
          description: "Optional exact tree filter (case-insensitive), e.g. 'combat'.",
        },
        include_completed: {
          type: Type.BOOLEAN,
          description: "When false, only returns non-completed nodes. Default: true.",
        },
      },
    },
  },
  {
    name: "list_inventory",
    description:
      "List Admiral inventory resources grouped by category (ore, gas, crystal, parts, currency, blueprints). " +
      "Call this when planning upgrades or checking available materials before recommending spend.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          enum: ["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"],
          description: "Optional category filter.",
        },
        query: {
          type: Type.STRING,
          description: "Optional name filter (partial match), e.g. 'ore' or 'latinum'.",
        },
      },
    },
  },
  {
    name: "list_active_events",
    description:
      "List active in-game events from the Admiral's live context feed. " +
      "Returns event name, type, scoring parameters, and start/end windows. " +
      "Call this when advising daily priorities, point optimization, or dock rotation decisions.",
    // No parameters
  },
  {
    name: "list_away_teams",
    description:
      "List Away Team missions currently locking officers, including mission names and return times. " +
      "Call this before recommending crews so unavailable officers are excluded.",
    // No parameters
  },
  {
    name: "get_faction_standing",
    description:
      "Get current faction/syndicate standing and access tiers for the Admiral. " +
      "Optionally filter by faction name. " +
      "Call this when recommendation quality depends on store/reputation unlocks.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        faction: {
          type: Type.STRING,
          description: "Optional faction filter (e.g. 'Federation', 'Klingon', 'Romulan', 'Syndicate', 'Rogue').",
        },
      },
    },
  },
  {
    name: "web_lookup",
    description:
      "Lookup structured public STFC reference context from allowlisted community domains only. " +
      "Respects robots.txt, rate limits requests per domain, and returns deterministic structured summaries (never raw HTML). " +
      "Use this when the Admiral asks for external community context not present in local reference data.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        domain: {
          type: Type.STRING,
          enum: ["stfc.space", "memory-alpha.fandom.com", "stfc.fandom.com"],
          description: "Allowlisted domain to query.",
        },
        query: {
          type: Type.STRING,
          description: "Search query or article title, e.g. 'USS Enterprise' or 'Spock'.",
        },
        entity_type: {
          type: Type.STRING,
          enum: ["officer", "ship", "event", "auto"],
          description: "Optional semantic hint for parsing strategy.",
        },
      },
      required: ["domain", "query"],
    },
  },
  {
    name: "calculate_upgrade_path",
    description:
      "Estimate resource requirements to upgrade a ship from current tier to a target tier, " +
      "and compare against Admiral inventory to show gaps. " +
      "Call this before recommending an upgrade so advice is grounded in available materials.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "Ship reference ID to analyze.",
        },
        target_tier: {
          type: Type.INTEGER,
          description: "Desired tier (defaults to current tier + 1).",
        },
      },
      required: ["ship_id"],
    },
  },
  {
    name: "estimate_acquisition_time",
    description:
      "Estimate time-to-upgrade based on current resource gaps and expected daily acquisition rates. " +
      "Use this after calculate_upgrade_path to project how many days remain to reach the target tier.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "Ship reference ID to analyze.",
        },
        target_tier: {
          type: Type.INTEGER,
          description: "Desired tier (defaults to current tier + 1).",
        },
        daily_income: {
          type: Type.OBJECT,
          description: "Optional per-resource daily income overrides, e.g. { '3★ Ore': 120, '3★ Crystal': 80 }.",
        },
      },
      required: ["ship_id"],
    },
  },
  {
    name: "calculate_true_power",
    description:
      "Estimate effective ship power using Admiral overlay power plus active research buffs. " +
      "Returns confidence and data coverage so research remains advisory when sparse or stale. " +
      "Call this when the Admiral asks for true/effective power for a specific ship.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "Ship reference ID to calculate true power for.",
        },
        intent_key: {
          type: Type.STRING,
          description: "Optional activity intent key to focus relevant research buffs (e.g. 'pvp', 'mining-lat').",
        },
      },
      required: ["ship_id"],
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
    name: "analyze_battle_log",
    description:
      "Analyze a battle log JSON to identify key failure rounds, incoming/outgoing damage trends, " +
      "ability trigger timing, and likely loss causes. " +
      "Call this when the Admiral wants post-battle root cause analysis.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        battle_log: {
          type: Type.OBJECT,
          description: "Battle log payload containing rounds, damage events, and ability triggers.",
        },
      },
      required: ["battle_log"],
    },
  },
  {
    name: "suggest_counter",
    description:
      "Given a battle log JSON, recommend specific crew/ship counter-adjustments grounded in failure analysis. " +
      "References ability timing and research context when available. " +
      "Call this after analyze_battle_log when the Admiral asks what to change next.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        battle_log: {
          type: Type.OBJECT,
          description: "Battle log payload containing rounds, damage events, and ability triggers.",
        },
      },
      required: ["battle_log"],
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

  // ─── Target Mutation Tools (#80) ───────────────────────────

  {
    name: "create_target",
    description:
      "Create a new acquisition or progression target — an officer to acquire, a ship to build, " +
      "or a crew loadout to assemble. Includes dupe detection: warns if an active target for the same ref_id already exists. " +
      "Call this when the Admiral says they want to target, acquire, or work toward something.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_type: {
          type: Type.STRING,
          enum: ["officer", "ship", "crew"],
          description: "Type of target: officer (acquire/upgrade), ship (build/tier), crew (assemble loadout)",
        },
        ref_id: {
          type: Type.STRING,
          description: "Reference ID for the target entity (e.g. 'cdn:officer:1234', 'cdn:ship:5678'). Required for officer/ship targets.",
        },
        loadout_id: {
          type: Type.INTEGER,
          description: "Loadout ID for crew targets. Links the target to a specific loadout.",
        },
        priority: {
          type: Type.INTEGER,
          description: "Priority level 1-3 (1 = high, 3 = low). Default: 2.",
        },
        target_tier: {
          type: Type.INTEGER,
          description: "Target tier/level to reach (e.g. ship tier 8, officer tier 3)",
        },
        target_level: {
          type: Type.INTEGER,
          description: "Target level to reach (e.g. officer level 50)",
        },
        target_rank: {
          type: Type.STRING,
          description: "Target rank to reach (e.g. 'Commander', 'Captain')",
        },
        reason: {
          type: Type.STRING,
          description: "Why this target matters — used for prioritization context (e.g. 'Cloaking platform acquisition', 'Needed for Kirk PvP crew')",
        },
      },
      required: ["target_type"],
    },
  },
  {
    name: "update_target",
    description:
      "Update an existing target's priority, status, reason, or progression goals. " +
      "Use this to change priority, update the reason, adjust target tier/level/rank, " +
      "or set status to 'abandoned'. For marking targets complete, prefer complete_target instead.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_id: {
          type: Type.INTEGER,
          description: "Target ID to update (from list_targets)",
        },
        priority: {
          type: Type.INTEGER,
          description: "New priority level 1-3 (1 = high, 3 = low)",
        },
        status: {
          type: Type.STRING,
          enum: ["active", "abandoned"],
          description: "New status. Use 'abandoned' to retire a target. For 'achieved', use complete_target instead.",
        },
        target_tier: {
          type: Type.INTEGER,
          description: "Updated target tier",
        },
        target_level: {
          type: Type.INTEGER,
          description: "Updated target level",
        },
        target_rank: {
          type: Type.STRING,
          description: "Updated target rank",
        },
        reason: {
          type: Type.STRING,
          description: "Updated reason/context",
        },
      },
      required: ["target_id"],
    },
  },
  {
    name: "complete_target",
    description:
      "Mark a target as achieved/completed. Records the achievement timestamp. " +
      "Call this when the Admiral confirms they've acquired the officer, built the ship, " +
      "or assembled the crew loadout.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_id: {
          type: Type.INTEGER,
          description: "Target ID to mark as achieved (from list_targets)",
        },
      },
      required: ["target_id"],
    },
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
      "rather than executing directly. Tell the Admiral to use Plan → Fleet Presets tab to activate.",
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
  {
    name: "sync_overlay",
    description:
      "Sync Admiral game-state overlays from a MajelGameExport payload. " +
      "Validates payload shape, normalizes IDs, computes a changeset diff against current overlays, " +
      "and optionally applies updates. " +
      "Default is dry-run preview only. Use dry_run=false to commit.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        export: {
          type: Type.OBJECT,
          description: "MajelGameExport object payload (preferred).",
        },
        payload_json: {
          type: Type.STRING,
          description: "MajelGameExport JSON string payload (alternative to export object).",
        },
        manual_updates: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Optional natural-language updates (e.g. ['I upgraded my Enterprise to tier 7']). Parsed and merged into the sync payload.",
        },
        dry_run: {
          type: Type.BOOLEAN,
          description: "When true (default), preview diff only. When false, apply overlay updates.",
        },
      },
    },
  },
  {
    name: "sync_research",
    description:
      "Sync Admiral research tree data from a structured payload (schema_version 1.0). " +
      "Computes a summary preview and optionally persists the snapshot. " +
      "Default is dry-run; set dry_run=false to apply.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        export: {
          type: Type.OBJECT,
          description: "Research tree snapshot object with schema_version, nodes, and state arrays.",
        },
        payload_json: {
          type: Type.STRING,
          description: "Research tree snapshot JSON string (alternative to export object).",
        },
        dry_run: {
          type: Type.BOOLEAN,
          description: "When true (default), preview only. When false, writes snapshot to research store.",
        },
      },
    },
  },
  {
    name: "set_ship_overlay",
    description:
      "Record the Admiral's actual in-game ship progression on a specific ship: current tier, level, power, " +
      "and ownership state. Use this when the Admiral tells you their ship's current tier/level (e.g. 'my Serene Squall " +
      "is at tier 9 level 45'). Also sets ownership state and target flag. " +
      "Provide ship_id from search_ships or get_ship_detail results.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ship_id: {
          type: Type.STRING,
          description: "The ship reference ID (e.g. 'cdn:ship:697653604')",
        },
        ownership_state: {
          type: Type.STRING,
          description: "Ownership state: 'owned', 'unowned', or 'unknown'",
        },
        tier: {
          type: Type.NUMBER,
          description: "Current tier (e.g. 9)",
        },
        level: {
          type: Type.NUMBER,
          description: "Current level (e.g. 45)",
        },
        power: {
          type: Type.NUMBER,
          description: "Current power rating",
        },
        target: {
          type: Type.BOOLEAN,
          description: "Whether this ship is a fleet priority target",
        },
        target_note: {
          type: Type.STRING,
          description: "Optional note about this ship's target status",
        },
      },
      required: ["ship_id"],
    },
  },
  {
    name: "update_inventory",
    description:
      "Record the Admiral's current resource inventory — ore, gas, crystal, parts, currency, or blueprints. " +
      "Use this when the Admiral tells you what resources they have " +
      "(e.g. 'I have 280 3-star Ore and 150 3-star Crystal'). " +
      "Each item requires a category and name; grade and quantity are optional.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          description: "Array of inventory items to record.",
          items: {
            type: Type.OBJECT,
            properties: {
              category: {
                type: Type.STRING,
                enum: ["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"],
                description: "Resource category.",
              },
              name: {
                type: Type.STRING,
                description: "Resource name, e.g. '3★ Ore', 'Latinum', 'Bortas Blueprints'.",
              },
              grade: {
                type: Type.STRING,
                description: "Optional grade/rarity, e.g. '3-star', 'rare', 'common'.",
              },
              quantity: {
                type: Type.INTEGER,
                description: "Amount the Admiral currently has.",
              },
            },
            required: ["category", "name", "quantity"],
          },
        },
        source: {
          type: Type.STRING,
          description: "Optional source label, e.g. 'manual', 'chat', 'import'.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "set_officer_overlay",
    description:
      "Record the Admiral's actual in-game officer progression: current level, rank (1-5), power, " +
      "and ownership state. Use this when the Admiral tells you their officer's current level or rank " +
      "(e.g. 'Kirk is rank 4 level 50'). " +
      "Provide officer_id from search_officers or get_officer_detail results.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        officer_id: {
          type: Type.STRING,
          description: "The officer reference ID (e.g. 'cdn:officer:988947581')",
        },
        ownership_state: {
          type: Type.STRING,
          description: "Ownership state: 'owned', 'unowned', or 'unknown'",
        },
        level: {
          type: Type.NUMBER,
          description: "Current level",
        },
        rank: {
          type: Type.STRING,
          description: "Current rank (1-5)",
        },
        power: {
          type: Type.NUMBER,
          description: "Current power contribution",
        },
        target: {
          type: Type.BOOLEAN,
          description: "Whether this officer is a fleet priority target",
        },
        target_note: {
          type: Type.STRING,
          description: "Optional note about this officer's target status",
        },
      },
      required: ["officer_id"],
    },
  },

  // ─── Dock Assignment Tools ─────────────────────────────────

  {
    name: "assign_dock",
    description:
      "Assign a loadout (or variant) to a drydock slot. This creates a plan item linking " +
      "the loadout to the dock number. If the dock already has an assignment, the old one " +
      "is deactivated and replaced. " +
      "Call this after creating a loadout to place it in a specific dock.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        dock_number: {
          type: Type.INTEGER,
          description: "Dock slot number (e.g. 1, 2, 3, 4, 5)",
        },
        loadout_id: {
          type: Type.INTEGER,
          description: "Loadout ID to assign to this dock (from create_loadout or list_plan_items)",
        },
        variant_id: {
          type: Type.INTEGER,
          description: "Optional variant ID to assign instead of the base loadout",
        },
        label: {
          type: Type.STRING,
          description: "Optional label for this dock assignment (e.g. 'PvP Dock', 'Mining')",
        },
        notes: {
          type: Type.STRING,
          description: "Optional notes about this dock assignment",
        },
      },
      required: ["dock_number"],
    },
  },
  {
    name: "update_dock",
    description:
      "Update an existing dock assignment (plan item) — change the loadout, variant, dock number, " +
      "label, or active status. Use this to reassign a dock without creating a new plan item.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        plan_item_id: {
          type: Type.INTEGER,
          description: "Plan item ID to update (from list_plan_items)",
        },
        loadout_id: {
          type: Type.INTEGER,
          description: "New loadout ID (optional — omit to keep current)",
        },
        variant_id: {
          type: Type.INTEGER,
          description: "New variant ID (optional — omit to keep current)",
        },
        dock_number: {
          type: Type.INTEGER,
          description: "New dock number (optional — omit to keep current)",
        },
        label: {
          type: Type.STRING,
          description: "Updated label",
        },
        is_active: {
          type: Type.BOOLEAN,
          description: "Whether this assignment is active (false to deactivate)",
        },
        notes: {
          type: Type.STRING,
          description: "Optional notes",
        },
      },
      required: ["plan_item_id"],
    },
  },
  {
    name: "remove_dock_assignment",
    description:
      "Remove all active assignments from a dock slot, leaving it empty. " +
      "This deactivates plan items but does not delete the dock entry. " +
      "Call this when the Admiral wants to clear a dock.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        dock_number: {
          type: Type.INTEGER,
          description: "Dock slot number to clear (e.g. 1, 2, 3)",
        },
      },
      required: ["dock_number"],
    },
  },
];
