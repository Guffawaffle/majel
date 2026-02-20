/**
 * Chat API — send messages, load history, search recall.
 */

import type { ChatImage, ChatResponse, HistoryResponse, RecallResponse } from "../types.js";
import { apiFetch, qs } from "./fetch.js";

/**
 * Send a chat message (optionally with an image attachment).
 * Throws ApiError on failure — callers display the error.
 */
export async function sendChat(
  sessionId: string,
  message: string,
  image?: ChatImage,
): Promise<ChatResponse> {
  return apiFetch<ChatResponse>("/api/chat", {
    method: "POST",
    headers: { "X-Session-Id": sessionId },
    body: JSON.stringify({ message, ...(image && { image }) }),
  });
}

/**
 * Load recent Lex history entries for the chat sidebar.
 * Returns an empty object on failure.
 */
export async function loadHistory(): Promise<HistoryResponse> {
  try {
    return await apiFetch<HistoryResponse>(
      `/api/history${qs({ source: "lex", limit: 20 })}`,
    );
  } catch {
    return {};
  }
}

/**
 * Search Lex recall store.
 * Returns an empty object on failure.
 */
export async function searchRecall(query: string): Promise<RecallResponse> {
  try {
    return await apiFetch<RecallResponse>(
      `/api/recall${qs({ q: query })}`,
    );
  } catch {
    return { query, results: [] };
  }
}
