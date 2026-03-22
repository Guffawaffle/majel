/**
 * tool-mode.ts — Per-run tool policy classification.
 *
 * Determines whether a chat request should expose fleet tools to the model.
 * This prevents bulk transformation/parsing requests from entering
 * tool-call mode where they cause MALFORMED_FUNCTION_CALL failures.
 *
 * See ADR-007 (fleet tools) and the chat-run analysis from 2026-03-22.
 */

// ─── Tool Mode Type ──────────────────────────────────────────

/**
 * Per-run tool policy. Controls whether fleet tool declarations are
 * exposed to the model for a given chat call.
 *
 * - "fleet": Fleet tool declarations exposed (lookups, recommendations, calculations)
 * - "none":  No tools exposed (parsing, extraction, transformation, summarization)
 */
export type ToolMode = "fleet" | "none";

// ─── Structured data detection ───────────────────────────────

/** Minimum CSV-like lines to consider the message as containing structured data. */
const STRUCTURED_DATA_LINE_THRESHOLD = 5;
/** Minimum comma-separated fields per line to count as CSV-like. */
const CSV_FIELD_THRESHOLD = 3;

/**
 * Detect whether text contains substantial structured data (CSV rows, tables).
 * Counts lines with 3+ comma-separated values.
 */
function hasStructuredData(message: string): boolean {
  return countStructuredLines(message) >= STRUCTURED_DATA_LINE_THRESHOLD;
}

/**
 * Count CSV-like lines in a message (lines with 3+ comma-separated values).
 * Used by the bulk-commit gate to estimate entity count for HandoffCard.
 */
export function countStructuredLines(message: string): number {
  const lines = message.split("\n");
  let csvLineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.includes(",") && trimmed.split(",").length >= CSV_FIELD_THRESHOLD) {
      csvLineCount++;
    }
  }
  return csvLineCount;
}

// ─── Intent keyword patterns ─────────────────────────────────

/**
 * Signals that the user wants to parse, extract, transform, or reformat
 * data they have already supplied in the message.
 */
const TRANSFORM_INTENT = /\b(parse|extract|convert|format|reformat|rewrite|normalize|transform|update\s+(?:my\s+)?(?:list|roster|data|officers?)|import|bulk|batch|clean\s+up|organize|sort|let'?s\s+do\s+the\s+rest)\b/i;

/**
 * Signals that the user wants Majel to look up, recommend, or calculate
 * something using reference data — tasks that benefit from fleet tools.
 */
const FLEET_INTENT = /\b(recommend|suggest(?:ion)?|best|optimal|compare|who\s+should|what\s+ship|which\s+officer|crew\s+for|bridge|loadout|upgrade\s+path|research|mining|combat|pvp|armada|faction|hostile|territory|warp\s+range|tell\s+me\s+about|look\s+up|find\s+me|calculate)\b/i;

// ─── Classifier ──────────────────────────────────────────────

/**
 * Message length at which structured data is a strong toolless signal
 * even without explicit transform keywords. A large blob of pasted
 * data (roster, CSV) is almost always a transformation task.
 */
const LARGE_PAYLOAD_THRESHOLD = 2000;

/**
 * Classify whether a chat request should use fleet tools or run toolless.
 *
 * Toolless mode is selected for parsing, extraction, and transformation tasks
 * where the user has already supplied the source data in the prompt. These
 * requests cause MALFORMED_FUNCTION_CALL failures when the model tries to
 * serialize large payloads as tool arguments.
 *
 * Fleet tool mode is preserved for lookups, recommendations, and calculations
 * that require Majel reference data not present in the user's message.
 *
 * The heuristic combines three signals:
 * 1. Presence of structured data (CSV-like rows) in the message
 * 2. Transform/extraction intent keywords vs. fleet/knowledge intent keywords
 * 3. Message length as a supporting signal (not sole decision-maker)
 *
 * When in doubt, defaults to "fleet" to preserve existing behavior.
 */
export function classifyToolMode(message: string, hasImage: boolean): ToolMode {
  return classifyToolModeVerbose(message, hasImage).mode;
}

/**
 * Classifier signals for verbose traces (ADR-050 §6) and bulk detection (ADR-049 §3).
 */
export interface ClassifierSignals {
  mode: ToolMode;
  /** True when structured data triggers the bulk-commit gate (ADR-049 §3). */
  bulkDetected: boolean;
  hasStructuredData: boolean;
  hasTransformIntent: boolean;
  hasFleetIntent: boolean;
  isLargePayload: boolean;
  hasImage: boolean;
  messageLength: number;
}

/**
 * Verbose classifier that returns both the mode decision and the raw signals.
 * Used by the verbose traces system to expose classifier reasoning.
 */
export function classifyToolModeVerbose(message: string, hasImage: boolean): ClassifierSignals {
  const structured = hasStructuredData(message);
  const transform = TRANSFORM_INTENT.test(message);
  const fleet = FLEET_INTENT.test(message);
  const isLargePayload = message.length > LARGE_PAYLOAD_THRESHOLD;

  const base: Omit<ClassifierSignals, "mode" | "bulkDetected"> = {
    hasStructuredData: structured,
    hasTransformIntent: transform,
    hasFleetIntent: fleet,
    isLargePayload,
    hasImage,
    messageLength: message.length,
  };

  // Multimodal extraction: image + transform intent → toolless (not bulk)
  if (hasImage && transform) return { ...base, mode: "none", bulkDetected: false };

  // Strong fleet intent without structured data → fleet
  if (fleet && !structured) return { ...base, mode: "fleet", bulkDetected: false };

  // Structured data + transform intent → toolless + bulk (ADR-049 §3)
  if (structured && transform) return { ...base, mode: "none", bulkDetected: true };

  // Large payload with structured data → toolless + bulk (ADR-049 §3)
  if (structured && isLargePayload) return { ...base, mode: "none", bulkDetected: true };

  // Default: fleet
  return { ...base, mode: "fleet", bulkDetected: false };
}
