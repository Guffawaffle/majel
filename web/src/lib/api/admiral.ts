/**
 * Admiral API — user management, invite codes, session management.
 * All endpoints require admiral role.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiDelete, apiPatch, apiPost, pathEncode } from "./fetch.js";
import type { Role, User } from "../types.js";

// ─── User Management ────────────────────────────────────────

export async function adminListUsers(): Promise<User[]> {
  const data = await apiFetch<{ users: User[] }>("/api/auth/admiral/users");
  return data.users;
}

export async function adminSetRole(email: string, role: Role): Promise<unknown> {
  return apiPost("/api/auth/admiral/set-role", { email, role });
}

export async function adminSetLock(
  email: string,
  locked: boolean,
  reason?: string,
): Promise<unknown> {
  return apiPatch("/api/auth/admiral/lock", { email, locked, reason });
}

export async function adminDeleteUser(email: string): Promise<unknown> {
  return apiDelete("/api/auth/admiral/user", { email });
}

// ─── Invite Management ──────────────────────────────────────

export interface InviteOpts {
  label?: string;
  maxUses?: number;
  expiresIn?: string;
}

export async function adminListInvites(): Promise<unknown[]> {
  const data = await apiFetch<{ codes: unknown[] }>("/api/admiral/invites");
  return data.codes;
}

export async function adminCreateInvite(opts?: InviteOpts): Promise<unknown> {
  return apiPost("/api/admiral/invites", opts ?? {});
}

export async function adminRevokeInvite(code: string): Promise<unknown> {
  return apiDelete(`/api/admiral/invites/${pathEncode(code)}`);
}

// ─── Session Management ─────────────────────────────────────

export async function adminListSessions(): Promise<unknown[]> {
  const data = await apiFetch<{ sessions: unknown[] }>("/api/admiral/sessions");
  return data.sessions;
}

export async function adminDeleteSession(id: string): Promise<unknown> {
  return apiDelete(`/api/admiral/sessions/${pathEncode(id)}`);
}

export async function adminDeleteAllSessions(): Promise<unknown> {
  return apiDelete("/api/admiral/sessions");
}
