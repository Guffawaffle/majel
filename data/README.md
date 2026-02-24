# data/

Operational data and local runtime artifacts.

## Purpose
- Holds local datasets, snapshots, seeds, and translator inputs used by ingestion and tooling.

## Source-Controlled vs Generated
- Source-controlled: `seed/`, `translators/`.
- Generated/local-only: `.stfc-snapshot/`, `behavior.db`, `behavior.db-shm`, `behavior.db-wal`.

## Safe Usage
- Treat this directory as data-bearing: do not commit new runtime DB or snapshot files.
- Prefer reproducible inputs in `seed/` and `translators/`; regenerate runtime artifacts as needed.
