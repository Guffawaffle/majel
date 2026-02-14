/**
 * auth.js — Authentication API
 *
 * @module  api/auth
 * @layer   api-client
 * @domain  auth
 * @depends api/_fetch
 * @exports getMe
 * @emits   none
 * @state   none
 */

import { _fetch } from './_fetch.js';

/**
 * Fetch current user identity + role from /api/auth/me.
 * Returns { id, email, displayName, role } or null on error/unauth.
 */
export async function getMe() {
    try {
        const res = await _fetch("/api/auth/me");
        if (!res.ok) return null;
        const body = await res.json();
        return body.data?.user ?? null;
    } catch {
        return null;
    }
}
