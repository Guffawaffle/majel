/**
 * model-availability.ts — Centralized Model Availability Resolver
 *
 * ADR-042 Phase 1: Pure function that composes four independent signals
 * into a single availability answer for any model + actor combination.
 *
 * Majel — STFC Fleet Intelligence System
 */

import { MODEL_REGISTRY_MAP, type ModelDef } from "./gemini/model-registry.js";

// ─── Types ────────────────────────────────────────────────────

export interface ModelOverride {
  adminEnabled: boolean;
  reason?: string;
}

export type ModelOverrides = Record<string, ModelOverride>;

export interface ProviderCapabilities {
  gemini: boolean;
  claude: boolean;
}

export interface ModelAvailability {
  available: boolean;
  registryEnabled: boolean;
  providerCapable: boolean;
  roleAllowed: boolean;
  adminEnabled: boolean | null; // null = no override, using registry default
  effectiveReason?: string;
}

// ─── Resolver ─────────────────────────────────────────────────

/**
 * Resolve the availability of a model for a given actor.
 *
 * Composition rule:
 *   available = providerCapable AND roleAllowed AND effectiveEnabled
 *
 * Where effectiveEnabled = adminOverride ?? model.defaultEnabled
 *
 * This is a pure function — no DB calls, no side effects.
 */
export function resolveModelAvailability(
  modelId: string,
  actor: { isAdmiral: boolean },
  overrides: ModelOverrides,
  providerCapabilities: ProviderCapabilities,
): ModelAvailability {
  const model = MODEL_REGISTRY_MAP.get(modelId);
  if (!model) {
    return {
      available: false,
      registryEnabled: false,
      providerCapable: false,
      roleAllowed: false,
      adminEnabled: null,
      effectiveReason: "Unknown model",
    };
  }

  const registryEnabled = model.defaultEnabled;
  const providerCapable = providerCapabilities[model.provider] ?? false;
  const roleAllowed = !model.roleGate || actor.isAdmiral;

  const override = overrides[modelId];
  const adminEnabled: boolean | null = override ? override.adminEnabled : null;
  const effectiveEnabled = adminEnabled ?? registryEnabled;

  const available = providerCapable && roleAllowed && effectiveEnabled;

  let effectiveReason: string | undefined;
  if (!available) {
    if (!providerCapable) {
      effectiveReason = `${model.provider === "claude" ? "Vertex AI" : "Gemini"} provider not configured`;
    } else if (!roleAllowed) {
      effectiveReason = "Requires admiral role";
    } else if (!effectiveEnabled) {
      effectiveReason = override?.reason
        ?? (registryEnabled ? "Disabled by admin" : "Not enabled by default (preview or new provider)");
    }
  }

  return {
    available,
    registryEnabled,
    providerCapable,
    roleAllowed,
    adminEnabled,
    effectiveReason,
  };
}

/**
 * Resolve availability for all models in the registry.
 * Models where roleAllowed is false are excluded entirely
 * (user shouldn't know they exist).
 */
export function resolveAllModelAvailability(
  actor: { isAdmiral: boolean },
  overrides: ModelOverrides,
  providerCapabilities: ProviderCapabilities,
): Array<{ model: ModelDef; availability: ModelAvailability }> {
  const results: Array<{ model: ModelDef; availability: ModelAvailability }> = [];
  for (const model of MODEL_REGISTRY_MAP.values()) {
    const availability = resolveModelAvailability(model.id, actor, overrides, providerCapabilities);
    // Omit models where the actor doesn't have role access
    if (!availability.roleAllowed) continue;
    results.push({ model, availability });
  }
  return results;
}

/**
 * Parse the system.modelOverrides JSON blob from the SettingsStore.
 * Returns an empty object on parse failure or missing value.
 */
export function parseModelOverrides(raw: string): ModelOverrides {
  if (!raw || raw === "{}") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: ModelOverrides = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && "adminEnabled" in value) {
        const v = value as { adminEnabled: unknown; reason?: unknown };
        if (typeof v.adminEnabled === "boolean") {
          result[key] = {
            adminEnabled: v.adminEnabled,
            ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
          };
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}
