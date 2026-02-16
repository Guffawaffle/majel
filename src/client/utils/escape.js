/**
 * escape.js — Shared HTML escaping utility
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Escapes strings for safe injection into innerHTML / template literals.
 * Covers &, <, >, ", and ' to prevent XSS in both double- and single-quoted attributes.
 */

/**
 * Escape a string for safe HTML insertion.
 * @param {*} str — Value to escape (null/undefined → '')
 * @returns {string}
 */
export function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
