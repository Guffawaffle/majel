# QA-001: Phase 1 First-Pass Notes

**Date:** 2026-02-11  
**Tester:** Guffawaffle (Admiral)  
**Build:** Revision `majel-00009-c45`  
**URL:** https://aria.smartergpt.dev  

## Status: Aria is LIVE and working! 🎉

---

## Bugs

### QA-001-1: Catalog search box loses focus on redraw
- **Severity:** High (UX-breaking)
- **Location:** Catalog screen, search input
- **Behavior:** Focus flickers in and out of the search box when the catalog redraws. Typing is interrupted. This is a persistent bug that's changed shape but not been resolved.
- **Root cause (likely):** Catalog re-render replaces the DOM element, destroying the focused input. Need to preserve focus across redraws — either debounce/skip redraws while input is focused, or restore focus + cursor position after redraw.

### QA-001-2: Cannot remove a ship from a dock once assigned
- **Severity:** High (functional)
- **Location:** Dock management
- **Behavior:** Once a ship is assigned to a dock, there's no way to unassign it.
- **Fix:** Add an "unassign" / remove button on dock ship entries.

### QA-001-3: Ships and Officers default tier/level should be 1, not 0
- **Severity:** Medium (data integrity)
- **Location:** Officer & Ship overlay store
- **Behavior:** Tier and level fields allow values below 1. In STFC, minimum tier is 1 and minimum level is 1.
- **Fix:** Clamp minimum values to 1 in the UI and validate in the store.

## Feature Requests

### QA-001-4: Back button — functional and intelligently designed
- **Severity:** Medium (navigation UX)
- **Location:** Global navigation
- **Notes:** Need a proper back button that navigates contextually (e.g., dock detail → dock list, officer detail → catalog). Browser back works but a UI element is needed.

### QA-001-5: Ships assigned to multiple docks → dock intel warning
- **Severity:** Medium (fleet intelligence)
- **Location:** Dock management / fleet overview
- **Behavior:** A ship assigned to more than one dock should trigger a visible warning. This is a strategic intel issue — you can't crew the same ship twice.
- **Implementation:** Cross-reference dock assignments, surface as a warning badge or diagnostic.

### QA-001-6: Hide Lex Memory and Memory Recall UI
- **Severity:** Low (polish)
- **Location:** UI — Lex Memory panel, Memory Recall feature
- **Behavior:** These features show in the UI but aren't implemented yet. "Lex Memory" shows "not configured" in Diagnostics.
- **Fix:** Hide behind a feature flag. Re-enable when memory integration is ready.

### QA-001-7: Diagnostics — Admiral only
- **Severity:** Medium (security/UX)
- **Location:** Diagnostics screen
- **Behavior:** Diagnostics should only be visible to Admirals. Could eventually have a user-facing version toggled on for troubleshooting, but default to Admiral-only for now.
- **Implementation:** Check `role === "admiral"` before showing diagnostics nav item. Feature-flag for future user-facing diagnostic mode.

### QA-001-8: Fleet screen — cards/list toggle + inline notes
- **Severity:** Low (UX enhancement)
- **Location:** Fleet screen
- **Behavior:** Currently lots of blank space. Two ideas:
  1. **Card/list view toggle** — like the Catalog screen already has
  2. **Inline notes per fleet entry** — e.g., "Need to farm X Y for this", "Comes from Borg daily loop"
- **Notes:** This is a UX design decision. Inline notes would add real value for fleet planning. Could be a simple text field per ship/officer that persists. Consider what's most user-friendly — probably cards + notes combined.

---

## Priority Order (suggested)
1. **QA-001-1** — Search focus (UX-breaking, persistent bug)
2. **QA-001-2** — Remove ship from dock (functional gap)
3. **QA-001-3** — Min tier/level = 1 (data integrity)
4. **QA-001-7** — Diagnostics Admiral-only (security)
5. **QA-001-6** — Hide Lex Memory UI (polish)
6. **QA-001-5** — Multi-dock ship warning (intel feature)
7. **QA-001-4** — Back button (navigation UX)
8. **QA-001-8** — Fleet screen redesign (UX enhancement)
