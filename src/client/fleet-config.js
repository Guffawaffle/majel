/**
 * fleet-config.js — Fleet Config Panel
 * 
 * Majel — STFC Fleet Intelligence System
 * Handles the fleet config slide-out panel (ops level, drydocks, hangar slots).
 */

import * as api from './api.js';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const fleetConfigTab = $("#fleet-config-tab");
const fleetConfigPanel = $("#fleet-config-panel");
const fleetConfigClose = $("#fleet-config-close");

/**
 * Open the fleet config panel
 */
function openFleetConfig() {
    fleetConfigPanel.classList.remove("hidden");
    // Trigger reflow then add open class for animation
    void fleetConfigPanel.offsetHeight;
    fleetConfigPanel.classList.add("open");
    fleetConfigTab.classList.add("active");
}

/**
 * Close the fleet config panel
 */
function closeFleetConfig() {
    fleetConfigPanel.classList.remove("open");
    fleetConfigTab.classList.remove("active");
    setTimeout(() => fleetConfigPanel.classList.add("hidden"), 260);
}

// ─── Event Handlers ─────────────────────────────────────────
/**
 * Initialize fleet config module
 */
export async function init() {
    if (!fleetConfigTab || !fleetConfigPanel) return;

    // Open/close handlers
    fleetConfigTab.addEventListener("click", openFleetConfig);
    if (fleetConfigClose) {
        fleetConfigClose.addEventListener("click", closeFleetConfig);
    }

    // Close panel on outside click
    document.addEventListener("click", (e) => {
        if (
            fleetConfigPanel &&
            !fleetConfigPanel.classList.contains("hidden") &&
            !fleetConfigPanel.contains(e.target) &&
            !fleetConfigTab.contains(e.target)
        ) {
            closeFleetConfig();
        }
    });

    // Load settings and populate inputs
    const data = await api.loadFleetSettings();
    if (data.settings) {
        for (const setting of data.settings) {
            const input = document.querySelector(`.fc-number[data-key="${setting.key}"]`);
            if (input) {
                input.value = setting.value;
            }
        }
    }

    // Wire up all fleet config inputs
    document.querySelectorAll(".fc-number").forEach((input) => {
        const key = input.dataset.key;
        const min = parseInt(input.min, 10);
        const max = parseInt(input.max, 10);

        // Save on change (blur or Enter)
        input.addEventListener("change", () => {
            let val = parseInt(input.value, 10);
            if (isNaN(val)) val = min;
            val = Math.max(min, Math.min(max, val));
            input.value = val;
            input.classList.add("saving");
            setTimeout(() => input.classList.remove("saving"), 350);
            api.saveFleetSetting(key, val);
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                input.blur();
            }
        });
    });

    // Wire up +/- buttons
    document.querySelectorAll(".fc-increment").forEach((btn) => {
        btn.addEventListener("click", () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            const max = parseInt(input.max, 10);
            let val = parseInt(input.value, 10) || 0;
            if (val < max) {
                input.value = val + 1;
                input.dispatchEvent(new Event("change"));
            }
        });
    });

    document.querySelectorAll(".fc-decrement").forEach((btn) => {
        btn.addEventListener("click", () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            const min = parseInt(input.min, 10);
            let val = parseInt(input.value, 10) || 0;
            if (val > min) {
                input.value = val - 1;
                input.dispatchEvent(new Event("change"));
            }
        });
    });
}
