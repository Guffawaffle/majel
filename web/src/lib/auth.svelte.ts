/**
 * Auth store — reactive user state backed by the typed API layer.
 *
 * Delegates to api/auth.ts for network calls, keeps the reactive
 * $state here so components can read getUser() / isLoading() etc.
 */

import type { Role, User } from "./types.js";
import { getMe, postLogout } from "./api/auth.js";
import { ApiError } from "./api/fetch.js";

let user = $state<User | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

/** Current authenticated user (null = not logged in or loading) */
export function getUser(): User | null {
  return user;
}

/** Whether the initial auth check is still in progress */
export function isLoading(): boolean {
  return loading;
}

/** Auth error message, if any */
export function getError(): string | null {
  return error;
}

/** Role hierarchy — higher index = more permissions. */
const ROLE_RANK: Record<Role, number> = {
  ensign: 0,
  lieutenant: 1,
  captain: 2,
  admiral: 3,
};

/** Check if the current user has at least the given role. */
export function hasRole(role: Role): boolean {
  if (!user) return false;
  return (ROLE_RANK[user.role] ?? -1) >= (ROLE_RANK[role] ?? 99);
}

/** Fetch current user from the API. Call once at app startup via onMount. */
export async function fetchMe(): Promise<void> {
  loading = true;
  error = null;
  try {
    user = await getMe();
    if (!user) {
      // Not authenticated — redirect to landing/login page.
      // In dev, Vite proxies /login to Express; in prod, same origin.
      window.location.href = "/login";
    }
  } catch (e) {
    user = null;
    if (e instanceof ApiError && e.status === 401) {
      window.location.href = "/login";
      return;
    }
    // Network error (Express not running, etc.) — show inline message
    error = e instanceof ApiError ? e.message : "Network error — is the Express server running?";
  } finally {
    loading = false;
  }
}

/** Log out and redirect to landing page. */
export async function logout(): Promise<void> {
  try {
    await postLogout();
  } finally {
    user = null;
    window.location.href = "/";
  }
}
