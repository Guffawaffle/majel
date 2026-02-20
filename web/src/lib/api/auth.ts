/**
 * Auth API — login status check.
 * Full login/signup/verify flows are server-rendered on the landing page,
 * so only getMe() and logout() are needed here.
 */

import type { User } from "../types.js";
import { apiFetch } from "./fetch.js";

/** Fetch the current authenticated user, or null if not logged in. */
export async function getMe(): Promise<User | null> {
  try {
    const data = await apiFetch<{ user: User }>("/api/auth/me");
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** Log out the current user. Server clears the session cookie. */
export async function postLogout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}
