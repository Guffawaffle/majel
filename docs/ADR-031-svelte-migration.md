# ADR-031: Frontend Migration — Svelte 5 + Vite (No Kit)

**Status:** Accepted  
**Date:** 2026-02-19  
**Authors:** Guff, Opie (Claude)  
**Supersedes:** ADR-002 (Framework Selection — SvelteKit)  
**References:** ADR-023 (Architecture Restructure), ADR-030 (View Consolidation)

---

## Context

The Majel client is a vanilla JS single-page application: 8,335 LOC across 28 files, 7 views plus 3 legacy views (pending ADR-030 consolidation), zero build step, browser-native ES modules via import map, hash routing, and no TypeScript.

This architecture was appropriate for the prototype-to-MVP phase (v0.1 → v0.4). It is now the primary source of friction:

### Pain Points

| Problem | Impact |
|---------|--------|
| **No component model** — views are procedural DOM manipulation (1,500 LOC in `crews.js` alone) | Adding sub-tabs, modals, or reusable widgets requires duplicating DOM logic |
| **No reactivity** — manual `querySelector` + `textContent` updates scattered through every view | State changes require manually finding and updating every DOM node |
| **No TypeScript** — 8,335 LOC of untyped JS | Refactoring is blind; API contract drift undetectable |
| **Scattered state** — module-scoped `let` variables, no stores | Cross-component state sharing is ad-hoc; no devtools |
| **No build step** — import maps work but prevent tree-shaking, minification, or HMR | DX is limited; no hot reload during development |

### Why Now

1. **ADR-030** consolidates 10 views → 7. Rebuilding in Svelte during consolidation is cheaper than consolidating in vanilla JS and then migrating.
2. **ADR-025 Crews view** (1,512 LOC) and **Plan view** (1,054 LOC) are the largest client files and the next major UI work. Building them in Svelte from the start avoids writing 2,500+ LOC that immediately needs rewriting.
3. **Research tree UI** (ADR-028 Phase 2) requires complex node-graph rendering with SVG dependency lines, progress tracking, and interactive nodes — Svelte's reactive bindings make this natural to build.

---

## Decision

**Svelte 5 + Vite** as a standalone client application in `web/`. No SvelteKit.

Express API remains 100% untouched. No proxy indirection, no server hooks, no adapter-node — Express serves the Vite build output as static files.

### Why NOT SvelteKit

ADR-002 originally recommended SvelteKit. After implementation analysis, the risk profile changed:

| Concern | Assessment |
|---------|-----------|
| **SSR not needed** | Majel is 100% behind auth. No SEO, no public pages, no first-paint optimization needed. SSR adds complexity for zero benefit. |
| **API proxy indirection** | SvelteKit's server routes would proxy to Express, adding a layer that doesn't exist today. Express already serves the API perfectly. |
| **Svelte API instability** | Three breaking version transitions (3 → 4 → 5) in 3 years. Runes (Svelte 5) are the latest shift. SvelteKit amplifies this — adapter changes, server hook changes, form action changes compound the framework churn. |
| **Lock-in to Kit's server model** | SvelteKit wants to own the HTTP server (adapter-node). Majel's Express server has 110 endpoints, 12 route modules, cookie-session auth, PostgreSQL RLS, and 1,344 tests. Moving this stack to Kit's model is high-risk, high-effort. |
| **Escape hatch** | Svelte + Vite is framework-independent. If Svelte 6 breaks everything, the migration target is "another Vite plugin" (React, Solid, Vue). With SvelteKit, the migration target is a full framework swap. |

### Why Svelte 5 Specifically

| Feature | Benefit |
|---------|---------|
| **Runes** (`$state`, `$derived`, `$effect`) | Explicit, predictable reactivity. No magic `$:` labels. |
| **Smallest runtime** | Compiles components away — no virtual DOM overhead. |
| **Single-file components** | HTML + logic + scoped CSS in one `.svelte` file. |
| **TypeScript native** | `<script lang="ts">` with template-level type checking. |
| **Vite integration** | First-class via `@sveltejs/vite-plugin-svelte`. HMR, tree-shaking, dev proxy. |

---

## Architecture

### Directory Structure

```
web/                              # NEW: Svelte client app
├── index.html                    # Vite entry point
├── vite.config.ts                # proxy /api → Express :3000
├── package.json                  # svelte, vite, @sveltejs/vite-plugin-svelte
├── tsconfig.json
└── src/
    ├── main.ts                   # Mount <App /> to #app
    ├── App.svelte                # Root: router + sidebar + title bar
    ├── app.css                   # LCARS theme (ported from layout.css + variables.css)
    │
    ├── lib/
    │   ├── api.ts                # Typed fetch wrapper (replaces 13 api/*.js files)
    │   ├── auth.ts               # Auth store ($state) — getMe, logout, role checks
    │   ├── router.ts             # Lightweight client-side hash router
    │   └── types.ts              # Client-side types (Officer, Ship, Loadout, etc.)
    │
    ├── components/
    │   ├── Sidebar.svelte
    │   ├── TitleBar.svelte
    │   ├── StatusBar.svelte
    │   ├── ConfirmDialog.svelte
    │   └── HelpPanel.svelte
    │
    └── views/
        ├── Login.svelte
        ├── Chat.svelte
        ├── Catalog.svelte
        ├── Fleet.svelte
        ├── Workshop/             # ADR-030 "Crews" → "Workshop"
        │   ├── Workshop.svelte   # Sub-tab container
        │   ├── Cores.svelte
        │   ├── Loadouts.svelte
        │   ├── Policies.svelte
        │   └── Reservations.svelte
        ├── Plan/
        │   ├── Plan.svelte
        │   ├── EffectiveState.svelte
        │   ├── Docks.svelte
        │   ├── FleetPresets.svelte
        │   └── PlanItems.svelte
        ├── Admiral.svelte
        ├── Diagnostics.svelte
        └── Settings.svelte
```

### Development Workflow

```
Terminal 1:  npm run dev:api     # Express on :3000
Terminal 2:  npm run dev:web     # Vite on :5173, proxy /api → :3000
```

Vite's dev server handles HMR and proxies API calls to Express. No CORS issues, no double-server confusion.

### Production Build

```
npm run build                    # tsc (server) + vite build (web)
```

Express serves the Vite output from `dist/web/`:

```typescript
// src/server/index.ts (addition)
app.use('/app', express.static(path.join(__dirname, '../web')));
app.get('/app/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});
```

### API Surface (unchanged)

All 110 endpoints across 12 route files remain exactly as-is. The Svelte client consumes them via a typed `api.ts` wrapper that replaces the current 13 untyped `api/*.js` modules. No endpoint changes, no middleware changes, no auth changes.

---

## Migration Plan

### Phase 0 — Scaffold (#95)
- Initialize `web/` with Vite + Svelte 5 + TypeScript
- Configure `vite.config.ts` with API proxy
- Verify HMR works with a hello-world component
- Add `dev:web` and `build:web` scripts to root `package.json`

### Phase 1 — Shell (#96)
- Port LCARS theme CSS (variables, base, layout)
- Build `App.svelte` with sidebar, title bar, status bar
- Implement lightweight hash router
- Auth gate (check session, redirect to login)

### Phase 2 — API Layer (#97)
- Create typed `api.ts` with `apiFetch()` wrapper (CSRF, envelope unwrapping)
- Create auth store with `$state` rune
- Type all API request/response interfaces

### Phase 3 — Chat View (#98)
- Port `chat.js` (709 LOC) + `sessions.js` (200 LOC) to `Chat.svelte`
- Markdown rendering, copy buttons, image upload
- Session sidebar with create/rename/delete

### Phase 4 — Catalog + Fleet (#99)
- Port `catalog.js` (736 LOC) → `Catalog.svelte`
- Port `fleet.js` (914 LOC) → `Fleet.svelte`
- Inline editing, filter bars, stats bars, card/list toggle

### Phase 5 — Crews + Plan (#100)
- Port `crews.js` (1,512 LOC) → `Workshop/` components (6+ files)
- Port `plan.js` (1,054 LOC) → `Plan/` components (5 files)
- Apply ADR-030 consolidation (absorb Drydock, Fleet Ops)
- **Largest payoff** — 2,566 LOC → decomposed Svelte components with proper state

### Phase 6 — Admiral + Diagnostics + Settings (#101)
- Port `admiral.js` (456 LOC) → `Admiral.svelte`
- Port `diagnostics.js` (461 LOC) → `Diagnostics.svelte`
- Port `settings.js` (313 LOC) → `Settings.svelte`

### Phase 7 — Components + Help (#102)
- Port `help-panel.js` (237 LOC) + `help-content.js` (404 LOC) → `HelpPanel.svelte`
- Port `confirm-dialog.js` → `ConfirmDialog.svelte`
- Port shared utilities (`game-enums.js`, `format.js`)

### Phase 8 — Production Integration (#103)
- Wire Vite build into production build pipeline
- Update Express static serving to use `dist/web/`
- Update Docker build to include Vite build step
- Delete legacy `src/client/` directory
- Update import map removal + CSP headers
- Final CI verification

---

## Parallel Operation

During migration, both clients co-exist:

- `/app` → old vanilla JS client (existing, served from `dist/client/`)
- `/v2` → new Svelte client (served from `dist/web/`)

This enables incremental validation. Each migrated view can be tested in `/v2` while the stable client remains at `/app`. When all views are ported and validated, `/v2` replaces `/app` and `src/client/` is deleted.

---

## What This ADR Does NOT Change

- **Express API** — all 110 endpoints, 12 route modules, all middleware unchanged
- **PostgreSQL schema** — no table changes, no migration changes
- **AI tools** — all 26+ Gemini function calling tools unchanged
- **Authentication** — cookie-session auth, CSRF, rate limiting unchanged
- **Tests** — all 1,344 server tests continue to pass (client has no tests today)
- **Cloud deployment** — Docker build adds `vite build` step, everything else unchanged

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Svelte 5 runes API is new | Bugs in edge cases | Runes are GA since Oct 2024; community is large |
| Large migration surface (8,335 LOC) | Partial completion risk | Parallel operation — old client stays working throughout |
| LCARS theme porting | Visual regression | Screenshot comparison at each phase |
| Vite config complexity | Build issues | Standard Svelte + Vite template; well-documented |
| Team ramp-up on Svelte | Slower initial velocity | Svelte has lowest learning curve of major frameworks |

---

## Consequences

### Positive
- **TypeScript throughout** — catch API contract drift at compile time
- **Component model** — reusable widgets, scoped CSS, reactive state
- **HMR during development** — instant feedback on changes
- **Smaller bundle** — Svelte compiles away; no runtime framework shipped
- **Future-proof** — Svelte + Vite is framework-agnostic build infra; easy to swap if needed
- **Research tree feasibility** — SVG node graphs with reactive bindings are natural in Svelte

### Negative
- **Migration effort** — 8,335 LOC to rewrite (but most is procedural DOM that simplifies dramatically in Svelte)
- **Temporary dual-client** — two clients served during migration (weeks, not months)
- **New dependency** — `svelte`, `@sveltejs/vite-plugin-svelte`, `vite` added to project

---

## References

- [ADR-002](ADR-002-framework.md) — Original SvelteKit recommendation (superseded)
- [ADR-023](ADR-023-architecture-restructure.md) — MVC restructure (completed, patterns carried forward)
- [ADR-030](ADR-030-view-consolidation.md) — View consolidation (7 views, executed during migration)
- [Svelte 5 Runes](https://svelte.dev/docs/svelte/what-are-runes)
- [Vite](https://vite.dev/)
- [@sveltejs/vite-plugin-svelte](https://github.com/sveltejs/vite-plugin-svelte)
