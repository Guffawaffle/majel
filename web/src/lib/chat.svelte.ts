/**
 * Chat store — reactive state for the active chat session.
 *
 * Manages the current session ID, message list, pending image,
 * sending state, and the send flow. Components read reactive getters;
 * mutations go through exported functions.
 */

import type { ChatImage, ChatMessage, ChatResponse } from "./types.js";
import { sendChat as apiSendChat } from "./api/chat.js";

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
}

let currentSessionId = $state<string>(crypto.randomUUID());
let messages = $state<LocalMessage[]>([]);
let sending = $state(false);
let pendingImage = $state<(ChatImage & { name: string; dataUrl: string; fileSize: number }) | null>(null);

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

// ─── Mutations ──────────────────────────────────────────────

/** Start a brand-new chat session. */
export function startNewSession(): void {
  currentSessionId = crypto.randomUUID();
  messages = [];
  pendingImage = null;
  sending = false;
  localIdSeq = -1;
}

/** Switch to a restored session, replaying its messages. */
export function restoreMessages(sessionId: string, restored: ChatMessage[]): void {
  currentSessionId = sessionId;
  messages = restored.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  }));
  pendingImage = null;
  sending = false;
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

  try {
    const result: ChatResponse = await apiSendChat(currentSessionId, msgText, image);
    messages.push({
      id: nextLocalId(),
      role: "model",
      text: result.answer,
      createdAt: new Date().toISOString(),
    });
    onSent?.();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Something went wrong.";
    messages.push({
      id: nextLocalId(),
      role: "error",
      text: errMsg,
      createdAt: new Date().toISOString(),
    });
  } finally {
    sending = false;
  }
}
