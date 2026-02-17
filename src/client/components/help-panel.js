/**
 * help-panel.js — Contextual Help Panel (slide-in drawer)
 *
 * Non-obtrusive right-side panel that shows help relevant to the
 * current view. Triggered by the "?" button in the title bar.
 *
 * UX principles:
 *   - Pull-based: only appears when you ask for it
 *   - Context-aware: shows help for whichever view you're on
 *   - Browsable: navigate to other views' help from within the panel
 *   - Dismissible: click outside, Escape, or click "?" again
 *   - No walkthroughs, no tooltips, no interruptions
 */

import { esc } from 'utils/escape.js';
import { getHelpForView, getHelpViewNames, helpContent } from 'components/help-content.js';

let panel = null;
let backdrop = null;
let isOpen = false;
let currentHelpView = null;
let onKeyDown = null;

// View display names and icons for the nav index
const VIEW_META = {
    chat:           { icon: '💬', label: 'Chat' },
    catalog:        { icon: '📋', label: 'Catalog' },
    fleet:          { icon: '🚀', label: 'Fleet' },
    drydock:        { icon: '⚓', label: 'Drydock' },
    'crew-builder': { icon: '👥', label: 'Crew Builder' },
    'fleet-ops':    { icon: '🎯', label: 'Fleet Ops' },
    crews:          { icon: '⚓', label: 'Crews' },
    plan:           { icon: '🗺️', label: 'Plan' },
    diagnostics:    { icon: '⚡', label: 'Diagnostics' },
    admiral:        { icon: '🛡️', label: 'Admiral Console' },
};

/**
 * Initialize the help panel. Call once during app startup.
 * Creates the DOM elements but keeps them hidden.
 */
export function initHelpPanel() {
    if (panel) return; // already initialized

    // Backdrop (click-outside dismiss)
    backdrop = document.createElement('div');
    backdrop.className = 'help-backdrop';
    backdrop.addEventListener('click', closeHelp);

    // Panel
    panel = document.createElement('aside');
    panel.className = 'help-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Help');

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
}

/**
 * Toggle the help panel. If closed, opens with content for the given view.
 * If open and showing the same view, closes. If open but different view, switches.
 *
 * @param {string|null} viewName — current active view name
 */
export function toggleHelp(viewName) {
    if (isOpen && currentHelpView === viewName) {
        closeHelp();
    } else {
        openHelp(viewName);
    }
}

/**
 * Open the help panel with content for the given view.
 * @param {string|null} viewName
 */
export function openHelp(viewName) {
    if (!panel) initHelpPanel();

    currentHelpView = viewName;
    renderContent(viewName);

    backdrop.classList.add('visible');
    panel.classList.add('open');
    isOpen = true;

    // Update title bar button state
    const btn = document.getElementById('help-btn');
    if (btn) btn.classList.add('active');

    // Keyboard dismiss
    onKeyDown = (e) => {
        if (e.key === 'Escape') { closeHelp(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKeyDown);

    // Focus trap — focus the panel for screen readers
    panel.focus();
}

/**
 * Close the help panel.
 */
export function closeHelp() {
    if (!panel || !isOpen) return;

    panel.classList.remove('open');
    backdrop.classList.remove('visible');
    isOpen = false;
    currentHelpView = null;

    const btn = document.getElementById('help-btn');
    if (btn) btn.classList.remove('active');

    if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown);
        onKeyDown = null;
    }
}

/** @returns {boolean} */
export function isHelpOpen() { return isOpen; }

// ─── Rendering ──────────────────────────────────────────────

/**
 * Render help content into the panel.
 * @param {string|null} viewName
 */
function renderContent(viewName) {
    const help = getHelpForView(viewName);
    const isGlobalView = !viewName || !helpContent[viewName];

    // Build sections HTML
    const sectionsHtml = help.sections.map(s => `
        <div class="help-section">
            <h4 class="help-section-heading">${esc(s.heading)}</h4>
            <div class="help-section-body">${s.body}</div>
        </div>
    `).join('');

    // Build tips HTML
    const tipsHtml = help.tips.length > 0 ? `
        <div class="help-tips">
            <div class="help-tips-label">💡 Tips</div>
            <ul>${help.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        </div>
    ` : '';

    // Build keyboard shortcuts HTML
    const keysHtml = help.keys.length > 0 ? `
        <div class="help-keys">
            <div class="help-keys-label">⌨ Keyboard</div>
            <div class="help-keys-grid">
                ${help.keys.map(k => `
                    <kbd>${esc(k.key)}</kbd>
                    <span>${esc(k.action)}</span>
                `).join('')}
            </div>
        </div>
    ` : '';

    // Build view index (browse other views' help)
    const viewIndex = buildViewIndex(viewName);

    panel.innerHTML = `
        <div class="help-header">
            <div class="help-header-text">
                <h3 class="help-title">${esc(help.title)}</h3>
                <p class="help-intro">${esc(help.intro)}</p>
            </div>
            <button class="help-close" aria-label="Close help" title="Close">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
        <div class="help-body">
            ${sectionsHtml}
            ${tipsHtml}
            ${keysHtml}
            ${!isGlobalView ? `
                <div class="help-divider"></div>
                <button class="help-about-btn" data-help-view="_global">
                    ⟐ About Ariadne
                </button>
            ` : ''}
            <div class="help-divider"></div>
            <div class="help-index">
                <div class="help-index-label">Help for other views</div>
                ${viewIndex}
            </div>
        </div>
    `;

    // Wire close button
    panel.querySelector('.help-close')?.addEventListener('click', closeHelp);

    // Wire "About Ariadne" button
    panel.querySelector('.help-about-btn')?.addEventListener('click', () => {
        renderContent(null);
        currentHelpView = null;
    });

    // Wire view index links
    panel.querySelectorAll('.help-index-link').forEach(link => {
        link.addEventListener('click', () => {
            const target = link.dataset.helpView;
            renderContent(target);
            currentHelpView = target;
            // Scroll to top of panel body
            panel.querySelector('.help-body')?.scrollTo(0, 0);
        });
    });
}

/**
 * Build the view index — clickable links to other views' help.
 * @param {string|null} currentView — currently displayed help view
 * @returns {string} HTML
 */
function buildViewIndex(currentView) {
    const views = getHelpViewNames();
    return `<div class="help-index-grid">
        ${views.map(name => {
            const meta = VIEW_META[name] || { icon: '📄', label: name };
            const isCurrent = name === currentView;
            return `
                <button class="help-index-link ${isCurrent ? 'current' : ''}"
                        data-help-view="${esc(name)}"
                        ${isCurrent ? 'disabled' : ''}>
                    <span class="help-index-icon">${meta.icon}</span>
                    <span class="help-index-name">${esc(meta.label)}</span>
                </button>
            `;
        }).join('')}
    </div>`;
}
