/**
 * router.js — View Registry, Hash Routing & Lazy CSS
 *
 * Majel — STFC Fleet Intelligence System
 * ADR-023: View registry replaces manual show*() functions.
 *
 * Lifecycle: registerView() at setup → init() on first navigation →
 *            refresh() on every activation.
 */

const views = new Map();
const initialized = new Set();
const loadedCSS = new Set();

// Seed loadedCSS with CSS already present via <link> tags (prevents duplicates)
document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const href = link.getAttribute('href');
    if (href) loadedCSS.add(href);
});

// Security: whitelist valid CSS href patterns (ADR-023 §3)
const CSS_HREF_PATTERN = /^(views\/[\w-]+\/[\w-]+\.css|components\/[\w-]+\.css|styles\/[\w-]+\.css)$/;

// Hash redirect map — backward compatibility (Phase 4 adds 'admin' → 'admiral-dashboard')
const HASH_REDIRECTS = {};

// ─── State ──────────────────────────────────────────────────
let currentView = null;
let viewHistory = [];
let userRoleFn = () => null;

const $ = (sel) => document.querySelector(sel);

// ─── CSS Loading (async, FOUC prevention) ───────────────────

/**
 * Load a CSS file dynamically. Returns a Promise that resolves on load.
 * Validates href against a whitelist to prevent CSS injection (ADR-023 §3).
 */
function ensureCSS(href) {
    if (!href || loadedCSS.has(href)) return Promise.resolve();

    if (!CSS_HREF_PATTERN.test(href)) {
        console.error(`ensureCSS: rejected invalid href "${href}"`);
        return Promise.resolve();
    }

    return new Promise(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        link.onerror = resolve; // degrade gracefully — unstyled > broken
        document.head.appendChild(link);
        loadedCSS.add(href);
    });
}

// ─── View Registry ──────────────────────────────────────────

/**
 * Register a view in the router.
 *
 * @param {string} name — View identifier (matches data-view in sidebar)
 * @param {Object} config
 * @param {HTMLElement}   config.area       — Main container element
 * @param {HTMLElement[]} [config.extraAreas] — Additional elements to show/hide
 * @param {string}  config.icon      — Emoji for title bar
 * @param {string}  config.title     — Title bar heading
 * @param {string}  config.subtitle  — Title bar subtitle
 * @param {string}  [config.cssHref] — CSS path (lazy-loaded)
 * @param {Function} [config.init]   — Called once on first navigation
 * @param {Function} [config.refresh] — Called every activation
 * @param {string}  [config.gate]    — Required role (e.g. 'admiral')
 */
export function registerView(name, config) {
    views.set(name, { ...config, extraAreas: config.extraAreas || [] });
}

/** Set the function that returns the current user role. */
export function setUserRoleFn(fn) { userRoleFn = fn; }

/** Get the currently active view name. */
export function getCurrentView() { return currentView; }

/** Get the registered views map (read-only). */
export function getRegisteredViews() { return views; }

/**
 * Mark a view as already initialized.
 * Use for views that are eager-initialized during startup.
 */
export function markInitialized(name) { initialized.add(name); }

// ─── Navigation ─────────────────────────────────────────────

/**
 * Navigate to a registered view.
 * Hides all areas, loads CSS (async), runs init/refresh, updates chrome.
 */
export async function navigateToView(name, { pushHistory = true, updateUrl = true } = {}) {
    const view = views.get(name);
    if (!view) {
        // Unknown view — fall back to chat
        if (name !== 'chat' && views.has('chat')) {
            return navigateToView('chat', { pushHistory, updateUrl });
        }
        return;
    }

    // Gate check — redirect to chat on role mismatch
    if (view.gate && userRoleFn() !== view.gate) {
        if (views.has('chat')) return navigateToView('chat', { pushHistory, updateUrl });
        return;
    }

    // Track view history for back button
    if (pushHistory && currentView && currentView !== name) {
        viewHistory.push(currentView);
        if (viewHistory.length > 20) viewHistory.shift();
    }

    // Hide setup guide (non-view state)
    const setupGuide = $('#setup-guide');
    if (setupGuide) setupGuide.classList.add('hidden');

    // Hide all registered view areas
    for (const [, v] of views) {
        if (v.area) v.area.classList.add('hidden');
        for (const extra of v.extraAreas) {
            if (extra) extra.classList.add('hidden');
        }
    }

    // Load CSS (async — wait to prevent FOUC)
    await ensureCSS(view.cssHref);

    // First-time init
    if (!initialized.has(name) && view.init) {
        await view.init();
        initialized.add(name);
    }

    // Show target area(s)
    if (view.area) view.area.classList.remove('hidden');
    for (const extra of view.extraAreas) {
        if (extra) extra.classList.remove('hidden');
    }

    // Refresh
    if (view.refresh) await view.refresh();

    // Update title bar
    const titleBar = $('#title-bar');
    const heading = $('#title-bar-heading');
    const subtitle = $('#title-bar-subtitle');
    if (heading) heading.textContent = `${view.icon} ${view.title}`;
    if (subtitle) subtitle.textContent = view.subtitle || '';
    if (titleBar) titleBar.classList.remove('hidden');

    // Highlight active sidebar nav
    document.querySelectorAll('.sidebar-nav-btn[data-view]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.view === name)
    );

    currentView = name;

    // Update URL hash
    if (updateUrl && window.location.hash !== `#/${name}`) {
        history.pushState(null, '', `#/${name}`);
    }

    // Back button visibility
    const backBtn = $('#title-back-btn');
    if (backBtn) {
        backBtn.classList.toggle('hidden', viewHistory.length === 0 || name === 'chat');
    }
}

// ─── Hash Routing ───────────────────────────────────────────

/** Parse view name from URL hash, applying any redirects. */
export function getViewFromHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const resolved = HASH_REDIRECTS[raw] || raw;
    return views.has(resolved) ? resolved : null;
}

/**
 * Initialize hash routing, sidebar nav, popstate, and back button.
 * Call once after all views are registered.
 */
export function initRouting() {
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');

    // Sidebar navigation
    document.querySelectorAll('.sidebar-nav-btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            navigateToView(btn.dataset.view);
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.classList.add('hidden');
        });
    });

    // Browser back/forward
    window.addEventListener('popstate', () => {
        const view = getViewFromHash();
        if (view && view !== currentView) {
            if (viewHistory.length > 0) viewHistory.pop();
            navigateToView(view, { pushHistory: false, updateUrl: false });
        } else if (!view && currentView) {
            // Unknown hash — redirect to chat
            navigateToView('chat', { pushHistory: false, updateUrl: true });
        }
    });

    // In-app back button — triggers browser back (fires popstate)
    const backBtn = $('#title-back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (viewHistory.length > 0) history.back();
        });
    }
}

// ─── Sidebar Gating ─────────────────────────────────────────

/**
 * Show/hide sidebar nav items based on user role + view gates.
 * Also hides tools not yet wired to user accounts (QA-001-6).
 */
export function applySidebarGating() {
    const role = userRoleFn();
    for (const [name, view] of views) {
        if (view.gate) {
            const btn = document.querySelector(`.sidebar-nav-btn[data-view="${name}"]`);
            if (btn) btn.classList.toggle('hidden', role !== view.gate);
        }
    }

    // Hidden tools — not yet wired (QA-001-6)
    const historyBtn = $('#history-btn');
    const recallBtn = $('#recall-btn');
    if (historyBtn) historyBtn.classList.add('hidden');
    if (recallBtn) recallBtn.classList.add('hidden');
}
