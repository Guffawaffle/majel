/**
 * admiral.js — Admiral Console API (Admin)
 *
 * @module  api/admiral
 * @layer   api-client
 * @domain  admiral
 * @depends api/_fetch
 * @exports adminListUsers, adminSetRole, adminSetLock, adminDeleteUser,
 *          adminListInvites, adminCreateInvite, adminRevokeInvite,
 *          adminListSessions, adminDeleteSession, adminDeleteAllSessions
 * @emits   none
 * @state   none
 */

import { _fetch } from './_fetch.js';

// ─── User Management ────────────────────────────────────────

/**
 * List all registered users (admiral only)
 * @returns {Promise<Array>} Array of user objects
 */
export async function adminListUsers() {
    const res = await _fetch("/api/auth/admin/users");
    const env = await res.json();
    return env.data?.users || [];
}

/**
 * Set a user's role (admiral only)
 * @param {string} email - User email
 * @param {string} role - New role
 * @returns {Promise<Object>}
 */
export async function adminSetRole(email, role) {
    const res = await _fetch("/api/auth/admin/set-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Lock or unlock a user account (admiral only)
 * @param {string} email - User email
 * @param {boolean} locked - Lock (true) or unlock (false)
 * @param {string} [reason] - Optional lock reason
 * @returns {Promise<Object>}
 */
export async function adminSetLock(email, locked, reason) {
    const res = await _fetch("/api/auth/admin/lock", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, locked, reason }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Delete a user by email (admiral only)
 * @param {string} email - User email
 * @returns {Promise<Object>}
 */
export async function adminDeleteUser(email) {
    const res = await _fetch("/api/auth/admin/user", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

// ─── Invite Management ──────────────────────────────────────

/**
 * List all invite codes (admiral only)
 * @returns {Promise<Array>} Array of invite code objects
 */
export async function adminListInvites() {
    const res = await _fetch("/api/admin/invites");
    const env = await res.json();
    return env.data?.codes || [];
}

/**
 * Create a new invite code (admiral only)
 * @param {Object} opts - { label?, maxUses?, expiresIn? }
 * @returns {Promise<Object>}
 */
export async function adminCreateInvite(opts = {}) {
    const res = await _fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Revoke an invite code (admiral only)
 * @param {string} code - Invite code
 * @returns {Promise<Object>}
 */
export async function adminRevokeInvite(code) {
    const res = await _fetch(`/api/admin/invites/${encodeURIComponent(code)}`, {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

// ─── Session Management ─────────────────────────────────────

/**
 * List all tenant sessions (admiral only)
 * @returns {Promise<Array>} Array of session objects
 */
export async function adminListSessions() {
    const res = await _fetch("/api/admin/sessions");
    const env = await res.json();
    return env.data?.sessions || [];
}

/**
 * Delete a specific tenant session (admiral only)
 * @param {string} id - Tenant/session ID
 * @returns {Promise<Object>}
 */
export async function adminDeleteSession(id) {
    const res = await _fetch(`/api/admin/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Delete ALL tenant sessions (admiral only)
 * @returns {Promise<Object>}
 */
export async function adminDeleteAllSessions() {
    const res = await _fetch("/api/admin/sessions", {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}
