# ADR-012: Reference Data — Localization Templates + User Input

**Status:** Accepted  
**Date:** 2026-02-09  
**Authors:** Guff, Opie (Claude)

## Context

Majel needs game reference data (officer abilities, ship specs, research trees) to power crew suggestions, conflict detection, and the Research view. This data is semi-static — it changes with game patches but is stable between them.

**Rejected approaches:**
- **Scraping community sites** — fragile, ethically grey, maintenance burden
- **Scopely API** — doesn't exist
- **Client datamining** — ToS violation, not an option

## Decision

### Localization Templates + User Input

Reference data uses a **template model**: Majel ships with localization-style templates containing the structure and labels, and users fill in their specific values.

Example officer ability template:
```json
{
  "id": "uhura",
  "name": "Uhura",
  "group": "enterprise-crew",
  "rarity": "epic",
  "captain_maneuver": {
    "name": "United We Stand",
    "template": "Increase {stat} by {value} when {condition}",
    "stat": null,
    "value": null,
    "condition": null
  },
  "officer_ability": { ... },
  "below_deck": { ... }
}
```

The localization file provides the **skeleton** (officer names, group membership, ability names). The user fills in their specific values (ability percentages at their tier/level) through the UI.

### Why This Works

1. **Officer names, groups, and ability names are public knowledge** — printed on every community site, YouTube video, and the game itself
2. **Ability values scale with tier/level** — only the user knows their specific values
3. **Centralized identifiers** — each officer/ship/research node has a stable `id` that code references, decoupled from display text
4. **Community-contributable** — the template files are just JSON, easy to update when new officers drop
5. **No scraping, no ToS issues** — we're providing a UI for the user's own data

### Data Layers

| Layer | Source | Example |
|-------|--------|---------|
| **Template** | Bundled JSON, community-maintained | `{ id: "uhura", name: "Uhura", group: "enterprise-crew" }` |
| **User values** | Filled in by player via UI | `{ tier: 4, level: 35, captain_value: "+25% damage" }` |
| **Computed** | App derives from template + user | `"Uhura (T4): United We Stand — +25% damage when..."` |

### Research Trees

Same pattern: Majel ships with the **tree structure** (node names, categories, prerequisites) and the user marks what they've unlocked and at what level. The structure is public knowledge; the player's progress is personal input.

## Consequences

- Users must do some manual data entry (mitigated by good UI — checkboxes, dropdowns, not free text)
- Template files need updating when Scopely adds content (community can contribute PRs)
- No legal/ethical concerns — all public knowledge structured into templates
- Research tree and officer data available to AI via function calling (#7) without blasting full context
