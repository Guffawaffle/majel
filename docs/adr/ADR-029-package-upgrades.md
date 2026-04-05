# ADR-029 — Package Version Upgrades

**Status:** Accepted ✅ (all phases complete)  
**Date:** 2025-07-25  
**Completed:** 2026-02-17  
**Context:** All 7 outdated dependencies were major-version bumps (except one minor). Upgrades sequenced by risk — all 5 phases executed successfully.

---

## Current State (post-cleanup)

| Package | Current | Latest | Bump | Risk |
|---------|---------|--------|------|------|
| `typescript-eslint` | 8.55.0 | 8.56.0 | MINOR | None |
| `dotenv` | 16.6.1 | 17.3.1 | MAJOR | Low |
| `@types/node` | 20.19.33 | 25.2.3 | MAJOR | Low |
| `eslint` + `@eslint/js` | 9.39.2 | 10.0.x | MAJOR | Low |
| `express` | 4.22.1 | 5.2.1 | MAJOR | Medium |
| `@types/express` | 4.17.25 | 5.0.6 | MAJOR | Medium |

**npm audit:** 0 vulnerabilities (qs DoS fixed separately).

---

## Upgrade Phases

### Phase 1 — Zero-Risk (no code changes)

```bash
npm i typescript-eslint@latest    # 8.55 → 8.56 (minor)
```
**Verify:** `npm run lint && npm run build`

---

### Phase 2 — Low-Risk Tooling

```bash
npm i dotenv@latest               # 16 → 17
```
- Majel uses `--import dotenv/config` preload only (no `dotenv.config()` calls).
- v17 keeps the `dotenv/config` entry point. No code changes needed.

**Verify:** `npm run dev` — confirm env vars load.

---

### Phase 3 — Type Definitions

```bash
npm i -D @types/node@latest       # 20 → 25
```
- All Node.js usage is stable APIs: `node:crypto`, `node:path`, `node:fs/promises`, `node:http`, `node:url`.
- No deprecated `Buffer` constructors, no callback-style fs APIs.

**Verify:** `npx tsc --noEmit`

---

### Phase 4 — ESLint Major

```bash
npm i -D eslint@latest @eslint/js@latest
```
- Already on flat config (`eslint.config.mjs`) — required format for ESLint 10.
- Custom plugin (`eslint-plugin-importmap.mjs`) uses standard rule API.
- `typescript-eslint` 8.56 supports ESLint 10 peer.

**Possible action:** Rule default changes may introduce new warnings. Run lint, review, suppress or fix as needed.

**Verify:** `npm run lint`

---

### Phase 5 — Express 5 (largest change)

```bash
npm i express@latest
npm i -D @types/express@latest    # or remove if express@5 ships types
```

#### Required Code Changes

1. **Path pattern syntax** — Express 5 uses `path-to-regexp` v8 with stricter rules:

   | File | Before | After |
   |------|--------|-------|
   | `src/server/routes/settings.ts:118` | `"/api/settings/:key(*)"` | `"/api/settings/{*key}"` |
   | `src/server/index.ts:242` | `"/app/*"` | `"/app/{*splat}"` |

2. **Type augmentation review:**
   - `src/server/types/express-locals.d.ts` — uses `declare global { namespace Express { interface Locals } }`. If Express 5 ships its own types, the augmentation target may change. Test with `tsc --noEmit`; if it breaks, switch to `declare module "express-serve-static-core"` pattern.
   - `src/server/services/memory-middleware.ts:20-25` — already uses the `declare module "express-serve-static-core"` pattern. May need namespace change if Express 5's types restructure.

3. **SafeRouter simplification (optional):**
   - `src/server/safe-router.ts` wraps route handlers to catch async rejections. Express 5 handles this natively. SafeRouter becomes redundant but harmless. Can be removed in a follow-up for clarity.

4. **`req.query` behavior:**
   - ~30 occurrences of `req.query.x as string` across routes. Express 5 defaults to returning query values as strings (not arrays). Existing `as string` casts remain valid. If any routes rely on repeated query params being arrays, they'll need updating.

5. **`express-rate-limit`** v8.2.1 — already supports Express 5. No action needed.

#### Pre-Flight Checklist for Express 5

- [ ] Search for any `req.param()` calls (none found, but re-verify)
- [ ] Search for `res.send(number)` patterns (none found)
- [ ] Test all route patterns with Express 5's path parser
- [ ] Run full test suite
- [ ] Test rate limiting behavior
- [ ] Test static file serving (`/app/`, `/login/`)
- [ ] Test WebSocket upgrade if applicable

**Verify:** `npm run build && npm test && npm run lint`

---

## Execution Strategy

| Phase | Packages | Commit Message |
|-------|----------|---------------|
| 1 | `typescript-eslint` | `chore(deps): bump typescript-eslint 8.55→8.56` |
| 2 | `dotenv` | `chore(deps): bump dotenv 16→17` |
| 3 | `@types/node` | `chore(deps): bump @types/node 20→25` |
| 4 | `eslint`, `@eslint/js` | `chore(deps): bump eslint 9→10` |
| 5 | `express`, `@types/express` | `feat(deps): upgrade to Express 5` |

Each phase is a separate commit. If any phase breaks, revert and investigate before proceeding. All phases can be done in a single session except Phase 5, which should have its own focused session with full testing.

---

## Decision

All upgrades completed. Phases 1–4 landed in commit `b4a23ae` (Phases 1-4) and Phase 5 in commit `4b2a64e` (Express 5). Zero outdated packages, zero npm audit vulnerabilities.
