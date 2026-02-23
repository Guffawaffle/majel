# Changelog

All notable changes to Majel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Alpha versioning (v0.x):** Breaking changes may occur between minor versions. Migration paths are not guaranteed.

---

## [Unreleased]

### Added

#### Effects Contract v3 — Phase 6 CI budgets + runtime split/caching rollout (#145)
- Added `effects:budgets` AX command with configurable thresholds in `data/seed/effects-ci-budget.v1.json`.
  - Block gates: deterministic hash stability, inferred promoted ratio, mapped coverage floor.
  - Warn budget: low-confidence candidate count.
  (`scripts/ax/effects-budgets.ts`, `data/seed/effects-ci-budget.v1.json`)
- Integrated `effects:budgets` into default `ax ci` pipeline as an explicit gate step with surfaced warning metrics. (`scripts/ax/ci.ts`, `scripts/ax.ts`)
- Added runtime split artifact delivery endpoints with deterministic hash-addressed paths and cache headers:
  - `/api/effects/runtime/manifest.json`
  - `/api/effects/runtime/taxonomy.<hash>.json`
  - `/api/effects/runtime/officers.index.<hash>.json`
  - `/api/effects/runtime/chunk-<id>.<hash>.json`
  (`src/server/routes/effects.ts`)
- Updated web fetch strategy to load effect data via manifest/taxonomy/index/chunks with fallback to legacy `/api/effects/bundle`. (`web/src/lib/effect-bundle-adapter.ts`)
- Added runtime split fetch coverage in effect bundle tests. (`test/effect-bundle.test.ts`)

#### Effects Contract v3 — Phase 5 override engine + precedence checks (#144)
- Added explicit override seed surface `data/seed/effects-overrides.v1.json` and integrated deterministic precedence: generated base -> overrides -> final artifact in `effects:build`. (`data/seed/effects-overrides.v1.json`, `scripts/ax/effects-build.ts`)
- Added contract-level override executor for `replace_effect` operations with stable target IDs and forced override metadata (`forcedByOverride=true`). (`src/server/services/effects-contract-v3.ts`)
- Added contradiction protections for override processing:
  - taxonomy contradiction checks (invalid refs block)
  - intra-ability contradiction checks on source-span key conflicts
  - override contradiction checks for duplicate mutation targets/signatures/effect IDs
  (`src/server/services/effects-contract-v3.ts`)
- Added structured override audit/failure reporting in build flow and override metadata in build receipts. (`scripts/ax/effects-build.ts`, `scripts/ax/effects-harness.ts`)
- Added focused override tests for replace behavior, missing targets, duplicate-target conflicts, and duplicate-signature conflicts. (`test/effects-contract-v3.test.ts`)

#### Effects Contract v3 — Phase 4 gate runner + promotion receipts (#146)
- Enabled `effects:apply-decisions` to execute deterministic candidate gates, apply reviewed promotion decisions, and emit audit receipts. (`scripts/ax/effects-apply-decisions.ts`)
- Added deterministic gate runner coverage for schema/taxonomy/condition validity, ordering checks, confidence threshold, and intra-ability contradiction checks. (`scripts/ax/effects-harness.ts`)
- Added promotion materialization for approved candidates with explicit inferred metadata:
  - `extraction.method="inferred"`
  - `inferred=true`
  - `promotionReceiptId=<receiptId>`
  (`scripts/ax/effects-harness.ts`)
- Added no-overwrite invariant enforcement to block deterministic effect mutation regressions during promotion. (`scripts/ax/effects-harness.ts`)
- Added gate/promotion tests and command-chain smoke coverage in the harness workflow. (`test/effects-harness.test.ts`)

#### Effects Contract v3 — Phase 3 trigger pipeline + sidecar provenance (#142)
- Added strict `needs_interpretation` trigger detection in hybrid inference flow:
  - `effects.length === 0 && !isInert`
  - or `unmapped` contains `unmapped_ability_text|unknown_magnitude|low_confidence_mapping|unknown_effect_key`
  (`scripts/ax/effects-harness.ts`)
- Added candidate-level provenance metadata in inference sidecar records: `model`, `promptVersion`, `inputDigest`. (`scripts/ax/effects-harness.ts`)
- Added deterministic sidecar hashing and hash-scoped filename output: `inference-report.<hash>.json`. (`scripts/ax/effects-harness.ts`, `scripts/ax/effects-build.ts`)
- Added focused tests for trigger behavior and deterministic sidecar hash/path semantics. (`test/effects-harness.test.ts`)

#### Effects Contract v3 — Phase 1 Scaffold (#141)
- Added deterministic Effects Contract v3 scaffold service with:
  - seed contract validation (`validateEffectsSeedForV3`)
  - deterministic ordering helpers (`orderSeedForDeterminism`)
  - stable canonical hashing + artifact summary helpers
  - draft artifact generator with stable `abilityId`/`effectId` semantics
  (`src/server/services/effects-contract-v3.ts`)
- Added dry-run diagnostics command `npm run effects:dry-run` that validates seed data, checks deterministic hash stability, and prints a JSON report suitable for CI/PM review. (`scripts/effects-contract-dry-run.ts`, `package.json`)
- Added CI enforcement for effects dry-run via `ax ci` so contract validation executes in the default quality gate. (`scripts/ax/ci.ts`)
- Added focused tests for validation failures and determinism invariants. (`test/effects-contract-v3.test.ts`)

#### Effects AX build/review harness (Addendum C)
- Added committed AX harness commands for local snapshot review loops:
  - `effects:build` (deterministic + optional hybrid sidecar inference report)
  - `effects:review-pack` (AI-readable review JSON/Markdown pack)
  - `effects:apply-decisions` (guarded placeholder; intentionally disabled pending later gates)
  (`scripts/ax/effects-build.ts`, `scripts/ax/effects-review-pack.ts`, `scripts/ax/effects-apply-decisions.ts`, `scripts/ax/effects-harness.ts`, `scripts/ax.ts`, `package.json`)

#### Effects Officer Data Source v2 planning scaffold (ADR-035)
- Added ADR-035 proposing hybrid DB-derived officer scaffold flow with seed-minimal contract surface and fixture-only PR CI policy. (`docs/ADR-035-effects-officer-data-source-v2.md`)
- Added repository data hygiene policy documenting forbidden raw CDN/snapshot paths and guardrail workflow. (`DATA_HYGIENE.md`)
- Added AX `data:hygiene` command scaffold and integrated it into `ax ci` as an explicit CI gate step. (`scripts/ax/data-hygiene.ts`, `scripts/ax/ci.ts`, `scripts/ax.ts`, `package.json`)
- Added Phase 1 deterministic scaffold export command `effects:snapshot:export` emitting `snapshotId`, `schemaHash`, `contentHash`, and stable fixture export payloads for hermetic PR workflows. (`scripts/ax/effects-snapshot-export.ts`, `scripts/ax.ts`, `package.json`)
- Added Phase 2 build input split: `effects:build` now accepts `--input=<snapshot-export.json>` and records input provenance metadata (`snapshotId`, `contentHash`, `schemaHash`) in build output/receipts while preserving deterministic hash behavior. (`scripts/ax/effects-build.ts`, `scripts/ax/effects-harness.ts`)
- Added Phase 3 pinned snapshot verification command `effects:snapshot:verify` with mismatch-fail behavior for expected `contentHash` and computed integrity checks (`schemaHash`/`contentHash`) to support nightly pinned snapshot gates. (`scripts/ax/effects-snapshot-verify.ts`, `scripts/ax.ts`, `package.json`)
- Added Phase 4 fixture-only seed split: moved officer rows from `effect-taxonomy.json` into `effect-taxonomy.officer-fixture.v1.json` and updated loaders/dry-run to merge fixture officers at build time while keeping contract primitives in the main seed file. (`data/seed/effect-taxonomy.json`, `data/seed/effect-taxonomy.officer-fixture.v1.json`, `scripts/ax/effects-harness.ts`, `src/server/services/effect-seed-loader.ts`, `scripts/effects-contract-dry-run.ts`)
- Added optional Phase 5 schema scaffold `catalog_effect_value` for future value canonicalization semantics (`comparator`, `scale`, `raw_span_ref`) without changing current extractor/runtime behavior. (`src/server/stores/effect-store.ts`)
- Follow-up hardening from ADR-035 review:
  - provenance source locators now reference the fixture corpus namespace (`effect-taxonomy.officer-fixture.v1.json#/officers/byAbilityId/...`) for snapshot export and unmapped fallback evidence paths.
  - `ax ci` now runs `data:hygiene` in strict mode.
  - snapshot `contentHash` policy now excludes `generatedAt` so timestamp-only export changes do not invalidate pinned hash checks.
  (`scripts/ax/effects-snapshot-export.ts`, `scripts/ax/effects-snapshot-verify.ts`, `scripts/ax/ci.ts`, `scripts/ax/effects-harness.ts`, `src/server/services/effects-contract-v3.ts`, `docs/ADR-035-effects-officer-data-source-v2.md`, `DATA_HYGIENE.md`)

### Fixed

#### Effects runtime caching + CI budget accuracy (post-review hardening)
- Runtime split endpoints now preserve route-owned cache headers/ETag behavior instead of default envelope cache overrides, enabling manifest/hash asset caching semantics as designed. (`src/server/routes/effects.ts`)
- Manifest revalidation now uses stable bundle-hash ETag basis and supports 304 conditional responses with short-lived in-memory runtime artifact coherence window. (`src/server/routes/effects.ts`, `test/effect-routes.test.ts`)
- `mappedCoveragePercent` in effects budgets now measures mapped abilities directly (`isInert || effects.length>0`) instead of subtracting unmapped entry counts. (`scripts/ax/effects-budgets.ts`)
- Runtime artifact endpoints now return raw stable JSON representations (no per-request envelope meta), removing ETag/body representation drift risk for cacheable responses; manifest `generatedAt` remains stable for unchanged `bundleHash`. (`src/server/routes/effects.ts`, `test/effect-routes.test.ts`)

#### Effect taxonomy seed contract parity
- Seed taxonomy now includes `targetTag: station` and `effectKey: penetration` so existing intent/ability references pass strict contract validation. (`data/seed/effect-taxonomy.json`)

### Validation
- `effects:dry-run` now returns `ok: true` with deterministic repeat hash stability on current seed input.
- Added runtime chunk cache revalidation coverage (`If-None-Match` -> `304`) alongside immutable cache assertions for taxonomy/index/chunk endpoints. (`test/effect-routes.test.ts`)

## [0.6.1] — 2026-02-21

### Security
- **Replace xlsx with exceljs** — removed vulnerable `xlsx@0.18.5` (prototype pollution, GHSA-4r6h-8v6p-xvw6) and replaced with `exceljs@4.4.0` (zero known CVEs). XLSX import support fully re-enabled. (`src/server/services/import-mapping.ts`, `test/import-routes-data.test.ts`)
- **SSRF hardening for web_lookup** — all 4 `fetch()` calls in the web lookup tool now use `redirect: "error"` (blocks open-redirect SSRF), `AbortSignal.timeout(10_000)` (prevents slowloris/hang), and a 2 MB response size cap via `safeReadText()` helper. (`src/server/services/fleet-tools/read-tools-web-lookup.ts`)

### Fixed

#### Crew Recommender (QuickCrew "Simple Mode")
- **Parsteel typo** — corrected "parasteel" → "parsteel" across intent catalog, crew types, and recommender keyword maps to match STFC game data. Mining-para intent now resource-matches correctly. (`web/src/lib/crew-recommender.ts`, `web/src/lib/intent-catalog.ts`, `src/server/types/crew-types.ts`)
- **Ore substring false positives** — replaced `.includes()` with `\b` word-boundary regex in `hasKeyword()` and `miningGoalFit()`. "ore" no longer false-matches on "explores", "stored", etc.
- **Inert Captain Maneuver detection** — officers whose CM text contains "has no effect", "inert", or "does nothing" now receive a -2 penalty instead of the +3 captain bonus.
- **Dead code removal** — removed unused `abilityBlob()` function that joined all 3 abilities regardless of bridge slot (was a BDA/CM leakage vector, never called).
- **Dead INTENT_KEYWORDS cleanup** — removed 9 unreachable `mining-*` entries from `INTENT_KEYWORDS` (the mining code path uses `MINING_RESOURCE_KEYWORDS` via `miningGoalFit()` instead).

#### Performance
- **AdmiralView tab-scoped refresh** — replaced 3-dataset fan-out `onMount → refresh()` with `$effect` watching `activeTab`. Only fetches data for the active tab; tracks loaded tabs to avoid redundant requests on tab switch. (#123) (`web/src/views/AdmiralView.svelte`)
- **FleetView cross-ref fan-out reduction** — `buildCrossRefs()` now performs tab-scoped lazy loading: officer cross-refs (bridge cores, reservations) fetched only when officers tab is active, ship cross-refs (loadouts, docks) only for ships tab. Removed dead `fetchBelowDeckPolicies()` call that was fetched but never consumed. Added `crossRefLoadedTabs` tracking to avoid redundant rebuilds on tab switch. (#127) (`web/src/views/FleetView.svelte`)

### Added
- **Web lookup rate-limit tests** — 3 new tests covering rate-limit enforcement after 5 requests, per-domain isolation, and observability metrics. (`test/fleet-tools.test.ts`)

---

## [0.6.0] — 2026-02-21

### Added

#### Start/Sync Guided Setup (ADR-026a A1)
- New Start/Sync hub view with first-run flow and guided ownership setup (`web/src/views/StartSyncView.svelte`)
- Guided setup templates + matcher engine for recommended officers/ships (`web/src/lib/guided-setup-templates.ts`)
- One-shot cross-view launch intents for Catalog/Workshop handoff (`web/src/lib/view-intent.svelte.ts`)

#### API Mutation Locking + Local-First Consistency
- Per-entity mutation lock orchestration to prevent concurrent write races (`web/src/lib/api/mutation.ts`)
- New mutation locking coverage tests (`web/src/lib/api/mutation.test.ts`, `web/src/lib/api/mutation-locking.test.ts`)
- Cache epoch invalidation primitive for precise stale-read prevention (`web/src/lib/cache/cache-epochs.ts`)

#### Data Interaction Coverage Expansion
- New auth-boundary matrix suite for data routes (`test/data-route-auth-boundaries.test.ts`)
- Shared route case helpers for reusable error/authorization assertions (`test/helpers/data-route-base.ts`, `test/helpers/route-cases.ts`)
- New inventory and research store integration tests (`test/inventory-store.test.ts`, `test/research-store.test.ts`)
- New import data and composition inference test coverage (`test/import-routes-data.test.ts`, `test/import-composition-inference.test.ts`)

### Changed

#### Backend Data Routes and Stores
- Import routes hardened for data safety and composition inference workflows (`src/server/routes/imports.ts`)
- Receipt route behaviors tightened for resolve/undo and validation edge cases (`src/server/routes/receipts.ts`)
- Admiral/catalog route updates for improved diagnostics and consistency (`src/server/routes/admiral.ts`, `src/server/routes/catalog.ts`)
- Inventory/research/proposal store logic refined for upsert, filtering, and envelope consistency (`src/server/stores/inventory-store.ts`, `src/server/stores/research-store.ts`, `src/server/stores/proposal-store.ts`)

#### Web Client Flow Reliability
- Imports workshop flow expanded for unresolved-item handling and guided progression (`web/src/components/workshop/ImportsTab.svelte`)
- Plan/fleet/catalog/workshop/admiral views updated for cache-aware data flow and navigation continuity
- API modules migrated to locked mutation/invalidation patterns across chat, catalog, crews, imports, receipts, sessions, settings, and user-settings

### Fixed

- Dock/user data reliability hardening across scoped data paths and client mutation sequencing
- Cache race and stale-view scenarios reduced via lock-key serialization + targeted invalidation
- Auth envelope and rank-boundary behavior normalized across data-related endpoints

## [0.5.1] — 2026-02-21

### Added

#### Local-First Data Cache — Phase 1 (ADR-032, #107)
- **IndexedDB cache engine** (`web/src/lib/cache/idb-cache.ts`, 283 LOC) — generic IDB store with TTL expiration, stale-while-revalidate, `purge()`, `clear()`
- **Cached fetch wrapper** (`cached-fetch.ts`, 140 LOC) — drop-in replacement for `fetch()` with cache-first strategy, background revalidation, Svelte 5 `$state()` integration
- **Cache key registry** (`cache-keys.ts`, 87 LOC) — typed key builders + TTL constants per entity type (ships/officers/targets/sessions)
- **Reactive cache store** (`cache-store.svelte.ts`, 66 LOC) — Svelte 5 rune-based global cache instance with `$effect()` lifecycle
- **Barrel export** (`index.ts`, 33 LOC) — public API surface
- **43 tests** across 3 test files — IDB engine, cached fetch, cache keys
- **Integration** — wired into `catalog.ts`, `App.svelte`, `Sidebar.svelte`

#### Local-First Data Cache — Phase 2 (#108)
- **Crew entity caching** — all 13 crew GET functions routed through `cachedFetch(TTL.COMPOSITION)`: bridge cores, loadouts, variants, below-deck policies, docks, fleet presets, plan items, officer reservations, effective state
- **Invalidation rules** — 18 crew mutation functions call `invalidateForMutation()` with 9 mutation types mapped to precise cache key prefixes; import-commit flushes all catalog + crew caches
- **11 new tests** — crew key generation, invalidation map coverage

#### Local-First Data Cache — Phase 3 (#109)
- **Optimistic mutation helpers** (`optimistic.ts`, 89 LOC) — `optimisticCreate`, `optimisticUpdate`, `optimisticDelete` with snapshot + rollback on failure
- **Network status store** (`network-status.svelte.ts`) — reactive `navigator.onLine` + online/offline event listeners
- **Sync queue** (`sync-queue.svelte.ts`, 82 LOC) — in-memory mutation queue with replay on reconnect
- **OfflineBanner component** — "Offline — viewing cached data" banner + pending mutation count + "Sync now" button; auto-replays on reconnect
- **20 new tests** — 6 optimistic, 12 sync-queue, 2 network-status

#### Local-First Data Cache — Phase 4 (#110)
- **Settings cache** — `loadFleetSettings`, `loadSetting`, `loadUserSetting` routed through `cachedFetch(TTL.COMPOSITION)`; save mutations invalidate cache
- **ETag/If-None-Match** — `sendOk()` computes weak ETag from data payload on GET requests, returns 304 when match; browser HTTP cache handles conditional revalidation transparently
- **Cache hygiene** — startup purge increased from 48h to 7 days; `clearCacheOnLogout()` clears IDB + resets metrics
- **BroadcastChannel multi-tab** — `invalidateForMutation` broadcasts patterns to other tabs via `majel-cache` channel; receiving tabs invalidate local IDB entries
- **Performance metrics** (`cache-metrics.ts`) — hit/miss/revalidation counters + bandwidth estimation; wired into `cachedFetch`
- **Diagnostics Cache tab** — hit rate, miss rate, revalidations, bandwidth saved, clear/refresh buttons in DiagnosticsView
- **15 new tests** — 6 metrics, 6 broadcast, 3 settings key/invalidation

#### Multi-Timer Overlay (ADR-033, #111)
- **Timer store** (`timer.svelte.ts`, 219 LOC) — up to 10 concurrent timers, 250ms tick engine, localStorage persistence, Svelte 5 rune-based state
- **Web Audio sounds** (`timer-audio.ts`, 217 LOC) — 10 procedural LCARS-themed alert sounds via Web Audio API
- **UI components** — `TimerBar` (persistent top bar), `TimerPill` (compact badge), `TimerDetail` (expanded view), `TimerCreate` (form)
- **31 tests** — 21 timer store, 10 audio engine

### Fixed

#### Security
- **minimatch ReDoS (GHSA-3ppc-4f35-3m26)** — 7 high-severity transitive deps via `typescript-eslint` resolved with `overrides` in root `package.json`
- **ajv moderate vulnerability** — resolved via `npm audit fix`
- **xlsx prototype pollution (GHSA-4r6h-8v6p-xvw6)** — no upstream fix from SheetJS; feature-flagged at server validation layer (`imports.ts` analyze + validateSourcePayload guards) + UI file picker restricted to CSV-only

---

## [0.5.0] — 2026-02-20

### Added

#### Phase 8: Svelte Cutover (ADR-031 complete)
- **Legacy client deleted** — 45 files (~12,691 lines) removed from `src/client/`
- **Landing page separated** — `src/landing/` (landing.html, landing.css, landing.js) standalone from SPA
- **CSP cleaned** — `script-src` simplified from SHA-256 hash to `'self'` (Svelte uses external bundles only)
- **Dockerfile updated** — multi-stage build now copies landing + Svelte dist
- **Build pipeline** — `npm run build` wires landing copy + `npm --prefix web run build`

#### Frontend Test Suite (54 tests, 3 files)
- **fetch.test.ts** (21 tests) — ADR-004 envelope unwrap, CSRF header injection, 5xx sanitization, `qs()`, `pathEncode()`
- **router.test.ts** (18 tests) — view registry (7 views), redirect aliases (admin→admiral, drydock→crews), navigate, getViewDef
- **auth.test.ts** (15 tests) — fetchMe, 401 redirect, hasRole hierarchy, logout + redirect
- **vitest.config.ts (web)** — happy-dom environment + Svelte vite plugin
- **`npm run test:web`** — convenience script in root package.json

#### GitHub Actions CI
- **`.github/workflows/ci.yml`** — PostgreSQL 16 service container, lint → typecheck (server + web) → test (server + web) → build
- **15-minute timeout**, concurrency group, coverage artifact upload

#### Auth Audit Hardening (#91 WARN items)
- **W3:** Explicit `COLUMNS` constant replaces `SELECT *` in audit queries
- **W4:** Append-only enforcement — `trg_audit_append_only` trigger + `REVOKE DELETE` on `majel_app` role
- **W5–W7:** Verify-email success/failure and reset-password failure paths now audited with detail
- **W8–W9:** Bootstrap event renamed `admin.bootstrap`, uses `auditMeta(req)` helper
- **W10:** `GET /api/auth/admiral/users` (list users) now audited
- **W12:** Logger redact paths deepened — `**.token`, `**.password`, `req.headers.authorization`, `req.headers.cookie`
- **W15:** `parseAllowedIps()` validates IPv4/IPv6 syntax, logs and skips invalid entries
- **W16:** Trust proxy comment improved for multi-proxy deployments
- **W17:** 13 dedicated unit tests for `ip-allowlist.ts` (parseAllowedIps + middleware)
- **W18:** RUNBOOK expanded from 8 to 13 recipes — password reset abuse, signup spikes, 5xx errors, boot events, IP allowlist blocks

#### AX Toolkit Modular Refactor
- **`scripts/ax/` decomposition** — monolithic `ax.ts` (1,252 lines) split into 10 typed modules + thin router
  - `types.ts` (75 lines) — `AxResult`, `AxCommand`, domain types (`TestFailure`, `TypecheckError`, `LintError`, etc.)
  - `runner.ts` (114 lines) — `runCapture()`, `makeResult()`, `emitResult()`, arg helpers
  - `test.ts` (169), `typecheck.ts` (46), `lint.ts` (94), `status.ts` (71), `coverage.ts` (75), `diff.ts` (86), `ci.ts` (88), `affected.ts` (247)
  - `ax.ts` router reduced to 91 lines — static `COMMANDS` table dispatching to modules
- **`--ax` flag removed** — all `ax:*` scripts now emit JSON-only by default
- **NDJSON run history** — `logs/ax-runs.ndjson` append log for all ax invocations
- **CI composition** — `ci.ts` composes `lint.run()`, `typecheck.run()`, `test.run()` — zero duplication

#### CDN Data Pipeline (#83, ADR-028)
- **Game data snapshot ingest** — public CDN serving complete STFC game data as static JSON
  - Snapshot pipeline fetches all 7 entity types + 15 translation packs (73MB)
  - `syncCdnShips()` / `syncCdnOfficers()` parse, translate, and upsert 112 ships + 278 officers
  - CDN entities use `cdn:ship:<gameId>` / `cdn:officer:<gameId>` IDs (coexist with legacy `raw:*` entries)
  - CDN snapshot version (`version.txt` UUID) tracked and returned in sync response
- **Reference store schema expansion** — new columns for ships (`hull_type`, `max_tier`, `max_level`, `build_time_in_seconds`, `officer_bonus`, `crew_slots`, `build_cost`, `levels`, `game_id`) and officers (`officer_class`, `faction`, `synergy_id`, `max_rank`, `trait_config`)
- **Shared game enum module** (`game-enums.ts`) — hull type, officer class, rarity, faction label maps with helper functions, used by both ingest and fleet tools
- **Store filters** — `officerClass` (int), `hullType` (int), `grade` (int) added to SQL query builders + catalog REST API query params

#### CDN Data in UI (#84)
- **Catalog officer cards** — officer class badge (`CMD`/`SCI`/`ENG`, color-coded red/blue/gold), faction badge, below-deck ability (`BD:`)
- **Catalog ship cards** — hull type badge (Destroyer/Survey/Explorer/Battleship/Defense/Armada), max tier, max level, formatted build time
- **Filter dropdowns** — officer class selector (officers tab), hull type selector (ships tab) with server-side SQL filtering
- **Fleet view** — officer class + faction badges on officer rows/cards, hull type badge on ship rows/cards
- **Client-side game enums** (`utils/game-enums.js`) — hull type, officer class labels (full + abbreviated), `formatDuration()`

#### SDK Migration (ADR-027)
- **`@google/generative-ai` → `@google/genai`** — new modular SDK with streaming, structured output, improved error handling
  - `gemini-engine.ts` rewritten for new SDK API surface
  - `tool-runner.ts` refactored for new function calling format
  - System prompt and settings store rebuilt for SDK compatibility

#### Views
- **Crews view** (`#/crews`) — full composition workshop with 4 sub-tabs (Bridge Cores, Loadouts, Policies, Reservations)
- **Plan view** (`#/plan`) — effective state dashboard with fleet presets and plan items
- **Fleet Ops view** (`#/fleet-ops`) — docks, fleet presets, deployment with conflict detection

#### Canonical SafeRouter
- **Auto-wrap async handlers** — catches thrown errors, returns structured error responses
- **Global error hooks** — `onError` callback for logging/metrics

#### AI Tools + Briefing (ADR-025)
- **Fleet tool integration** — `suggest_crew`, `suggest_targets`, `resolve_conflict` surface CDN-enriched fields (officerClass, faction, hullType, maxTier, officerBonus, crewSlots)
- **Tool declarations** — descriptions updated to mention CDN field availability
- **Enriched payloads** — all officer payloads include officerClass + faction, ship payloads include hullType + maxTier

#### Target Mutation Tools (#80)
- **`create_target`** — create acquisition targets (officer/ship/crew) with dupe detection via active `ref_id` check, priority 1-3, optional tier/level/rank goals
- **`update_target`** — modify priority, status (active/abandoned), reason, or progression fields; redirects 'achieved' to `complete_target`
- **`complete_target`** — mark targets achieved with timestamp; guards against abandoned/already-achieved states
- **System prompt** — target tools added to mutation rules and tool selection guide

#### Dupe Detection (#81)
- **`create_bridge_core`** — detects duplicate by name (case-insensitive) and by member set (same 3 officers regardless of order or name)
- **`create_loadout`** — detects duplicate by name within the same ship (case-insensitive)
- **`create_variant`** — detects duplicate by name within the same base loadout (case-insensitive)
- All dupe responses follow AX-friendly pattern: `status: "duplicate_detected"`, existing entity details, `nextSteps`

#### Contextual Help System
- **Help panel** — slide-in drawer triggered by `?` button in the title bar, shows context-aware help for the current view
- **Per-view help content** — structured help for all 10 views: Chat, Catalog, Fleet, Drydock, Crew Builder, Fleet Ops, Crews, Plan, Diagnostics, Admiral Console
- **Browsable** — navigate between views' help from within the panel; "About Ariadne" global overview accessible from any view
- **Non-obtrusive UX** — no walkthroughs, no tooltips, no interruptions; purely pull-based (only appears when you click `?`)
- **Keyboard shortcuts** — per-view shortcut reference (Catalog: Space/T/arrows; Chat: Enter/Shift+Enter)
- **Tips** — contextual quick-tips for each view's key workflows
- **Router hook** — `onNavigate()` callback for view change listeners; help panel auto-closes on navigation

### Changed
- **Chat timeout** — 30s → 60s for complex AI responses
- **Session auto-titling** — sessions titled from first user message
- **AX-friendly mutation responses** — structured JSON output for all fleet tool mutations
- **Fleet tool schemas** — standardized for AI grokability (consistent parameter naming, descriptions)
- **Input validation hardening** — stricter parameter validation across fleet tool mutations
- **ADR-028 status** — "Proposed" → "Accepted" with CDN pipeline as foundational work

### Fixed
- **Session list CSS** — `.sidebar-spacer { flex: 1 }` → `flex: 0` — was competing with `.session-section { flex: 1 }`, crowding the session list
- **Auth flash on landing** — server-side cookie check redirects authenticated users directly to `/app` (302), eliminating flash of login page
- **Fleet view** — undefined `loadoutArr` + wrong policy unwrap key
- **Crews view** — 10 bug fixes from deep review
- **System prompt** — rebuilt to teach Aria to use her tools effectively

### Architecture
- **ADR-031: Svelte 5 + Vite migration decided** — vanilla JS client (8,335 LOC) migrating to Svelte 5 + Vite (no SvelteKit). Express API untouched. See [ADR-031](docs/ADR-031-svelte-migration.md).
- **ADR-002 superseded** — original SvelteKit recommendation replaced by ADR-031 (Svelte + Vite without Kit)
- **ADR-030: View Consolidation proposed** — retire Crew Builder, Drydock, Fleet Ops; consolidate to 7 views

### Security
- **Injection defense** — parameterized queries, rate limits, guided actions for fleet mutations
- **CSP hardening** — hash mismatch fix + pre-commit guard
- **Cross-cutting security** — TOCTOU fixes, N+1 elimination, apiFetch migration

### Added (prior)

#### Loadout Architecture (ADR-022)
- **PostgreSQL loadout store** — `loadout-store.ts` with intent catalog, loadouts, docks, plan items, officer conflict detection
  - 100 tests covering CRUD, away members, planning, edge cases
  - Batch SQL queries (`ANY($1::int[])`) — N+1 eliminated from resolveLoadouts, resolvePlanItems, listDocks
  - Transactional creates (`withTransaction` for createLoadout, createPlanItem)
  - Window function for officer conflict detection (`COUNT(*) OVER (PARTITION BY officer_id)`)

#### Cloud CLI v2 (ADR-018)
- **20 commands** across 3 auth tiers: open, read, write
  - Status, health, logs, env, secrets, sql, revisions, diff, metrics, costs, warm (read)
  - Deploy, build, push, rollback, scale, canary, promote, ssh (write)
  - Help, init (open)
- **AX mode** (`--ax` flag) — structured JSON output for AI agent consumption
  - All exit paths emit valid JSON (no silent failures)
  - Per-step error context in multi-step commands (deploy)
  - Recovery `hints[]` on every failure path
  - Command arg schemas in `help --ax` output
- **Auth tier system** — `.cloud-auth` token file with `chmod 600`, env var fallback for CI

#### Model Selector
- **5 Gemini tiers** — flash-lite, flash, 3-flash-preview, 2.5-pro, 3-pro-preview
  - Hot-swap via `POST /api/models/select` (Admiral only, no restart)
  - Persisted to settings store, survives restarts
  - `GET /api/models` returns full registry + current + default

#### Postgres Middleware (ADR-021)
- **PostgresFrameStore** — Lex frame store backed by PostgreSQL with RLS
- **Memory middleware** — per-user scoped memory via `attachScopedMemory()`

#### User System (ADR-019)
- **Role-based access control** — Ensign, Lieutenant, Captain, Admiral tiers
  - Session cookie + Bearer token auth flows
  - `requireRole(appState, minRole)` middleware factory
  - Legacy tenant cookie backward compatibility

#### AX Mode Documentation
- **docs/AX-SCHEMA.md** — documents both CLI `AxOutput` and API envelope schemas
  - Error codes reference with agent-specific guidance
  - Auth tier documentation

### Changed
- **API discovery** (`GET /api`) — now includes `auth` tier per endpoint, `body`/`params` schemas for key endpoints, updated envelope description mentioning `hints`
- **API error envelope** — `sendFail()` accepts optional `hints?: string[]` parameter; `ApiErrorResponse.error` gains optional `hints` field
- **Health endpoint** — returns `retryAfterMs: 2000` + `Retry-After` HTTP header when status is `"initializing"`
- **Diagnostic endpoint** — reads actual model from `geminiEngine.getModel()` (was hardcoded `"gemini-2.5-flash-lite"`)
- **Model select response** — `hint` (string) → `hints` (string array) for consistency with CLI convention
- **`GET /api/models`** — includes `defaultModel` field

### Security
- **Shell injection prevention** — `execSync` → `execFileSync` + `shellSplit()` in Cloud CLI
- **Token validation** — 32+ hex char pattern enforcement on cloud auth tokens
- **Env value masking** — `cmdDiff` shows only drifting key names, masks all values with `****`
- **Input validation** — numeric validation on scale args, regex validation on revision names
- **SET clause allowlists** — commented in updateLoadout/updatePlanItem SQL builders
- **Auth error codes** — use `ErrorCode.*` constants instead of string literals
- **Auth hint hardening** — no env var names leaked in error responses
- **SIGINT/SIGTERM handlers** — graceful cleanup for cmdLogs/cmdSsh child processes

### Improved
- **Batch SQL performance** — loadout member, away member, and dock assignment queries collapsed from N+1 to 2 queries
- **Seed performance** — 24 sequential INSERTs collapsed to 1 multi-value INSERT
- **API key validation** — `createGeminiEngine()` throws immediately if key is empty
- **Model validation** — `setModel()` throws on unknown model ID (was silent fallback)
- **Engine lifecycle** — `close()` method clears session cleanup interval timer
- **Limit clamping** — history and recall `limit` params clamped to 1-100
- **Error logging** — memory save failures logged at `error` level with sessionId context
- **Discovery fidelity** — route list includes auth tiers and param schemas
- **Test coverage** — 1,348 server tests across 42 files + 54 frontend tests (3 files)

---

## [0.4.0] - 2026-02-08

### Added

#### Catalog + Overlay Model (ADR-016)
- **Reference + overlay architecture** — immutable wiki data with personal overlay deltas
  - Reference store: `reference-store.ts` — read-only officer/ship data from wiki
  - Overlay store: `overlay-store.ts` — user levels, tiers, notes, priorities (survives re-syncs)
  - Merged views: `GET /api/catalog/officers/merged`, `GET /api/catalog/ships/merged`
  - Entity counts: `GET /api/catalog/counts`
- **Wiki sync** — bulk import from STFC Fandom wiki (174 officers, 54 ships)
  - `POST /api/catalog/sync` — scrape + parse + upsert
  - Canonical entity IDs: `wiki:officer:<pageId>`, `wiki:ship:<pageId>` (ADR-015)
  - Idempotent: safe to re-run without losing overlay data
- **Catalog API** — 8 endpoints for browsing and overlaying fleet data
  - `GET /api/catalog/officers`, `GET /api/catalog/ships` — reference data
  - `GET /api/catalog/officers/:id`, `GET /api/catalog/ships/:id` — individual records
  - `PATCH /api/catalog/officers/:id/overlay`, `PATCH /api/catalog/ships/:id/overlay` — set overlays
  - `DELETE /api/catalog/officers/:id/overlay`, `DELETE /api/catalog/ships/:id/overlay` — clear overlays
  - `POST /api/catalog/bulk-overlay` — batch overlay updates

#### Drydock System (ADR-010)
- **Drydock loadouts** — ship configurations with officer assignments
  - CRUD: `GET/PUT/DELETE /api/dock/docks/:num`
  - Summary: `GET /api/dock/docks/summary`
  - Conflict detection: `GET /api/dock/docks/conflicts`
  - Cascade preview: `GET /api/dock/docks/:num/cascade-preview`
- **Intent system** — declarative crew roles
  - `GET/POST/DELETE /api/dock/intents`
  - `PUT /api/dock/docks/:num/intents`
- **Crew presets** — reusable crew configurations with tagging
  - `GET/POST/PATCH/DELETE /api/dock/presets`
  - Dock-specific preset finder: `GET /api/dock/docks/:num/presets`
  - Tag management: `GET /api/dock/tags`

#### Fleet Tab (ADR-017)
- **Inline-editable fleet roster** — power, rank, tier, level, priority, notes
  - Debounced auto-save on field blur
  - Filter bar (owned, all, faction, rarity) with search
  - Stats bar with live aggregates (total power, officer/ship counts)
  - Power column with formatted display (e.g., "42.5M")

#### AI Diagnostics
- **Natural-language query tool** — AI-powered data exploration
  - `GET /api/diagnostic` — health check
  - `POST /api/diagnostic/schema` — describe database schema to AI
  - `POST /api/diagnostic/query` — AI generates + executes SQL from natural language
  - `POST /api/diagnostic/summary` — AI summarizes query results
- **Diagnostics tab** — browser UI with query input, SQL transparency, result display

#### SPA Routing
- **Hash-based routing** — 5 views: `#chat`, `#catalog`, `#fleet`, `#drydock`, `#diagnostics`
  - Tab state persisted in URL hash
  - Back/forward browser navigation support
  - Default view: `#chat`

#### Session Management (ADR-009)
- **Chat session store** — SQLite-backed session persistence
  - `GET/PATCH/DELETE /api/sessions(/:id)`
  - Multi-tab safety: session IDs generated client-side
- **Session isolation** — independent Gemini chat per browser tab

#### Configuration
- **Settings schema** — 49 configurable settings across 5 categories
  - Model tuning: temperature, topP, topK, maxOutputTokens
  - System: request timeout, log level, log format
- **Settings API** — `GET/PATCH /api/settings`, `DELETE /api/settings/:key`
- **Unified config resolver** — priority: user setting > env var > schema default

#### Documentation
- **17 ADRs** covering architecture, framework, epistemic model, API design,
  middleware, identity, fleet management, image interpretation (planned),
  session isolation, drydock loadouts, structured logging, Ariadne rebrand,
  LCARS v2, MicroRunner, canonical entity identity, catalog-overlay model,
  and fleet tab return.

### Changed

#### Route Reorganization
- **7 route modules** — modular routing across 56 endpoints:
  - `routes/core.ts` — health, API discovery
  - `routes/chat.ts` — chat, history, recall
  - `routes/catalog.ts` — officers, ships, overlays, sync
  - `routes/docks.ts` — loadouts, presets, tags, intents
  - `routes/diagnostic-query.ts` — AI data queries
  - `routes/sessions.ts` — session CRUD
  - `routes/settings.ts` — settings CRUD
- **API discovery** — `GET /api` lists all endpoints with descriptions

#### Google Sheets Removal (ADR-016 D7)
- **Fully removed** — no Sheets API, no OAuth, no `googleapis` dependency
- Replaced by wiki sync + overlay model
- All `credentials.json`, `token.json`, spreadsheet config obsoleted

#### Gemini Engine
- **MicroRunner pipeline** (ADR-014) — classify → context gate → validate
  - Task types: `reference_lookup`, `dock_planning`, `fleet_query`, `strategy_general`
  - T2 reference packs injected on demand (not always in prompt)
  - Output validation against authority ladder
- **Drydock briefing injection** — system prompt includes dock summary
- **Session tracking** — `getSessionCount()` for diagnostics

### Improved
- **Security hardening** — server-side input validation on all PATCH routes
  - Level 1–200, tier 1–10, power 0–999M, rank 50 chars, targetNote 500 chars
  - CSS.escape() for user-generated selectors
  - TOCTOU race fix (overlay writes wrapped in transactions)
  - Stale closure fix in tab management
  - Double-fire blur+debounce prevention
- **Error handling** — consistent `ErrorCode` enum, structured error responses
- **Logging** — Pino structured JSON logs (`MAJEL_LOG_PRETTY=true` for dev)
- **Test coverage** — 13 test files, 512 tests via Vitest
- **Diagnostic depth** — `/api/diagnostic` shows frame counts, DB paths, uptime

---

## [0.3.0] - 2026-02-05

### Added

#### Middleware Layer (ADR-005 Phase 2)
- **Request/response envelope** — all API responses wrapped in `{ ok, data, meta }` / `{ ok, error, meta }`
  - `sendOk(res, data)` and `sendFail(res, code, message, status)` helpers
  - Eliminates raw `res.json()` usage in routes
  - Consistent error codes via `ErrorCode` enum
- **HTTP request logging** — Pino HTTP middleware (`pino-http`)
  - Logs all requests/responses with timing, status, user agent
  - Configurable via `MAJEL_LOG_LEVEL` (debug, info, warn, error)

#### Settings Store (ADR-005 Phase 3)
- **SQLite-backed settings** — user preferences persisted in `.smartergpt/lex/settings.db`
  - Priority chain: user override > env var > default
  - Type-safe schema with validation (string, number, boolean, JSON)
  - Sensitive fields marked for future masking
- **Settings API** — read/write via REST
  - `GET /api/settings` — all settings with resolved values
  - `PATCH /api/settings` — update multiple settings atomically
  - `DELETE /api/settings/:key` — reset to default

#### Configuration Unification (ADR-005 Phase 3)
- **Resolved config object** — single source of truth for runtime config
  - Reads from settings store → env vars → defaults
  - No more scattered `process.env` checks in route handlers
  - Injected into app context at boot

### Changed
- **Session history source** — `GET /api/history` now supports `?source=lex|session|both` (default: `both`)
  - Lex frames for long-term memory
  - Session store for current conversation
- **Gemini client cleanup** — removed `GoogleGenerativeAI` wrapper, using SDK directly
- **Port config** — `MAJEL_PORT` now respected via settings resolution

### Improved
- **Startup robustness** — app boots even if Sheets fails
  - Roster errors logged, `/api/health` reports `fleet.error`
  - Graceful degradation: chat works without fleet data
- **Test stability** — Vitest config tuned (10s timeout, fork pool for isolation)

### Fixed
- Env var precedence in config resolution
- Memory service initialization race condition
- HTTP logging interfering with test output

### Security
- Settings DB location configurable (defaults to workspace isolation)
- API key sensitivity markers added (not yet enforced)

---

## [0.2.0] - 2026-02-01

### Added

#### Lex Memory Integration (ADR-001)
- **Frame-based memory** — every chat turn persisted as Lex frame
  - Stores: user message, Gemini response, timestamp, metadata
  - Workspace-isolated: `LEX_WORKSPACE_ROOT` ensures separate DB
- **Semantic recall** — `GET /api/recall?q=kirk` searches by meaning
  - Lex embedding-based search (not keyword matching)
  - Returns relevant past conversations with context
- **Timeline history** — `GET /api/history` shows chronological conversation log
  - Powered by Lex frame timestamps
  - Persists across server restarts

#### Modern Chat UI
- **LCARS-inspired dark theme** — Star Trek: TNG computer aesthetic
  - High-contrast orange/blue palette
  - Responsive layout (mobile-friendly)
- **Markdown rendering** — Gemini responses formatted with headers, lists, code blocks
- **Copy buttons** — click-to-copy for code blocks and full responses
- **Sidebar toggle** — collapsible history/recall panel

#### API Endpoints
- `POST /api/chat` — send message, get Gemini response
- `GET /api/history` — conversation timeline from Lex
- `GET /api/recall?q=query` — semantic search of past conversations
- `GET /api/health` — system status (Gemini, Lex, Sheets)
- `GET /api/roster` — fetch/refresh fleet data from Sheets

### Changed
- **Gemini model** — upgraded to `gemini-2.5-flash-lite` (preview)
  - 1M token context window (up from 32K in 1.5-flash)
  - Allows full roster injection (~30K tokens)
- **System prompt** — epistemic framework integrated
  - Source attribution: "According to your roster..."
  - Confidence signaling: "Based on available data..." vs. "I'm uncertain..."
  - No fabrication: refuse to answer if data unavailable

### Improved
- **Multi-tab Sheets parsing** — handles officer/ship/custom tabs automatically
  - `MAJEL_TAB_MAPPING` env var for tab configuration
- **Error reporting** — structured error messages in API responses
- **Logging** — Pino logger with debug/info/warn/error levels

---

## [0.1.0] - 2026-01-25

### Added
- **Initial MVP** — proof-of-concept Python CLI
  - Google Sheets OAuth integration
  - Gemini API chat via `google-generativeai` SDK
  - CSV roster parsing and injection into system prompt
  - Basic conversation loop (no memory, no UI)

#### Core Features
- **Roster ingestion** — fetch STFC officer data from Google Sheets
  - OAuth 2.0 flow with `credentials.json` + `token.json`
  - CSV export and parsing
- **Brute-force context** — entire roster dumped into Gemini system prompt
  - No RAG, no vector DB — deterministic and simple
- **Gemini 1.5 Flash** — fast, cost-effective LLM
  - ~$0.10/1M input tokens (paid tier)
  - Content filters disabled (`BLOCK_NONE`)

#### Documentation
- **ADR-001** — Architecture (local-first, privacy-focused)
- **ADR-002** — Framework (SvelteKit deferred to v1.0)
- **ADR-003** — Epistemic Framework (source attribution, confidence)
- **ADR-004** — AX-First API (envelope pattern)
- **docs/SETUP.md** — OAuth walkthrough for Google Sheets
- **docs/PROMPT_GUIDE.md** — how Majel is trained

### Technical Decisions
- **Language:** Python → Node.js (ADR-001, v0.2 rewrite)
- **Framework:** Express (alpha) → SvelteKit (v1.0, ADR-002)
- **License:** MIT
- **Deployment:** Local-only (no cloud, ADR-001)

---

## Legend

- **Added** — new features, endpoints, capabilities
- **Changed** — modifications to existing behavior (may break compatibility)
- **Improved** — enhancements without breaking changes
- **Fixed** — bug fixes
- **Security** — vulnerability patches, security improvements
- **Deprecated** — features marked for removal (none yet in alpha)

---

*For detailed technical context, see [ADRs](docs/) and [CONTRIBUTING.md](CONTRIBUTING.md).*
