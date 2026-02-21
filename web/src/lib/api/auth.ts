/**
 * Auth API — login status check.
 * Full login/signup/verify flows are server-rendered on the landing page,
 * so only getMe() and logout() are needed here.
 */

import type { User } from "../types.js";
import { apiFetch, ApiError } from "./fetch.js";
import { runLockedMutation } from "./mutation.js";

/** Fetch the current authenticated user, or null if not logged in. */
export async function getMe(): Promise<User | null> {
  try {
    const data = await apiFetch<{ user: User }>("/api/auth/me");
    return data.user ?? null;
  } catch (err) {
    // 401 = not logged in → return null so the caller shows the login page.
    // Any other error (network failure, 500, etc.) should propagate so the
    // caller can display an inline error instead of silently treating it as
    // "no user".
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Log out the current user. Server clears the session cookie. */
export async function postLogout(): Promise<void> {
  await runLockedMutation({
    label: "Logout",
    lockKey: "auth:logout",
    mutate: async () => {
      await apiFetch("/api/auth/logout", { method: "POST" });
    },
  });
}
