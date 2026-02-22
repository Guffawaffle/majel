/**
 * crew-validator.ts — "Does this crew work?" validation matrix (ADR-034 Phase C, #134)
 *
 * Pure function: given a trio of officer IDs, an EffectBundleData, and a TargetContext,
 * evaluates every ability of every officer and returns a structured validation matrix.
 *
 * No side effects, no server calls. Usable in tests.
 */

import type {
  TargetContext,
  OfficerEvaluation,
  EvaluationIssue,
  SlotContext,
} from "./types/effect-types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import type { BridgeSlot } from "./types.js";
import { evaluateOfficer } from "./effect-evaluator.js";
import {
  buildTargetContext,
  bridgeSlotToSlotContext,
  type TargetContextOverrides,
} from "./effect-context.js";

// ─── Types ──────────────────────────────────────────────────

export interface ValidatedOfficer {
  officerId: string;
  officerName: string;
  slot: BridgeSlot;
  slotContext: SlotContext;
  evaluation: OfficerEvaluation;
  /** Summarized verdict for the whole officer. */
  verdict: "works" | "partial" | "blocked" | "unknown";
  /** Total effect score (from evaluateOfficer). */
  totalScore: number;
  /** Issue summary: worst issue across all abilities. */
  topIssues: EvaluationIssue[];
}

export interface CrewValidation {
  officers: ValidatedOfficer[];
  /** Total crew score. */
  totalScore: number;
  /** Overall crew verdict. */
  verdict: "works" | "partial" | "blocked" | "unknown";
  /** Human-readable summary lines. */
  summary: string[];
}

export interface ValidateCrewInput {
  slots: Record<BridgeSlot, string | null>;
  officerNames: Record<string, string>;
  intentKey: string;
  shipClass?: string | null;
  targetClass?: string | null;
  contextOverrides?: Omit<TargetContextOverrides, "shipClass" | "targetClass">;
  effectBundle: EffectBundleData;
}

// ─── Core Logic ─────────────────────────────────────────────

function deriveOfficerVerdict(evaluation: OfficerEvaluation): "works" | "partial" | "blocked" | "unknown" {
  const hasBlocker = evaluation.issues.some((i) => i.severity === "blocker");
  const hasConditional = evaluation.issues.some((i) => i.severity === "conditional");
  const hasAnyEffects = evaluation.abilities.some((a) => a.effects.length > 0);

  if (!hasAnyEffects) return "unknown";
  if (hasBlocker && evaluation.totalScore <= 0) return "blocked";
  if (hasBlocker || hasConditional) return "partial";
  return "works";
}

function deriveCrewVerdict(officers: ValidatedOfficer[]): "works" | "partial" | "blocked" | "unknown" {
  if (officers.length === 0) return "unknown";
  if (officers.every((o) => o.verdict === "works")) return "works";
  if (officers.every((o) => o.verdict === "blocked" || o.verdict === "unknown")) return "blocked";
  return "partial";
}

function buildSummary(officers: ValidatedOfficer[], intentKey: string): string[] {
  const lines: string[] = [];

  const working = officers.filter((o) => o.verdict === "works");
  const partial = officers.filter((o) => o.verdict === "partial");
  const blocked = officers.filter((o) => o.verdict === "blocked");
  const unknown = officers.filter((o) => o.verdict === "unknown");

  if (working.length === officers.length) {
    lines.push(`All ${officers.length} officers fully compatible with "${intentKey}".`);
  } else {
    if (working.length > 0) {
      lines.push(`${working.map((o) => o.officerName).join(", ")}: all abilities work.`);
    }
    if (partial.length > 0) {
      for (const o of partial) {
        const conditionalCount = o.evaluation.issues.filter((i) => i.severity === "conditional").length;
        const blockerCount = o.evaluation.issues.filter((i) => i.severity === "blocker").length;
        const parts: string[] = [];
        if (blockerCount > 0) parts.push(`${blockerCount} blocked`);
        if (conditionalCount > 0) parts.push(`${conditionalCount} conditional`);
        lines.push(`${o.officerName}: ${parts.join(", ")}.`);
      }
    }
    if (blocked.length > 0) {
      lines.push(`${blocked.map((o) => o.officerName).join(", ")}: no abilities apply.`);
    }
  }

  if (unknown.length > 0) {
    lines.push(`${unknown.map((o) => o.officerName).join(", ")}: not in effect catalog.`);
  }

  return lines;
}

// ─── Public API ─────────────────────────────────────────────

const SLOTS_ORDERED: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

export function validateCrew(input: ValidateCrewInput): CrewValidation {
  const {
    slots,
    officerNames,
    intentKey,
    shipClass,
    targetClass,
    contextOverrides,
    effectBundle,
  } = input;
  const intent = effectBundle.intents.get(intentKey);
  const weights = effectBundle.intentWeights.get(intentKey);
  if (!intent || !weights) {
    throw new Error(`Unknown intent key: ${intentKey}`);
  }

  const ctx = buildTargetContext(intent, {
    shipClass,
    targetClass,
    ...contextOverrides,
  });

  const officers: ValidatedOfficer[] = [];

  for (const slot of SLOTS_ORDERED) {
    const officerId = slots[slot];
    if (!officerId) continue;

    const slotContext = bridgeSlotToSlotContext(slot);
    const abilities = effectBundle.officerAbilities.get(officerId) ?? [];
    const evaluation = evaluateOfficer(officerId, abilities, ctx, weights, slotContext);
    const verdict = deriveOfficerVerdict(evaluation);

    // Collect unique top issues (dedupe by type)
    const seen = new Set<string>();
    const topIssues: EvaluationIssue[] = [];
    for (const issue of evaluation.issues) {
      if (!seen.has(issue.type)) {
        seen.add(issue.type);
        topIssues.push(issue);
      }
    }

    officers.push({
      officerId,
      officerName: officerNames[officerId] ?? officerId,
      slot,
      slotContext,
      evaluation,
      verdict,
      totalScore: Math.round(evaluation.totalScore * 100) / 100,
      topIssues,
    });
  }

  const totalScore = Math.round(officers.reduce((sum, o) => sum + o.totalScore, 0) * 100) / 100;
  const verdict = deriveCrewVerdict(officers);
  const summary = buildSummary(officers, intentKey);

  return { officers, totalScore, verdict, summary };
}
