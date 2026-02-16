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

import { apiFetch } from './_fetch.js';

// ─── User Management ────────────────────────────────────────

/**
 * List all registered users (admiral only)
 * @returns {Promise<Array>} Array of user objects
 */
export async function adminListUsers() {
    const data = await apiFetch("/api/auth/admiral/users");
    return data?.users || [];
}

/**
 * Set a user's role (admiral only)
 * @param {string} email - User email
 * @param {string} role - New role
 * @returns {Promise<Object>}
 */
export async function adminSetRole(email, role) {
    return apiFetch("/api/auth/admiral/set-role", {
        method: "POST",
        body: JSON.stringify({ email, role }),
    });
}

/**
 * Lock or unlock a user account (admiral only)
 * @param {string} email - User email
 * @param {boolean} locked - Lock (true) or unlock (false)
 * @param {string} [reason] - Optional lock reason
 * @returns {Promise<Object>}
 */
export async function adminSetLock(email, locked, reason) {
    return apiFetch("/api/auth/admiral/lock", {
        method: "PATCH",
        body: JSON.stringify({ email, locked, reason }),
    });
}

/**
 * Delete a user by email (admiral only)
 * @param {string} email - User email
 * @returns {Promise<Object>}
 */
export async function adminDeleteUser(email) {
    return apiFetch("/api/auth/admiral/user", {
        method: "DELETE",
        body: JSON.stringify({ email }),
    });
}

// ─── Invite Management ──────────────────────────────────────

/**
 * List all invite codes (admiral only)
 * @returns {Promise<Array>} Array of invite code objects
 */
export async function adminListInvites() {
    const data = await apiFetch("/api/admiral/invites");
    return data?.codes || [];
}

/**
 * Create a new invite code (admiral only)
 * @param {Object} opts - { label?, maxUses?, expiresIn? }
 * @returns {Promise<Object>} The created invite data
 */
export async function adminCreateInvite(opts = {}) {
    return apiFetch("/api/admiral/invites", {
        method: "POST",
        body: JSON.stringify(opts),
    });
}

/**
 * Revoke an invite code (admiral only)
 * @param {string} code - Invite code
 * @returns {Promise<Object>}
 */
export async function adminRevokeInvite(code) {
    return apiFetch(`/api/admiral/invites/${encodeURIComponent(code)}`, {
        method: "DELETE",
    });
}

// ─── Session Management ─────────────────────────────────────

/**
 * List all tenant sessions (admiral only)
 * @returns {Promise<Array>} Array of session objects
 */
export async function adminListSessions() {
    const data = await apiFetch("/api/admiral/sessions");
    return data?.sessions || [];
}

/**
 * Delete a specific tenant session (admiral only)
 * @param {string} id - Tenant/session ID
 * @returns {Promise<Object>}
 */
export async function adminDeleteSession(id) {
    return apiFetch(`/api/admiral/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
}

/**
 * Delete ALL tenant sessions (admiral only)
 * @returns {Promise<Object>}
 */
export async function adminDeleteAllSessions() {
    return apiFetch("/api/admiral/sessions", {
        method: "DELETE",
    });
}
