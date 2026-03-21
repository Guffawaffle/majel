/**
 * fleet-tools/trust.ts — Three-Tier Trust Classification
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Classifies Aria's mutation tools into trust tiers:
 *   - auto:    Execute immediately (low-risk property updates)
 *   - approve: Stage as a proposal, require Admiral approval (structural mutations)
 *   - block:   Reject entirely, require explicit unlock (fleet-wide mutations)
 *
 * Resolution: user override (fleet.trust setting) → system default → "approve" fallback.
 */

import type { UserSettingsStore } from "../../stores/user-settings-store.js";

// ─── Types ──────────────────────────────────────────────────────

export type TrustLevel = "auto" | "approve" | "block";

const VALID_TRUST_LEVELS = new Set<string>(["auto", "approve", "block"]);
const MUTATION_TOOL_NAME_PATTERN = /^(create|update|set|sync|assign|remove|complete|activate|delete)_/;

// ─── System Defaults ────────────────────────────────────────────

/**
 * Default trust level per tool. Tools not listed here default to "approve".
 * Users can override any tool via the fleet.trust JSON setting.
 */
const DEFAULT_TRUST: Record<string, TrustLevel> = {
  // Auto: low-risk reads & property updates
  set_officer_overlay: "auto",
  set_ship_overlay: "auto",
  update_inventory: "auto",
  create_target: "auto",
  update_target: "auto",
  complete_target: "auto",
  record_target_delta: "auto",
  record_reminder_feedback: "auto",
  record_goal_restatement: "auto",

  // Approve: structural mutations
  create_bridge_core: "approve",
  create_loadout: "approve",
  create_variant: "approve",
  assign_dock: "approve",
  update_dock: "approve",
  remove_dock_assignment: "approve",
  set_reservation: "approve",
  sync_overlay: "approve",
  sync_research: "approve",

  // Block: fleet-wide mutations (must be explicitly unlocked)
  activate_preset: "block",
};

// ─── Resolution ─────────────────────────────────────────────────

/**
 * Resolve the trust level for a tool, checking user overrides first.
 *
 * Resolution chain:
 *   1. User's fleet.trust JSON → tool-specific override
 *   2. DEFAULT_TRUST map
 *   3. "approve" fallback (safe default for unknown tools)
 */
export async function getTrustLevel(
  toolName: string,
  userId: string,
  userSettingsStore?: UserSettingsStore | null,
): Promise<TrustLevel> {
  // Check user override
  if (userSettingsStore) {
    try {
      const entry = await userSettingsStore.getForUser(userId, "fleet.trust");
      if (entry.source === "user") {
        const overrides = JSON.parse(entry.value) as Record<string, string>;
        const userLevel = overrides[toolName];
        if (userLevel && VALID_TRUST_LEVELS.has(userLevel)) {
          return userLevel as TrustLevel;
        }
      }
    } catch {
      // Non-fatal: fall through to system default
    }
  }

  // System default
  return DEFAULT_TRUST[toolName] ?? "approve";
}

/**
 * Check if a tool name is a mutation tool (has a trust classification).
 * Read-only tools are not in the trust system and always execute immediately.
 */
export function isMutationTool(toolName: string): boolean {
  return toolName in DEFAULT_TRUST || MUTATION_TOOL_NAME_PATTERN.test(toolName);
}

// ─── Tool → Client Cache Mutation Key ───────────────────────────

/**
 * Maps tool names to client cache invalidation keys (INVALIDATION_MAP keys).
 * Only includes tools whose mutations affect client-cached data.
 * Tools not listed here have no client-side cache to invalidate.
 */
const TOOL_MUTATION_KEY: Record<string, string> = {
  set_officer_overlay: "officer-overlay",
  set_ship_overlay: "ship-overlay",
  create_bridge_core: "bridge-core",
  create_loadout: "crew-loadout",
  create_variant: "crew-variant",
  assign_dock: "crew-dock",
  update_dock: "crew-dock",
  remove_dock_assignment: "crew-dock",
  set_reservation: "officer-reservation",
  activate_preset: "fleet-preset",
  // Broad flush for sync operations (matches applyProposal behavior)
  sync_overlay: "import-commit",
  sync_research: "import-commit",
};

/**
 * Resolve the client cache mutation key for a tool, if any.
 * Returns null for tools that don't affect client-cached data.
 */
export function getMutationKey(toolName: string): string | null {
  return TOOL_MUTATION_KEY[toolName] ?? null;
}

/**
 * Get the full default trust map (for diagnostics/settings UI).
 */
export function getDefaultTrustMap(): Readonly<Record<string, TrustLevel>> {
  return DEFAULT_TRUST;
}
