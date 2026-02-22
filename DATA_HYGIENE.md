# Data Hygiene Policy

This repository intentionally avoids committing raw CDN/game snapshot payloads.

## Why

- Keep repository diffs readable and reviewable
- Prevent accidental publication of bulky/raw source payloads
- Preserve deterministic build inputs with clear provenance

## Allowed in Git

- Contract primitives and small deterministic fixtures (taxonomy/intents/overrides/budget config)
- Officer fixture seed corpus only at `data/seed/effect-taxonomy.officer-fixture.v1.json`
- Generated artifacts that are explicitly approved for commit in an ADR/process update

## Forbidden in Git

- Raw CDN snapshot directories and payload dumps
- Full uncurated source payload mirrors
- Large JSON payloads under `data/` that are not fixture/contract inputs

## Forbidden Path Prefixes (CI gate)

- `data/.stfc-snapshot/`
- `data/raw-cdn/`
- `data/cdn-raw/`
- `tmp/cdn/`

## CI Guardrail

- Command: `npm run ax -- data:hygiene`
- Included in: `npm run ax -- ci`
- Behavior:
  - Blocks known forbidden path prefixes
  - Blocks suspicious oversized JSON under `data/` (unless explicitly allowlisted)
  - Flags likely raw-CDN signature keys when detected in committed/untracked files

## Local Workflow

- Run before commits touching `data/`:
  - `npm run ax -- data:hygiene`
- If a block is intentional, update this policy and ADR rationale first.
