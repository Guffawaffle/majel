/**
 * Admiral API — user management, invite codes, session management.
 * All endpoints require admiral role.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiDelete, apiPatch, apiPost, pathEncode } from "./fetch.js";
import type { AdminInvite, AdminSession, AdminUser, Role } from "../types.js";
import { runLockedMutation } from "./mutation.js";

// ─── User Management ────────────────────────────────────────

export async function adminListUsers(): Promise<AdminUser[]> {
  const data = await apiFetch<{ users: AdminUser[] }>("/api/auth/admiral/users");
  return data.users;
}

export async function adminSetRole(email: string, role: Role): Promise<void> {
  await runLockedMutation({
    label: `Set role ${email}`,
    lockKey: `admiral:user:${email}`,
    mutate: async () => {
      await apiPost("/api/auth/admiral/set-role", { email, role });
    },
  });
}

export async function adminSetLock(
  email: string,
  locked: boolean,
  reason?: string,
): Promise<void> {
  await runLockedMutation({
    label: `Set lock ${email}`,
    lockKey: `admiral:user:${email}`,
    mutate: async () => {
      await apiPatch("/api/auth/admiral/lock", { email, locked, reason });
    },
  });
}

export async function adminDeleteUser(email: string): Promise<void> {
  await runLockedMutation({
    label: `Delete user ${email}`,
    lockKey: `admiral:user:${email}`,
    mutate: async () => {
      await apiDelete("/api/auth/admiral/user", { email });
    },
  });
}

// ─── Invite Management ──────────────────────────────────────

export interface InviteOpts {
  label?: string;
  maxUses?: number;
  expiresIn?: string;
}

export async function adminListInvites(): Promise<AdminInvite[]> {
  const data = await apiFetch<{ codes: AdminInvite[] }>("/api/admiral/invites");
  return data.codes;
}

export async function adminCreateInvite(opts?: InviteOpts): Promise<{ code: string }> {
  return runLockedMutation({
    label: "Create invite",
    lockKey: "admiral:invite:create",
    mutate: () => apiPost<{ code: string }>("/api/admiral/invites", opts ?? {}),
  });
}

export async function adminRevokeInvite(code: string): Promise<void> {
  await runLockedMutation({
    label: `Revoke invite ${code}`,
    lockKey: `admiral:invite:${code}`,
    mutate: async () => {
      await apiDelete(`/api/admiral/invites/${pathEncode(code)}`);
    },
  });
}

// ─── Session Management ─────────────────────────────────────

export async function adminListSessions(): Promise<AdminSession[]> {
  const data = await apiFetch<{ sessions: AdminSession[] }>("/api/admiral/sessions");
  return data.sessions;
}

export async function adminDeleteSession(id: string): Promise<void> {
  await runLockedMutation({
    label: `Delete admin session ${id}`,
    lockKey: `admiral:session:${id}`,
    mutate: async () => {
      await apiDelete(`/api/admiral/sessions/${pathEncode(id)}`);
    },
  });
}

export async function adminDeleteAllSessions(): Promise<void> {
  await runLockedMutation({
    label: "Delete all admin sessions",
    lockKey: "admiral:session:all",
    mutate: async () => {
      await apiDelete("/api/admiral/sessions");
    },
  });
}
