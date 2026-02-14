/**
 * _fetch.js — Shared Fetch Wrapper
 *
 * @module  api/_fetch
 * @layer   api-client
 * @domain  core
 * @depends none
 * @exports apiFetch, ApiError
 * @emits   none
 * @state   none
 *
 * Single choke point for all API communication (ADR-023 Phase 1).
 * Enforces CSRF, credentials, Content-Type, 5xx sanitization,
 * and envelope unwrapping.
 */

/**
 * Legacy fetch wrapper — credentials + CSRF only.
 * Used by domain modules during Phase 1 migration (move, not rewrite).
 * New code should use apiFetch instead.
 *
 * @param {string} url - API path
 * @param {RequestInit} [opts] - Fetch options
 * @returns {Promise<Response>} Raw Response object
 */
export const _fetch = (url, opts = {}) => fetch(url, {
    ...opts,
    credentials: 'same-origin',
    headers: {
        'X-Requested-With': 'majel-client',
        ...opts.headers,
    },
});

/**
 * Structured API error with status and optional detail.
 * Detail is omitted for 5xx errors (never expose server internals).
 */
export class ApiError extends Error {
    /**
     * @param {string} message - Human-readable error message
     * @param {number} status - HTTP status code
     * @param {Object} [detail] - Structured error detail (omitted for 5xx)
     */
    constructor(message, status, detail) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.detail = detail;
    }
}

/**
 * Fetch wrapper with CSRF, credentials, and envelope unwrapping.
 *
 * - Adds `credentials: 'same-origin'` on every request
 * - Adds `X-Requested-With: majel-client` header (CSRF)
 * - Adds `Content-Type: application/json` default
 * - Sanitizes 5xx errors — client code never sees raw server internals
 * - Unwraps the ADR-004 envelope — returns `body.data` on success
 *
 * @param {string} path - API path (e.g., '/api/auth/me')
 * @param {RequestInit} [opts] - Fetch options
 * @returns {Promise<any>} Unwrapped response data (body.data)
 * @throws {ApiError} On non-2xx responses
 */
export async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'majel-client',
            ...opts.headers,
        },
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
        // Sanitize 5xx — never expose raw server internals to client code
        const message = res.status >= 500
            ? 'Server error — please try again'
            : (body.error?.message ?? res.statusText);
        const detail = res.status < 500 ? body.error : undefined;
        throw new ApiError(message, res.status, detail);
    }
    return body.data;
}
