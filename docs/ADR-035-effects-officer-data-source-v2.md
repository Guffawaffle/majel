# ADR-035 — Effects Officer Data Source v2 (DB-derived, seed-minimal)

**Status:** Proposed  
**Date:** 2026-02-22  
**Authors:** Guff, Cody, Lex  
**References:** ADR-034 (Effect Taxonomy), `data/seed/effects-overrides.v1.json`, `data/seed/effects-ci-budget.v1.json`, `scripts/ax/*`

---

## Context

Effects Contract v3 is expanding toward full officer coverage. The current seed shape in `data/seed/effect-taxonomy.json` mixes:

- Contract primitives (taxonomy keys, condition keys, issue types, intents)
- Officer ability rows + extracted text (CDN-derived)

Committing full officer data in-repo creates large diffs/churn, provenance ambiguity, and accidental raw CDN payload risk.

### Constraints

- Effects v3 output must remain deterministic.
- PR CI must remain hermetic and reproducible (no live DB dependency).
- Overrides, unmapped reporting, and receipts must stay auditable.
- Full-data validation must be possible in development/nightly without committing raw CDN payloads.

---

## Decision Drivers

- Determinism + repeatability for PR CI
- Operational reliability for local + CI
- Data volume/repo hygiene
- Provenance: answer “which snapshot produced this output?”
- Safety guardrails against accidental raw CDN commits
- Rollback to known-good snapshot/export

---

## Options Considered

### Option A — Hybrid (DB source of truth + deterministic export)

- Git stores contract primitives + overrides + small fixtures.
- Full officer data lives in DB snapshots seeded outside normal PR flow.
- Build/export step generates deterministic officer scaffold JSON from DB.
- PR CI uses pinned fixture export.
- Nightly CI validates pinned full snapshot export + budgets.

**Pros:** preserves hermetic PR CI, keeps repo clean, supports full-data coverage.  
**Cons:** requires snapshot/versioning discipline and export tooling.

### Option B — Fully DB-native

**Pros:** minimal repo data.  
**Cons:** CI flakiness risk, weaker determinism, harder onboarding.

### Option C — Commit generated full artifact

**Pros:** deterministic, no runtime DB dependency.  
**Cons:** large churn/noise and repository bloat remain.

---

## Decision

Adopt **Option A (Hybrid)**.

- DB snapshot is authoritative for full officer ability/raw-text corpus.
- Git remains authoritative for immutable contract surface:
  - taxonomy keys/condition keys/issue types/slots
  - intents/scoring vectors
  - override schema/precedence
  - CI budget policy
- Deterministic export produces build input artifact from DB.
- PR CI remains fixture-only and hermetic.
- Nightly validates pinned snapshot export by immutable `contentHash`.

---

## Contract & Hashing Policy

- Canonical JSON bytes must use existing stable serialization primitives in `src/server/services/effects-contract-v3.ts` (`stableJsonStringify` + `sha256Hex`).
- `generatedAt` in snapshot/export metadata is lifecycle-bound (snapshot/export creation time), never request-time jitter.
- Effect ID stability and override safety rules remain unchanged from Effects Contract v3.

---

## Build / Export Pipeline (Target)

1. `npm run ax -- effects:snapshot:export --snapshotId=<id> --out=<path>`
   - Deterministically exports officer scaffold (`officers + abilities + sourceRef`) plus snapshot metadata (`snapshotId`, `schemaHash`, `contentHash`, `generatedAt`).
   - Output is not committed by default.

2. `npm run ax -- effects:build --input=<export.json> --mode=deterministic|hybrid`
   - Deterministic extraction always runs.
   - Hybrid inference follows existing gate/promotion/receipt rules.

3. `npm run ax -- ci` (PR)
   - Fixture-only input, no live DB requirement.

4. Nightly CI
   - Uses pinned full snapshot export.
   - Fails if `contentHash` differs from expected.
   - Applies budget/regression gates.

---

## Guardrails

- Add CI data-hygiene gate to block known raw CDN paths/signatures.
- Document forbidden data patterns in `DATA_HYGIENE.md`.
- Optional local pre-commit hook mirrors CI checks.

---

## Rollback / Failure Behavior

- Snapshot unavailable:
  - PR CI unaffected (fixture path).
  - Nightly fails with explicit snapshot resolution error.
  - Local dev may fallback to cached export or fixtures.
- Export validation failure:
  - Fail fast with receipt; no publish/promotion.

---

## Migration Plan

### Phase 0 — ADR + guardrails
- Land ADR and CI scaffold checks for data hygiene.

### Phase 1 — Snapshot schema + export command
- Define snapshot metadata contract and deterministic export command.

### Phase 2 — Build input split
- Update effects build flow to consume fixture/full export input while preserving current contract checks.

### Phase 3 — Nightly full snapshot gates
- Add pinned snapshot fetch/verify and budget regression thresholds.

### Phase 4 — Seed minimization
- Remove large officer corpus from git seeds; keep fixtures only.

### Phase 5 — Optional value canonicalization table
- Introduce minimal value semantics (`unit`, `stacking`, optional `comparator`/`scale`) only when extraction quality needs it.

---

## Open Questions

- Snapshot storage location and access model for nightly runs
- Fixture dataset shape/size needed to preserve edge-case coverage
- Multi-locale handling timing and scope
