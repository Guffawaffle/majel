# ADR-023: Architecture Restructure — MVC by Concern

| Field       | Value                                         |
|-------------|-----------------------------------------------|
| **Status**  | Proposed (revised after critical review)       |
| **Date**    | 2026-02-14                                    |
| **Author**  | Guff + Opie                                   |
| **Reviewed**| Critical review: security, AX, UX, DX         |
| **Branch**  | `arch/restructure` (proposed)                 |
| **Depends** | ADR-022 (loadout architecture), ADR-020       |
| **Blocks**  | #44 (Phase 3 UI), #41 (Phase 4 ADVANCED)      |

## Context

The Majel client grew organically from a single-page prototype to a 13-file, 8,290-line vanilla JS application. Every file sits flat in `src/client/` with no folder structure. The codebase has three critical pain points:

1. **Monolithic `api.js` (715 lines, 51 exports)** — every API domain (auth, chat, catalog, fleet, docks, loadouts, admin, sessions, intents, plan) lives in a single file. Adding a new domain means editing a file that touches all domains.

2. **Monolithic `styles.css` (2,541 lines)** — all CSS for all views in one file. Section headers exist but there's no isolation. Editing fleet styles risks breaking catalog styles through cascade collisions.

3. **Implicit coupling in `app.js` (485 lines)** — 7 hand-written `show*()` functions that each manually toggle 7+ DOM elements. Adding a new view requires editing app.js in 5+ places.

The server side is better — it already has a `routes/` directory — but 33 files sit flat in `src/server/` with no grouping by role (stores, types, services).

### Agent Experience Problem

An AI agent dropped into this codebase must read every file to orient. There's no folder structure to guide navigation, no README breadcrumbs, no predictable interfaces. The Phase 3 UI attempt exposed this: modifying loadout UI required touching 5 files across all domains simultaneously.

### Security Surface

The `admin` naming convention (`data-view="admin"`, `#/admin`, `/api/admin/*`, CSS class `.admin-*`) is a common bot probe target. Renaming to `admiral-dashboard` reduces automated scanning noise. Note: this is noise reduction, not a security boundary — the real protection is the `requireAdmiral()` middleware.

Additionally, the current codebase has **no CSRF protection** and **no Content-Security-Policy headers**. The existing auth uses `sameSite: strict` + `httpOnly` cookies, which mitigates cross-origin CSRF but does not protect against same-site subdomain attacks. The restructure introduces dynamic CSS injection (`ensureCSS`), which makes the absence of CSP `style-src` a real vector. Both gaps must be closed as part of this work.

## Decision

Restructure the client into an MVC-by-concern architecture with predictable conventions. Apply a lighter server-side grouping. Rename all external `admin` surfaces to `admiral-dashboard` / `admiral`. Close existing security gaps (CSP, CSRF) that the restructure would otherwise amplify.

## Client Structure

```
src/client/
├── index.html                          # Shell — loads foundation CSS + app.js
├── app.js                              # Thin init: auth gate, module loading, health poll
├── router.js                           # View registry, hash routing, lazy CSS, back button
│
├── api/                                # @layer: api-client
│   ├── _fetch.js                       # Shared fetch wrapper, envelope unwrap, CSRF, error class
│   ├── index.js                        # Barrel re-export (import * as api from 'api')
│   ├── auth.js                         # getMe, logout
│   ├── chat.js                         # sendChat, loadHistory, searchRecall
│   ├── sessions.js                     # fetchSessions, restoreSession, deleteSession
│   ├── settings.js                     # saveFleetSetting, loadFleetSettings
│   ├── catalog.js                      # fetchCatalogOfficers/Ships, counts, overlays, sync
│   ├── fleet.js                        # fetchShips, fetchOfficers, overlays, conflicts
│   ├── docks.js                        # fetchDocks, updateDock, deleteDock, dock ships/intents
│   ├── loadouts.js                     # loadout CRUD, members, by-intent
│   ├── plan.js                         # plan items, validation, briefing
│   ├── intents.js                      # fetchIntents
│   └── admiral.js                      # user mgmt, invites, sessions (admiral-only)
│   └── README.md
│
├── views/                              # @layer: views (one folder = one nav destination)
│   ├── chat/
│   │   ├── chat.js                     # init(), refresh(), destroy()
│   │   └── chat.css
│   ├── loadouts/                       # Phase 3 (#44) — created during restructure
│   │   ├── loadouts.js
│   │   └── loadouts.css
│   ├── catalog/
│   │   ├── catalog.js
│   │   └── catalog.css
│   ├── fleet/
│   │   ├── fleet.js
│   │   └── fleet.css
│   ├── diagnostics/
│   │   ├── diagnostics.js
│   │   └── diagnostics.css
│   └── admiral-dashboard/
│       ├── admiral-dashboard.js
│       └── admiral-dashboard.css
│   └── README.md
│
├── components/                         # @layer: shared-components
│   ├── confirm-dialog.js
│   ├── confirm-dialog.css
│   └── README.md
│
└── styles/                             # @layer: foundation (loaded by index.html)
    ├── variables.css                   # :root custom properties
    ├── base.css                        # Reset, html/body, typography, scrollbar
    ├── layout.css                      # #app flex, #main, sidebar, title bar, mobile header
    ├── input.css                       # Chat input, form controls, buttons, badges
    ├── responsive.css                  # @media queries (768px, 480px)
    └── README.md
```

## Server Structure

```
src/server/
├── index.ts                            # App factory + boot (unchanged)
├── config.ts, db.ts, logger.ts         # Infrastructure (unchanged)
├── envelope.ts, rate-limit.ts          # Middleware (unchanged)
│
├── routes/                             # Already exists — rename admin.ts only
│   ├── auth.ts
│   ├── catalog.ts
│   ├── chat.ts
│   ├── core.ts
│   ├── docks.ts
│   ├── loadouts.ts
│   ├── sessions.ts
│   ├── settings.ts
│   ├── diagnostic-query.ts
│   └── admiral.ts                      # was admin.ts — /api/admiral/* endpoints
│
├── stores/                             # NEW — group all *-store.ts
│   ├── dock-store.ts
│   ├── loadout-store.ts
│   ├── user-store.ts
│   ├── overlay-store.ts
│   ├── invite-store.ts
│   ├── postgres-frame-store.ts
│   ├── reference-store.ts
│   ├── behavior-store.ts
│   └── settings.ts
│
├── types/                              # NEW — group all *-types.ts + declarations
│   ├── dock-types.ts
│   ├── loadout-types.ts
│   └── express-locals.d.ts
│
└── services/                           # NEW — non-store business logic
    ├── gemini.ts
    ├── micro-runner.ts
    ├── dock-briefing.ts
    ├── plan-briefing.ts
    ├── wiki-ingest.ts
    ├── frame-maintenance.ts
    ├── memory.ts
    ├── memory-middleware.ts
    ├── auth.ts
    ├── email.ts
    └── password.ts
```

## Key Design Patterns

### 1. View Registry (replaces manual show*() functions)

The view registry has a formal contract. Every view must provide:

```ts
// ViewConfig — the registry contract (documented, not enforced at runtime)
interface ViewConfig {
    area: HTMLElement;         // REQUIRED — the view's container element (from index.html)
    icon: string;              // REQUIRED — emoji for title bar
    title: string;             // REQUIRED — title bar heading
    subtitle: string;          // REQUIRED — title bar subtitle
    cssHref?: string;          // OPTIONAL — lazy-loaded CSS file path
    init?: () => void;         // OPTIONAL — called once on first navigation
    refresh: () => void;       // REQUIRED — called every time view becomes active
    destroy?: () => void;      // OPTIONAL — cleanup when leaving view
    gate?: string;             // OPTIONAL — required role (e.g. 'admiral')
}
```

Lifecycle: `registerView()` at module load → `init()` on first navigation → `refresh()` on every navigation → `destroy()` when leaving (if provided).

```js
// router.js
const views = new Map();
const initialized = new Set();

export function registerView(name, config) { views.set(name, config); }

export async function navigateToView(name) {
    const view = views.get(name);
    if (!view) return;
    // Gate check
    if (view.gate && getUserRole() !== view.gate) return;
    // Hide all views
    for (const [, v] of views) v.area?.classList.add('hidden');
    // Load CSS (async — wait to prevent FOUC)
    await ensureCSS(view.cssHref);
    // First-time init
    if (!initialized.has(name)) { view.init?.(); initialized.add(name); }
    // Show + refresh
    view.area.classList.remove('hidden');
    view.refresh?.();
    setTitleBar(view.icon, view.title, view.subtitle);
    setActiveNav(name);
}
```

Each view self-registers:
```js
// views/catalog/catalog.js
import { registerView } from 'router';
import * as catalogApi from 'api/catalog';

const area = document.querySelector('#catalog-area');

export function init() {
    registerView('catalog', {
        area,
        icon: '📋', title: 'Catalog', subtitle: 'Reference data & ownership tracking',
        cssHref: 'views/catalog/catalog.css',
        refresh,
    });
}

function refresh() { /* ... */ }
```

Adding a new view never requires editing app.js or router.js.

### 2. Shared Fetch Wrapper (replaces 51 copy-pasted patterns)

The `_fetch.js` wrapper is the single choke point for all API communication. It enforces:
- **CSRF protection** via custom `X-Requested-With` header (server validates presence)
- **Explicit credential mode** (`same-origin`) — no ambient credential leakage
- **5xx sanitization** — internal server errors return generic messages, never raw stack traces
- **Envelope unwrapping** — consistent `response.data` extraction

```js
// api/_fetch.js
export class ApiError extends Error {
    constructor(message, status, detail) {
        super(message);
        this.status = status;
        this.detail = detail; // structured error info, never raw body for 5xx
    }
}

export async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'majel-client',  // CSRF: server rejects without this
            ...opts.headers,
        },
        ...opts,
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
```

**Server-side CSRF validation** (added to `index.ts` middleware):
```ts
// All state-changing API routes require the custom header
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'majel-client') {
        return res.status(403).json({ error: { message: 'Missing CSRF header' } });
    }
    next();
});
```

This is lightweight and sufficient because:
- `Content-Type: application/json` already prevents simple CORS form submissions
- The custom header cannot be set by cross-origin requests without CORS preflight
- Combined with `sameSite: strict` cookies, this creates defense in depth

### 3. Lazy CSS Loading (async, with FOUC prevention)

CSS loading returns a Promise. The router `await`s it before unhiding the view, preventing flash of unstyled content.

```js
// router.js
const loadedCSS = new Set();
const CSS_HREF_PATTERN = /^(views\/[\w-]+\/[\w-]+\.css|components\/[\w-]+\.css|styles\/[\w-]+\.css)$/;

function ensureCSS(href) {
    if (!href || loadedCSS.has(href)) return Promise.resolve();

    // Security: validate href matches expected pattern (prevents CSS injection)
    if (!CSS_HREF_PATTERN.test(href)) {
        console.error(`ensureCSS: rejected invalid href "${href}"`);
        return Promise.resolve();
    }

    return new Promise(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        link.onerror = resolve; // degrade gracefully — unstyled is better than broken
        document.head.appendChild(link);
        loadedCSS.add(href);
    });
}
```

Foundation CSS (variables, base, layout, input, responsive) loaded via `<link>` tags in index.html. View-specific CSS loaded lazily on first navigation — zero wasted bytes, zero FOUC.

### 4. Content-Security-Policy Headers

Added as Phase 0 prerequisite — not optional:

```ts
// index.ts — CSP middleware (before static files)
app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",       // blocks injected external stylesheets
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "frame-ancestors 'none'",
    ].join('; '));
    next();
});
```

This locks down the attack surface that dynamic `ensureCSS` would otherwise open. The `style-src 'self'` directive means even if `ensureCSS` were called with a malicious URL, the browser would refuse to load it.

### 5. Import Maps (eliminates `../../` path counting)

Browser-native import maps eliminate relative path errors — the #1 source of agent-introduced bugs in module restructures:

```html
<!-- index.html -->
<script type="importmap">
{
    "imports": {
        "api/":        "./api/",
        "views/":      "./views/",
        "components/": "./components/",
        "router":      "./router.js",
        "app":         "./app.js"
    }
}
</script>
```

With this, imports become flat and unambiguous:
```js
// Before: import * as catalogApi from '../../api/catalog.js';
// After:
import * as catalogApi from 'api/catalog.js';
import { registerView } from 'router';
import { showConfirm } from 'components/confirm-dialog.js';
```

No bundler. No path counting. Agents can write imports by convention without reading the filesystem.

### 6. Admiral-Dashboard Rename (noise reduction)

All externally visible `admin` surfaces renamed. This is **noise reduction** (fewer bot hits in logs), not a security boundary — `requireAdmiral()` middleware is the real gate.

| Layer | Old | New |
|-------|-----|-----|
| DOM | `data-view="admin"`, `id="admin-area"` | `data-view="admiral-dashboard"`, `id="adm-area"` |
| Hash route | `#/admin` | `#/admiral-dashboard` |
| CSS classes | `.admin-*` | `.adm-*` |
| Client file | `admin.js` | `admiral-dashboard.js` |
| Server route file | `routes/admin.ts` | `routes/admiral.ts` |
| API paths | `/api/admin/*` | `/api/admiral/*` |
| Auth route paths | `/api/auth/admin/*` | `/api/auth/admiral/*` |

Internal variable names (`adminToken`, `adminListUsers`) remain unchanged — they never appear in URLs, DOM, or CSS and carry zero bot-scanning risk.

**Backward-compatible hash redirect** (preserves bookmarks for 3 release cycles):
```js
// router.js — hash migration map
const HASH_REDIRECTS = { 'admin': 'admiral-dashboard' };

function getViewFromHash() {
    let hash = window.location.hash.replace(/^#\/?/, '');
    if (HASH_REDIRECTS[hash]) {
        hash = HASH_REDIRECTS[hash];
        history.replaceState(null, '', `#/${hash}`); // update URL silently
    }
    return views.has(hash) ? hash : null;
}
```

**Old route tombstoning** — old `/api/admin/*` routes explicitly return 404. No redirects, no catch-all fallthrough. Documented in route file comments:
```ts
// routes/admiral.ts — old paths are gone, not redirected
// /api/admin/* → 404 (no route registered). No redirect to /api/admiral/*.
// This is intentional: redirects would leak the new path to scanners.
```

## Agent-Friendly Conventions

### File Header Manifests

Every file starts with an expanded manifest:
```js
/**
 * @module views/catalog/catalog
 * @layer view
 * @domain catalog
 * @depends api/catalog, components/confirm-dialog
 * @exports init, refresh
 * @emits catalog:filter-change, catalog:sync-complete
 * @listens hashchange
 * @requires-dom #catalog-area, .cat-grid, .cat-filters
 * @state { officers[], ships[], filters, isLoading }
 */
```

Tag reference:
| Tag | Purpose | Example |
|-----|---------|--------|
| `@module` | Import path from project root | `views/catalog/catalog` |
| `@layer` | Architectural layer | `view`, `api-client`, `component`, `foundation` |
| `@domain` | Business domain | `catalog`, `fleet`, `loadouts`, `admiral` |
| `@depends` | Direct import dependencies | `api/catalog, components/confirm-dialog` |
| `@exports` | Public API | `init, refresh` |
| `@emits` | Custom events dispatched | `catalog:filter-change` |
| `@listens` | Events this module handles | `hashchange, click` |
| `@requires-dom` | DOM elements this module queries | `#catalog-area, .cat-grid` |
| `@state` | Mutable module-level state | `{ officers[], filters, isLoading }` |

Enables:
- `grep -r @domain catalog` → all catalog-related files
- `grep -r @emits` → all event sources (trace event flow)
- `grep -r @requires-dom '#catalog-area'` → who depends on this DOM element
- `grep -r @state` → which modules are stateful (stale-state risk)

### File Size Guidelines

**Target 200 lines for new files.** Existing views will exceed this during migration — catalog (~550 lines), fleet (~540 lines) are expected. These will be refactored incrementally post-restructure:
- `catalog.js` → `catalog-render.js` + `catalog-filters.js` + `catalog-sync.js`
- `fleet.js` → `fleet-render.js` + `fleet-editing.js`

The 200-line target is aspirational for new work, not a hard constraint on migrated files.

### Predictable Interface Contract

- Every view exports `init()` and `refresh()`
- Every API module exports named functions: `fetchX`, `createX`, `deleteX`, `updateX`
- Every CSS file scopes selectors to view area: `.catalog-area .cat-grid`
- `api/index.js` barrel re-exports all domains: `import * as api from 'api/index.js'` still works for files that need broad access

### README Breadcrumbs

Each folder gets a comprehensive README with interface contract and howto:

```markdown
# views/

One folder per navigation destination. Each view is a self-contained module.

## Interface Contract

Every view module MUST export:
- `init()` — called by app.js at startup, registers with the view registry
- `refresh()` — called every time the view becomes active

Every view module MAY export:
- `destroy()` — cleanup when leaving the view

## How to Add a New View

1. Create `views/my-view/my-view.js` + `views/my-view/my-view.css`
2. Add `<section id="my-view-area" class="my-view-area hidden"></section>` to index.html
3. Add nav button: `<button class="sidebar-nav-btn" data-view="my-view">`
4. In `my-view.js`, call `registerView('my-view', { area, icon, title, ... })`
5. Import and call `init()` from `app.js`
6. That's it. No other files need editing.

## What NOT to Do

- Do NOT add show*() functions to app.js — use the registry
- Do NOT import from other view folders — views are independent
- Do NOT put API calls directly in view code — use api/ modules
```

`ls` + `cat README.md` gives an agent full orientation in 2 tool calls.

### No Implicit Coupling

The view registry eliminates app.js needing to know what views exist. Import maps (§5) eliminate relative path navigation — agents write imports by convention, not by counting `../` segments.

### Barrel Import Convention

The `api/index.js` barrel re-exports all domain modules for backward compatibility. However, **views must import directly from domain modules, not the barrel:**

```js
// ✅ YES — 1 network request, loads only fleet module
import { fetchShips, fetchOfficers } from 'api/fleet.js';

// ❌ NO — triggers browser to fetch ALL 12 API modules (barrel fan-out)
import * as api from 'api/index.js';

// ❌ NO — same problem, named import still triggers full barrel parse
import { fetchShips } from 'api/index.js';
```

**Why this matters:** With no bundler, the browser executes barrel re-exports literally. `import` from the barrel causes the browser to fetch, parse, and execute every re-exported module. On Cloud Run, each fetch is a billable request. With 12 API modules, a single barrel import turns 1 request into 12.

The barrel exists for **migration only** (Phase 1) — so existing code that does `import { fn } from './api.js'` can temporarily switch to `import { fn } from 'api/index.js'` before being updated to direct domain imports. After Phase 1 is complete, no view should reference the barrel.

### No-Bundler Ceiling

Browser-native ES modules are the right choice at current scale (~250KB total JS, ~20 modules). If the client grows past **500KB total JS** or **50+ modules**, evaluate `esbuild` as a zero-config bundler for minification + tree-shaking. This is a future decision, not a current concern.

### Import Verification

Every phase includes a verification step to catch broken imports:
```bash
# After Phase 1 — no consumer should still reference the old api.js
grep -r "from '.*api\.js'" src/client/ && echo 'FAIL: stale api.js import' && exit 1

# After Phase 3 — no flat view files should remain
ls src/client/chat.js src/client/catalog.js 2>/dev/null && echo 'FAIL: unmoved view files' && exit 1
```

## Migration Strategy

Each phase is one PR, independently mergeable. Tests pass after every phase. Import verification step runs at end of each phase (see §Agent-Friendly Conventions).

### Phase 0: Security Foundations + Scaffolding (#48)

This phase is non-optional — it establishes the security prerequisites that later phases depend on.

1. **CSP headers** — add `Content-Security-Policy` middleware to `index.ts`. `style-src 'self'` must be in place before Phase 2 introduces dynamic CSS loading.
2. **CSRF middleware** — add `X-Requested-With` validation for state-changing requests. Must be in place before Phase 1 creates the shared `_fetch.js` wrapper.
3. **Directory structure** — create all target directories with comprehensive README files.
4. **Import map** — add `<script type="importmap">` to `index.html`. Must be in place before Phase 1 changes import paths.
5. **ADR-023 committed** to branch.

Zero behavior change — existing code untouched, new middleware is additive.

### Phase 1: API Decomposition (#49)

Extract `api/` modules from monolithic `api.js`.

1. Create `_fetch.js` with CSRF header, credential mode, 5xx sanitization.
2. Split 51 functions into 12 domain files (auth, chat, sessions, settings, catalog, fleet, docks, loadouts, plan, intents, admiral).
3. Create `api/index.js` barrel re-export for backward compatibility.
4. Update all consumer imports to use import map paths.
5. Delete original `api.js`.
6. **Verify:** `grep -r "from '.*api\.js'" src/client/` returns 0 results.

### Phase 2: CSS Decomposition (#50)

Split `styles.css` along existing section boundaries.

1. Extract foundation CSS to `styles/` (variables, base, layout, input, responsive).
2. Extract view-specific CSS to `views/*/` folders.
3. Move confirm-dialog CSS to `components/`.
4. Update `index.html` `<link>` tags for foundation CSS.
5. View CSS files loaded via `<link>` tags initially (lazy loading wired in Phase 3).
6. **Verify:** `styles.css` deleted, every view visually identical.

Note: on HTTP/1.1 (local dev), 5 foundation CSS files may load slightly slower than 1 monolithic file. This is acceptable — production runs behind HTTP/2 on Cloud Run. If local dev perf is noticeable, foundation CSS can be concatenated into a single file.

### Phase 3a: Router Registry + First View (#51)

Highest-risk change — isolated to prove the pattern works.

1. Create `router.js` with view registry, async `ensureCSS`, hash routing, back button.
2. Migrate **chat view only** to `views/chat/chat.js` with `registerView()`.
3. `app.js` keeps all existing `show*()` functions except `showChat()` — replaced by registry.
4. Both old and new patterns coexist — incremental, testable.
5. **Verify:** chat works via registry, all other views work via old `show*()`, browser back/forward works.

### Phase 3b: Remaining Views (#51)

Migrate remaining views one at a time, testing between each:

1. catalog → `views/catalog/`
2. fleet → `views/fleet/`
3. diagnostics → `views/diagnostics/`
4. admin → `views/admiral-dashboard/` (rename happens here)
5. Move `sessions.js` → `views/chat/sessions.js` (it's a chat sub-module, not a standalone view)
6. Move `confirm-dialog.js` → `components/confirm-dialog.js`
7. Wire lazy CSS loading (switch from `<link>` tags to `ensureCSS()` for view CSS).
8. **Verify:** all views work via registry, no flat view files remain.

### Phase 3c: App.js Cleanup (#51)

Remove all scaffolding from the old pattern:

1. Delete all `show*()` functions from `app.js` (~140 lines).
2. Delete manual DOM element refs for each view area (~15 lines).
3. Delete `VALID_VIEWS` array (replaced by registry `views.keys()`).
4. `app.js` target: ≤200 lines (health, auth, ops level, recall dialog, mobile sidebar, init).
5. Delete `drydock.js` (849 lines). If loadout UI isn't ready, add an empty `views/loadouts/` placeholder.
6. **Verify:** `app.js` ≤200 lines, no `show*()` functions, all navigation via registry.

### Phase 4: Admiral-Dashboard Rename (#52)

Rename all server-side `admin` API routes to `admiral`.

1. Rename `routes/admin.ts` → `routes/admiral.ts`, update all route paths.
2. Update `routes/auth.ts` paths: `/api/auth/admin/*` → `/api/auth/admiral/*`.
3. Update `index.ts`: `createAdminRoutes` → `createAdmiralRoutes`.
4. Update client `api/admiral.js` fetch URLs.
5. Update `test/auth.test.ts` (~29 route path references).
6. Add backward-compatible hash redirect: `#/admin` → `#/admiral-dashboard`.
7. Old `/api/admin/*` routes return 404 — no redirects, no catch-all.
8. **Verify:** `grep -r '/api/admin' src/ test/` returns 0 results.

### Phase 5: Server Grouping (#53)

Independent of client phases — can run in parallel.

1. Move stores to `stores/`, types to `types/`, services to `services/`.
2. Update all import paths (mechanical find-and-replace).
3. No `tsconfig.json` changes needed — `include: ["src/**/*.ts"]` glob still matches.
4. **Verify:** `npm run build && npm test` green.

### Client Smoke Test (added — runs after Phase 3)

The client has no automated tests. Add a minimal import smoke test:

```ts
// test/client-imports.test.ts
import { describe, it, expect } from 'vitest';
import { readdir } from 'fs/promises';
import { join } from 'path';

describe('client module structure', () => {
    it('all view directories have required files', async () => {
        const viewsDir = join(__dirname, '../src/client/views');
        const views = await readdir(viewsDir, { withFileTypes: true });
        for (const v of views.filter(d => d.isDirectory())) {
            const files = await readdir(join(viewsDir, v.name));
            expect(files).toContain(`${v.name}.js`);
            expect(files).toContain(`${v.name}.css`);
        }
    });

    it('all api modules export from _fetch.js convention', async () => {
        const apiDir = join(__dirname, '../src/client/api');
        const files = await readdir(apiDir);
        expect(files).toContain('_fetch.js');
        expect(files).toContain('index.js');
    });

    it('no flat view files remain in src/client/', async () => {
        const clientDir = join(__dirname, '../src/client');
        const files = await readdir(clientDir);
        const staleViews = files.filter(f =>
            ['chat.js', 'catalog.js', 'fleet.js', 'diagnostics.js', 'admin.js', 'drydock.js'].includes(f)
        );
        expect(staleViews).toEqual([]);
    });
});
```

## File Lifecycle: drydock.js and sessions.js

Two existing files need explicit lifecycle plans:

**`drydock.js` (849 lines)** — the largest client file, entirely superseded by the loadout architecture:
- Phase 3a: untouched (chat migrates first)
- Phase 3b: moved to `views/drydock/drydock.js` with all other views
- Phase 3c: **deleted**. If loadout UI (#44) isn't ready, an empty `views/loadouts/` placeholder is created instead. The nav button changes from "Drydock" to "Loadouts" pointing at either the new view or the placeholder.

**`sessions.js` (214 lines)** — session list management, used by the chat view:
- Phase 3b: moved to `views/chat/sessions.js` (it's a chat sub-module, not an independent view)
- Import updated: `import * as sessions from './sessions.js'` → `import * as sessions from 'views/chat/sessions.js'`
- It does NOT get its own view folder — it has no nav destination.

## Consequences

### Positive
- New views require zero edits to existing files (just create a folder + register)
- Agent can orient in 2 tool calls per directory (ls + README)
- CSS changes to one view cannot cascade-break another
- Bot scanners find no `admin` surface
- CSP + CSRF protection established (was missing entirely)
- Import maps eliminate relative path errors (most common agent bug)
- File count increases but average file size drops from ~640 to ~150 lines
- Async CSS loading prevents FOUC
- Backward-compatible hash redirect preserves bookmarks

### Negative
- HTTP requests increase (more CSS files) — mitigated by HTTP/2 on Cloud Run + browser cache headers (`maxAge: '1d'`)
- Migration has 5 phases (7 sub-PRs) — requires discipline to avoid mixing concerns
- File header manifests add ~10 lines of metadata per file

### Neutral
- Total line count stays roughly the same (structure, not rewrite)
- Server behavior unchanged (only import paths and route file names move)
- No bundler introduced — still browser-native ES modules (ceiling: 500KB / 50 modules)
- Import paths don't get longer (import maps make them shorter)

## Cost & Infrastructure

Reviewed for cost footguns at $20/month hobby budget (GCP Cloud Run + Cloud SQL).

### Budget Floor

| Scenario | Monthly Cost | Notes |
|----------|-------------|-------|
| **Idle** | ~$8–9 | Cloud SQL db-f1-micro is 80% ($7.67 always-on) |
| **Hobby** (you + friends) | ~$10–12 | Cloud Run free tier covers compute |
| **Light use** (50 DAU) | ~$12–15 | Still within free tier |
| **Growth** (500 DAU) | ~$20–30 | Cloud SQL becomes undersized |

Cloud Run free tier: 2M requests/month, 360K vCPU-seconds. Hobby use never touches these limits.

### Cost Mitigations (implemented)

| # | Mitigation | Impact | Status |
|---|-----------|--------|--------|
| 1 | `compression` middleware | 60–70% smaller responses | ✅ Implemented |
| 2 | `maxAge: '1d'` + `etag` on static files | 90% fewer repeat requests | ✅ Implemented |
| 3 | PG pool `max: 5` (was unbounded default 10) | Prevents connection exhaustion at 3 instances | ✅ Implemented |
| 4 | Barrel import convention (direct domain imports) | Prevents 12x request fan-out per view | ✅ Documented |
| 5 | `startup-cpu-boost` on Cloud Run | 50% faster cold starts, free | ⏳ Enable on next deploy |

### Deferred Until Real Users

| # | Action | Trigger |
|---|--------|---------|
| 1 | Cloud CDN + Load Balancer | > 1,000 DAU or egress > $5/month |
| 2 | Bundler (esbuild) | Total JS > 500KB or > 50 modules |
| 3 | Neon PG migration | Cloud SQL bill pressure |
| 4 | `min-instances=1` | Cold starts annoying real users |
| 5 | Content hashing for immutable caching | After bundler is added |

## Review Findings Addressed

This ADR was revised after a formal critical review (security → AX → UX → DX). Key findings incorporated:

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| S1 | CRITICAL | No CSRF protection | `X-Requested-With` header in `_fetch.js` + server middleware (§2) |
| S2 | CRITICAL | `ensureCSS` CSS injection vector | Href whitelist regex + CSP `style-src 'self'` (§3, §4) |
| S3 | IMPORTANT | No CSP headers | CSP middleware added as Phase 0 prerequisite (§4) |
| S5 | IMPORTANT | `_fetch.js` leaks 5xx internals | 5xx sanitization in wrapper (§2) |
| S6 | IMPORTANT | No explicit `credentials` mode | `credentials: 'same-origin'` in wrapper (§2) |
| AX1 | IMPORTANT | File headers missing event/DOM/state tags | Expanded manifest with `@emits`, `@requires-dom`, `@state` |
| AX2 | IMPORTANT | `../../` relative paths cause agent errors | Import maps added (§5) |
| AX3 | IMPORTANT | View registry contract underspecified | Full `ViewConfig` interface documented (§1) |
| AX4 | IMPORTANT | 200-line cap unrealistic | Reframed as target for new files, extraction plan for existing |
| AX7 | NOTE | No barrel re-export | `api/index.js` barrel added |
| UX1 | IMPORTANT | Lazy CSS causes FOUC | `ensureCSS` returns Promise, router `await`s before showing (§3) |
| UX2 | IMPORTANT | Hash rename breaks bookmarks | Backward-compatible redirect map (§6) |
| UX3 | IMPORTANT | HTTP/2 assumed | Documented: prod is HTTP/2, local dev is HTTP/1.1, acceptable |
| DX1 | IMPORTANT | Phase 3 overloaded | Split into 3a (registry + chat), 3b (remaining), 3c (cleanup) |
| DX2 | IMPORTANT | No client tests | Import smoke test added post-Phase 3 |
| DX3 | IMPORTANT | No import verification | `grep` verification step per phase |
| DX5 | IMPORTANT | drydock.js lifecycle unspecified | Explicit lifecycle: move in 3b, delete in 3c |
| DX6 | MINOR | Phase 0 + Phase 6 too small | Phase 0 expanded (security), Phase 6 absorbed into Phase 3b |

## References

- ADR-022: Loadout Architecture (Phase 3 UI blocked on this restructure)
- ADR-020: Admiral Console (renamed in this ADR)
- ADR-010: Drydock (code to be deleted during Phase 3c)
- Critical Review: 2026-02-14 (security, AX, UX, DX — 18 findings, all addressed)
