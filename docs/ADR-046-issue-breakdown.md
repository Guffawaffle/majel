# ADR-046 — Issue Breakdown (Draft)

> Implementation plan for ADR-046 LCARS Design System & Token Contract.
> All issues belong under a single program umbrella issue.
>
> **Implementation character:** This is token cleanup and restrained
> polish, not a visual redesign. Every phase should finish feeling like
> a tightening of the existing system. See ADR-046 D6 (CSS-First Bias)
> and D7 (Hard Constraints).

---

## Umbrella Issue

**Title:** ADR-046 — LCARS Design System & Token Contract  
**Labels:** `program`, `frontend`  
**Body:**

```
Implement the LCARS design system token contract per ADR-046.

Linked ADR: docs/ADR-046-lcars-design-system-token-contract.md

### Program Objective
Lock the LCARS token architecture, clean up hardcoded color values,
add faction accent tokens, and apply restrained LCARS polish to the
Catalog page — all within documented production scope boundaries.

### Sequenced Implementation Plan

| Phase | Issue | Title | Status |
|---|---|---|---|
| 1 | #220 | Token contract foundation | [ ] |
| 2 | #221 | LCARS theme override cleanup | [ ] |
| 3 | #222 | Hardcoded rgba cleanup | [ ] |
| 4 | #223 | Faction badge colors | [ ] |
| 5 | #224 | Catalog LCARS polish | [ ] |
| 6 | #225 | Mobile LCARS sanity check | [ ] |

### Definition of Done
- [ ] All tokens defined in variables.css / lcars-theme.css only
- [ ] Zero hardcoded rgba accent values in view/component CSS
- [ ] Faction badges render per-faction colors from tokens
- [ ] Catalog page passes visual check in LCARS + dark themes
- [ ] Mobile viewport verified for LCARS theme
- [ ] `npm run ax -- ci` passes
```

---

## Phase 1 — Token Contract Foundation

**Title:** ADR-046 Phase 1 — Token contract foundation  
**Labels:** `frontend`, `design-system`

### Purpose
Establish the locked token set in `variables.css` as the single source
of truth. Add missing soft/dim accent variants, faction tokens, and state
alias tokens that production will depend on.

### Scope
- Add `--accent-gold-soft`, `--accent-blue-soft` tokens to `:root`
- Add `--state-success`, `--state-warning`, `--state-danger` alias tokens
- Add all 5 faction tokens (`--faction-federation`, `--faction-klingon`,
  `--faction-romulan`, `--faction-independent`, `--faction-borg`)
- Verify `--bg-user-msg` and `--focus-ring` are present
- Verify `--accent-green-dim`, `--accent-red-dim`, `--accent-orange-dim`
  are present (they are — confirm no value drift)
- Add inline comment block documenting semantic intent of accent tokens
  (gold = primary action, blue = structural, etc.)

### Non-Goals
- Renaming existing tokens
- Changing any existing token values
- Modifying any component or view files
- Adding LCARS-only tokens (that's Phase 2)

### Acceptance Criteria
- [ ] `variables.css` `:root` contains all tokens from ADR-046 D2
- [ ] Faction tokens are defined with muted palette values
- [ ] State alias tokens reference accent tokens via `var()`
- [ ] Semantic mapping comment block present in variables.css
- [ ] No visual regression — `dark` and `lcars` themes render identically to before
- [ ] `npm run ax -- ci` passes

### Implementation Notes
**File:** `web/src/styles/variables.css`

New tokens to add (values from ADR-046 D2):
```css
--accent-gold-soft:  rgba(240, 160, 48, 0.12);
--accent-blue-soft:  rgba(96, 160, 255, 0.12);

--state-success: var(--accent-green);
--state-warning: var(--accent-gold);
--state-danger:  var(--accent-red);

--faction-federation:  #5b9bd5;
--faction-klingon:     #d35f52;
--faction-romulan:     #3d9b56;
--faction-independent: #8a9199;
--faction-borg:        #45b5aa;
```

This phase is additive only — no consumers change yet.

---

## Phase 2 — LCARS Theme Override Cleanup

**Title:** ADR-046 Phase 2 — LCARS theme override cleanup  
**Labels:** `frontend`, `design-system`

### Purpose
Tighten the LCARS theme layer. Add LCARS-only tokens, verify structural
CSS consumes tokens correctly, and confirm no token definitions have
leaked into component styles.

### Scope
- Add `--lcars-warm` and `--lcars-warm-soft` tokens to `[data-theme="lcars"]`
  in `lcars-theme.css`
- Verify sidebar rail gradient uses `var(--accent-gold)`, `var(--accent-blue)`,
  `var(--accent-purple)` (it does today — confirm)
- Verify title bar elbow uses `var(--accent-gold)` (it does — confirm)
- Verify boot screen color blocks and labels use token references, not
  hardcoded hex with inline fallbacks
- Audit all component `<style>` blocks: confirm none define CSS custom
  properties (search for `--` in `<style>` blocks)
- Document `--font-lcars` in the LCARS token comment block

### Non-Goals
- Changing LCARS visual appearance
- Adding new LCARS structural CSS
- Touching catalog or data-layer components

### Acceptance Criteria
- [ ] `--lcars-warm` and `--lcars-warm-soft` are defined in `lcars-theme.css`
- [ ] `--font-lcars` is documented in LCARS token comment block
- [ ] No component `<style>` block defines a `--` custom property
- [ ] LoadingScreen.svelte hexes that have token equivalents use tokens
- [ ] No visual regression in LCARS mode boot screen, sidebar, title bar
- [ ] `npm run ax -- ci` passes

### Implementation Notes
**Primary files:**
- `web/src/styles/lcars-theme.css`
- `web/src/components/LoadingScreen.svelte` (style block only)

**Audit scope:** all `.svelte` files in `web/src/components/` and
`web/src/views/` — grep for `^\s*--` inside `<style>` blocks.

### Risks
- LoadingScreen.svelte uses `var(--accent-gold, #f0a030)` fallback
  pattern extensively. These fallbacks are correct defensive CSS and
  should be preserved (they protect against missing token definition).
  Only convert bare hex values that have no `var()` wrapper.

---

## Phase 3 — Hardcoded rgba Cleanup

**Title:** ADR-046 Phase 3 — Replace hardcoded rgba values with tokens  
**Labels:** `frontend`, `design-system`, `tech-debt`

### Purpose
Replace all hardcoded `rgba()` accent values scattered across view CSS
and component styles with references to the soft/dim tokens added in
Phase 1.

### Scope
Replace hardcoded rgba values with token references in:

| File | Approx. count | Values |
|---|---|---|
| `catalog-view.css` | 5 | gold soft (×4), green-dim fallback (×1) |
| `fleet-view.css` | 7 | gold soft (×3), blue-dim fallbacks (×2), green-dim (×1), gold-dim (×1) |
| `LoadingScreen.svelte` | 5 | gold soft (×1), red-dim (×3), blue soft (×1) |
| `ChatInput.svelte` | 1 | gold soft (×1) |
| `ImageLightbox.svelte` | 2 | red-dim (×2) |
| `crew-validator.css` | 6 | existing fallbacks — verify they use tokens now |
| `diagnostics-view.css` | 1 | red-dim fallback |
| `EffectiveStateTab.svelte` | 1 | red-dim fallback |

Total: ~28 replacements across 8 files (excluding values already in
variables.css itself).

### Non-Goals
- Changing visual appearance — replacement values must be visually
  identical (some `rgba` opacities differ slightly at 0.10 vs 0.12;
  normalize to the token's 0.12 / 0.18 — acceptable variance)
- Adding new tokens beyond what Phase 1 defined
- Touching template/markup in any component

### Acceptance Criteria
- [ ] Zero bare `rgba(240, 160, 48, ...)` outside variables.css
- [ ] Zero bare `rgba(96, 160, 255, ...)` outside variables.css
- [ ] Zero bare `rgba(248, 113, 113, ...)` outside variables.css
- [ ] Zero bare `rgba(52, 211, 153, ...)` outside variables.css
- [ ] Zero bare `rgba(251, 146, 60, ...)` outside variables.css
- [ ] `var(--token, rgba(...))` fallback patterns converted to `var(--token)` only
  (the token is now guaranteed to exist from Phase 1)
- [ ] Visual spot-check: catalog, fleet, boot screen, chat input, image
  lightbox, crew validator, diagnostics — no color shift
- [ ] `npm run ax -- ci` passes

### Implementation Notes
This is a mechanical find-replace pass. Recommended approach:

1. Search for each `rgba(R, G, B,` pattern
2. Replace with corresponding `var(--accent-*-soft)` or `var(--accent-*-dim)`
3. For `var(--token, rgba(...))` patterns, simplify to `var(--token)`

**Edge case:** LoadingScreen uses very low opacity (`0.06`, `0.08`) which
doesn't match any standard token. This is an implementation-review item
(ADR-046 D10), not a design question. During implementation:
- Try the standard soft token (0.12) — if the visual result is acceptable
  on the boot screen's near-black background, use it.
- If not, keep the bare `rgba()` with an inline comment and move on.

Do not block the phase on this decision.

---

## Phase 4 — Faction Badge Colors

**Title:** ADR-046 Phase 4 — Faction badge colors  
**Labels:** `frontend`, `design-system`, `catalog`

### Purpose
Replace the uniform `--accent-blue` color on all faction badges with
per-faction colors resolved from the faction tokens added in Phase 1.

### Scope
- Add a `factionCss(value: string)` function that maps faction name
  strings (as they appear in the data) to CSS class suffixes
- Update Badge.svelte `cssClass` derivation for `kind="faction"` to
  use `factionCss(value)`
- Add per-faction CSS classes in Badge.svelte `<style>` block:
  `.badge-faction-federation`, `.badge-faction-klingon`, etc.
- Each class sets `color: var(--faction-*)` from the root tokens
- Default/unknown factions fall back to `--faction-independent`

### Non-Goals
- Adding faction colors to cards, backgrounds, or page-level surfaces
- Adding faction-colored border-left on catalog cards (that's Phase 5)
- Changing Badge component props or interface
- Touching any file other than Badge.svelte (and possibly game-enums.ts)

### Acceptance Criteria
- [ ] Federation officers show blue badge text (`#5b9bd5`)
- [ ] Klingon officers show muted red badge text (`#d35f52`)
- [ ] Romulan officers show olive-green badge text (`#3d9b56`)
- [ ] Independent officers show gray badge text (`#8a9199`)
- [ ] Borg officers show cyan badge text (`#45b5aa`)
- [ ] Unknown/null faction falls back to `--faction-independent`
- [ ] No change to badge layout, size, or structure
- [ ] Faction colors render correctly in both `dark` and `lcars` themes
- [ ] `npm run ax -- ci` passes

### Implementation Notes
**Primary file:** `web/src/components/Badge.svelte`

The faction name values coming from the data need to be mapped to
classes. This is an implementation-review item (ADR-046 D10): decide
during this phase whether `factionCss()` lives in `Badge.svelte` or
`game-enums.ts`. Don't pre-decide — check the data shape first.

Check `CatalogOfficer.faction.name` values in the database
to confirm exact faction strings (likely: "Federation", "Klingon
Empire", "Romulan Star Empire", "Independent", "Borg"). The mapper
must be case-insensitive and handle partial matches (e.g., "Klingon"
from "Klingon Empire").

```typescript
function factionCss(value: string | number | null | undefined): string {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("federation")) return "badge-faction-federation";
  if (v.includes("klingon"))    return "badge-faction-klingon";
  if (v.includes("romulan"))    return "badge-faction-romulan";
  if (v.includes("borg"))       return "badge-faction-borg";
  if (v.includes("independent")) return "badge-faction-independent";
  return "badge-faction-independent"; // default
}
```

CSS additions:
```css
.badge-faction-federation  { color: var(--faction-federation); }
.badge-faction-klingon     { color: var(--faction-klingon); }
.badge-faction-romulan     { color: var(--faction-romulan); }
.badge-faction-independent { color: var(--faction-independent); }
.badge-faction-borg        { color: var(--faction-borg); }
```

### Risks
- Faction name strings in the database might not match expected values.
  Verify with a quick SQL query before implementing:
  `SELECT DISTINCT faction_name FROM reference_officers ORDER BY 1`

---

## Phase 5 — Catalog LCARS Polish

**Title:** ADR-046 Phase 5 — Catalog LCARS polish  
**Labels:** `frontend`, `design-system`, `catalog`

### Purpose
Apply restrained LCARS visual refinements to the Catalog page. All
changes are CSS-only within the LCARS theme scope — no template changes
unless explicitly justified (see ADR-046 D6).

### Scope
- Add `[data-theme="lcars"]` overrides in `catalog-view.css` for:
  - Card border-radius (inherit from theme `--radius` — may already work)
  - Gold (`--accent-gold`) border-color on card hover
  - Card name rendered in `--font-lcars` (if it improves readability — evaluate)
  - Filter chips: slightly rounder in LCARS mode
  - Tab bar: verify pill-shaped buttons work with existing LCARS overrides
- Optional: faction-colored `border-left` on catalog cards using a CSS
  class + `var(--faction-*)` — implementation-review item (ADR-046 D10):
  only if the template already has a class hook or data attribute for
  faction. If it requires adding a DOM element, it is out of scope.
- Verify card density at grid scale (500+ items) with LCARS theme active
- Verify letter bar doesn't overflow at larger LCARS radii

### Non-Goals
- Adding new DOM elements for LCARS framing
- Adding text-bearing card rails
- Card structural changes
- Touch files outside catalog-view.css and lcars-theme.css
- Faction-colored card backgrounds

### Acceptance Criteria
- [ ] Catalog cards in LCARS mode have consistent radii with rest of shell
- [ ] Card hover shows gold accent border
- [ ] Filter chips and letter bar render correctly at LCARS radii
- [ ] No overflow or clipping at 500+ item grid
- [ ] Tab bar active state consistent with LCARS pill conventions
- [ ] Spot-check in `dark` theme — no bleed from LCARS-specific overrides
- [ ] `npm run ax -- ci` passes

### Implementation Notes
**Primary file:** `web/src/styles/catalog-view.css` (LCARS overrides
section at bottom of file)

Keep the override block clearly separated:
```css
/* ── LCARS theme overrides ──────────────────────────────── */
[data-theme="lcars"] .cat-card { ... }
[data-theme="lcars"] .cat-card:hover { ... }
```

### Risks
- Card name in Century Gothic may render wider than in the system
  font, causing text truncation at `minmax(280px, 1fr)` card widths.
  Test with long officer names (e.g., "Georgiou, Mirror" or full
  Romulan names).

---

## Phase 6 — Mobile LCARS Sanity Check

**Title:** ADR-046 Phase 6 — Mobile LCARS sanity check  
**Labels:** `frontend`, `design-system`, `mobile`

### Purpose
Verify LCARS theme renders correctly on mobile viewports and fix any
issues. This is validation and bugfix, not feature work.

### Scope
- Test mobile header (`<div class="mobile-header">`) with LCARS
  typography, borders, and letter-spacing
- Test sidebar overlay open/close in LCARS mode
- Test catalog card grid at 375px and 768px widths
- Test chat view + chat input at mobile widths
- Test boot screen at mobile widths
- Fix any overflow, clipping, or layout issues caused by:
  - Larger LCARS radii (16/12/20px)
  - Wider letter-spacing on nav buttons
  - Century Gothic font metrics (wider than system fonts)
- Document any intentional mobile degradation decisions

### Non-Goals
- Adding mobile-specific LCARS structural framing
- Reproducing elbow/rail geometry on mobile
- Redesigning mobile navigation
- Performance testing

### Acceptance Criteria
- [ ] Mobile header renders without overflow at 375px width
- [ ] Sidebar overlay opens and closes cleanly in LCARS mode
- [ ] Catalog card grid reflows to single column without horizontal scroll
- [ ] Chat input and send/stop button usable at mobile widths
- [ ] Boot screen renders within viewport at mobile widths
- [ ] No horizontal scroll on any view at 375px
- [ ] Any found issues fixed or documented as known limitations
- [ ] `npm run ax -- ci` passes

### Implementation Notes
**Test method:** Browser DevTools responsive mode at 375px (iPhone SE)
and 768px (iPad). Or actual device if available.

**Likely fix files:**
- `web/src/styles/lcars-theme.css` (add mobile media query overrides)
- `web/src/styles/layout.css` (if base layout needs fixes)
- Component `<style>` blocks (for scoped mobile fixes only — not token defs)

### Risks
- Century Gothic is not available on most Android devices. The fallback
  chain (`"URW Gothic", "Apple SD Gothic Neo", system-ui, sans-serif`)
  should handle this, but the visual result may differ from the
  development environment. Accept this as a known platform variance,
  not a bug.
- `letter-spacing: 4px` on the mobile header title may cause "ARIADNE"
  to overflow on very narrow screens. Fix: reduce letter-spacing in
  a `@media (max-width: 480px)` override.

---

## Sequencing Notes

Phases 1-3 are strictly sequential (each depends on the previous).
Phase 4 can run in parallel with Phase 3 (no file overlap).
Phase 5 depends on Phases 1-3 (needs tokens and cleanup done).
Phase 6 depends on all prior phases (validates the final state).

```
Phase 1 (tokens) → Phase 2 (LCARS cleanup) → Phase 3 (rgba cleanup) → Phase 5 (catalog)
                                              Phase 4 (badges) ────────↗              ↓
                                                                              Phase 6 (mobile)
```

Estimated total: 6 issues under 1 umbrella = 7 GitHub issues.
