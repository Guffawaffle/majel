/**
 * confirm-dialog.js — Cascade-aware confirmation dialog
 *
 * Shows what will be removed before destructive actions.
 * Returns a Promise<boolean> — true if user approves, false if denied.
 */

let activeDialog = null;

/**
 * Show a confirmation dialog with cascade preview details.
 *
 * @param {Object} opts
 * @param {string} opts.title - e.g. "Delete Dock 3?"
 * @param {string} [opts.subtitle] - e.g. "PvP Defense"
 * @param {Array<{label: string, items: string[]}>} [opts.sections] - cascade groups
 * @param {string} [opts.approveLabel] - button text (default: "Delete")
 * @param {string} [opts.denyLabel] - button text (default: "Cancel")
 * @param {string} [opts.severity] - "danger" | "warning" (default: "danger")
 * @returns {Promise<boolean>}
 */
export function showConfirmDialog(opts) {
    // Dismiss any existing dialog
    dismissDialog();

    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";

        const severity = opts.severity || "danger";
        const approveLabel = opts.approveLabel || "Delete";
        const denyLabel = opts.denyLabel || "Cancel";

        // Build sections HTML
        let sectionsHtml = "";
        if (opts.sections && opts.sections.length > 0) {
            const nonEmpty = opts.sections.filter(s => s.items.length > 0);
            if (nonEmpty.length > 0) {
                sectionsHtml = `
                    <div class="confirm-cascade">
                        <div class="confirm-cascade-header">This will also remove:</div>
                        ${nonEmpty.map(section => `
                            <div class="confirm-cascade-section">
                                <div class="confirm-cascade-label">${esc(section.label)} (${section.items.length})</div>
                                <ul class="confirm-cascade-list">
                                    ${section.items.map(item => `<li>${esc(item)}</li>`).join("")}
                                </ul>
                            </div>
                        `).join("")}
                    </div>
                `;
            }
        }

        // If nothing would be removed, show a simple message
        const nothingToRemove = !opts.sections || opts.sections.every(s => s.items.length === 0);
        const emptyMsg = nothingToRemove
            ? `<p class="confirm-hint">No linked data will be affected.</p>`
            : "";

        overlay.innerHTML = `
            <div class="confirm-dialog ${severity}">
                <div class="confirm-header">
                    <span class="confirm-icon">${severity === "danger" ? "⚠" : "⚡"}</span>
                    <div class="confirm-titles">
                        <div class="confirm-title">${esc(opts.title)}</div>
                        ${opts.subtitle ? `<div class="confirm-subtitle">${esc(opts.subtitle)}</div>` : ""}
                    </div>
                </div>
                ${sectionsHtml}
                ${emptyMsg}
                <div class="confirm-actions">
                    <button class="confirm-btn deny">${esc(denyLabel)}</button>
                    <button class="confirm-btn approve ${severity}">${esc(approveLabel)}</button>
                </div>
            </div>
        `;

        // Events
        const approve = overlay.querySelector(".confirm-btn.approve");
        const deny = overlay.querySelector(".confirm-btn.deny");

        approve.addEventListener("click", () => { dismissDialog(); resolve(true); });
        deny.addEventListener("click", () => { dismissDialog(); resolve(false); });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) { dismissDialog(); resolve(false); }
        });

        // Keyboard
        const onKey = (e) => {
            if (e.key === "Escape") { dismissDialog(); resolve(false); }
            if (e.key === "Enter") { dismissDialog(); resolve(true); }
        };
        document.addEventListener("keydown", onKey, { once: true });

        document.body.appendChild(overlay);
        activeDialog = { overlay, onKey };
        deny.focus();
    });
}

function dismissDialog() {
    if (activeDialog) {
        activeDialog.overlay.remove();
        activeDialog = null;
    }
}

function esc(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
