/**
 * gemini/tool-dispatch.ts — Tool call execution loop & utilities
 *
 * Extracted from gemini/index.ts. Handles the multi-round function call
 * loop, trust-tier gating, proposal batching, and response sanitization.
 */

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Part, FunctionCall } from "@google/genai";
import { log } from "../../logger.js";
import type { ToolEnv } from "../fleet-tools/index.js";
import { executeFleetTool } from "../fleet-tools/index.js";
import { getTrustLevel, isMutationTool } from "../fleet-tools/trust.js";
import type { ProposalStoreFactory, BatchItem } from "../../stores/proposal-store.js";
import { sanitizeForModel } from "./sanitize.js";
import { canonicalStringify } from "../../util/canonical-json.js";
import type {
  SessionState,
  ProposalSummary,
  ChatResult,
  TokenUsageCallback,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

/** Max rounds of function calling before forcing a text response. */
export const MAX_TOOL_ROUNDS = 5;
/** Per-call timeout for sendMessage inside the tool loop (#233). */
export const TOOL_CALL_TIMEOUT_MS = 30_000;
/** Max string field length in sanitized tool responses. */
export const MAX_FIELD_LENGTH = 500;
/** Max mutation tool calls per single chat message. */
export const MAX_MUTATIONS_PER_CHAT = 5;

// ─── Types ──────────────────────────────────────────────────────

/** Minimal shape of a Gemini sendMessage result used by the tool dispatch loop. */
export interface SendMessageResult {
  text?: string | null;
  functionCalls?: FunctionCall[] | null;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/** Dependencies injected from the engine into the tool dispatch loop. */
export interface ToolDispatchDeps {
  sendWithCacheRetry: (
    session: SessionState,
    parts: string | Part[],
    label: string,
    timeoutMs?: number,
  ) => Promise<SendMessageResult>;
  proposalStoreFactory?: ProposalStoreFactory | null;
  onTokenUsage?: TokenUsageCallback | null;
  currentModelId: string;
}

// ─── extractResponseDiagnostics ─────────────────────────────────

/** Extract diagnostic info from a Gemini response for logging when the response is empty. */
export function extractResponseDiagnostics(result: unknown): Record<string, unknown> | null {
  const r = result as {
    candidates?: Array<{ finishReason?: string; safetyRatings?: unknown[]; content?: { parts?: Array<{ functionCall?: unknown }> } }>;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  const candidate = r?.candidates?.[0];
  const diag: Record<string, unknown> = {};
  if (candidate?.finishReason) diag.finishReason = candidate.finishReason;
  if (candidate?.safetyRatings) diag.safetyRatings = candidate.safetyRatings;
  if (candidate?.finishReason === "MALFORMED_FUNCTION_CALL" && candidate?.content?.parts) {
    const malformedCalls = candidate.content.parts
      .filter((p) => p.functionCall != null)
      .map((p) => p.functionCall);
    if (malformedCalls.length > 0) diag.malformedFunctionCalls = malformedCalls;
  }
  if (r?.promptFeedback?.blockReason) {
    diag.blockReason = r.promptFeedback.blockReason;
    if (r.promptFeedback.blockReasonMessage) diag.blockReasonMessage = r.promptFeedback.blockReasonMessage;
  }
  if (!r?.candidates?.length) diag.noCandidates = true;
  return Object.keys(diag).length > 0 ? diag : null;
}

// ─── sanitizeToolResponse ───────────────────────────────────────

/**
 * Deep-sanitize tool response objects before feeding them to the model.
 * Uses sanitizeForModel() (ADR-040) to strip prompt-injection markers.
 * Strips null/undefined/empty-array values to reduce token noise (#261).
 */
export function sanitizeToolResponse(obj: unknown): unknown {
  if (typeof obj === "string") {
    let s = sanitizeForModel(obj);
    if (s.length > MAX_FIELD_LENGTH) s = s.slice(0, MAX_FIELD_LENGTH) + "…";
    return s;
  }
  if (Array.isArray(obj)) {
    const mapped = obj.map(sanitizeToolResponse);
    return mapped;
  }
  if (obj === null || obj === undefined) return undefined;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      const sanitized = sanitizeToolResponse(v);
      if (Array.isArray(sanitized) && sanitized.length === 0) continue;
      if (sanitized === undefined) continue;
      out[k] = sanitized;
    }
    return out;
  }
  return obj; // numbers, booleans
}

// ─── generatePreview ────────────────────────────────────────────

/** Generate a human-readable preview string for a mutation tool call. */
export function generatePreview(toolName: string, args: Record<string, unknown>): string {
  /** Sanitize + truncate a single arg value for preview interpolation. */
  const s = (v: unknown): string => {
    const raw = String(v ?? "?");
    const clean = sanitizeForModel(raw);
    return clean.length > 100 ? clean.slice(0, 100) + "…" : clean;
  };

  switch (toolName) {
    case "create_bridge_core":
      return `Create bridge core "${s(args.name)}" — Captain: ${s(args.captain)}, Bridge: ${s(args.bridge_1)} + ${s(args.bridge_2)}`;
    case "create_loadout":
      return `Create loadout "${s(args.name)}" for ship ${s(args.ship_id)}`;
    case "create_variant":
      return `Create variant "${s(args.name)}" on loadout ${s(args.loadout_id)}`;
    case "assign_dock":
      return `Assign dock ${s(args.dock_number)} → loadout ${s(args.loadout_id ?? args.variant_id)}`;
    case "update_dock":
      return `Update dock plan item ${s(args.plan_item_id)}`;
    case "remove_dock_assignment":
      return `Clear dock ${s(args.dock_number)} assignment`;
    case "set_reservation":
      return args.reserved_for
        ? `Reserve officer ${s(args.officer_id)} for ${s(args.reserved_for)}`
        : `Clear reservation for officer ${s(args.officer_id)}`;
    case "set_officer_overlay":
      return `Add officer ${s(args.officer_id)} to your fleet`;
    case "set_ship_overlay":
      return `Add ship ${s(args.ship_id)} to your fleet`;
    case "sync_overlay":
      return "Sync overlay data from game export";
    case "sync_research":
      return "Sync research tree snapshot";
    default:
      return `${toolName}(${Object.keys(args).join(", ")})`;
  }
}

// ─── createBatchProposal ────────────────────────────────────────

/**
 * Create a batched proposal from accumulated approve-tier mutations.
 * Returns the proposal summary if created, null if proposal store unavailable.
 */
export async function createBatchProposal(
  proposalStoreFactory: ProposalStoreFactory | null | undefined,
  batch: BatchItem[],
  userId: string,
  proposals: ProposalSummary[],
): Promise<ProposalSummary | null> {
  if (!proposalStoreFactory || batch.length === 0) return null;

  try {
    const proposalStore = proposalStoreFactory.forUser(userId);
    const argsHash = createHash("sha256")
      .update(canonicalStringify(batch))
      .digest("hex");

    const proposal = await proposalStore.create({
      tool: "_batch",
      argsJson: { batchItems: batch },
      argsHash,
      proposalJson: {
        summary: batch.map((b) => b.preview).join("; "),
        itemCount: batch.length,
      },
      batchItems: batch,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    const summary: ProposalSummary = {
      id: proposal.id,
      batchItems: batch.map((b) => ({ tool: b.tool, preview: b.preview })),
      expiresAt: proposal.expiresAt,
    };
    proposals.push(summary);
    return summary;
  } catch (err) {
    log.gemini.error({ err: err instanceof Error ? err.message : String(err) }, "proposal:create-failed");
    return null;
  }
}

// ─── handleFunctionCalls ────────────────────────────────────────

/**
 * Handle the function call loop: execute tool calls, send responses back,
 * repeat until Gemini produces a text response.
 *
 * Trust-aware (#93): checks each mutation tool against the trust tier system.
 * - auto:    Execute immediately
 * - approve: Stage into a batched proposal for Admiral approval
 * - block:   Reject with error — tool must be explicitly unlocked in settings
 *
 * Returns ChatResult with text + any staged proposals.
 */
export async function handleFunctionCalls(
  deps: ToolDispatchDeps,
  session: SessionState,
  initialFunctionCalls: FunctionCall[],
  sessionId: string,
  scopedContext: ToolEnv,
  userId: string,
  requestId?: string,
  isCancelled?: () => boolean,
): Promise<ChatResult> {
  let functionCalls = initialFunctionCalls;
  let round = 0;
  let mutationCount = 0;
  const pendingBatch: BatchItem[] = [];
  const proposals: ProposalSummary[] = [];
  const executedTools: string[] = [];

  while (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
    // Check cancellation at the top of each round (#232)
    if (isCancelled?.()) {
      log.gemini.info({ requestId, sessionId, round }, "tool:cancelled");
      if (pendingBatch.length > 0) {
        await createBatchProposal(deps.proposalStoreFactory, pendingBatch, userId, proposals);
      }
      return { text: "I was interrupted before finishing. Here's what I had so far.", proposals, executedTools };
    }

    round++;
    log.gemini.debug({
      requestId,
      sessionId,
      round,
      calls: functionCalls.map((fc) => fc.name),
    }, "tool:round");

    // Execute all function calls in parallel
    const responses = await Promise.all(
      functionCalls.map(async (fc) => {
        const toolName = fc.name!;
        const args = fc.args as Record<string, unknown>;

        // ── Trust tier gate for mutation tools ──────────────
        if (isMutationTool(toolName)) {
          // Detect overlay creation vs update (ADR-049 Slice 2, ADR-051 Slice 1)
          let isCreate: boolean | undefined;
          if (toolName === "set_officer_overlay" && scopedContext.deps.overlayStore) {
            const refId = typeof args.officer_id === "string" ? args.officer_id : undefined;
            if (refId) {
              // Resolve instance_id: "new" → generated ID (ADR-051)
              let instanceId = typeof args.instance_id === "string" ? args.instance_id : undefined;
              if (instanceId === "new") {
                instanceId = `inst_${nanoid()}`;
                args.instance_id = instanceId;
                isCreate = true;
              } else {
                const effective = instanceId ?? "primary";
                const existing = await scopedContext.deps.overlayStore.getOfficerOverlay(refId, effective);
                isCreate = existing === null;
              }
            }
          } else if (toolName === "set_ship_overlay" && scopedContext.deps.overlayStore) {
            const refId = typeof args.ship_id === "string" ? args.ship_id : undefined;
            if (refId) {
              // Resolve instance_id: "new" → generated ID (ADR-051)
              let instanceId = typeof args.instance_id === "string" ? args.instance_id : undefined;
              if (instanceId === "new") {
                instanceId = `inst_${nanoid()}`;
                args.instance_id = instanceId;
                isCreate = true;
              } else {
                const effective = instanceId ?? "primary";
                const existing = await scopedContext.deps.overlayStore.getShipOverlay(refId, effective);
                isCreate = existing === null;
              }
            }
          }

          const trustLevel = await getTrustLevel(
            toolName,
            userId,
            scopedContext.deps.userSettingsStore,
            isCreate,
          );

          if (trustLevel === "block") {
            return {
              functionResponse: {
                name: toolName,
                response: {
                  tool: toolName,
                  blocked: true,
                  error: `Tool "${toolName}" is blocked. The Admiral must unlock it in fleet settings (fleet.trust) before it can be used.`,
                },
              },
            } as Part;
          }

          if (trustLevel === "approve") {
            mutationCount++;
            if (mutationCount > MAX_MUTATIONS_PER_CHAT) {
              return {
                functionResponse: {
                  name: toolName,
                  response: { error: "Mutation limit reached for this message. Ask the Admiral to confirm before proceeding." },
                },
              } as Part;
            }
            // Stage for batched proposal instead of executing
            const preview = generatePreview(toolName, args);
            pendingBatch.push({ tool: toolName, args, preview });
            return {
              functionResponse: {
                name: toolName,
                response: {
                  tool: toolName,
                  staged: true,
                  message: `Staged for Admiral approval: ${preview}`,
                },
              },
            } as Part;
          }

          // trustLevel === "auto" — fall through to execute
          mutationCount++;
          if (mutationCount > MAX_MUTATIONS_PER_CHAT) {
            return {
              functionResponse: {
                name: toolName,
                response: { error: "Mutation limit reached for this message. Ask the Admiral to confirm before proceeding." },
              },
            } as Part;
          }
        }

        // Execute tool (read-only tools and auto-trust mutations)
        if (isMutationTool(toolName)) executedTools.push(toolName);
        const result = await executeFleetTool(toolName, args, scopedContext);
        // Diagnostic: log tool call args + outcome for tracing (#diag)
        const resultObj = result as Record<string, unknown>;
        if (resultObj.error) {
          log.gemini.warn({ requestId, tool: toolName, args, error: resultObj.error }, "tool:result:error");
        } else {
          log.gemini.debug({ requestId, tool: toolName, args, ok: true }, "tool:result:ok");
        }
        return {
          functionResponse: {
            name: toolName,
            response: sanitizeToolResponse(result) as Record<string, unknown>,
          },
        } as Part;
      }),
    );

    // Send function responses back to the model (with per-call timeout #233)
    // Uses sendWithCacheRetry for cache-expiry resilience (ADR-049 §1a)
    const result = await deps.sendWithCacheRetry(session, responses, "tool-loop", TOOL_CALL_TIMEOUT_MS);
    if (result.usageMetadata) {
      log.gemini.info({ requestId, sessionId, round, ...result.usageMetadata }, "token:usage");
      deps.onTokenUsage?.(userId, deps.currentModelId, "tool_call", result.usageMetadata.promptTokenCount ?? 0, result.usageMetadata.candidatesTokenCount ?? 0);
    }
    const nextCalls = result.functionCalls;

    if (nextCalls && nextCalls.length > 0) {
      functionCalls = nextCalls;
      continue;
    }

    // Model produced a text response — create proposal if needed, then return
    const text = result.text ?? "";
    if (!text) {
      const diag = extractResponseDiagnostics(result);
      log.gemini.warn({ requestId, sessionId, round, diagnostics: diag }, "tool:empty-text");
    }
    if (pendingBatch.length > 0) {
      const proposal = await createBatchProposal(deps.proposalStoreFactory, pendingBatch, userId, proposals);
      if (proposal) {
        log.gemini.debug({ proposalId: proposal.id, items: pendingBatch.length }, "proposal:created");
      }
    }
    return { text, proposals, executedTools };
  }

  // Safety: max rounds exceeded — force a text response
  if (round >= MAX_TOOL_ROUNDS) {
    log.gemini.warn({ requestId, sessionId, rounds: round }, "tool:max-rounds");
  }

  // If we get here with no text, ask the model to summarize (with timeout #233)
  let text = "";
  try {
    // Uses sendWithCacheRetry for cache-expiry resilience (ADR-049 §1a)
    const summaryResult = await deps.sendWithCacheRetry(
      session,
      "Please provide a text response summarizing the tool results.",
      "tool-fallback-summary",
      TOOL_CALL_TIMEOUT_MS,
    );
    if (summaryResult.usageMetadata) {
      log.gemini.info({ requestId, sessionId, round, ...summaryResult.usageMetadata }, "token:usage:fallback");
      deps.onTokenUsage?.(userId, deps.currentModelId, "fallback", summaryResult.usageMetadata.promptTokenCount ?? 0, summaryResult.usageMetadata.candidatesTokenCount ?? 0);
    }
    // Guard: if model still returns function calls instead of text, use hardcoded message (#230)
    if (summaryResult.functionCalls && summaryResult.functionCalls.length > 0) {
      log.gemini.warn({ requestId, sessionId, rounds: round }, "tool:fallback-still-has-calls");
      text = "I used several tools to research your question but ran out of processing rounds. Please try rephrasing or breaking your question into smaller parts.";
    } else {
      text = summaryResult.text ?? "";
    }
    if (!text) {
      log.gemini.warn({ requestId, sessionId, rounds: round }, "tool:empty-text:fallback");
      text = "I processed your request but wasn't able to generate a summary. Please try again.";
    }
  } catch (err) {
    log.gemini.warn({ requestId, sessionId, err: err instanceof Error ? err.message : String(err) }, "tool:fallback-timeout");
    text = "I used several tools to research your question but the final summary timed out. Please try again.";
  }

  // Create proposal for any batched items even in the fallback path
  if (pendingBatch.length > 0) {
    await createBatchProposal(deps.proposalStoreFactory, pendingBatch, userId, proposals);
  }
  return { text, proposals, executedTools };
}
