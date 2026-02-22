# Effects Contract v3 + Uncertainty Addendum (LexSona + Runner Gates)

Status: Proposed for review
Audience: Majel + Lex + Aria integration

## 1) Goals and Boundaries

- Deterministic, human-reviewable authoring contract.
- Separate authoring/contract shape from runtime delivery shape.
- Explicit traceability: extracted effect -> evidence -> rule/source.
- Never silently drop unknowns: emit explicit `unmapped_*` records.
- Support both:
  - lightweight web delivery (chunked + cacheable)
  - richer server/agent querying (Aria) without shipping full payload to browser.
- Stochastic inference may propose mappings, but must never bypass deterministic guarantees.

Important semantic clarification:
- Lex provides primitives/patterns (rule retrieval/correction, provenance concepts).
- Majel owns the pipeline behavior: the gates, acceptance policy, receipts, and artifact materialization.

## 2) Effects Contract v2 (Authoring / Contract Shape)

Top-level contract (example)

    {
      "schemaVersion": "1.0.0",
      "artifactVersion": "1.0.0+sha256:2f5e...",
      "generatedAt": "2026-02-22T14:00:00.000Z",
      "source": {
        "snapshotVersion": "stfc-2026-02-22",
        "locale": "en",
        "generatorVersion": "0.1.0"
      },
      "taxonomyRef": {
        "version": "1.0.0",
        "canonicalization": "stable-json-v1(sorted by id, UTF-8, no whitespace)",
        "slotsDigest": "sha256:...",
        "effectKeysDigest": "sha256:...",
        "conditionKeysDigest": "sha256:...",
        "targetKindsDigest": "sha256:...",
        "targetTagsDigest": "sha256:...",
        "shipClassesDigest": "sha256:...",
        "issueTypesDigest": "sha256:..."
      },
      "officers": [
        {
          "officerId": "cdn:officer:988947581",
          "officerName": "James T. Kirk",
          "abilities": [
            {
              "abilityId": "cdn:officer:988947581:cm",
              "slot": "cm",
              "isInert": false,
              "inertReason": null,
              "name": "Inspirational",
              "rawText": "Kirk increases all damage dealt against hostiles.",
              "effects": [
                {
                  "effectId": "cdn:officer:988947581:cm:ef:src-0",
                  "effectKey": "damage_dealt",
                  "magnitude": 0.3,
                  "unit": "percent",
                  "stacking": "additive",
                  "targets": {
                    "targetKinds": ["hostile"],
                    "targetTags": ["pve"],
                    "shipClass": null
                  },
                  "conditions": [],
                  "extraction": {
                    "method": "deterministic",
                    "ruleId": "hostile_damage_v1",
                    "model": null,
                    "promptVersion": null,
                    "inputDigest": "sha256:..."
                  },
                  "inferred": false,
                  "promotionReceiptId": null,
                  "confidence": {
                    "score": 0.96,
                    "tier": "high",
                    "forcedByOverride": false
                  },
                  "evidence": [
                    {
                      "sourceRef": "officer_buffs.json#/record/25",
                      "snippet": "damage dealt against hostiles",
                      "ruleId": "hostile_damage_v1",
                      "sourceLocale": "en",
                      "sourcePath": "officer_buffs.json",
                      "sourceOffset": 25
                    }
                  ]
                }
              ],
              "unmapped": []
            }
          ]
        }
      ]
    }

### Required fields

- Top-level: `schemaVersion`, `artifactVersion`, `generatedAt`, `source`, `taxonomyRef`, `officers`.
- Ability: `abilityId`, `slot`, `isInert`, `effects`, `unmapped`, `rawText`.
- Effect: `effectId`, `effectKey`, `targets`, `conditions`, `confidence`, `evidence`, `extraction`, `inferred`.
- Unmapped entry: `type`, `severity`, `reason`, `evidence`.

### Optional fields

- Ability: `name`, `inertReason`.
- Effect: `magnitude`, `unit`, `stacking`, `promotionReceiptId`.
- Evidence: `sourceOffset` (best-effort debug only).
- Extraction: `ruleId`, `model`, `promptVersion`, `inputDigest` (recommended for inferred; optional for deterministic).

### Slot representation

- Enumerated: `cm | oa | bda`.
- No aliases in contract. (`ca` treated as external synonym for `cm`, never emitted.)

### Inert abilities

- `isInert=true` means the ability intentionally has no normalized effects (e.g. literal "No effect.").
- `inertReason` enum: `no_effect | not_applicable | unknown | null`.
- `rawText` remains required even for inert abilities.
- Inert abilities must not automatically emit unmapped warnings.

### Normalized effects

- `effectKey`: must exist in taxonomy effect keys.
- `magnitude`: nullable number.
- `unit`: `percent | flat | rate | seconds | rounds | unknown | null`.
- `stacking`: `additive | multiplicative | unknown | null`.

### Conditions and targets

- `targets.targetKinds[]` from taxonomy target kinds.
- `targets.targetTags[]` from taxonomy target tags.
- `conditions[]` items: `{ conditionKey, params }`, where `conditionKey` must exist in taxonomy condition keys.

### Confidence

    {
      "score": 0.0,
      "tier": "high|medium|low",
      "forcedByOverride": false
    }

- `forcedByOverride=true` is mandatory if an override changed mapping semantics.

### Evidence

Each effect and unmapped entry must include at least one evidence item:

    {
      "sourceRef": "officer_buffs.json#/record/25",
      "snippet": "matched text",
      "ruleId": "rule-or-parser-id",
      "sourceLocale": "en",
      "sourcePath": "officer_buffs.json",
      "sourceOffset": 123
    }

- `sourceRef` is the required stable locator.
- `sourceOffset` is optional and best-effort for debugging only.

### Explicit unmapped entries (never silent)

When extraction fails or is uncertain, emit under `ability.unmapped[]`:

    {
      "type": "unmapped_ability_text|unknown_effect_key|unknown_magnitude|low_confidence_mapping",
      "severity": "info|warn",
      "reason": "No effect rule matched normalized phrase",
      "confidence": 0.41,
      "evidence": [{ "sourceRef": "...", "snippet": "...", "ruleId": "none", "sourceLocale": "en" }]
    }

Note: `unknown_effect_key` is explicitly included in the "needs interpretation" trigger (see addendum).

Implementation note (Phase 2 hardening): deterministic generation emits `unmapped` entries with `type="unknown_effect_key"` and required evidence/sourceRef when extraction encounters unknown keys; strict validation gates still fail unknown taxonomy refs.

### Versioning policy

- `schemaVersion` (SemVer): contract shape version.
  - Additive (minor): new optional fields, new unmapped types, new metadata fields.
  - Breaking (major): remove/rename fields, change enum semantics, ID algorithm changes.
- `artifactVersion`: immutable build identity (`semver+hash` or pure hash).
- Consumers must:
  - hard-fail on unsupported major `schemaVersion`
  - tolerate unknown optional fields.

### Deterministic ordering rules

- officers sorted by `officerId` ascending.
- abilities sorted by slot order: `cm`, `oa`, `bda`.
- effects sorted by (`evidence[0].sourceRef`, `effectId`) ascending.
- evidence sorted by (`sourceRef`, `ruleId`) ascending.

### Stable ID rules (override-safe)

- `abilityId`: `officerId:slot` (example `cdn:officer:988947581:cm`).
- `effectId`: stable to source span, not normalized payload.
  - Format: `abilityId + ":ef:src-" + spanIndex`
  - spanIndex is deterministic within ability after sorting by source locator semantics:
    - primary: explicit parser span boundaries (`start/end`) when present
    - secondary: explicit `sourceRef` when present
    - fallback: stable parse order over deterministic source segments/effect IDs
  - Effect IDs survive override payload changes (critical for `replace_effect`).

## 3) Runtime Artifact Plan (Delivery Format)

Artifact split

- `taxonomy.<hash>.json` (small, stable)
  - effect keys, condition keys, target kinds/tags, ship classes, issue types, slots.
- `officers.index.<hash>.json` (light index)
  - officer IDs, names, ability IDs/slots, chunk pointers, lightweight stats.
- `effects/chunk-<n>.<hash>.json` (heavy chunks)
  - full normalized effects/evidence/unmapped for a subset of officers.
- `manifest.<hash>.json`
  - points to current file hashes, schemaVersion, artifactVersion.

Client fetch strategy

1. Fetch `manifest` first.
2. If manifest hash unchanged (cached), skip refetch.
3. Fetch `taxonomy` + `officers.index`.
4. Fetch effect chunks on demand:
   - selected officers
   - recommendation candidate pool
   - prefetch likely next chunk in background.

Caching strategy

- Hashed filenames: `Cache-Control: public, max-age=31536000, immutable`.
- Manifest: short TTL + `ETag` (`Cache-Control: public, max-age=60, stale-while-revalidate=300`).

DB runtime integration (for Aria/agent)

- Generated artifacts remain source of truth.
- Server/agent layer may ingest artifacts into normalized DB tables for queryability/joins/pagination.
- Web path remains chunked artifacts to avoid large payloads.

## 4) Override Surface Spec

Overrides are explicit, auditable, and applied after generation.

File: `data/seed/effects-overrides.v1.json`

    {
      "schemaVersion": "1.0.0",
      "artifactBase": "1.0.0+sha256:2f5e...",
      "operations": [
        {
          "op": "replace_effect",
          "target": {
            "abilityId": "cdn:officer:988947581:oa",
            "effectId": "cdn:officer:988947581:oa:ef:src-3"
          },
          "value": {
            "effectKey": "weapon_damage",
            "magnitude": 0.2,
            "unit": "percent",
            "stacking": "additive",
            "targets": { "targetKinds": ["hostile"], "targetTags": ["pve"], "shipClass": null },
            "conditions": [{ "conditionKey": "per_round_stacking", "params": { "maxStacks": "5" } }],
            "extraction": { "method": "overridden", "ruleId": "override", "model": null, "promptVersion": null, "inputDigest": null },
            "inferred": false,
            "promotionReceiptId": null,
            "confidence": { "score": 1.0, "tier": "high", "forcedByOverride": true },
            "evidence": [{ "sourceRef": "officer_buffs.json#/record/31", "snippet": "manual override", "ruleId": "override", "sourceLocale": "en" }]
          },
          "reason": "Known parser miss on stack text",
          "author": "@team",
          "ticket": "MAJ-123"
        }
      ]
    }

Precedence

1. Generated artifact (base)
2. Overrides (patch operations)
3. No hidden/manual runtime mutation

If override conflicts with missing target IDs, CI fails (prevents silent drift).

## 5) CI Drift + Gates (Failure Policy)

Block CI immediately

- Schema invalid (`schemaVersion` contract violations).
- Unknown taxonomy references (`effectKey`, `conditionKey`, `targetKind`, `targetTag`, `shipClass`).
- Non-deterministic output (same input -> different output hash).
- Output drift: generated artifact differs from checked-in artifact.
- Override target not found / invalid operation.
- Duplicate stable IDs (`abilityId` or `effectId`).
- No-overwrite invariant violated (see addendum): deterministic effects must not be mutated except via explicit override ops.

Warn initially (non-blocking)

- `unmapped_*` count above soft threshold.
- extraction issues count above soft threshold.
- low-confidence mappings present.
- missing magnitudes where effectKey suggests expected numeric value.
- new unknown source phrases.

Telemetry to track

- mapped ability coverage %
- unmapped count by type (including unknown_effect_key)
- inert ability count by reason
- low-confidence count
- forced override count
- inferred promoted count + ratio (see addendum)
- taxonomy unknown reference count (should stay 0)

Budget gate (phase 2)

- Coverage non-regression gate:
  - block if mapped coverage drops more than `X` points vs baseline
  - block if `unmapped_ability_text` increases by > `N` absolute without approved ticket

---

# Addendum A: Aria Uncertainty Pipeline (Stochastic Inference, LexSona + Runner Gates)

## A1) Core rule

Inference may propose. Only deterministic gates may promote.
Deterministic outputs are immutable unless changed by explicit override op.

## A2) When inference runs (gap detector)

Emit a `needs_interpretation` task for an ability if:

- `effects.length == 0` AND `isInert == false`
- OR `unmapped` contains any of:
  - `unmapped_ability_text`
  - `unknown_magnitude`
  - `low_confidence_mapping`
  - `unknown_effect_key`
- OR the deterministic pass flags a known hard pattern class (optional v2+; e.g. stacking per round/stateful triggers)

## A3) Candidate state machine (sidecar only)

Candidates live in an inference sidecar report, not in runtime artifacts.

States:
- `proposed` -> `gate_passed` -> `promoted`
- `proposed` -> `rejected`

Promotion creates canonical effects in the main artifacts with:
- `extraction.method = "inferred"`
- `inferred = true`
- `promotionReceiptId` set to the gate receipt that authorized promotion

## A4) LexSona inference step (Aria executor)

Input:
- ability rawText + structured context
- taxonomy constraints
- LexSona rule context (getRules) and correction memory (recordCorrection) where applicable
- strict output contract: JSON only, no prose

Output (candidates):
- proposed effect payload(s) compatible with the Effects Contract
- required evidence including stable `sourceRef`
- confidence score + tier
- rationale (stored in sidecar; not required in shipped artifacts)

## A5) LexRunner-style gates (implemented in Majel runner layer)

Gates are deterministic and must pass before promotion:

1) Schema validity gate
2) Taxonomy validity gate
3) Condition schema validity gate
4) Deterministic ordering gate
5) Confidence threshold gate
6) Contradiction gates (concrete):
   - Taxonomy contradiction: invalid refs (already a hard fail)
   - Intra-ability contradiction: same source span (sourceRef + spanIndex) proposes conflicting effectKeys or conflicting magnitudes for identical signature
   - Override contradiction: multiple overrides attempt to mutate the same (abilityId, effectId) in one run or create duplicate signatures

## A6) Materialization policy

- High confidence + gates pass -> promote to canonical effects (inferred=true)
- Medium/low confidence -> do not promote
  - keep as `unmapped_*` in main artifacts
  - keep candidates in inference sidecar for review (and potential rule/override creation)

## A7) Learning loop

- Human accept/reject flows into:
  - deterministic phrase rule (preferred), or
  - explicit override op
- Inference remains a backstop for gaps, not the primary authoring surface.

## A8) Inference sidecar report (developer artifact)

Example file: `inference-report.<hash>.json` (not fetched by default web UI)

    {
      "schemaVersion": "1.0.0",
      "artifactBase": "1.0.0+sha256:2f5e...",
      "runId": "2026-02-22T14:00:00Z+sha256:...",
      "candidates": [
        {
          "abilityId": "cdn:officer:282462507:bda",
          "candidateId": "cand:0",
          "candidateStatus": "proposed|gate_passed|promoted|rejected",
          "proposedEffects": [ { "...effect payload compatible with main contract..." } ],
          "gateResults": [
            { "gate": "taxonomy_validity", "status": "pass" },
            { "gate": "contradiction_intra_ability", "status": "pass" }
          ],
          "confidence": { "score": 0.62, "tier": "medium" },
          "rationale": "short text for humans",
          "model": "gemini-...",
          "promptVersion": "sha256:...",
          "inputDigest": "sha256:..."
        }
      ]
    }

## A9) Inference-specific CI budgets

- Block if inferred_promoted_ratio > X% (configurable)
- Warn if low-confidence candidate count spikes
- Block on mapped coverage regression (shared gate)
- Warn if forced override count spikes

---

# Addendum B: No-overwrite invariant (explicit)

- Deterministic effects are immutable within a generation run.
- Inferred candidates may not overwrite a deterministic effect record directly.
- The only allowed mutation of an existing effect record is via an explicit override op that targets (abilityId, effectId).
- If inference proposes an effect that collides with an existing deterministic effect signature, the candidate must be rejected or remain in sidecar.

---

# Addendum C: AX Build-and-Review Harness (Cody-operable)

Committed CLI scaffolding is available in `scripts/ax` so local AI operators (including Cody) can run snapshot build/review loops without private machine-only setup.

## Commands

1) `npm run ax -- effects:build --mode=deterministic|hybrid [--snapshot=<id>]`
- Produces deterministic artifacts (`manifest`, `taxonomy`, `officers.index`, `effects chunk`, contract file) under `tmp/effects/runs/<runId>/artifacts/`.
- In `hybrid` mode also produces `inference-report.<hash>.json` sidecar under the run folder.
- Hybrid inference sidecar now evaluates candidate gates and assigns statuses (`proposed`, `gate_passed`, `gate_failed`, `rejected`) with status counts recorded in the build receipt.
- Applies explicit override operations from `data/seed/effects-overrides.v1.json` after base generation and before final artifact write.
- Build fails with structured errors when override targets are missing or contradictions/taxonomy violations are detected.
- Writes build receipt: `receipts/effects-build.<runId>.json`.
- Always validates the contract first; build fails fast on schema/taxonomy errors.

2) `npm run ax -- effects:review-pack --run=<runId>`
- Reads the build receipt + inference report and emits AI review assets:
  - `review/review-pack.<runId>.json`
  - `review/review-pack.<runId>.md`
- Also emits `review/decisions.template.<runId>.json` with per-candidate suggested actions (`promote|reject|override|rule`) for structured AI-assisted review.
- Writes receipt: `receipts/effects-review-pack.<runId>.json`.

3) `npm run ax -- effects:apply-decisions --run=<runId> --decisions=<path>`
- Executes deterministic promotion gates against sidecar candidates and reviewed decisions.
- Emits gate receipt: `receipts/effects-gates.<runId>.json` with per-candidate gate outcomes.
- Materializes promoted artifact snapshot under the run artifacts folder and links inferred effects to `promotionReceiptId`.
- Enforces no-overwrite invariant: deterministic base effects cannot be removed/rewritten by decision application.

## Safety constraints

- AI review artifacts are derived sidecar outputs; they are not runtime web artifacts.
- Canonical artifacts are never directly mutated by AI review outputs in this phase.
- Future apply path must remain: decisions -> deterministic gates/validators -> receipt.