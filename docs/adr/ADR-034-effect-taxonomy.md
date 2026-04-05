# ADR-034 — TargetContext + EffectTag Taxonomy for Crew Recommendation

**Status:** Proposed  
**Date:** 2026-02-21  
**Authors:** Guff, Opie (Claude), Lex  
**References:** ADR-025 (Crew Composition Model), ADR-028 (Data Pipeline), ADR-012 (Reference Data)

---

## Context

The Quick Crew recommender (v0.6.1) uses brittle keyword matching against raw ability text to score officers for bridge slots. The `INTENT_KEYWORDS` dictionary maps intent keys like `"grinding"` to words like `["hostile", "damage", "pve"]`, then checks whether those words appear anywhere in ability descriptions. This produces false positives (Hikaru Sulu scoring as a "grinding" specialist because his flavor text mentions hostiles), false negatives (ability phrasing that doesn't match any keyword), and vague "Why this crew" explanations ("Ability text aligns with selected objective").

The root cause: **the recommender operates on unstructured text, not structured ability semantics.**

A community-maintained Google Sheet (STFC crew builder) takes the opposite approach: it normalizes every ability into tagged effects with typed applicability and conditions. You build a crew and it tells you exactly which abilities apply, which are conditional, and which don't work — per target type. This is the model we should adopt.

### Problems with the current approach

1. **Binary goalFit**: Any single keyword match gives full 6 points; no match gives 0. No graduation.
2. **Captain Maneuver is a soft bonus**: +3/-2 instead of a hard gate. Officers without a useful CM can score into the captain seat.
3. **Synergy dominates**: +4 per pair (up to +10 for a trio) overwhelms individual officer quality.
4. **No structured ability data**: Scoring depends on regex over English text, which is fragile across ability phrasings, translations, and flavor text contamination.
5. **Opaque "Why"**: Only 4 canned reason strings, none officer-specific.

---

## Decision

Introduce two first-class models and a normalized ability catalog:

1. **TargetContext** — the combat/activity scenario being optimized for (target type, engagement, ship class, tags).
2. **EffectTag** — a normalized "ability modifier" with typed applicability and conditions.
3. **Applicability evaluator** — a pure function that checks each effect against a target context, returning `works | conditional | blocked` with typed issue reasons.

Crew recommendation becomes:

1. Evaluate each candidate officer's normalized effects against the TargetContext.
2. Aggregate weighted scores by effectKey, discounting conditional and ignoring blocked effects.
3. Enforce captain rules (must have relevant CM for context).
4. Apply synergy as a small multiplier (not additive points).
5. Generate per-officer "why" output from the evaluation.

---

## Model: TargetContext

### `targetKind` (single value — coarse)

| Value | Description |
|-------|-------------|
| `hostile` | Generic PvE NPC |
| `player_ship` | PvP ship combat |
| `station` | Base attack/defense |
| `armada_target` | Armada boss/target |
| `mission_npc` | Mission-specific NPC (optional; can use `hostile` + tags) |

**Rule:** Keep `targetKind` coarse. Specificity goes into `targetTags`.

### `engagement` (single value)

`attacking | defending | any`

### `targetTags` (facet set — extensible)

**Faction/content:** `borg`, `swarm`, `augment`, `rogue`, `dominion`, `xindi`, `mirror`, `klingon`, `romulan`, `federation`

**Ship-class:** `target_explorer`, `target_interceptor`, `target_battleship`, `target_survey`

**Status:** `target_burning`, `target_hull_breached`, `target_morale`, `target_cloaked`

**Mode:** `pvp`, `pve`, `station_assault`, `armada`

### `shipContext`

- `shipClass`: `explorer | interceptor | battleship | survey`
- `shipId`: optional (stable internal ID)
- `shipTags`: optional set (e.g., `ship_borg`, `ship_scout`)

### `slotContext`

`captain | bridge | below_deck`

---

## Model: EffectTag

### `effectKey` (~40 initial keys, extensible)

**Damage/offense:** `damage_dealt`, `weapon_damage`, `crit_chance`, `crit_damage`, `accuracy`, `penetration`, `shield_piercing`

**Survivability:** `damage_taken`, `mitigation`, `armor`, `shield_deflection`, `dodge`, `shield_health`, `hull_health`, `shield_repair`, `hull_repair`

**Control/status:** `apply_burning`, `apply_hull_breach`, `apply_morale`, `resist_burning`, `resist_hull_breach`, `resist_morale`

**Loot/progression:** `loot_bonus`, `resource_drop_bonus`, `xp_bonus`

**Mining/economy:** `mining_rate`, `mining_protection`, `cargo_capacity`, `warp_range`, `repair_cost_reduction`

**Officer stats:** `officer_attack`, `officer_defense`, `officer_health`

### Conditions (typed keys + optional params)

**Timing:** `at_combat_start`, `at_round_start`, `when_weapons_fire`, `when_shields_depleted`, `when_hull_breached`, `when_burning`, `when_target_burning`, `when_target_hull_breached`

**Engagement:** `requires_attacking`, `requires_defending`

**Classification:** `requires_target_ship_class` (param: class), `requires_ship_class` (param: class), `requires_target_tag` (param: tag), `requires_ship_tag` (param: tag)

**Mode:** `requires_pvp`, `requires_pve`, `requires_station_target`, `requires_armada_target`

### Magnitude (optional)

- `value`: numeric (e.g., 0.10 for 10%)
- `unit`: `percent | flat | rate | seconds | rounds | unknown`
- `stacking`: `additive | multiplicative | unknown`

The model must work when magnitude is null.

---

## Model: Issue Types (for explainability)

Stable slug IDs used to generate "works / conditional / doesn't work" reasons:

| Issue Type | Severity | Meaning |
|-----------|----------|---------|
| `not_applicable_to_target_kind` | blocker | Effect targets a different target kind |
| `missing_required_target_tag` | blocker | Target doesn't have required tag |
| `missing_required_target_ship_class` | blocker | Target isn't the required ship class |
| `missing_required_ship_class` | blocker | Your ship isn't the required class |
| `requires_attacking` | conditional | Only works when attacking |
| `requires_defending` | conditional | Only works when defending |
| `requires_pvp` | conditional | PvP only |
| `requires_pve` | conditional | PvE only |
| `requires_station_target` | conditional | Station combat only |
| `requires_armada_target` | conditional | Armada only |
| `missing_required_status` | conditional | Requires specific combat state (burning, hull breach, etc.) |
| `slot_mismatch` | blocker | Effect is BDA but officer placed on bridge, etc. |
| `unknown_condition` | conditional | Parser couldn't classify condition |
| `reserved_officer` | info | Officer is reserved on another loadout |
| `captain_maneuver_missing_or_inert` | blocker | No usable CM for captain slot |

---

## Data Model (Relational)

String slugs as primary keys for all taxonomy tables (stable, human-readable, migration-safe).

### Tables

#### Taxonomy (extensible via INSERT, no code changes)

```sql
taxonomy_target_kind     (id TEXT PK)
taxonomy_target_tag      (id TEXT PK)
taxonomy_ship_class      (id TEXT PK)
taxonomy_slot            (id TEXT PK)           -- cm, oa, bda
taxonomy_effect_key      (id TEXT PK, category TEXT)
taxonomy_condition_key   (id TEXT PK, param_schema TEXT)
taxonomy_issue_type      (id TEXT PK, severity TEXT, default_message TEXT)
```

#### Ability Catalog (normalized effects per officer ability)

```sql
catalog_officer_ability       (id TEXT PK, officer_id TEXT FK, slot TEXT FK, name TEXT, raw_text TEXT, is_inert BOOLEAN)
catalog_ability_effect        (id TEXT PK, ability_id TEXT FK, effect_key TEXT FK, magnitude REAL, unit TEXT, stacking TEXT)
catalog_ability_effect_target_kind  (ability_effect_id TEXT FK, target_kind TEXT FK)
catalog_ability_effect_target_tag   (ability_effect_id TEXT FK, target_tag TEXT FK)
catalog_ability_effect_condition    (id TEXT PK, ability_effect_id TEXT FK, condition_key TEXT FK, params_json TEXT)
```

#### Intent Definitions (data-driven, not code)

```sql
intent_def                (id TEXT PK, name TEXT, description TEXT)
intent_default_context    (intent_id TEXT PK FK, target_kind TEXT FK, engagement TEXT, target_tags_json TEXT, ship_class TEXT FK)
intent_effect_weight      (intent_id TEXT FK, effect_key TEXT FK, weight REAL, PK (intent_id, effect_key))
```

### Key Relationships

- `reference_officers` (1) → (many) `catalog_officer_ability`
- `catalog_officer_ability` (1) → (many) `catalog_ability_effect`
- `catalog_ability_effect` (1) → (many) target kinds/tags/conditions
- `intent_def` (1) → (many) `intent_effect_weight`
- `intent_def` (1) → (1) `intent_default_context`

---

## Applicability Evaluation

Pure function: `evaluateEffect(effect, targetContext) → { status, issues[] }`

- `status` ∈ `works | conditional | blocked`
- `issues[]` contains issue type slugs + details

Rules:
- Effect requires `targetKind` and context doesn't match → `blocked` + `not_applicable_to_target_kind`
- Required condition can't be satisfied from context alone (e.g., "when target is burning") → `conditional` + `missing_required_status`
- Parser couldn't classify condition → `conditional` + `unknown_condition`
- Effect has no restrictions → `works`

---

## Recommendation Scoring

1. Build `TargetContext` from intent defaults + user choices.
2. For each officer ability, retrieve normalized `EffectTag`s from DB.
3. For each effect, call `evaluateEffect`.
4. Aggregate per-officer feature score:
   - Full weight for `works` effects
   - Discounted weight (0.5×) for `conditional` effects
   - Zero for `blocked` effects
5. Captain rules:
   - `slotContext=captain` requires at least one CM ability with any `works | conditional` effect relevant to context; otherwise ineligible.
   - If no qualifying captains exist, fallback to best available **with a loud warning**.
6. Trio score:
   - `baseScore = Σ officerScores + readiness`
   - `synergyMultiplier = 1 + (synergyPairs × 0.03)` (3–9% boost, not +10 additive points)
   - `finalScore = baseScore × synergyMultiplier`
7. "Why" output:
   - List top contributing effects per officer.
   - List any conditional/blocking issues.
   - Name specific officers, effects, and reasons (not canned strings).

---

## Extensibility Strategy

- **New effect keys**: INSERT into `taxonomy_effect_key` + map abilities.
- **New tags** (new content arc): INSERT into `taxonomy_target_tag`.
- **New intents**: INSERT into `intent_def` + `intent_effect_weight`.
- **No schema changes** needed for most growth.

---

## Ingest / Authoring Plan

Start with a hybrid approach:

1. **Structured CDN fields** → map directly into effects where data exists.
2. **Curated phrase patterns** → effectKey + conditionKey mappings for known phrasings.
3. **Manual overrides** → JSON seed file checked into repo for corrections.

Phase B will refine the phrase parser. Phase C may add sheet-style "validate a crew vs target" mode.

---

## Implementation Phases

### Phase A — Schema + Seed + Evaluator (foundation)

1. PostgreSQL migration: taxonomy tables + ability catalog + intent tables.
2. Seed taxonomy values, intent definitions with effect weights.
3. `evaluateEffect()` pure function + types.
4. Initial ability-to-effect mapping (phrase patterns + manual seed for top ~50 officers).

### Phase B — Rewire Recommender

1. Replace `INTENT_KEYWORDS` / `hasKeyword()` scoring with effect-based evaluation.
2. CM hard gate for captain (with fallback warning).
3. Synergy as multiplier (`1 + 0.03 × pairs`).
4. Per-officer "Why" evidence replacing 4 canned strings.
5. Update QuickCrewTab UI for new reason format.

### Phase C — Crew Validator ("Does it work?" mode)

1. Build-a-crew → evaluate each ability against target context.
2. Display works/conditional/blocked matrix per officer per ability.
3. Matches the community sheet's "Does this crew work?" feature.

---

## Testing Plan

- Unit tests for `evaluateEffect` with representative TargetContexts.
- Golden tests for known crews (ensure Kirk/Spock/McCoy ranks above Sulu/Spock/Ivanov for grinding).
- Regression tests for past "wrong captain" cases.
- Seed data validation (all referenced FKs resolve).

---

## Consequences

**Pros:**
- Removes most false positives from keyword matching.
- Explainable output becomes genuinely useful (per-officer, per-effect reasons).
- Intents become data, not code.
- Extensible without code changes for new content arcs.

**Cons:**
- Requires initial seeding work (effect taxonomy + ability mappings).
- Some effects will remain "conditional" until context is enriched.
- Phrase-pattern parser will miss edge cases initially (manual overrides compensate).
