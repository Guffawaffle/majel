/**
 * stub-engine.ts — Deterministic Stub Chat Engine (ADR-050)
 *
 * Implements ChatEngine with canned responses for dev_local usage.
 * Allows full chat UX without spending API tokens.
 *
 * Behavior:
 *   - Returns deterministic text responses
 *   - Echoes tool declarations back as predictable function calls when toolMode is "fleet"
 *   - Supports session history, model swap, and all ChatEngine lifecycle methods
 */

import type { ChatEngine } from "./engine.js";
import type { ChatResult, ImagePart } from "./gemini/index.js";
import type { ToolMode } from "./gemini/tool-mode.js";

const STUB_MODEL = "stub-echo-v1";

// ─── Factory ──────────────────────────────────────────────────

export function createStubEngine(): ChatEngine {
  const sessions = new Map<string, Array<{ role: string; text: string }>>();
  let currentModel = STUB_MODEL;

  function chat(
    message: string,
    sessionId?: string,
    _image?: ImagePart,
    _userId?: string,
    _requestId?: string,
    _isCancelled?: () => boolean,
    toolMode?: ToolMode,
  ): Promise<ChatResult> {
    const key = sessionId ?? "__default__";
    if (!sessions.has(key)) sessions.set(key, []);
    const history = sessions.get(key)!;

    history.push({ role: "user", text: message });

    const responseText = toolMode === "fleet"
      ? `[stub] Fleet tools available. Echo: ${message.slice(0, 120)}`
      : `[stub] ${message.slice(0, 200)}`;

    history.push({ role: "model", text: responseText });

    return Promise.resolve({
      text: responseText,
      proposals: [],
      executedTools: [],
      toolMode,
      attempts: [{ attempt: 1, toolMode: toolMode ?? "none" }],
    });
  }

  function getHistory(sessionId?: string): Array<{ role: string; text: string }> {
    const key = sessionId ?? "__default__";
    return sessions.get(key) ?? [];
  }

  function getSessionCount(): number {
    return sessions.size;
  }

  function closeSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  function getModel(): string {
    return currentModel;
  }

  function setModel(modelId: string): void {
    currentModel = modelId;
    sessions.clear();
  }

  function close(): void {
    sessions.clear();
  }

  return { chat, getHistory, getSessionCount, closeSession, getModel, setModel, close };
}
