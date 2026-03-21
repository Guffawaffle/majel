/**
 * Chat store — reactive state for the active chat session.
 *
 * Manages the current session ID, message list, pending image,
 * sending state, and the send flow. Components read reactive getters;
 * mutations go through exported functions.
 */

import type { ChatImage, ChatMessage, ChatProposal, ChatResponse, ChatTrace } from "./types.js";
import { ChatError } from "./api/chat.js";
import { sendChat as apiSendChat, cancelRun as apiCancelRun } from "./api/chat.js";
import type { RunProgressCallbacks } from "./api/chat.js";
import { invalidateForMutation } from "./cache/cached-fetch.js";

// ─── Run phase type (ADR-043) ───────────────────────────────

export type RunPhase = "idle" | "queued" | "running" | "cancelling"
  | "completed" | "failed" | "cancelled" | "timed_out";

// ─── State ──────────────────────────────────────────────────

/** Message as stored in local state (extends server ChatMessage with extras). */
export interface LocalMessage {
  /** Unique id (server id for restored, negative sequence for local-only) */
  id: number;
  role: "user" | "model" | "system" | "error";
  text: string;
  createdAt: string;
  /** Data URL for attached image thumbnail (user messages only). */
  imageDataUrl?: string;
  /** Pending proposals attached to this model message (approve-tier mutations). */
  proposals?: ChatProposal[];
  /** Admiral-only diagnostic trace for this response. */
  trace?: ChatTrace;
  /** Generation duration in milliseconds (model messages only). */
  elapsedMs?: number;
}

let currentSessionId = $state<string>(crypto.randomUUID());
const clientTabId = crypto.randomUUID();
let messages = $state<LocalMessage[]>([]);
let sending = $state(false);
let pendingImage = $state<(ChatImage & { name: string; dataUrl: string; fileSize: number }) | null>(null);

// ── Run lifecycle state (ADR-043) ──
let currentRunId = $state<string | null>(null);
let runPhase = $state<RunPhase>("idle");
let runElapsedMs = $state(0);
let runModel = $state<string | null>(null);
let elapsedTimerId: ReturnType<typeof setInterval> | undefined;
let elapsedOrigin = 0;

let localIdSeq = -1;
function nextLocalId(): number {
  return localIdSeq--;
}

// ─── Getters ────────────────────────────────────────────────

export function getSessionId(): string {
  return currentSessionId;
}

export function getMessages(): LocalMessage[] {
  return messages;
}

export function isSending(): boolean {
  return sending;
}

export function getPendingImage(): (ChatImage & { name: string; dataUrl: string; fileSize: number }) | null {
  return pendingImage;
}

export function hasMessages(): boolean {
  return messages.length > 0;
}

export function getCurrentRunId(): string | null {
  return currentRunId;
}

export function getRunPhase(): RunPhase {
  return runPhase;
}

export function getRunElapsedMs(): number {
  return runElapsedMs;
}

export function getRunModel(): string | null {
  return runModel;
}

// ─── Mutations ──────────────────────────────────────────────

/** Start a brand-new chat session. */
export function startNewSession(): void {
  currentSessionId = crypto.randomUUID();
  messages = [];
  pendingImage = null;
  sending = false;
  resetRunState();
  localIdSeq = -1;
}

/** Switch to a restored session, replaying its messages. */
export function restoreMessages(
  sessionId: string,
  restored: ChatMessage[],
  proposals?: Record<string, ChatProposal & { status: string }>,
): void {
  currentSessionId = sessionId;
  messages = restored.map((m) => {
    const local: LocalMessage = {
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
    };
    // Re-attach proposals from hydrated session data
    if (m.proposalIds?.length && proposals) {
      const attached: ChatProposal[] = [];
      for (const pid of m.proposalIds) {
        const p = proposals[pid];
        if (p) {
          attached.push({
            id: p.id,
            batchItems: p.batchItems,
            expiresAt: p.expiresAt,
            // Map stored status → resolvedStatus for the card
            resolvedStatus: p.status === "proposed" ? undefined
              : p.status === "applied" ? "applied"
              : p.status === "declined" ? "declined"
              : p.status === "expired" ? "expired"
              : "error",
          });
        }
      }
      if (attached.length > 0) local.proposals = attached;
    }
    return local;
  });
  pendingImage = null;
  sending = false;
  resetRunState();
}

/** Add a System or info message locally. */
export function addSystemMessage(text: string): void {
  messages.push({
    id: nextLocalId(),
    role: "system",
    text,
    createdAt: new Date().toISOString(),
  });
}

/** Attach an image for the next send. */
export function attachImage(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const validTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!validTypes.includes(file.type)) {
      reject(new Error("Only PNG, JPEG, and WebP images are supported."));
      return;
    }
    if (file.size > 7.5 * 1024 * 1024) {
      reject(new Error("Image must be under 7.5 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      pendingImage = {
        data: base64,
        mimeType: file.type,
        name: file.name || "image",
        dataUrl,
        fileSize: file.size,
      };
      resolve();
    };
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

/** Remove the pending image. */
export function clearPendingImage(): void {
  pendingImage = null;
}

// ─── Run lifecycle helpers (ADR-043) ────────────────────────

function resetRunState(): void {
  currentRunId = null;
  runPhase = "idle";
  runElapsedMs = 0;
  runModel = null;
  if (elapsedTimerId !== undefined) {
    clearInterval(elapsedTimerId);
    elapsedTimerId = undefined;
  }
}

function startElapsedTimer(): void {
  if (elapsedTimerId !== undefined) clearInterval(elapsedTimerId);
  elapsedOrigin = Date.now();
  runElapsedMs = 0;
  elapsedTimerId = setInterval(() => {
    runElapsedMs = Date.now() - elapsedOrigin;
  }, 250);
}

/** Cancel the currently active run (if any). */
export async function cancelCurrentRun(): Promise<void> {
  const id = currentRunId;
  if (!id || runPhase === "cancelling" || runPhase === "idle") return;
  runPhase = "cancelling";
  try {
    await apiCancelRun(id);
  } catch {
    // Server may already have finished — SSE terminal event will resolve
  }
}

/**
 * Send a chat message. Adds user + model/error messages to the list.
 * Returns void — components observe reactive state.
 *
 * @param text    — User message text (may be empty if image-only)
 * @param onSent  — Optional callback after successful API response (e.g. refresh sessions)
 */
export async function send(text: string, onSent?: () => void): Promise<void> {
  const msgText = text.trim() || (pendingImage ? "What's in this image?" : "");
  if (!msgText && !pendingImage) return;

  // Capture image before clearing
  const image = pendingImage
    ? { data: pendingImage.data, mimeType: pendingImage.mimeType }
    : undefined;
  const imageDataUrl = pendingImage?.dataUrl;

  // Add user message
  messages.push({
    id: nextLocalId(),
    role: "user",
    text: msgText,
    createdAt: new Date().toISOString(),
    imageDataUrl,
  });

  pendingImage = null;
  sending = true;
  runPhase = "queued";

  const progressCallbacks: RunProgressCallbacks = {
    onQueued: () => { runPhase = "queued"; },
    onStarted: (model) => {
      runPhase = "running";
      if (model) runModel = model;
      startElapsedTimer();
    },
    onProgress: (elapsed) => {
      runElapsedMs = elapsed;
      // Re-anchor the local timer to match server elapsed
      elapsedOrigin = Date.now() - elapsed;
    },
  };

  try {
    const result: ChatResponse = await apiSendChat(
      currentSessionId,
      msgText,
      image,
      clientTabId,
      (id) => { currentRunId = id; },
      progressCallbacks,
    );
    runPhase = "completed";
    const finalElapsed = runElapsedMs || undefined;
    messages.push({
      id: nextLocalId(),
      role: "model",
      text: result.answer,
      createdAt: new Date().toISOString(),
      proposals: result.proposals?.length ? result.proposals : undefined,
      trace: result.trace,
      elapsedMs: finalElapsed,
    });

    // Invalidate client caches affected by auto-trust mutations
    if (result.mutations?.length) {
      for (const key of result.mutations) {
        void invalidateForMutation(key);
      }
    }

    onSent?.();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Something went wrong.";
    const errTrace = e instanceof ChatError ? e.trace : undefined;
    if (errMsg === "Chat run was cancelled") {
      runPhase = "cancelled";
      messages.push({
        id: nextLocalId(),
        role: "system",
        text: "Generation stopped.",
        createdAt: new Date().toISOString(),
      });
    } else {
      runPhase = errMsg.includes("timed out") ? "timed_out" : "failed";
      messages.push({
        id: nextLocalId(),
        role: "error",
        text: errMsg,
        createdAt: new Date().toISOString(),
        trace: errTrace,
      });
    }
  } finally {
    sending = false;
    resetRunState();
  }
}

/**
 * Retry / regenerate: re-send the user message that preceded the given
 * model or error message. Creates a new run — the old response stays visible.
 */
export async function retry(messageIndex: number, onSent?: () => void): Promise<void> {
  if (sending) return;
  // Walk backwards from messageIndex to find the preceding user message
  let userText = "";
  for (let i = messageIndex - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userText = messages[i].text;
      break;
    }
  }
  if (!userText) return;
  await send(userText, onSent);
}
