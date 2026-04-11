/**
 * engine-manager.ts — Multi-Provider Engine Manager
 *
 * ADR-041 Phase 4: Routes chat to the correct provider engine
 * (Gemini or Claude) based on the currently selected model.
 * Implements ChatEngine so all consumers remain unchanged.
 *
 * Majel — STFC Fleet Intelligence System
 */

import { log } from "../logger.js";
import { MODEL_REGISTRY_MAP } from "./gemini/model-registry.js";
import type { ChatEngine } from "./engine.js";
import type { ImagePart, ChatResult } from "./gemini/index.js";
import type { ToolMode } from "./gemini/tool-mode.js";

// ─── Types ────────────────────────────────────────────────────

export type ProviderName = "gemini" | "claude";

export interface EngineManagerOptions {
  geminiEngine: ChatEngine;
  claudeEngine?: ChatEngine | null;
}

// ─── Factory ──────────────────────────────────────────────────

export function createEngineManager(opts: EngineManagerOptions): ChatEngine {
  const { geminiEngine, claudeEngine } = opts;

  /** Resolve which provider owns a given model ID. */
  function providerFor(modelId: string): ProviderName {
    const def = MODEL_REGISTRY_MAP.get(modelId);
    return def?.provider ?? "gemini";
  }

  /** Get the engine for a provider, falling back to Gemini if unavailable. */
  function engineFor(provider: ProviderName): ChatEngine {
    if (provider === "claude" && claudeEngine) return claudeEngine;
    return geminiEngine;
  }

  /** The currently active provider (derived from whichever engine's model is "current"). */
  function activeEngine(): ChatEngine {
    const provider = providerFor(getModel());
    return engineFor(provider);
  }

  // ─── ChatEngine implementation ────────────────────────────

  function chat(
    message: string,
    sessionId?: string,
    image?: ImagePart,
    userId?: string,
    requestId?: string,
    isCancelled?: () => boolean,
    toolMode?: ToolMode,
    bulkDetected?: boolean,
    userRole?: string,
  ): Promise<ChatResult> {
    return activeEngine().chat(message, sessionId, image, userId, requestId, isCancelled, toolMode, bulkDetected, userRole);
  }

  function getHistory(sessionId?: string): Array<{ role: string; text: string }> {
    return activeEngine().getHistory(sessionId);
  }

  function getSessionCount(): number {
    // Sum from all engines — sessions may exist in either
    let count = geminiEngine.getSessionCount();
    if (claudeEngine) count += claudeEngine.getSessionCount();
    return count;
  }

  function closeSession(sessionId: string): void {
    // Close on both engines — the caller doesn't know which owns it
    geminiEngine.closeSession(sessionId);
    claudeEngine?.closeSession(sessionId);
  }

  function getModel(): string {
    // We track the "current" by checking which engine was last setModel'd.
    // Start with Gemini's model as default (always available).
    return _currentModelId;
  }

  let _currentModelId: string = geminiEngine.getModel();

  function setModel(modelId: string): void {
    const provider = providerFor(modelId);
    const engine = engineFor(provider);

    // If the requested model needs Claude but Claude isn't available, reject gracefully
    if (provider === "claude" && !claudeEngine) {
      log.gemini.warn({ modelId }, "Claude engine not available — staying on current model");
      return;
    }

    engine.setModel(modelId);
    _currentModelId = modelId;
    log.gemini.info({ modelId, provider }, "engine-manager:model:switch");
  }

  function close(): void {
    geminiEngine.close();
    claudeEngine?.close();
  }

  return { chat, getHistory, getSessionCount, closeSession, getModel, setModel, close };
}
