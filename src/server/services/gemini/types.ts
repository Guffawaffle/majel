/**
 * gemini/types.ts — Shared types for the Gemini engine sub-modules
 *
 * Extracted from gemini/index.ts to break circular dependencies
 * between tool-dispatch.ts, context-cache.ts, and the main engine.
 */

import type { Chat } from "@google/genai";
import type { ToolMode } from "./tool-mode.js";

/**
 * Fleet configuration context for the system prompt.
 * These values come from the settings store and tell the model
 * about the Admiral's current game state.
 */
export interface FleetConfig {
  opsLevel: number;
  drydockCount: number;
  shipHangarSlots: number;
}

/**
 * Image attachment for multimodal chat (ADR-008 Phase A).
 * Maps directly to the Gemini SDK's inlineData Part format.
 */
export interface ImagePart {
  inlineData: {
    data: string;       // base64-encoded image data
    mimeType: string;   // image/png, image/jpeg, image/webp
  };
}

/**
 * Summary of a staged mutation proposal returned alongside chat text.
 * The frontend renders these as inline approval cards.
 */
export interface ProposalSummary {
  id: string;
  batchItems: Array<{ tool: string; preview: string }>;
  expiresAt: string;
}

/**
 * Per-attempt execution metadata for observability.
 * Emitted as part of ChatResult so the chat route can include it in
 * operation events and traces.
 */
export interface AttemptInfo {
  attempt: number;
  toolMode: ToolMode;
  finishReason?: string;
  retryReason?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

/**
 * Structured handoff card for bulk-detected requests (ADR-049 §6).
 * Appended server-side when the bulk-commit gate fires — the model's prose
 * provides analysis; the handoff card provides the action.
 */
export interface HandoffCard {
  type: "sync_handoff";
  target: "start_sync";
  route: "/start/import";
  summary: string;
  detectedEntityCount?: number;
}

/**
 * Structured return from GeminiEngine.chat().
 * `text` is the model's response; `proposals` contains any staged
 * mutations that need Admiral approval before being applied.
 */
export interface ChatResult {
  text: string;
  proposals: ProposalSummary[];
  /** Names of tools that were auto-executed (not staged as proposals). */
  executedTools?: string[];
  /** Diagnostic info from the Gemini response (only set on empty/blocked responses). */
  diagnostics?: Record<string, unknown>;
  /** Tool mode used for this call. */
  toolMode?: ToolMode;
  /** Per-attempt execution metadata for observability. */
  attempts?: AttemptInfo[];
  /** Structured handoff when bulk-commit gate fires (ADR-049). */
  handoff?: HandoffCard;
}

/** Callback for recording token usage (ADR-048 Phase A, #236). */
export type TokenUsageCallback = (
  userId: string, modelId: string, operation: string,
  inputTokens: number, outputTokens: number,
) => void;

/** Internal session state for a Gemini chat session. */
export interface SessionState {
  chat: Chat;
  history: Array<{ role: string; text: string }>;
  /** Compressed context from summarized older turns (#244) */
  summary: string | null;
  lastAccess: number;
}
