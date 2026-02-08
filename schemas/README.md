# Canonical Schemas

JSON Schema definitions for Majel's core data model entities.

These schemas serve as the **source of truth** for what each entity looks like at the API boundary. They are designed to be consumed by:

- **Agents** — to understand the data model before generating code
- **Validation** — to verify API payloads (future)
- **Documentation** — to communicate the data model to humans

## Entity Hierarchy

```
Ship ──────────────┐
                   ├──▶ Loadout (Ship + Intent + Crew)
Intent ────────────┘         │
                             ├── LoadoutMember (Officer + Position)
Officer ─────────────────────┘
```

## Files

| File | Entity | Description |
|------|--------|-------------|
| `ship.schema.json` | Ship | Vessel with class, grade, combat profile |
| `officer.schema.json` | Officer | Crew member with position/activity affinities |
| `intent.schema.json` | Intent | Activity type (mining, combat, utility) |
| `loadout.schema.json` | Loadout | Ship + Intent + Crew — the planning unit |

## Key Concepts

### Combat Profile (Ship)
Ships fall into three combat profiles:
- **`triangle`** — Explorer/Interceptor/Battleship (rock-paper-scissors PvP)
- **`non_combat`** — Survey ships, buffer ships (don't participate in triangle)
- **`specialty`** — Loop-specific ships (Vidar, Voyager) with a designated `specialtyLoop`

### Officer Affinities
Officers have hint fields indicating where they're most effective:
- **`classPreference`** — Best on which ship class (or `any`)
- **`activityAffinity`** — Best for PvE, PvP, mining, or `any`
- **`positionPreference`** — Captain, bridge, below_deck, or `any`

### The Loadout as Anchor
The **Loadout** (née "crew preset") is the fundamental planning unit. It answers:
> "When I use [Ship X] for [Activity Y], what's the best crew?"

Docks are a **physical deployment layer** on top of Loadouts — they represent
where a Loadout is currently active, but the Loadout itself is portable.
