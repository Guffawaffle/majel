/**
 * engine.ts — Provider-neutral Chat Engine interface.
 *
 * ADR-041: All routes and services type against ChatEngine,
 * never a provider-specific class. Gemini and Claude both
 * implement this interface.
 */

import type { ImagePart, ChatResult } from "./gemini/index.js";
import type { ToolMode } from "./gemini/tool-mode.js";

export interface ChatEngine {
  /** Send a message and get the structured response. */
  chat(message: string, sessionId?: string, image?: ImagePart, userId?: string, requestId?: string, isCancelled?: () => boolean, toolMode?: ToolMode, bulkDetected?: boolean, userRole?: string): Promise<ChatResult>;
  /** Get the full conversation history for a session. */
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
