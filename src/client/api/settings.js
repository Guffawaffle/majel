/**
 * settings.js — Fleet Settings API
 *
 * @module  api/settings
 * @layer   api-client
 * @domain  settings
 * @depends api/_fetch
 * @exports saveFleetSetting, loadFleetSettings, loadSetting
 * @emits   none
 * @state   none
 */

import { apiFetch } from './_fetch.js';

/**
 * Save a fleet config setting
 * @param {string} key - Setting key
 * @param {string|number} value - Setting value
 * @returns {Promise<void>}
 */
export async function saveFleetSetting(key, value) {
    try {
        await apiFetch("/api/settings", {
            method: "PATCH",
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
        return await apiFetch("/api/settings?category=fleet") || { settings: [] };
    } catch {
        return { settings: [] };
    }
}

/**
 * Load a single setting value by key (any category).
 * @param {string} key - Setting key (e.g. "system.uiMode")
 * @param {string} [fallback] - Default if not found
 * @returns {Promise<string>} Resolved setting value
 */
export async function loadSetting(key, fallback = '') {
    try {
        const data = await apiFetch('/api/settings') || {};
        const entry = (data.settings || []).find(s => s.key === key);
        return entry?.value ?? fallback;
    } catch {
        return fallback;
    }
}
