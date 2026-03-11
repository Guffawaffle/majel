/**
 * claude/index.ts — Claude Chat Engine via Vertex AI
 *
 * ADR-041 Phase 3: Implements ChatEngine for Anthropic Claude models
 * using the @anthropic-ai/vertex-sdk. Claude's API is stateless, so
 * session management (history, TTL, turn limits) is handled here.
 *
 * Majel — STFC Fleet Intelligence System
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  Message,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { log } from "../../logger.js";
import { type MicroRunner, VALIDATION_DISCLAIMER } from "../micro-runner.js";
import {
  type ToolEnv,
  type ToolContextFactory,
  FLEET_TOOL_DECLARATIONS,
  executeFleetTool,
} from "../fleet-tools/index.js";
import { toClaudeTools } from "../fleet-tools/claude-tool-adapter.js";
import { getTrustLevel, isMutationTool } from "../fleet-tools/trust.js";
import type { ProposalStoreFactory } from "../../stores/proposal-store.js";
import type { BatchItem } from "../../stores/proposal-store.js";
import type { UserSettingsStore } from "../../stores/user-settings-store.js";
import { MODEL_REGISTRY_MAP } from "../gemini/model-registry.js";
import { buildSystemPrompt } from "../gemini/system-prompt.js";
import { sanitizeForModel } from "../gemini/sanitize.js";
import { canonicalStringify } from "../../util/canonical-json.js";
import { createHash } from "node:crypto";
import type { ChatEngine } from "../engine.js";
import type { FleetConfig, ImagePart, ChatResult, ProposalSummary } from "../gemini/index.js";

// ─── Constants ────────────────────────────────────────────────

/** Default session TTL: 30 minutes */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Max turns per session before oldest are dropped */
const SESSION_MAX_TURNS = 50;
/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** Max rounds of tool calling before forcing a text response */
const MAX_TOOL_ROUNDS = 5;
/** Max mutations per chat message */
const MAX_MUTATIONS_PER_CHAT = 5;
/** Max field length in sanitized tool responses */
const MAX_FIELD_LENGTH = 500;
/** Max output tokens for Claude responses */
const MAX_TOKENS = 4096;

// ─── Retry helper for transient API errors ────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (attempt < MAX_RETRIES && status != null && RETRYABLE_STATUS.has(status)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.claude.warn({ attempt: attempt + 1, status, delay, label }, "Claude transient error — retrying");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Session State ────────────────────────────────────────────

interface SessionState {
  /** Full conversation history in Claude MessageParam format */
  messages: MessageParam[];
  /** Parallel plain-text history for ChatEngine.getHistory() */
  history: Array<{ role: string; text: string }>;
  lastAccess: number;
}

// ─── Engine Factory ───────────────────────────────────────────

export function createClaudeEngine(
  projectId: string,
  region: string,
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
  microRunner?: MicroRunner | null,
  initialModelId?: string | null,
  toolContextFactory?: ToolContextFactory | null,
  proposalStoreFactory?: ProposalStoreFactory | null,
  _userSettingsStore?: UserSettingsStore | null,
): ChatEngine {
  if (!projectId) {
    throw new Error("VERTEX_PROJECT_ID is required — cannot create Claude engine without it");
  }
  if (!region) {
    throw new Error("VERTEX_REGION is required — cannot create Claude engine without it");
  }

  const client = new AnthropicVertex({ projectId, region });

  const hasToolContext = !!toolContextFactory;
  const systemPrompt = buildSystemPrompt(fleetConfig, dockBriefing, hasToolContext);

  // Convert Gemini tool declarations to Claude format
  const claudeTools: Tool[] | undefined = hasToolContext
    ? toClaudeTools(FLEET_TOOL_DECLARATIONS) as unknown as Tool[]
    : undefined;

  let currentModelId = initialModelId && MODEL_REGISTRY_MAP.has(initialModelId)
    ? initialModelId
    : "claude-sonnet-4-5";

  const sessions = new Map<string, SessionState>();

  /** Per-session mutex: prevents concurrent chat() calls from corrupting history */
  const sessionLocks = new Map<string, Promise<void>>();
  function withSessionLock(sessionId: string, fn: () => Promise<ChatResult>): Promise<ChatResult> {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    sessionLocks.set(sessionId, next);
    return prev.then(fn).finally(() => release());
  }

  log.claude.debug({
    model: currentModelId,
    projectId,
    region,
    hasFleetConfig: !!fleetConfig,
    hasMicroRunner: !!microRunner,
    hasToolContext,
    toolCount: hasToolContext ? FLEET_TOOL_DECLARATIONS.length : 0,
    promptLen: systemPrompt.length,
  }, "init");

  /** Get or create a session by ID */
  function getSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        messages: [],
        history: [],
        lastAccess: Date.now(),
      };
      sessions.set(sessionId, state);
      log.claude.debug({ sessionId, totalSessions: sessions.size }, "session:create");
    }
    state.lastAccess = Date.now();
    return state;
  }

  /** Record a turn pair and enforce the turn limit. */
  function recordTurn(session: SessionState, userMsg: string, modelMsg: string): void {
    session.history.push({ role: "user", text: userMsg });
    session.history.push({ role: "model", text: modelMsg });

    if (session.history.length > SESSION_MAX_TURNS * 2) {
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }
      // Also trim the Claude messages array to stay in sync.
      // Each turn = 2 MessageParam entries (user + assistant).
      while (session.messages.length > SESSION_MAX_TURNS * 2) {
        session.messages.splice(0, 2);
      }
    }
  }

  /** Remove expired sessions */
  function cleanupSessions(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, state] of sessions) {
      if (id !== "default" && now - state.lastAccess > SESSION_TTL_MS) {
        sessions.delete(id);
        sessionLocks.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.claude.debug({ cleaned, remaining: sessions.size }, "session:cleanup");
    }
  }

  // Periodic cleanup (only in non-test environments)
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const cleanupTimer = isTest ? null : setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer) cleanupTimer.unref();

  /**
   * Deep-sanitize tool response objects before feeding them to the model.
   * Uses sanitizeForModel() (ADR-040) to strip prompt-injection markers.
   */
  function sanitizeToolResponse(obj: unknown): unknown {
    if (typeof obj === "string") {
      let s = sanitizeForModel(obj);
      if (s.length > MAX_FIELD_LENGTH) s = s.slice(0, MAX_FIELD_LENGTH) + "…";
      return s;
    }
    if (Array.isArray(obj)) return obj.map(sanitizeToolResponse);
    if (obj && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = sanitizeToolResponse(v);
      }
      return out;
    }
    return obj;
  }

  /** Generate a human-readable preview string for a mutation tool call. */
  function generatePreview(toolName: string, args: Record<string, unknown>): string {
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
      case "sync_overlay":
        return "Sync overlay data from game export";
      case "sync_research":
        return "Sync research tree snapshot";
      default:
        return `${toolName}(${Object.keys(args).join(", ")})`;
    }
  }

  /**
   * Create a batched proposal from accumulated approve-tier mutations.
   */
  async function createBatchProposal(
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
      log.claude.error({ err: err instanceof Error ? err.message : String(err) }, "proposal:create-failed");
      return null;
    }
  }

  /**
   * Send a messages.create() call to Claude and handle the tool loop.
   *
   * Claude's tool use works differently from Gemini:
   * - Response content is an array of blocks: TextBlock and ToolUseBlock
   * - stop_reason === "tool_use" means the model wants to call tools
   * - We send tool results as a user message with ToolResultBlockParam content
   * - The loop continues until stop_reason !== "tool_use" or max rounds hit
   */
  async function sendAndHandleTools(
    sessionMessages: MessageParam[],
    sessionId: string,
    scopedContext: ToolEnv | null,
    userId: string,
    requestId?: string,
  ): Promise<{ text: string; responseMessages: MessageParam[]; proposals: ProposalSummary[] }> {
    let round = 0;
    let mutationCount = 0;
    const pendingBatch: BatchItem[] = [];
    const proposals: ProposalSummary[] = [];
    const accumulatedMessages: MessageParam[] = [];

    for (;;) {
      round++;
      if (round > MAX_TOOL_ROUNDS + 1) {
        log.claude.warn({ requestId, sessionId, rounds: round - 1 }, "tool:max-rounds");
        break;
      }

      const allMessages = [...sessionMessages, ...accumulatedMessages];

      const response: Message = await withRetry(
        () => client.messages.create({
          model: currentModelId,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: allMessages,
          ...(claudeTools ? { tools: claudeTools } : {}),
        }),
        `claude-chat-round-${round}`,
      );

      // Extract text from content blocks
      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => "text" in b ? (b as { text: string }).text : "").join("");

      // Check for tool use
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

      if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0 || !scopedContext) {
        // No more tool calls — return final text
        // Add the assistant message to accumulated
        accumulatedMessages.push({
          role: "assistant",
          content: response.content as ContentBlockParam[],
        });

        if (pendingBatch.length > 0) {
          await createBatchProposal(pendingBatch, userId, proposals);
        }
        return { text, responseMessages: accumulatedMessages, proposals };
      }

      // ── Handle tool calls ──────────────────────────────
      log.claude.debug({
        requestId,
        sessionId,
        round,
        calls: toolUseBlocks.map((b) => "name" in b ? (b as { name: string }).name : "?"),
      }, "tool:round");

      // Add the assistant message (with tool_use blocks) to history
      accumulatedMessages.push({
        role: "assistant",
        content: response.content as ContentBlockParam[],
      });

      // Execute all tool calls and build tool_result blocks
      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const toolBlock = block as { id: string; name: string; input: unknown };
          const toolName = toolBlock.name;
          const args = toolBlock.input as Record<string, unknown>;

          // ── Trust tier gate for mutation tools ──────────
          if (isMutationTool(toolName)) {
            const trustLevel = await getTrustLevel(
              toolName,
              userId,
              scopedContext.deps.userSettingsStore,
            );

            if (trustLevel === "block") {
              return {
                type: "tool_result" as const,
                tool_use_id: toolBlock.id,
                content: JSON.stringify({
                  tool: toolName,
                  blocked: true,
                  error: `Tool "${toolName}" is blocked. The Admiral must unlock it in fleet settings (fleet.trust) before it can be used.`,
                }),
                is_error: true,
              };
            }

            if (trustLevel === "approve") {
              mutationCount++;
              if (mutationCount > MAX_MUTATIONS_PER_CHAT) {
                return {
                  type: "tool_result" as const,
                  tool_use_id: toolBlock.id,
                  content: JSON.stringify({ error: "Mutation limit reached for this message. Ask the Admiral to confirm before proceeding." }),
                  is_error: true,
                };
              }
              const preview = generatePreview(toolName, args);
              pendingBatch.push({ tool: toolName, args, preview });
              return {
                type: "tool_result" as const,
                tool_use_id: toolBlock.id,
                content: JSON.stringify({
                  tool: toolName,
                  staged: true,
                  message: `Staged for Admiral approval: ${preview}`,
                }),
              };
            }

            // trustLevel === "auto" — fall through to execute
            mutationCount++;
            if (mutationCount > MAX_MUTATIONS_PER_CHAT) {
              return {
                type: "tool_result" as const,
                tool_use_id: toolBlock.id,
                content: JSON.stringify({ error: "Mutation limit reached for this message. Ask the Admiral to confirm before proceeding." }),
                is_error: true,
              };
            }
          }

          // Execute tool (read-only tools and auto-trust mutations)
          const result = await executeFleetTool(toolName, args, scopedContext);
          const resultObj = result as Record<string, unknown>;
          if (resultObj.error) {
            log.claude.warn({ requestId, tool: toolName, args, error: resultObj.error }, "tool:result:error");
          } else {
            log.claude.debug({ requestId, tool: toolName, args, ok: true }, "tool:result:ok");
          }

          return {
            type: "tool_result" as const,
            tool_use_id: toolBlock.id,
            content: JSON.stringify(sanitizeToolResponse(result)),
          };
        }),
      );

      // Send tool results as a user message
      accumulatedMessages.push({
        role: "user",
        content: toolResults,
      });
    }

    // Fallback: max rounds exceeded — ask model to summarize
    const allMessages = [...sessionMessages, ...accumulatedMessages];
    allMessages.push({ role: "user", content: "Please provide a text response summarizing the tool results." });

    const fallbackResponse = await client.messages.create({
      model: currentModelId,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: allMessages,
    });

    const fallbackText = fallbackResponse.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? (b as { text: string }).text : "")
      .join("");

    if (pendingBatch.length > 0) {
      await createBatchProposal(pendingBatch, userId, proposals);
    }

    accumulatedMessages.push({ role: "user", content: "Please provide a text response summarizing the tool results." });
    accumulatedMessages.push({ role: "assistant", content: fallbackResponse.content as ContentBlockParam[] });

    return { text: fallbackText, responseMessages: accumulatedMessages, proposals };
  }

  /** Build user content: text only, or multimodal with image */
  function buildUserContent(text: string, image?: ImagePart): string | ContentBlockParam[] {
    if (!image) return text;
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.inlineData.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: image.inlineData.data,
        },
      },
      { type: "text" as const, text },
    ];
  }

  // ─── ChatEngine implementation ──────────────────────────────

  return {
    async chat(message: string, sessionId = "default", image?: ImagePart, userId?: string, requestId?: string): Promise<ChatResult> {
      const sessionKey = userId ? `${userId}:${sessionId}` : sessionId;
      return withSessionLock(sessionKey, async () => {
        const session = getSession(sessionKey);
        log.claude.debug({ requestId, sessionId: sessionKey, messageLen: message.length, hasImage: !!image, historyLen: session.history.length, userId }, "chat:send");

        const scopedContext = hasToolContext ? toolContextFactory!.forUser(userId ?? "local") : null;
        const effectiveUserId = userId ?? "local";

        const userContent = buildUserContent(message, image);

        // ── MicroRunner pipeline (optional) ──────────────────
        if (microRunner) {
          const startTime = Date.now();
          const { contract, gatedContext, augmentedMessage } = await microRunner.prepare(message);

          const augmentedContent = buildUserContent(augmentedMessage, image);
          session.messages.push({ role: "user", content: augmentedContent });

          const { text: responseText, responseMessages, proposals } = await sendAndHandleTools(
            session.messages,
            sessionKey,
            scopedContext,
            effectiveUserId,
            requestId,
          );

          // Merge tool-loop messages into session
          // Remove last user message (we already added it), then add all accumulated
          session.messages.pop();
          session.messages.push(...responseMessages.length > 0 ? [{ role: "user" as const, content: augmentedContent }, ...responseMessages.slice(0, -1)] : [{ role: "user" as const, content: augmentedContent }]);
          // Keep only the final assistant text message in session
          session.messages.push({ role: "assistant", content: responseText });

          // Validate response against contract
          let finalText = responseText;
          const validation = await microRunner.validate(
            finalText, contract, gatedContext, sessionKey, startTime, message,
          );
          const receipt = validation.receipt;

          if (validation.needsRepair && validation.repairPrompt) {
            log.claude.debug({ sessionId: sessionKey, violations: receipt.validationDetails }, "microrunner:repair");
            session.messages.push({ role: "user", content: validation.repairPrompt });

            const repairResponse = await client.messages.create({
              model: currentModelId,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages: session.messages,
            });

            finalText = repairResponse.content
              .filter((b) => b.type === "text")
              .map((b) => "text" in b ? (b as { text: string }).text : "")
              .join("");

            session.messages.push({ role: "assistant", content: finalText });
            receipt.repairAttempted = true;

            const revalidation = await microRunner.validate(
              finalText, contract, gatedContext, sessionKey, startTime, message,
            );
            receipt.validationResult = revalidation.receipt.validationResult === "pass" ? "repaired" : "fail";
            receipt.validationDetails = revalidation.receipt.validationDetails;
            receipt.durationMs = Date.now() - startTime;

            if (receipt.validationResult === "fail") {
              finalText = `${VALIDATION_DISCLAIMER}\n\n${finalText}`;
            }
          }

          microRunner.finalize(receipt);
          recordTurn(session, message, finalText);
          log.claude.debug({ requestId, sessionId: sessionKey, responseLen: finalText.length, historyLen: session.history.length }, "chat:recv");
          return { text: finalText, proposals };
        }

        // ── Standard path (no MicroRunner) ────────────────────
        session.messages.push({ role: "user", content: userContent });

        const { text: responseText, proposals } = await sendAndHandleTools(
          session.messages,
          sessionKey,
          scopedContext,
          effectiveUserId,
          requestId,
        );

        // Rebuild session messages: replace what we pushed with the full exchange
        session.messages.pop(); // remove the user message we pushed
        session.messages.push({ role: "user", content: userContent });
        // If there were tool exchanges, we only keep the final user+assistant pair
        // to avoid bloating session with intermediate tool messages.
        // The full tool exchange happened within sendAndHandleTools.
        session.messages.push({ role: "assistant", content: responseText });

        recordTurn(session, image ? `[image: ${image.inlineData.mimeType}] ${message}` : message, responseText);

        log.claude.debug({ requestId, sessionId: sessionKey, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
        return { text: responseText, proposals };
      }); // end withSessionLock
    },

    getHistory(sessionId = "default"): Array<{ role: string; text: string }> {
      const session = sessions.get(sessionId);
      return session ? [...session.history] : [];
    },

    getSessionCount(): number {
      return sessions.size;
    },

    closeSession(sessionId: string): void {
      const deleted = sessions.delete(sessionId);
      sessionLocks.delete(sessionId);
      if (deleted) {
        log.claude.debug({ sessionId, remaining: sessions.size }, "session:close");
      }
    },

    getModel(): string {
      return currentModelId;
    },

    setModel(modelId: string): void {
      if (!MODEL_REGISTRY_MAP.has(modelId)) {
        throw new Error(`Unknown model: ${modelId}. Valid Claude models: ${[...MODEL_REGISTRY_MAP.keys()].filter((k) => MODEL_REGISTRY_MAP.get(k)!.provider === "claude").join(", ")}`);
      }
      if (modelId === currentModelId) return;

      const previousModel = currentModelId;
      currentModelId = modelId;

      const sessionCount = sessions.size;
      sessions.clear();
      sessionLocks.clear();

      log.claude.info({ previousModel, newModel: modelId, sessionsCleared: sessionCount }, "model:switch");
    },

    close(): void {
      if (cleanupTimer) clearInterval(cleanupTimer);
      sessions.clear();
      sessionLocks.clear();
      log.claude.debug("engine:close");
    },
  };
}
