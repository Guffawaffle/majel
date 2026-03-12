/**
 * Admiral API — user management, invite codes, session management.
 * All endpoints require admiral role.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiDelete, apiPatch, apiPost, pathEncode } from "./fetch.js";
import type { AdminInvite, AdminSession, AdminUser, Role, AdminModelEntry, AdminModelToggleResponse } from "../types.js";
import { runLockedMutation } from "./mutation.js";

// ─── User Management ────────────────────────────────────────

export async function adminListUsers(): Promise<AdminUser[]> {
  const data = await apiFetch<{ users: AdminUser[] }>("/api/auth/admiral/users");
  return data.users;
}

export async function adminSetRole(userId: string, role: Role): Promise<void> {
  await runLockedMutation({
    label: `Set role ${userId}`,
    lockKey: `admiral:user:${userId}`,
    mutate: async () => {
      await apiPost("/api/auth/admiral/set-role", { userId, role });
    },
  });
}

export async function adminSetLock(
  userId: string,
  locked: boolean,
  reason?: string,
): Promise<void> {
  await runLockedMutation({
    label: `Set lock ${userId}`,
    lockKey: `admiral:user:${userId}`,
    mutate: async () => {
      await apiPatch("/api/auth/admiral/lock", { userId, locked, reason });
    },
  });
}

export async function adminDeleteUser(userId: string): Promise<void> {
  await runLockedMutation({
    label: `Delete user ${userId}`,
    lockKey: `admiral:user:${userId}`,
    mutate: async () => {
      await apiDelete("/api/auth/admiral/user", { userId });
    },
  });
}

export async function adminResendVerification(userId: string): Promise<void> {
  await runLockedMutation({
    label: `Resend verification ${userId}`,
    lockKey: `admiral:user:${userId}`,
    mutate: async () => {
      await apiPost("/api/auth/admiral/resend-verification", { userId });
    },
  });
}

export async function adminVerifyUser(userId: string): Promise<void> {
  await runLockedMutation({
    label: `Verify user ${userId}`,
    lockKey: `admiral:user:${userId}`,
    mutate: async () => {
      await apiPost("/api/auth/admiral/verify-user", { userId });
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

// ─── Model Management ───────────────────────────────────────

export async function adminListModels(): Promise<AdminModelEntry[]> {
  const data = await apiFetch<{ models: AdminModelEntry[] }>("/api/admiral/models");
  return data.models;
}

export async function adminSetModelAvailability(
  modelId: string,
  adminEnabled: boolean,
  reason?: string,
): Promise<AdminModelToggleResponse> {
  return runLockedMutation({
    label: `Toggle model ${modelId}`,
    lockKey: `admiral:model:${modelId}`,
    mutate: () =>
      apiPatch<AdminModelToggleResponse>(
        `/api/admiral/models/${pathEncode(modelId)}/availability`,
        { adminEnabled, ...(reason !== undefined ? { reason } : {}) },
      ),
  });
}
