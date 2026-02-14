/**
 * settings.js — Fleet Settings API
 *
 * @module  api/settings
 * @layer   api-client
 * @domain  settings
 * @depends api/_fetch
 * @exports saveFleetSetting, loadFleetSettings
 * @emits   none
 * @state   none
 */

import { _fetch } from './_fetch.js';

/**
 * Save a fleet config setting
 * @param {string} key - Setting key
 * @param {string|number} value - Setting value
 * @returns {Promise<void>}
 */
export async function saveFleetSetting(key, value) {
    try {
        await _fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [key]: String(value) }),
        });
    } catch (err) {
        console.error("Failed to save fleet setting:", key, err);
    }
}

/**
 * Load fleet settings from API
 * @returns {Promise<Object>} Settings data
 */
export async function loadFleetSettings() {
    try {
        const res = await _fetch("/api/settings?category=fleet");
        if (!res.ok) return { settings: [] };
        const data = (await res.json()).data || {};
        return data;
    } catch {
        return { settings: [] };
    }
}
