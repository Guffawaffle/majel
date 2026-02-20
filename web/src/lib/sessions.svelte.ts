/**
 * Sessions store — reactive session list + CRUD.
 *
 * Wraps api/sessions.ts with $state so the Sidebar and ChatView
 * can reactively display the list.
 */

import type { SessionSummary } from "./types.js";
import {
  fetchSessions as apiFetchSessions,
  restoreSession as apiRestoreSession,
  deleteSession as apiDeleteSession,
} from "./api/sessions.js";
import {
  getSessionId,
  restoreMessages,
  startNewSession,
} from "./chat.svelte.js";

// ─── State ──────────────────────────────────────────────────

let sessions = $state<SessionSummary[]>([]);
let loadingSessions = $state(false);

// ─── Getters ────────────────────────────────────────────────

export function getSessions(): SessionSummary[] {
  return sessions;
}

export function isLoadingSessions(): boolean {
  return loadingSessions;
}

// ─── Actions ────────────────────────────────────────────────

/** Fetch the session list from the server. */
export async function refreshSessions(): Promise<void> {
  loadingSessions = true;
  try {
    sessions = await apiFetchSessions(30);
  } finally {
    loadingSessions = false;
  }
}

/**
 * Restore a session by ID — switches the active chat to it.
 * Returns true on success.
 */
export async function switchToSession(id: string): Promise<boolean> {
  const session = await apiRestoreSession(id);
  if (!session) return false;
  restoreMessages(id, session.messages);
  return true;
}

/**
 * Delete a session. If it's the active session, starts a new chat.
 */
export async function removeSession(id: string): Promise<boolean> {
  const ok = await apiDeleteSession(id);
  if (!ok) return false;
  sessions = sessions.filter((s) => s.id !== id);
  if (getSessionId() === id) {
    startNewSession();
  }
  return true;
}

/** Start a new chat and refresh the session list. */
export function newChat(): void {
  startNewSession();
  // Don't await — just fire refresh in background
  refreshSessions();
}
