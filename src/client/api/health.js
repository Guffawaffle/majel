/**
 * health.js — Health Check API
 *
 * @module  api/health
 * @layer   api-client
 * @domain  health
 * @depends api/_fetch
 * @exports checkHealth
 * @emits   none
 * @state   none
 */

import { apiFetch } from './_fetch.js';

/**
 * Check the health/status of the backend API
 * @returns {Promise<Object|null>} Health data or null on error
 */
export async function checkHealth() {
    try {
        return await apiFetch("/api/health");
    } catch {
        return null;
    }
}
