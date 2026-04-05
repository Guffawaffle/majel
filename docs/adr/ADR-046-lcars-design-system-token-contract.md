# ADR-046 — LCARS Design System & Token Contract

**Status:** Draft  
**Date:** 2026-03-15  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect)  
**Program umbrella:** #219  
**Depends on:** ADR-031 (Svelte migration)

---

## Context

Majel has an LCARS-themed UI built on Svelte 5 + CSS custom properties. The
LCARS theme is the default and ships today via a `[data-theme="lcars"]` CSS
selector on `<html>`, toggled against a `dark` fallback. The current
implementation is functional but evolved organically:

- `variables.css` defines ~20 `:root` tokens — backgrounds, text, accents,
  structure
- `lcars-theme.css` overrides ~10 tokens and adds structural CSS (sidebar rail,
  title bar elbow, pill buttons, larger radii)
- ~15 hardcoded `rgba()` values for accent soft/dim variants are scattered
  across view CSS files (catalog-view.css, fleet-view.css, LoadingScreen.svelte)
- No faction-specific color tokens exist
- All faction badges render with uniform `--accent-blue` regardless of faction
- No documented boundary between shell-level LCARS identity and data-layer
  presentation

An LCARS-forward concept mockup (React/Tailwind, separate from production) was
evaluated. It explored card identity rails, text-bearing faction side labels,
persistent LCARS framing on all views, and a Design Lab surface. Design review
concluded:

- **Direction: A- (strong)** — shell-carried Trek identity with calm data layer
- **Implementation readiness: B** — concept artifacts need pruning before code
- Key takeaway: the production architecture already enforces the right boundary
  — shell/theme in CSS overrides, data components stay readable, minimal
  template churn

This ADR locks the token contract, production scope, and implementation
boundaries before any further UI work.

### What This ADR Does NOT Cover

- **Full faction-aware page theming** — five complete color palettes that
  re-skin every component for Federation/Klingon/Romulan/Independent/Borg.
  Explicitly deferred. Faction identity flows through badge/chip/border tokens,
  not component variants.
- **Token renaming** — the existing `--accent-gold` / `--accent-blue` /
  `--accent-purple` names are kept. A semantic rename (`--lcars-primary`,
  `--lcars-info`) is deferred until it earns its churn cost.
- **Design Lab or concept playground** — these are review artifacts, not
  production surfaces.
- **Component library / Storybook** — no component catalog UI ships.
- **Full LCARS frame persistence** — elbow/rail/frame bars on every view.
  Reserved for boot screen and dialogs only.

---

## Decisions

### D1: Token-First Architecture

All color, spacing, and structural values consumed by components must come from
CSS custom properties defined in exactly two files:

| File | Scope |
|---|---|
| `web/src/styles/variables.css` | `:root` — base tokens, fallback values, faction tokens |
| `web/src/styles/lcars-theme.css` | `[data-theme="lcars"]` — LCARS-specific overrides only |

**Rules:**

1. No component `<style>` block defines a CSS custom property.
2. No view-specific CSS file (e.g., `catalog-view.css`) defines a custom
   property.
3. No component hardcodes a hex color that should be a token reference.
4. Hardcoded `rgba()` soft/dim values that repeat across files must be
   promoted to tokens.
5. LCARS-only tokens (e.g., `--lcars-warm`) are defined in
   `lcars-theme.css` and are only consumed by LCARS-themed surfaces.

**Why preserve existing token names:**

The production codebase uses `--accent-gold` in 40+ locations across 8+ files.
Renaming to `--lcars-primary` would be a large mechanical find-replace that
touches every view, every CSS file, and the boot screen — with zero functional
benefit. The semantic mapping is documented here instead:

| Token | Semantic role |
|---|---|
| `--accent-gold` | Primary action, active emphasis, ownership |
| `--accent-blue` | Structural UI, informational, neutral framing |
| `--accent-purple` | Secondary emphasis, alternate grouping |
| `--accent-green` | Success state, owned-positive |
| `--accent-red` | Danger, error, destructive action |

### D2: Root Token Contract

The base token set in `variables.css` `:root`:

```css
:root {
  /* Backgrounds (4-level depth stack) */
  --bg-primary:    #0a0e1a;
  --bg-secondary:  #111827;
  --bg-tertiary:   #1a2236;
  --bg-hover:      #1e293b;
  --bg-user-msg:   #1a2a4a;

  /* Text (3-level hierarchy) */
  --text-primary:   #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted:     #8494a7;

  /* Accent colors */
  --accent-gold:       #f0a030;
  --accent-gold-dim:   #b07820;
  --accent-gold-soft:  rgba(240, 160, 48, 0.12);
  --accent-blue:       #60a0ff;
  --accent-blue-dim:   #3070cc;
  --accent-blue-soft:  rgba(96, 160, 255, 0.12);
  --accent-green:      #34d399;
  --accent-green-dim:  rgba(52, 211, 153, 0.18);
  --accent-red:        #f87171;
  --accent-red-dim:    rgba(248, 113, 113, 0.16);
  --accent-orange:     #fb923c;
  --accent-orange-dim: rgba(251, 146, 60, 0.18);
  --accent-purple:     #a78bfa;

  /* Structure */
  --border:        #1e293b;
  --border-light:  #334155;
  --radius:        8px;
  --radius-sm:     6px;
  --radius-md:     10px;
  --sidebar-width: 240px;
  --max-content:   720px;
  --transition:    0.15s ease;

  /* State (aliased from accent tokens) */
  --state-success: var(--accent-green);
  --state-warning: var(--accent-gold);
  --state-danger:  var(--accent-red);

  /* Faction — single source of truth */
  --faction-federation:  #5b9bd5;
  --faction-klingon:     #d35f52;
  --faction-romulan:     #3d9b56;
  --faction-independent: #8a9199;
  --faction-borg:        #45b5aa;

  /* Semantic */
  --accent-danger: var(--accent-red);
  --focus-ring:    0 0 0 2px var(--accent-blue);
}
```

### D3: LCARS Theme Override Contract

The LCARS theme layer in `lcars-theme.css`:

```css
[data-theme="lcars"] {
  /* Typography */
  --font-lcars: "Century Gothic", "URW Gothic",
                "Apple SD Gothic Neo", system-ui, sans-serif;

  /* Structure: rounder, bolder */
  --radius:     16px;
  --radius-sm:  12px;
  --radius-md:  20px;

  /* Warmer backgrounds */
  --bg-secondary: #0f1729;
  --bg-tertiary:  #162040;
  --bg-hover:     #1a2850;

  /* Bolder borders */
  --border:       #1a2850;
  --border-light: #263770;

  /* LCARS-only supporting accent (not in dark theme) */
  --lcars-warm:      #e7b093;
  --lcars-warm-soft: rgba(231, 176, 147, 0.12);

  /* Focus ring: gold in LCARS mode */
  --focus-ring: 0 0 0 2px var(--accent-gold);
}
```

LCARS structural CSS (sidebar rail, title bar elbow, pill buttons, section
labels) remains in `lcars-theme.css` using `[data-theme="lcars"]` selectors.
This is scoped presentation, not token definition.

### D4: Faction Token Governance

Faction identity is token-based, not component-variant-based.

**Rules:**

1. Five faction tokens are defined in `:root` (see D2).
2. Components resolve faction color at render time via CSS class →
   custom property mapping.
3. No component has a `faction` prop that triggers structural changes
   (different DOM, different layout).
4. Faction identity surfaces through:
   - Badge text color (`Badge.svelte`, `kind="faction"`)
   - Optional subtle `border-left` or chip accent on cards
   - Filter pill styling
5. Faction identity does NOT surface through:
   - Text-bearing side rails with faction labels
   - Structural DOM elements added per-faction
   - Full-page palette swaps
   - Component variants (no `<Card faction="klingon">` that changes layout)

**Badge faction color mapping** (replaces current uniform `--accent-blue`):

```css
/* Badge.svelte faction classes */
.badge-faction                     { color: var(--faction-independent); }
.badge-faction-federation          { color: var(--faction-federation); }
.badge-faction-klingon             { color: var(--faction-klingon); }
.badge-faction-romulan             { color: var(--faction-romulan); }
.badge-faction-independent         { color: var(--faction-independent); }
.badge-faction-borg                { color: var(--faction-borg); }
```

The `Badge` component maps the `value` prop to a CSS class via a lookup
function (e.g., `factionCss(value)`). This keeps faction resolution in
the presentation layer without complicating the component interface.

**Faction palette rationale (muted):**

| Faction | Hex | Why this value |
|---|---|---|
| Federation | `#5b9bd5` | Muted blue — distinct from `--accent-blue` (`#60a0ff`) |
| Klingon | `#d35f52` | Muted red — readable on dark bg, not fire-engine hot |
| Romulan | `#3d9b56` | Olive-green — distinct from `--state-success` (`#34d399`) |
| Independent | `#8a9199` | Neutral warm gray — reads as unaligned |
| Borg | `#45b5aa` | Cool cyan — distinct from Romulan green and success green |

### D5: Shell-First / Data-Calm Boundary

The governing aesthetic rule for all UI work:

**Shell layer** (sidebar, title bar, boot screen, dialogs) carries Trek/LCARS
identity through:
- Typography (Century Gothic / `--font-lcars`)
- Color-block rail (sidebar `::before` gradient)
- Larger border-radii (16/12/20px)
- Gold/blue/purple accent hierarchy
- Pill-shaped buttons and section labels
- Elbow caps (title bar `::before`)
- UPPERCASE + letter-spacing on nav items and section labels

**Data layer** (cards, tables, lists, form inputs, chat messages) stays
readable-first through:
- Standard backgrounds (`--bg-secondary` / `--bg-tertiary`)
- Standard borders (`--border` / `--border-light`)
- Standard text hierarchy (`--text-primary` / `--text-secondary` / `--text-muted`)
- Standard border-radius (inherits from theme, no extra LCARS-specific overrides)
- No decorative framing or LCARS structural elements

**The dividing line:**

> Card-level decoration that consumes layout space or requires new semantic
> structure is out of scope.
> Card-level decoration that stays lightweight and purely presentational
> (CSS-only, no new DOM) is in scope.

Examples of what IS allowed:
- `border-left: 3px solid var(--faction-federation)` on a card (CSS only, no DOM)
- `border-radius` increase via theme variable (inherited, no DOM)
- Gold `border-color` on hover (CSS only)

Examples of what is NOT allowed:
- `<div class="card-rail"><span>FED</span></div>` (new DOM, text content)
- `<div class="lcars-frame-top">` wrapping every card (structural framing)
- Per-card gradient backgrounds keyed to faction (maintenance multiplier)

### D6: CSS-First Implementation Bias

If a visual improvement can be achieved within the existing Svelte/CSS custom
property architecture without adding structural DOM, that is the required path.

**Rules:**

1. Prefer `[data-theme="lcars"]` CSS overrides over template changes.
2. Prefer token consumption over new token invention.
3. Prefer inherited theme values (e.g., `--radius`) over component-specific
   LCARS overrides.
4. Do not add DOM elements for purely decorative purposes.
5. Do not add CSS classes to templates solely to enable LCARS styling unless
   the class also has semantic meaning (e.g., a faction class that drives
   both color and accessibility).
6. Template changes are acceptable only when CSS alone cannot express the
   requirement — and that case must be justified in the PR.

This bias keeps the implementation path aligned with the production
architecture (Svelte 5 + CSS custom properties) and prevents translation
artifacts from the React/Tailwind concept mockup from entering the codebase.

### D7: Hard Constraints

The following constraints are non-negotiable for all work under this ADR.
They are not suggestions — they are gates.

1. **No text-bearing card rails.** No DOM element on a card that displays
   faction abbreviations (FED, IND, KLI, ROM, BRG) or similar text content
   as a structural rail.
2. **No Design Lab shipping surface.** The Design Lab is a concept review
   artifact. It does not appear in the production view router.
3. **No bottom wireframe-note shipping surface.** Same as above.
4. **No component-local token definitions.** No `<style>` block in any
   `.svelte` file defines a `--` CSS custom property.
5. **No large token rename sweep.** Existing token names (`--accent-gold`,
   `--accent-blue`, etc.) are preserved. Document semantic intent, do not
   rename.
6. **No faction-based component variants.** No component accepts a `faction`
   prop that triggers structural or layout changes. Faction identity flows
   through CSS class → token color, nothing more.
7. **No multi-page template churn.** Each phase touches the minimum files
   necessary. If a phase starts expanding beyond its listed file set, it
   should be scoped back or split.

### D8: Concept Artifacts — Non-Goals

The following items from the concept mockup are explicitly not part of
production scope:

| Artifact | Status | Reason |
|---|---|---|
| Design Lab page/view | Concept-only | Dev tooling, not a user feature |
| Bottom wireframe-note cards | Concept-only | Review artifact |
| Text-bearing card rails (FED/IND/KLI/ROM/BRG) | Rejected | Consumes layout, requires DOM, text spill risk |
| Full LCARS frame bars on persistent views | Deferred | High visual overhead, boot screen + dialogs only |
| Three-stop body gradient (`--bg-app-start/mid/end`) | Dropped | Single-use, inline if ever needed |
| `--lcars-pink` token | Dropped | No current consumer; add when needed |
| Five-palette faction page theming | Deferred | Maintenance multiplier with no current product need |
| Token renaming sweep | Deferred | 40+ reference sites, zero functional gain now |
| Broad redesign of data-layer cards | Rejected | Token tightening only; card structure stays as-is |

### D9: Mobile Degradation Rule

LCARS presentation degrades gracefully on mobile:

1. **Preserved:** color tokens, typography (`--font-lcars`), text styling
2. **Preserved:** border-radius values (theme-inherited)
3. **Reduced:** sidebar rail is hidden (sidebar is overlay on mobile)
4. **Reduced:** title bar elbow cap may be omitted if it interferes with
   mobile header layout
5. **No mobile-specific LCARS structural framing** — do not attempt to
   reproduce elbow/rail/frame geometry for narrow viewports
6. **Test mobile early** — verify LCARS theme on mobile header and sidebar
   overlay before desktop polish is considered done

### D10: Implementation-Review Items

The following items surfaced during design review and are tracked as
implementation-review checks, not new design exploration. Each is resolved
during the phase that touches the relevant file.

| Item | Check | Phase |
|---|---|---|
| `LoadingScreen.svelte` bare `rgba()` at low opacity (0.06, 0.08) | Replace with `--accent-*-soft` if token exists and visual match holds; otherwise leave with fallback comment | Phase 1 |
| Catalog faction accent on card (optional `border-left`) | CSS-only; requires faction CSS class on card element — verify if `CatalogView.svelte` already exposes faction class or if a minimal template addition is needed | Phase 4 |
| Faction name → CSS class mapping strings | Decide placement: `Badge.svelte` local function vs `game-enums.ts` shared utility — choose during Phase 3, not before | Phase 3 |

---

## Phased Implementation

### Phase 1 — Token Foundation (#220)

Lock the token contract in CSS and clean up hardcoded values.

**Scope:**
- Add soft/dim tokens to `variables.css` where production already uses
  hardcoded `rgba()` equivalents (`--accent-gold-soft`, `--accent-blue-soft`)
- Add faction tokens to `variables.css`
- Add state alias tokens to `variables.css`
- Replace hardcoded `rgba()` values in catalog-view.css, fleet-view.css,
  LoadingScreen.svelte with token references
- Verify `--bg-user-msg` and `--focus-ring` are present in `variables.css`

**Files:**
- `web/src/styles/variables.css`
- `web/src/styles/catalog-view.css`
- `web/src/styles/fleet-view.css`
- `web/src/components/LoadingScreen.svelte`
- `web/src/components/ImageLightbox.svelte`

### Phase 2 — LCARS Theme Cleanup (#221)

Tighten the LCARS override layer and add LCARS-only tokens.

**Scope:**
- Add `--lcars-warm` / `--lcars-warm-soft` tokens to `lcars-theme.css`
- Verify sidebar rail, title bar, and boot screen consume tokens
  correctly (no hardcoded fallback hex where a token now exists)
- Confirm no token definitions have leaked into component `<style>` blocks

**Files:**
- `web/src/styles/lcars-theme.css`
- `web/src/components/LoadingScreen.svelte` (verify token usage)

### Phase 3 — Faction Badge Colors (#223)

Wire faction tokens into the Badge component.

**Scope:**
- Add `factionCss()` lookup function to Badge.svelte or game-enums.ts
- Map faction name → CSS class (`.badge-faction-federation`, etc.)
- Add per-faction color rules using `var(--faction-*)` tokens
- Update Badge `cssClass` derivation for `kind="faction"`
- Verify on Catalog page (officers show faction badges)

**Files:**
- `web/src/components/Badge.svelte`
- `web/src/lib/game-enums.ts` (if mapper lives here)

### Phase 4 — Catalog Polish (#224)

Restrained visual refinements to the Catalog page within the locked contract.

**Scope:**
- LCARS-mode catalog card refinements (radii, hover border, gold accent
  on hover) — CSS only, no template changes
- Optional: subtle faction-colored `border-left` on catalog cards where
  faction data is present — CSS-only, uses `--faction-*` tokens
- Verify card density at 500+ items with LCARS theme active
- Verify filter chips, letter bar, bulk actions consume tokens correctly

**Files:**
- `web/src/styles/catalog-view.css`
- `web/src/views/CatalogView.svelte` (only if template needs a CSS class
  for faction, otherwise CSS-only)

### Phase 5 — Mobile Sanity (#225)

Verify LCARS theme on mobile viewports.

**Scope:**
- Test mobile header with LCARS typography and borders
- Test sidebar overlay (open/close) with LCARS styles
- Test catalog card grid at narrow widths
- Fix any overflow, clipping, or layout issues introduced by LCARS radii
  or letter-spacing
- Document any intentional mobile degradation (e.g., elbow cap omission)

**Files:**
- `web/src/styles/lcars-theme.css` (mobile overrides if needed)
- `web/src/components/Sidebar.svelte` (verify overlay behavior)

---

## Consequences

### Positive

- **Single source of truth** for all color values — no more scattered
  `rgba()` hardcodes
- **Theme switching remains clean** — `dark` ↔ `lcars` toggle continues to
  work via CSS custom property overrides
- **Faction identity is extensible** — adding a sixth faction requires one
  token and one CSS class, not component changes
- **Concept-to-production boundary is documented** — prevents concept-board
  artifacts from creeping into production scope
- **Mobile degradation is explicit** — avoids discovering broken LCARS on
  mobile after desktop polish is done

### Negative

- **Token proliferation risk** — soft/dim variants add ~6 tokens. Acceptable
  because they replace existing hardcoded values; net complexity is lower.
- **Faction badge mapping adds a lookup** — minor runtime cost (string match
  → CSS class), negligible at catalog scale.
- **Deferred token rename** — the semantic gap between token name (`gold`) and
  role (`primary action`) remains. Documented here; rename is available as a
  future standalone task with no blocking dependencies.

### Implementation Character

This ADR authorizes **token cleanup and restrained LCARS polish**, not a
broad visual redesign. Every phase should finish feeling like a tightening
of the existing system, not a transformation. If a change starts feeling
transformative, it is out of scope.
