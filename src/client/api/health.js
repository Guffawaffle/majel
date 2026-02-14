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

import { _fetch } from './_fetch.js';

/**
 * Check the health/status of the backend API
 * @returns {Promise<Object|null>} Health data or null on error
 */
export async function checkHealth() {
    try {
        const res = await _fetch("/api/health");
        const data = (await res.json()).data;
        return data;
    } catch {
        return null;
    }
}
