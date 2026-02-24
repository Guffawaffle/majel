# schemas/

Canonical JSON Schemas for Majel data contracts.

## Purpose
- Defines stable schema contracts for core entities used at data and API boundaries.
- Supports validation, tooling interoperability, and contract-aware generation.

## Source-Controlled vs Generated
- Source-controlled: all `*.schema.json` files and this README.
- Generated: none; update schemas intentionally via reviewed changes.

## Safe Usage
- Treat schema changes as contract changes: update dependent tooling/tests in the same change.
- Keep backward compatibility in mind and prefer additive evolution where practical.
- Do not place runtime data dumps in this directory.

