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
import { type MicroRunner, VALIDATION_DISCLAIMER, extractConversationalAnswer } from "../micro-runner.js";
import {
  type ToolEnv,
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
import { sanitizeForModel } from "./sanitize.js";
import { canonicalStringify } from "../../util/canonical-json.js";
import type { ChatEngine } from "../engine.js";
import type { ToolMode } from "./tool-mode.js";
import { countStructuredLines } from "./tool-mode.js";

// ─── Retry helper for transient Gemini API errors ─────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

/** Extract diagnostic info from a Gemini response for logging when the response is empty. */
function extractResponseDiagnostics(result: unknown): Record<string, unknown> | null {
  const r = result as {
    candidates?: Array<{ finishReason?: string; safetyRatings?: unknown[] }>;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  const candidate = r?.candidates?.[0];
  const diag: Record<string, unknown> = {};
  if (candidate?.finishReason) diag.finishReason = candidate.finishReason;
  if (candidate?.safetyRatings) diag.safetyRatings = candidate.safetyRatings;
  if (r?.promptFeedback?.blockReason) {
    diag.blockReason = r.promptFeedback.blockReason;
    if (r.promptFeedback.blockReasonMessage) diag.blockReasonMessage = r.promptFeedback.blockReasonMessage;
  }
  if (!r?.candidates?.length) diag.noCandidates = true;
  return Object.keys(diag).length > 0 ? diag : null;
}

/** Build an AttemptInfo record from a Gemini response for telemetry. */
function buildAttemptInfo(
  attempt: number,
  mode: ToolMode,
  result: unknown,
  retryReason?: string,
): AttemptInfo {
  const diag = extractResponseDiagnostics(result);
  const usage = (result as { usageMetadata?: Record<string, number> }).usageMetadata;
  return {
    attempt,
    toolMode: mode,
    ...(retryReason ? { retryReason } : {}),
    ...(typeof diag?.finishReason === "string" ? { finishReason: diag.finishReason as string } : {}),
    ...(usage?.promptTokenCount != null ? { promptTokenCount: usage.promptTokenCount } : {}),
    ...(usage?.candidatesTokenCount != null ? { candidatesTokenCount: usage.candidatesTokenCount } : {}),
    ...(usage?.totalTokenCount != null ? { totalTokenCount: usage.totalTokenCount } : {}),
    ...(usage?.thoughtsTokenCount != null ? { thoughtsTokenCount: usage.thoughtsTokenCount } : {}),
  };
}

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
export type { ChatEngine } from "../engine.js";
export {
  buildSystemPrompt,
  SAFETY_SETTINGS,
  DEFAULT_INTENT_CONFIG,
  resolveIntentConfig,
} from "./system-prompt.js";
export type { IntentMode, IntentConfig } from "./system-prompt.js";
export { type ToolMode, type ClassifierSignals, classifyToolMode, classifyToolModeVerbose, countStructuredLines } from "./tool-mode.js";

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

/**
 * @deprecated Use ChatEngine from ../engine.ts for provider-neutral typing.
 * Retained for backward compatibility — GeminiEngine is identical to ChatEngine.
 */
export type GeminiEngine = ChatEngine;

/** Callback for recording token usage (ADR-048 Phase A, #236). */
export type TokenUsageCallback = (
  userId: string, modelId: string, operation: string,
  inputTokens: number, outputTokens: number,
) => void;

// ─── Constants ────────────────────────────────────────────────

/** Default session TTL: 30 minutes */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Max turns per session before oldest are dropped (hard fallback) */
const SESSION_MAX_TURNS = 50;
/** Summarize oldest turns when history exceeds this many turn pairs (#244) */
const SUMMARIZE_AFTER_TURNS = 20;
/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionState {
  chat: Chat;
  history: Array<{ role: string; text: string }>;
  /** Compressed context from summarized older turns (#244) */
  summary: string | null;
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
  onTokenUsage?: TokenUsageCallback | null,
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

  // ── Context caching (#240) ────────────────────────────────────
  // Cache the static system instruction to reduce per-request input token cost.
  // When cached, Gemini charges ~75% less for the cached portion.
  const CACHE_TTL = "3600s"; // 1 hour — matches session cleanup cycle
  let cachedContentName: string | null = null;

  async function createContextCache(): Promise<string | null> {
    try {
      const cached = await ai.caches.create({
        model: currentModelId,
        config: {
          systemInstruction,
          ...(tools ? { tools } : {}),
          ttl: CACHE_TTL,
          displayName: `majel-system-${currentModelId}`,
        },
      });
      if (cached.name) {
        log.gemini.info({
          cacheName: cached.name,
          model: currentModelId,
          tokenCount: cached.usageMetadata?.totalTokenCount,
        }, "context_cache:created");
        return cached.name;
      }
      return null;
    } catch (err) {
      log.gemini.warn({
        err: err instanceof Error ? err.message : String(err),
        model: currentModelId,
      }, "context_cache:create_failed — falling back to inline systemInstruction");
      return null;
    }
  }

  async function deleteContextCache(): Promise<void> {
    if (!cachedContentName) return;
    const name = cachedContentName;
    cachedContentName = null;
    try {
      await ai.caches.delete({ name });
      log.gemini.debug({ cacheName: name }, "context_cache:deleted");
    } catch {
      // Best-effort cleanup — cache will expire via TTL anyway
    }
  }

  /** Detect a stale/expired context cache error from the Gemini API (403). */
  function isCacheExpiredError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("CachedContent not found");
  }

  /**
   * Invalidate the stale context cache and fall back to inline systemInstruction.
   * Rebuilds chatConfig and recreates a session's Chat to use the new config.
   */
  function handleCacheExpiry(session: SessionState): void {
    log.gemini.warn({ cacheName: cachedContentName }, "context_cache:expired — falling back to inline systemInstruction");
    cachedContentName = null;
    chatConfig = buildChatConfig();
    session.chat = createChat(toSdkHistory(session.history, session.summary));
  }

  /**
   * Send a message with retry + cache-expiry recovery (ADR-049).
   * Wraps withRetry and catches stale context cache errors, falling back
   * to inline systemInstruction and retrying once.
   */
  async function sendWithCacheRetry(
    session: SessionState,
    messageParts: string | Part[],
    label: string,
    timeoutMs?: number,
  ): Promise<ReturnType<Chat["sendMessage"]>> {
    const doSend = () => {
      const sendPromise = session.chat.sendMessage({ message: messageParts });
      if (!timeoutMs) return sendPromise;
      return Promise.race([
        sendPromise,
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`sendMessage timeout (${label})`)), timeoutMs);
          // Let the process exit even if timer is pending
          t.unref?.();
        }),
      ]);
    };
    try {
      return await withRetry(doSend, label);
    } catch (err) {
      if (isCacheExpiredError(err)) {
        handleCacheExpiry(session);
        return withRetry(
          () => {
            const p = session.chat.sendMessage({ message: messageParts });
            if (!timeoutMs) return p;
            return Promise.race([
              p,
              new Promise<never>((_, reject) => {
                const t = setTimeout(() => reject(new Error(`sendMessage timeout (${label}-cache-retry)`)), timeoutMs);
                t.unref?.();
              }),
            ]);
          },
          `${label}-cache-retry`,
        );
      }
      throw err;
    }
  }

  /**
   * Send a message without tool declarations (toolless mode).
   * Creates a temporary Chat with inline systemInstruction (no cache, no tools)
   * seeded with the current session history.
   *
   * Used for:
   * 1. Requests classified as toolless by classifyToolMode()
   * 2. Malformed-function fallback retries after MALFORMED_FUNCTION_CALL
   */
  async function sendToolless(
    session: SessionState,
    messageParts: string | Part[],
    label: string,
  ): Promise<ReturnType<Chat["sendMessage"]>> {
    const toollessConfig: GenerateContentConfig = {
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
      automaticFunctionCalling: { disable: true },
      maxOutputTokens: 4096,
    };
    const tempChat = ai.chats.create({
      model: currentModelId,
      config: toollessConfig,
      history: toSdkHistory(session.history, session.summary),
    });
    return withRetry(() => tempChat.sendMessage({ message: messageParts }), label);
  }

  // ── Bulk-gated path (ADR-049 §3) ─────────────────────────────
  // When bulkDetected, mutation tools are stripped from the tool list.
  // Read-only tools remain so the model can still do advisory lookups.

  const BULK_ADDENDUM = "\n\n[SYSTEM NOTE] The user has pasted structured fleet data. " +
    "Analyze and discuss it freely. Mutation tools are not available for this request. " +
    "If the user wants to save this data to their fleet, direct them to the Import feature in Start/Sync.";

  const readOnlyTools = hasToolContext
    ? FLEET_TOOL_DECLARATIONS.filter((d) => d.name != null && !isMutationTool(d.name))
    : [];

  /**
   * Send a message with mutation tools stripped (bulk-commit gate).
   * Creates a temporary Chat with read-only tools only + system prompt addendum.
   */
  async function sendBulkGated(
    session: SessionState,
    messageParts: string | Part[],
    label: string,
  ): Promise<ReturnType<Chat["sendMessage"]>> {
    const bulkConfig: GenerateContentConfig = {
      systemInstruction: systemInstruction + BULK_ADDENDUM,
      safetySettings: SAFETY_SETTINGS,
      ...(readOnlyTools.length > 0 ? { tools: [{ functionDeclarations: readOnlyTools }] } : {}),
      automaticFunctionCalling: { disable: true },
      maxOutputTokens: 4096,
    };
    const tempChat = ai.chats.create({
      model: currentModelId,
      config: bulkConfig,
      history: toSdkHistory(session.history, session.summary),
    });
    return withRetry(() => tempChat.sendMessage({ message: messageParts }), label);
  }

  /** Build a HandoffCard from the original message (ADR-049 §6). */
  function buildHandoffCard(message: string): HandoffCard {
    const entityCount = countStructuredLines(message);
    return {
      type: "sync_handoff",
      target: "start_sync",
      route: "/start/import",
      summary: entityCount > 0
        ? `${entityCount} structured data rows detected in pasted data`
        : "Structured data detected in pasted data",
      ...(entityCount > 0 ? { detectedEntityCount: entityCount } : {}),
    };
  }

  /** Build a GenerateContentConfig shared by all chat sessions for this engine. */
  function buildChatConfig(): GenerateContentConfig {
    // When a context cache is active, use it instead of inline systemInstruction.
    // The cache already contains the system prompt + tool declarations.
    if (cachedContentName) {
      return {
        cachedContent: cachedContentName,
        safetySettings: SAFETY_SETTINGS,
        automaticFunctionCalling: { disable: true },
        maxOutputTokens: 4096,
      };
    }
    return {
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
      ...(tools ? { tools } : {}),
      // Disable automatic function calling — we handle the tool loop ourselves
      automaticFunctionCalling: { disable: true },
      // Cap output length to prevent unbounded response costs (#234)
      maxOutputTokens: 4096,
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

  // Attempt to create context cache at engine init (async, non-blocking).
  // If it fails, buildChatConfig() falls back to inline systemInstruction.
  void createContextCache().then((name) => {
    if (name) {
      cachedContentName = name;
      chatConfig = buildChatConfig();
    }
  });

  /**
   * Convert local history to SDK Content[] format.
   * Prepends summary as a context turn pair when available (#244).
   */
  function toSdkHistory(history: Array<{ role: string; text: string }>, summary: string | null = null): Content[] {
    const result: Content[] = [];
    if (summary) {
      result.push({ role: "user", parts: [{ text: "[Earlier conversation context]" }] });
      result.push({ role: "model", parts: [{ text: summary }] });
    }
    for (const h of history) {
      result.push({ role: h.role, parts: [{ text: h.text }] });
    }
    return result;
  }

  /**
   * Summarize conversation turns into a compact context block.
   * Uses a lightweight single-shot Gemini call (#244).
   */
  async function summarizeHistory(
    turns: Array<{ role: string; text: string }>,
    existingSummary: string | null,
    userId?: string,
  ): Promise<string> {
    const parts: string[] = [];
    if (existingSummary) {
      parts.push(`Previous context:\n${existingSummary}`);
    }
    parts.push("Conversation:");
    for (const t of turns) {
      parts.push(`${t.role}: ${t.text}`);
    }

    const result = await ai.models.generateContent({
      model: currentModelId,
      contents: `Summarize this conversation concisely. Preserve key facts, decisions, names, and context needed for continuation. Output only the summary.\n\n${parts.join("\n")}`,
      config: { maxOutputTokens: 512 },
    });
    const usageMeta = (result as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
    if (usageMeta) {
      onTokenUsage?.(userId ?? "local", currentModelId, "summarize", usageMeta.promptTokenCount ?? 0, usageMeta.candidatesTokenCount ?? 0);
    }
    return result.text ?? "";
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
   * Record a turn pair, summarize older turns when threshold is crossed,
   * and enforce the hard turn limit as fallback.
   *
   * Summarization (#244): at SUMMARIZE_AFTER_TURNS, the oldest half is
   * compressed into a summary block via a lightweight Gemini call. This
   * preserves conversational context while cutting input token cost ~60%.
   * If summarization fails, the hard cap at SESSION_MAX_TURNS drops turns.
   */
  async function recordTurnAndTrim(session: SessionState, userMsg: string, modelMsg: string, userId?: string): Promise<void> {
    session.history.push({ role: "user", text: userMsg });
    session.history.push({ role: "model", text: modelMsg });

    const turnCount = session.history.length / 2;

    // Summarize when we cross the threshold
    if (turnCount > SUMMARIZE_AFTER_TURNS) {
      // Identify the oldest half (rounded to full turn pairs) for summarization.
      // Splice only AFTER success so turns are preserved on failure (#248).
      const dropMessages = Math.floor(turnCount / 2) * 2;
      const toSummarize = session.history.slice(0, dropMessages);

      try {
        session.summary = await summarizeHistory(toSummarize, session.summary, userId);
        // Summarization succeeded — now remove the summarized turns
        session.history.splice(0, dropMessages);
        log.gemini.info({
          summarizedTurns: dropMessages / 2,
          summaryLen: session.summary.length,
          remainingTurns: session.history.length / 2,
        }, "session:summarize");
        session.chat = createChat(toSdkHistory(session.history, session.summary));
        return;
      } catch (err) {
        // Summarization failed — turns are preserved, fall through to hard cap
        log.gemini.warn({ err: err instanceof Error ? err.message : String(err) }, "session:summarize_failed");
      }
    }

    // Hard cap fallback — prevents unbounded growth if summarization is skipped or fails
    if (session.history.length > SESSION_MAX_TURNS * 2) {
      while (session.history.length > SESSION_MAX_TURNS * 2) {
        session.history.splice(0, 2);
      }
      session.chat = createChat(toSdkHistory(session.history, session.summary));
    }
  }

  /** Get or create a session by ID */
  function getSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        chat: createChat(),
        history: [],
        summary: null,
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
  // Production safety: never skip cleanup in production, even if VITEST is set (#249)
  const isProduction = process.env.NODE_ENV === "production";
  const isTest = !isProduction && (process.env.NODE_ENV === "test" || process.env.VITEST === "true");
  if (!isTest && process.env.VITEST === "true" && isProduction) {
    log.gemini.warn("VITEST env var set in production — ignoring it, session cleanup will run normally.");
  }
  const cleanupTimer = isTest ? null : setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
  if (cleanupTimer) {
    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
  }

  /** Max rounds of function calling before forcing a text response */
  const MAX_TOOL_ROUNDS = 5;
  /** Per-call timeout for sendMessage inside the tool loop (#233) */
  const TOOL_CALL_TIMEOUT_MS = 30_000;

  const MAX_FIELD_LENGTH = 500;

  /**
   * Deep-sanitize tool response objects before feeding them to the model.
   * Uses sanitizeForModel() (ADR-040) to strip prompt-injection markers.
   * Strips null/undefined/empty-array values to reduce token noise (#261).
   */
  function sanitizeToolResponse(obj: unknown): unknown {
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

  async function handleFunctionCalls(
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
          await createBatchProposal(pendingBatch, userId, proposals);
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
            // Detect overlay creation vs update (ADR-049 Slice 2)
            let isCreate: boolean | undefined;
            if (toolName === "set_officer_overlay" && scopedContext.deps.overlayStore) {
              const refId = typeof args.officer_id === "string" ? args.officer_id : undefined;
              if (refId) {
                const existing = await scopedContext.deps.overlayStore.getOfficerOverlay(refId);
                isCreate = existing === null;
              }
            } else if (toolName === "set_ship_overlay" && scopedContext.deps.overlayStore) {
              const refId = typeof args.ship_id === "string" ? args.ship_id : undefined;
              if (refId) {
                const existing = await scopedContext.deps.overlayStore.getShipOverlay(refId);
                isCreate = existing === null;
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
      const result = await sendWithCacheRetry(session, responses, "tool-loop", TOOL_CALL_TIMEOUT_MS);
      const usageMeta = (result as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
      if (usageMeta) {
        log.gemini.info({ requestId, sessionId, round, ...usageMeta }, "token:usage");
        onTokenUsage?.(userId, currentModelId, "tool_call", usageMeta.promptTokenCount ?? 0, usageMeta.candidatesTokenCount ?? 0);
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
        const proposal = await createBatchProposal(pendingBatch, userId, proposals);
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
      const summaryResult = await sendWithCacheRetry(
        session,
        "Please provide a text response summarizing the tool results.",
        "tool-fallback-summary",
        TOOL_CALL_TIMEOUT_MS,
      );
      const usageMeta = (summaryResult as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
      if (usageMeta) {
        log.gemini.info({ requestId, sessionId, round, ...usageMeta }, "token:usage:fallback");
        onTokenUsage?.(userId, currentModelId, "fallback", usageMeta.promptTokenCount ?? 0, usageMeta.candidatesTokenCount ?? 0);
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
      await createBatchProposal(pendingBatch, userId, proposals);
    }
    return { text, proposals, executedTools };
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

  return {
    async chat(message: string, sessionId = "default", image?: ImagePart, userId?: string, requestId?: string, isCancelled?: () => boolean, toolMode?: ToolMode, bulkDetected?: boolean): Promise<ChatResult> {
      // #85: Namespace session keys by userId to prevent cross-user session leakage
      const sessionKey = userId ? `${userId}:${sessionId}` : sessionId;
      return withSessionLock(sessionKey, async () => {
      const session = getSession(sessionKey);

      // Determine effective tool mode for this call:
      // - If the engine has no tool context, tools are never available.
      // - If the caller specified a toolMode, use it.
      // - Otherwise default to "fleet" (preserves existing behavior).
      const effectiveToolMode: ToolMode = !hasToolContext ? "none" : (toolMode ?? "fleet");
      const isBulkGated = bulkDetected === true && hasToolContext;
      let needsSessionRebuild = false;
      const attempts: AttemptInfo[] = [];

      log.gemini.debug({ requestId, sessionId: sessionKey, messageLen: message.length, hasImage: !!image, historyLen: session.history.length, userId, toolMode: effectiveToolMode }, "chat:send");

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

        // Send augmented message — bulk-gated mode strips mutation tools (ADR-049),
        // toolless mode uses a temporary chat without tool declarations
        const result = isBulkGated
          ? await sendBulkGated(session, buildMessageParts(augmentedMessage), "micro-runner-bulk-gated")
          : effectiveToolMode === "none"
            ? await sendToolless(session, buildMessageParts(augmentedMessage), "micro-runner-toolless")
            : await sendWithCacheRetry(session, buildMessageParts(augmentedMessage), "micro-runner");
        if (effectiveToolMode === "none" || isBulkGated) needsSessionRebuild = true;

        const initUsage = (result as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
        if (initUsage) {
          log.gemini.info({ requestId, sessionId: sessionKey, ...initUsage, toolMode: effectiveToolMode }, "token:usage:initial");
          onTokenUsage?.(effectiveUserId, currentModelId, "chat", initUsage.promptTokenCount ?? 0, initUsage.candidatesTokenCount ?? 0);
        }
        attempts.push(buildAttemptInfo(1, effectiveToolMode, result));

        // Only check for function calls when tools are enabled
        let responseText: string;
        let chatProposals: ProposalSummary[] = [];
        const functionCalls = effectiveToolMode === "fleet" && hasToolContext ? result.functionCalls : undefined;

        if (functionCalls && functionCalls.length > 0) {
          // Handle function call loop — tool results feed back to model
          const chatResult = await handleFunctionCalls(session, functionCalls, sessionKey, scopedContext!, effectiveUserId, requestId, isCancelled);
          responseText = chatResult.text;
          chatProposals = chatResult.proposals;
        } else {
          responseText = result.text ?? "";
          // Retry on empty response with adaptive fallback for malformed function calls
          if (!responseText) {
            const diag = extractResponseDiagnostics(result);
            const finishReason = typeof diag?.finishReason === "string" ? diag.finishReason : undefined;

            // Cancel check before retry (#cancel-gate)
            if (isCancelled?.()) {
              log.gemini.info({ requestId, sessionId: sessionKey, toolMode: effectiveToolMode }, "chat:retry-skipped:cancelled");
              if (needsSessionRebuild) session.chat = createChat(toSdkHistory(session.history, session.summary));
              return { text: "", proposals: [], toolMode: effectiveToolMode, attempts };
            }

            // Adaptive fallback: MALFORMED_FUNCTION_CALL → retry without tools
            const isMalformed = finishReason === "MALFORMED_FUNCTION_CALL";
            const retryToolMode: ToolMode = isMalformed ? "none" : effectiveToolMode;
            const retryReason = isMalformed ? "MALFORMED_FUNCTION_CALL" : "empty_response";
            const retryLabel = isMalformed ? "micro-runner-malformed-fallback" : "micro-runner-empty-retry";

            log.gemini.warn({ requestId, sessionId: sessionKey, diagnostics: diag, retryToolMode, retryReason }, "chat:empty-response:retrying");

            const retryResult = retryToolMode === "none"
              ? await sendToolless(session, buildMessageParts(augmentedMessage), retryLabel)
              : await sendWithCacheRetry(session, buildMessageParts(augmentedMessage), retryLabel);
            if (retryToolMode === "none") needsSessionRebuild = true;

            const retryUsage = (retryResult as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
            if (retryUsage) {
              log.gemini.info({ requestId, sessionId: sessionKey, ...retryUsage, toolMode: retryToolMode }, "token:usage:empty-retry");
              onTokenUsage?.(effectiveUserId, currentModelId, "empty_retry", retryUsage.promptTokenCount ?? 0, retryUsage.candidatesTokenCount ?? 0);
            }
            attempts.push(buildAttemptInfo(2, retryToolMode, retryResult, retryReason));

            responseText = retryResult.text ?? "";
            if (!responseText) {
              const retryDiag = extractResponseDiagnostics(retryResult);
              log.gemini.warn({ requestId, sessionId: sessionKey, diagnostics: retryDiag }, "chat:empty-response:retry-failed");
            }
          }
        }

        // Validate response against contract
        const validation = await microRunner.validate(
          responseText, contract, gatedContext, sessionKey, startTime, message,
        );
        const receipt = validation.receipt;

        // Single repair pass if validation failed
        if (validation.needsRepair && validation.repairPrompt) {
          log.gemini.debug({ sessionId: sessionKey, violations: receipt.validationDetails }, "microrunner:repair");
          // Uses sendWithCacheRetry for retry + cache-expiry resilience (ADR-049 §1b)
          const repairResult = await sendWithCacheRetry(session, validation.repairPrompt, "micro-runner-repair");
          const repairUsage = (repairResult as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
          if (repairUsage) {
            log.gemini.info({ requestId, sessionId: sessionKey, ...repairUsage }, "token:usage:repair");
            onTokenUsage?.(effectiveUserId, currentModelId, "repair", repairUsage.promptTokenCount ?? 0, repairUsage.candidatesTokenCount ?? 0);
          }
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

        // Unwrap accidental JSON output (model sometimes wraps answer in outputSchema structure)
        responseText = extractConversationalAnswer(responseText);

        // Only record non-empty responses into session history to avoid poisoning the context
        if (responseText) {
          await recordTurnAndTrim(session, message, responseText, effectiveUserId);
        }
        // Rebuild session chat after toolless calls to sync SDK history
        if (needsSessionRebuild) {
          session.chat = createChat(toSdkHistory(session.history, session.summary));
        }
        log.gemini.debug({ requestId, sessionId: sessionKey, responseLen: responseText.length, historyLen: session.history.length, toolMode: effectiveToolMode }, "chat:recv");
        const handoff = isBulkGated ? buildHandoffCard(message) : undefined;
        return { text: responseText, proposals: chatProposals, toolMode: effectiveToolMode, attempts, ...(handoff ? { handoff } : {}) };
      }

      // ── Standard path (no MicroRunner) ────────────────────
      const result = isBulkGated
        ? await sendBulkGated(session, buildMessageParts(message), "standard-bulk-gated")
        : effectiveToolMode === "none"
          ? await sendToolless(session, buildMessageParts(message), "standard-toolless")
          : await sendWithCacheRetry(session, buildMessageParts(message), "standard");
      if (effectiveToolMode === "none" || isBulkGated) needsSessionRebuild = true;

      const stdUsage = (result as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
      if (stdUsage) {
        log.gemini.info({ requestId, sessionId: sessionKey, ...stdUsage, toolMode: effectiveToolMode }, "token:usage:initial");
        onTokenUsage?.(effectiveUserId, currentModelId, "chat", stdUsage.promptTokenCount ?? 0, stdUsage.candidatesTokenCount ?? 0);
      }
      attempts.push(buildAttemptInfo(1, effectiveToolMode, result));

      // Only check for function calls when tools are enabled
      let responseText: string;
      let chatProposals: ProposalSummary[] = [];
      const functionCalls = effectiveToolMode === "fleet" && hasToolContext ? result.functionCalls : undefined;

      let responseDiagnostics: Record<string, unknown> | undefined;
      if (functionCalls && functionCalls.length > 0) {
        const chatResult = await handleFunctionCalls(session, functionCalls, sessionKey, scopedContext!, effectiveUserId, requestId, isCancelled);
        responseText = chatResult.text;
        chatProposals = chatResult.proposals;
      } else {
        responseText = result.text ?? "";
        if (!responseText) {
          const diag = extractResponseDiagnostics(result);
          const finishReason = typeof diag?.finishReason === "string" ? diag.finishReason : undefined;

          // Cancel check before retry (#cancel-gate)
          if (isCancelled?.()) {
            log.gemini.info({ requestId, sessionId: sessionKey, toolMode: effectiveToolMode }, "chat:retry-skipped:cancelled");
            if (needsSessionRebuild) session.chat = createChat(toSdkHistory(session.history, session.summary));
            return { text: "", proposals: [], toolMode: effectiveToolMode, attempts };
          }

          // Adaptive fallback: MALFORMED_FUNCTION_CALL → retry without tools
          const isMalformed = finishReason === "MALFORMED_FUNCTION_CALL";
          const retryToolMode: ToolMode = isMalformed ? "none" : effectiveToolMode;
          const retryReason = isMalformed ? "MALFORMED_FUNCTION_CALL" : "empty_response";
          const retryLabel = isMalformed ? "standard-malformed-fallback" : "standard-empty-retry";

          log.gemini.warn({ requestId, sessionId: sessionKey, diagnostics: diag, retryToolMode, retryReason }, "chat:empty-response:retrying");

          const retryResult = retryToolMode === "none"
            ? await sendToolless(session, buildMessageParts(message), retryLabel)
            : await sendWithCacheRetry(session, buildMessageParts(message), retryLabel);
          if (retryToolMode === "none") needsSessionRebuild = true;

          const retryUsage = (retryResult as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
          if (retryUsage) {
            log.gemini.info({ requestId, sessionId: sessionKey, ...retryUsage, toolMode: retryToolMode }, "token:usage:empty-retry");
            onTokenUsage?.(effectiveUserId, currentModelId, "empty_retry", retryUsage.promptTokenCount ?? 0, retryUsage.candidatesTokenCount ?? 0);
          }
          attempts.push(buildAttemptInfo(2, retryToolMode, retryResult, retryReason));

          responseText = retryResult.text ?? "";
          if (!responseText) {
            const retryDiag = extractResponseDiagnostics(retryResult);
            log.gemini.warn({ requestId, sessionId: sessionKey, diagnostics: retryDiag }, "chat:empty-response:retry-failed");
            responseDiagnostics = retryDiag ?? diag ?? undefined;
          }
        }
      }

      // Unwrap accidental JSON output (model sometimes wraps answer in outputSchema structure)
      responseText = extractConversationalAnswer(responseText);

      // Only record non-empty responses into session history to avoid poisoning the context
      if (responseText) {
        await recordTurnAndTrim(session, image ? `[image: ${image.inlineData.mimeType}] ${message}` : message, responseText, effectiveUserId);
      }
      // Rebuild session chat after toolless calls to sync SDK history
      if (needsSessionRebuild) {
        session.chat = createChat(toSdkHistory(session.history, session.summary));
      }

      log.gemini.debug({ requestId, sessionId: sessionKey, responseLen: responseText.length, historyLen: session.history.length, toolMode: effectiveToolMode }, "chat:recv");
      const handoff = isBulkGated ? buildHandoffCard(message) : undefined;
      return { text: responseText, proposals: chatProposals, diagnostics: responseDiagnostics, toolMode: effectiveToolMode, attempts, ...(handoff ? { handoff } : {}) };
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

      // Invalidate context cache for the old model and create one for the new model
      void deleteContextCache().then(() => createContextCache()).then((name) => {
        cachedContentName = name;
        chatConfig = buildChatConfig();
      });

      // Rebuild chat config immediately (will use inline systemInstruction
      // until the new cache is ready)
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
      // Clean up context cache (#240)
      void deleteContextCache();
      sessions.clear();
      sessionLocks.clear();
      log.gemini.debug("engine:close");
    },
  };
}
