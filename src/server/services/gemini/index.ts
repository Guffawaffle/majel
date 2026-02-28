/**
 * gemini/index.ts — Gemini Engine (barrel + engine implementation)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Architecture: full roster CSV injected into system prompt as context.
 * The model has unrestricted access to its training knowledge — the roster
 * is supplementary intelligence, not a constraint.
 *
 * See docs/PROMPT_GUIDE.md for tuning strategy.
 */

import { createHash } from "node:crypto";
import {
  GoogleGenAI,
  type Chat,
  type Part,
  type FunctionCall,
  type GenerateContentConfig,
  type Content,
} from "@google/genai";
import { log } from "../../logger.js";
import { type MicroRunner, VALIDATION_DISCLAIMER } from "../micro-runner.js";
import {
  type ToolContext,
  type ToolContextFactory,
  FLEET_TOOL_DECLARATIONS,
  executeFleetTool,
} from "../fleet-tools/index.js";
import { getTrustLevel, isMutationTool } from "../fleet-tools/trust.js";
import type { ProposalStoreFactory } from "../../stores/proposal-store.js";
import type { BatchItem } from "../../stores/proposal-store.js";
import type { UserSettingsStore } from "../../stores/user-settings-store.js";
import { MODEL_REGISTRY, MODEL_REGISTRY_MAP, resolveModelId } from "./model-registry.js";
import { buildSystemPrompt, SAFETY_SETTINGS } from "./system-prompt.js";

// ─── Retry helper for transient Gemini API errors ─────────────

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
      const status = (err as { status?: number }).status ?? (err as { httpStatusCode?: number }).httpStatusCode;
      if (attempt < MAX_RETRIES && status != null && RETRYABLE_STATUS.has(status)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.gemini.warn({ attempt: attempt + 1, status, delay, label }, "Gemini transient error — retrying");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Re-exports (preserve existing import paths) ──────────────

export { MODEL_REGISTRY, MODEL_REGISTRY_MAP, getModelDef, resolveModelId, DEFAULT_MODEL } from "./model-registry.js";
export type { ModelDef } from "./model-registry.js";
export {
  buildSystemPrompt,
  SAFETY_SETTINGS,
  DEFAULT_INTENT_CONFIG,
  resolveIntentConfig,
} from "./system-prompt.js";
export type { IntentMode, IntentConfig } from "./system-prompt.js";

// ─── Engine Types ─────────────────────────────────────────────

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
 * Structured return from GeminiEngine.chat().
 * `text` is the model's response; `proposals` contains any staged
 * mutations that need Admiral approval before being applied.
 */
export interface ChatResult {
  text: string;
  proposals: ProposalSummary[];
}

export interface GeminiEngine {
  /** Send a message and get the structured response. Optional sessionId for isolation. Optional image attachment. Optional userId for user-scoped tool access (#85). */
  chat(message: string, sessionId?: string, image?: ImagePart, userId?: string): Promise<ChatResult>;
  /** Get the full conversation history. Optional sessionId (default: "default"). */
  getHistory(sessionId?: string): Array<{ role: string; text: string }>;
  /** Get the number of active sessions. */
  getSessionCount(): number;
  /** Close a specific session and free its resources. */
  closeSession(sessionId: string): void;
  /** Get the current model ID. */
  getModel(): string;
  /** Hot-swap the model. Clears all sessions (new model = fresh context). */
  setModel(modelId: string): void;
  /** Clean up resources (cleanup timer). Call on shutdown or in tests. */
  close(): void;
}

// ─── Constants ────────────────────────────────────────────────

/** Default session TTL: 30 minutes */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Max turns per session before oldest are dropped */
const SESSION_MAX_TURNS = 50;
/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionState {
  chat: Chat;
  history: Array<{ role: string; text: string }>;
  lastAccess: number;
}

// ─── Engine Implementation ────────────────────────────────────

/**
 * Create a Gemini chat engine with fleet data context baked in.
 *
 * Session isolation:
 * - Each sessionId gets its own Chat with independent history
 * - Default (no sessionId) uses "default" session for backward compat
 * - Sessions expire after 30min of inactivity (configurable via SESSION_TTL_MS)
 * - Each session capped at 50 turns (configurable via SESSION_MAX_TURNS)
 *
 * Configuration:
 * - Safety settings: all filters off (personal tool, not public product)
 * - System instruction: full prompt with fleet data context
 * - Temperature: not set (uses model default ~1.0 for Flash-Lite)
 */
export function createGeminiEngine(
  apiKey: string,
  fleetConfig?: FleetConfig | null,
  dockBriefing?: string | null,
  microRunner?: MicroRunner | null,
  initialModelId?: string | null,
  toolContextFactory?: ToolContextFactory | null,
  proposalStoreFactory?: ProposalStoreFactory | null,
  _userSettingsStore?: UserSettingsStore | null,
): GeminiEngine {
  // I5: Fail fast with clear message if API key is missing
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required — cannot create Gemini engine without it");
  }

  const ai = new GoogleGenAI({ apiKey });
  // Build tools array if tool context factory is available
  const hasToolContext = !!toolContextFactory;
  const systemInstruction = buildSystemPrompt(fleetConfig, dockBriefing, hasToolContext);

  let currentModelId = resolveModelId(initialModelId);

  const tools = hasToolContext
    ? [{ functionDeclarations: FLEET_TOOL_DECLARATIONS }]
    : undefined;

  /** Build a GenerateContentConfig shared by all chat sessions for this engine. */
  function buildChatConfig(): GenerateContentConfig {
    return {
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
      ...(tools ? { tools } : {}),
      // Disable automatic function calling — we handle the tool loop ourselves
      automaticFunctionCalling: { disable: true },
    };
  }

  let chatConfig = buildChatConfig();
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

  log.gemini.debug({
    model: currentModelId,
    hasFleetConfig: !!fleetConfig,
    hasDockBriefing: !!dockBriefing,
    hasMicroRunner: !!microRunner,
    hasToolContext,
    toolCount: hasToolContext ? FLEET_TOOL_DECLARATIONS.length : 0,
    promptLen: systemInstruction.length,
  }, "init");

  /**
   * Convert local history to SDK Content[] format.
   * Used to rebuild Chat when history is trimmed.
   */
  function toSdkHistory(history: Array<{ role: string; text: string }>): Content[] {
    return history.map(h => ({
      role: h.role,
      parts: [{ text: h.text }],
    }));
  }

  /** Create a new Chat session with the current model + config + optional history. */
  function createChat(history?: Content[]): Chat {
    return ai.chats.create({
      model: currentModelId,
      config: chatConfig,
      ...(history ? { history } : {}),
    });
  }

  /**
   * Record a turn pair and enforce the turn limit.
   * When history exceeds SESSION_MAX_TURNS, the oldest pairs are dropped
   * and the SDK Chat is rebuilt from the trimmed history so the
   * SDK's internal buffer stays in sync (prevents unbounded memory/token drift).
   */
  function recordTurnAndTrim(session: SessionState, userMsg: string, modelMsg: string): void {
    session.history.push({ role: "user", text: userMsg });
    session.history.push({ role: "model", text: modelMsg });

    if (session.history.length > SESSION_MAX_TURNS * 2) {
      // Drop oldest turn pairs
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }
      // CRITICAL: Rebuild SDK Chat from trimmed history.
      // Without this, the SDK's internal buffer keeps the full un-trimmed
      // conversation, causing unbounded memory growth and token cost.
      session.chat = createChat(toSdkHistory(session.history));
    }
  }

  /** Get or create a session by ID */
  function getSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        chat: createChat(),
        history: [],
        lastAccess: Date.now(),
      };
      sessions.set(sessionId, state);
      log.gemini.debug({ sessionId, totalSessions: sessions.size }, "session:create");
    }
    state.lastAccess = Date.now();
    return state;
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
      log.gemini.debug({ cleaned, remaining: sessions.size }, "session:cleanup");
    }
  }

  // Periodic cleanup (only in non-test environments)
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const cleanupTimer = isTest ? null : setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer) {
    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
  }

  /** Max rounds of function calling before forcing a text response */
  const MAX_TOOL_ROUNDS = 5;

  /**
   * Patterns that could be used for prompt injection via data-poisoned
   * tool responses (e.g., a malicious officer name containing instructions).
   * We sanitize these from all string values before feeding back to the model.
   */
  const INJECTION_PATTERNS = /\[(SYSTEM|CONTEXT|END CONTEXT|INSTRUCTION)[^\]]*\]|<\/?system>|<\/?instruction>/gi;
  const MAX_FIELD_LENGTH = 500;

  /** Deep-sanitize tool response objects before feeding them to the model */
  function sanitizeToolResponse(obj: unknown): unknown {
    if (typeof obj === "string") {
      let s = obj.replace(INJECTION_PATTERNS, "");
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
    return obj; // numbers, booleans, null
  }

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
  const MAX_MUTATIONS_PER_CHAT = 5;

  /** Generate a human-readable preview string for a mutation tool call. */
  function generatePreview(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "create_bridge_core":
        return `Create bridge core "${args.name ?? "?"}" — Captain: ${args.captain ?? "?"}, Bridge: ${args.bridge_1 ?? "?"} + ${args.bridge_2 ?? "?"}`;
      case "create_loadout":
        return `Create loadout "${args.name ?? "?"}" for ship ${args.ship_id ?? "?"}`;
      case "create_variant":
        return `Create variant "${args.name ?? "?"}" on loadout ${args.loadout_id ?? "?"}`;
      case "assign_dock":
        return `Assign dock ${args.dock_number ?? "?"} → loadout ${args.loadout_id ?? args.variant_id ?? "?"}`;
      case "update_dock":
        return `Update dock plan item ${args.plan_item_id ?? "?"}`;
      case "remove_dock_assignment":
        return `Clear dock ${args.dock_number ?? "?"} assignment`;
      case "set_reservation":
        return args.reserved_for
          ? `Reserve officer ${args.officer_id ?? "?"} for ${args.reserved_for}`
          : `Clear reservation for officer ${args.officer_id ?? "?"}`;
      case "sync_overlay":
        return "Sync overlay data from game export";
      case "sync_research":
        return "Sync research tree snapshot";
      default:
        return `${toolName}(${Object.keys(args).join(", ")})`;
    }
  }

  async function handleFunctionCalls(
    chat: Chat,
    initialFunctionCalls: FunctionCall[],
    sessionId: string,
    scopedContext: ToolContext,
    userId: string,
  ): Promise<ChatResult> {
    let functionCalls = initialFunctionCalls;
    let round = 0;
    let mutationCount = 0;
    const pendingBatch: BatchItem[] = [];
    const proposals: ProposalSummary[] = [];

    while (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      round++;
      log.gemini.debug({
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
            const trustLevel = await getTrustLevel(
              toolName,
              userId,
              scopedContext.userSettingsStore,
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
          const result = await executeFleetTool(toolName, args, scopedContext);
          return {
            functionResponse: {
              name: toolName,
              response: sanitizeToolResponse(result) as Record<string, unknown>,
            },
          } as Part;
        }),
      );

      // Send function responses back to the model
      const result = await chat.sendMessage({ message: responses });
      const nextCalls = result.functionCalls;

      if (nextCalls && nextCalls.length > 0) {
        functionCalls = nextCalls;
        continue;
      }

      // Model produced a text response — create proposal if needed, then return
      const text = result.text ?? "";
      if (pendingBatch.length > 0) {
        const proposal = await createBatchProposal(pendingBatch, userId, proposals);
        if (proposal) {
          log.gemini.debug({ proposalId: proposal.id, items: pendingBatch.length }, "proposal:created");
        }
      }
      return { text, proposals };
    }

    // Safety: max rounds exceeded — force a text response
    if (round >= MAX_TOOL_ROUNDS) {
      log.gemini.warn({ sessionId, rounds: round }, "tool:max-rounds");
    }

    // If we get here with no text, ask the model to summarize
    const summaryResult = await chat.sendMessage({
      message: "Please provide a text response summarizing the tool results.",
    });
    const text = summaryResult.text ?? "";

    // Create proposal for any batched items even in the fallback path
    if (pendingBatch.length > 0) {
      await createBatchProposal(pendingBatch, userId, proposals);
    }
    return { text, proposals };
  }

  /**
   * Create a batched proposal from accumulated approve-tier mutations.
   * Returns the proposal summary if created, null if proposal store unavailable.
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
        .update(JSON.stringify(batch))
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

  return {
    async chat(message: string, sessionId = "default", image?: ImagePart, userId?: string): Promise<ChatResult> {
      // #85: Namespace session keys by userId to prevent cross-user session leakage
      const sessionKey = userId ? `${userId}:${sessionId}` : sessionId;
      return withSessionLock(sessionKey, async () => {
      const session = getSession(sessionKey);
      log.gemini.debug({ sessionId: sessionKey, messageLen: message.length, hasImage: !!image, historyLen: session.history.length, userId }, "chat:send");

      // #85: Create user-scoped tool context for this chat call
      const scopedContext = hasToolContext ? toolContextFactory!.forUser(userId ?? "local") : null;
      const effectiveUserId = userId ?? "local";

      // ── Build multimodal message parts (ADR-008) ────────
      // When an image is attached, we build a Part[] array: [imagePart, textPart]
      // The SDK's sendMessage() accepts string | Part[] natively.
      function buildMessageParts(text: string): string | Part[] {
        if (!image) return text;
        return [
          { inlineData: image.inlineData } as Part,
          { text } as Part,
        ];
      }

      // ── MicroRunner pipeline (optional) ──────────────────
      if (microRunner) {
        const startTime = Date.now();
        const { contract, gatedContext, augmentedMessage } = await microRunner.prepare(message);

        // Send augmented message (with gated context prepended)
        // Image attached on first message only (augmentedMessage includes gated context)
        const result = await withRetry(
          () => session.chat.sendMessage({ message: buildMessageParts(augmentedMessage) }),
          "micro-runner",
        );

        // Check for function calls before text extraction
        let responseText: string;
        let chatProposals: ProposalSummary[] = [];
        const functionCalls = hasToolContext ? result.functionCalls : undefined;

        if (functionCalls && functionCalls.length > 0) {
          // Handle function call loop — tool results feed back to model
          const chatResult = await handleFunctionCalls(session.chat, functionCalls, sessionKey, scopedContext!, effectiveUserId);
          responseText = chatResult.text;
          chatProposals = chatResult.proposals;
        } else {
          responseText = result.text ?? "";
        }

        // Validate response against contract
        const validation = await microRunner.validate(
          responseText, contract, gatedContext, sessionKey, startTime, message,
        );
        const receipt = validation.receipt;

        // Single repair pass if validation failed
        if (validation.needsRepair && validation.repairPrompt) {
          log.gemini.debug({ sessionId: sessionKey, violations: receipt.validationDetails }, "microrunner:repair");
          const repairResult = await session.chat.sendMessage({ message: validation.repairPrompt });
          responseText = repairResult.text ?? "";
          receipt.repairAttempted = true;

          // Re-validate the repaired response
          const revalidation = await microRunner.validate(
            responseText, contract, gatedContext, sessionKey, startTime, message,
          );
          receipt.validationResult = revalidation.receipt.validationResult === "pass" ? "repaired" : "fail";
          receipt.validationDetails = revalidation.receipt.validationDetails;
          receipt.durationMs = Date.now() - startTime;

          // If still failing after repair, prepend disclaimer
          if (receipt.validationResult === "fail") {
            responseText = `${VALIDATION_DISCLAIMER}\n\n${responseText}`;
          }
        }

        microRunner.finalize(receipt);

        recordTurnAndTrim(session, message, responseText);
        log.gemini.debug({ sessionId: sessionKey, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
        return { text: responseText, proposals: chatProposals };
      }

      // ── Standard path (no MicroRunner) ────────────────────
      const result = await withRetry(
        () => session.chat.sendMessage({ message: buildMessageParts(message) }),
        "standard",
      );

      // Check for function calls before text extraction
      let responseText: string;
      let chatProposals: ProposalSummary[] = [];
      const functionCalls = hasToolContext ? result.functionCalls : undefined;

      if (functionCalls && functionCalls.length > 0) {
        const chatResult = await handleFunctionCalls(session.chat, functionCalls, sessionKey, scopedContext!, effectiveUserId);
        responseText = chatResult.text;
        chatProposals = chatResult.proposals;
      } else {
        responseText = result.text ?? "";
      }

      recordTurnAndTrim(session, image ? `[image: ${image.inlineData.mimeType}] ${message}` : message, responseText);

      log.gemini.debug({ sessionId: sessionKey, responseLen: responseText.length, historyLen: session.history.length }, "chat:recv");
      return { text: responseText, proposals: chatProposals };
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
        log.gemini.debug({ sessionId, remaining: sessions.size }, "session:close");
      }
    },

    getModel(): string {
      return currentModelId;
    },

    setModel(modelId: string): void {
      // I6: Throw on unrecognized model instead of silently degrading
      if (!MODEL_REGISTRY_MAP.has(modelId)) {
        throw new Error(`Unknown model: ${modelId}. Valid: ${MODEL_REGISTRY.map((m) => m.id).join(", ")}`);
      }
      if (modelId === currentModelId) return;

      const previousModel = currentModelId;
      currentModelId = modelId;
      // Rebuild chat config — new sessions will use the updated model ID
      chatConfig = buildChatConfig();

      // Clear all sessions — new model needs fresh chat context
      const sessionCount = sessions.size;
      sessions.clear();
      sessionLocks.clear();

      log.gemini.info({
        previousModel,
        newModel: modelId,
        sessionsCleared: sessionCount,
      }, "model:switch");
    },

    close(): void {
      // M2: Clear cleanup timer to prevent leaks in tests
      if (cleanupTimer) clearInterval(cleanupTimer);
      sessions.clear();
      sessionLocks.clear();
      log.gemini.debug("engine:close");
    },
  };
}
