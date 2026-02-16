/**
 * model-registry.ts — Gemini Model Registry
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Available Gemini models with metadata for the model selector.
 * Ordered by cost tier (cheapest → most expensive).
 */

// ─── Model Definition ─────────────────────────────────────────

/**
 * Pricing notes (per 1M tokens, as of Feb 2026):
 * - Flash-Lite:  $0.075 input / $0.30 output (cheapest, no native thinking)
 * - 2.5 Flash:   $0.15 input / $0.60 output (thinking-capable, great balance)
 * - 3 Flash:     ~$0.15 input / $0.60 output (latest gen, native thinking)
 * - 2.5 Pro:     $1.25 input / $10 output (deep reasoning, long context)
 * - 3 Pro:       ~$1.25 input / $10 output (frontier intelligence)
 */
export interface ModelDef {
  id: string;
  name: string;
  tier: "budget" | "balanced" | "thinking" | "premium" | "frontier";
  description: string;
  thinking: boolean;
  contextWindow: number;
  costRelative: number; // 1 = cheapest, 5 = most expensive
  speed: "fastest" | "fast" | "moderate" | "slow";
}

// ─── Registry ─────────────────────────────────────────────────

export const MODEL_REGISTRY: ModelDef[] = [
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash-Lite",
    tier: "budget",
    description: "Ultra-fast, lowest cost. Great for high-volume chat. No native thinking.",
    thinking: false,
    contextWindow: 1_048_576,
    costRelative: 1,
    speed: "fastest",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    tier: "balanced",
    description: "Best price-performance. Thinking-capable with dynamic budget. Solid all-rounder.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 2,
    speed: "fast",
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (Preview)",
    tier: "thinking",
    description: "Latest-gen Flash with native thinking. Fast + smart. Preview — may change.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 2,
    speed: "fast",
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    tier: "premium",
    description: "Advanced reasoning, deep analysis, long context. Best for complex strategy & code.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 4,
    speed: "moderate",
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro (Preview)",
    tier: "frontier",
    description: "Most intelligent model. State-of-the-art reasoning & multimodal. Preview — may change.",
    thinking: true,
    contextWindow: 1_048_576,
    costRelative: 5,
    speed: "slow",
  },
];

export const MODEL_REGISTRY_MAP = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));

/** Get a model definition by ID, or null if unknown. */
export function getModelDef(modelId: string): ModelDef | null {
  return MODEL_REGISTRY_MAP.get(modelId) ?? null;
}

/** Validate a model ID. Returns the ID if valid, or the default if not. */
export function resolveModelId(modelId: string | undefined | null): string {
  if (modelId && MODEL_REGISTRY_MAP.has(modelId)) return modelId;
  return DEFAULT_MODEL;
}

export const DEFAULT_MODEL = "gemini-3-flash-preview";
