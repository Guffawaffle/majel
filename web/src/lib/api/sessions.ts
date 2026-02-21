/**
 * Sessions API — list, restore, delete chat sessions.
 */

import type { ChatSession, SessionSummary } from "../types.js";
import { apiFetch, apiDelete, pathEncode, qs } from "./fetch.js";
import { runLockedMutation } from "./mutation.js";

/**
 * Fetch recent sessions (most recent first).
 * Returns an empty array on failure.
 */
export async function fetchSessions(limit = 30): Promise<SessionSummary[]> {
  try {
    const data = await apiFetch<{ sessions: SessionSummary[] }>(
      `/api/sessions${qs({ limit })}`,
    );
    return data.sessions;
  } catch {
    return [];
  }
}

/**
 * Restore a full session by ID (includes messages).
 * Returns null on failure.
 */
export async function restoreSession(id: string): Promise<ChatSession | null> {
  try {
    return await apiFetch<ChatSession>(`/api/sessions/${pathEncode(id)}`);
  } catch {
    return null;
  }
}

/**
 * Delete a session by ID.
 * Returns true on success, false on failure.
 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await runLockedMutation({
      label: `Delete session ${id}`,
      lockKey: `session:${id}`,
      mutate: async () => {
        await apiDelete(`/api/sessions/${pathEncode(id)}`);
      },
    });
    return true;
  } catch {
    return false;
  }
}
