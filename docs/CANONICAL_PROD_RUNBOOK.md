# Canonical Production Upload Runbook (Idempotent)

Scope: `officer`, `ship`, `research`, `system`, `building`  
Out of scope: `hostile`, `consumable`

## Deploy Automation

`npm run cloud:deploy` now runs this sequence automatically after a healthy deploy:

1. Idempotent canonical seed (`officer` + `ship` upsert path)
2. Idempotent crawler feed load (`officer`, `ship`, `research`, `system`, `building`, translations) with runtime dataset activation
3. Post-deploy smoke checklist (`/api/health`, `/api`, `/api/auth/me`, `/api/catalog/counts`)

Behavior is add/update only (upsert) and supports idempotent replay/no-op for unchanged feed content hashes.

Optional deploy flags:

- `--skip-seed` to bypass post-deploy data sync
- `--seed-feed <feed-id-or-path>` to force a specific feed run
- `--feeds-root <path>` to resolve feed IDs
- `--retention-keep-runs <n>` for runtime dataset retention

## Preconditions

- Production DB credentials available via existing cloud tooling.
- Feed package path or feed ID is known and immutable (`feedId`, `runId`, `contentHash`).
- Feed produced from `stfc.space` handoff pipeline.

## 1) Preflight (must pass)

Apply migrations (idempotent):

```bash
npm run ax -- canonical:migrate
```

```bash
npm run ax -- canonical:preflight --feed <feed-id-or-path> --feeds-root <feeds-root>
```

Expected:
- `success: true`
- no duplicate natural keys
- no content hash mismatch

## 2) Apply (staged)

Set DB connection once per shell:

```bash
export DATABASE_URL='postgresql://<user>:<password>@<host>:5432/majel'
```

```bash
npm run ax -- feed:load --feed <feed-id-or-path> --feeds-root <feeds-root>
```

Optional activation on apply:

```bash
npm run ax -- feed:load --feed <feed-id-or-path> --feeds-root <feeds-root> --activate-runtime-dataset
```

## 3) Post-apply verification

```bash
npm run ax -- canonical:postcheck --scope global --limit 10
```

Verify:
- active run is expected `runId`
- latest run status is `active` (or `staged` if not activated)
- metadata reflects expected `contentHash` and `datasetKind`

## 4) Rollback approach

- Identify prior known-good run from `canonical:postcheck` output.
- Re-apply prior feed with `--activate-runtime-dataset`.
- Re-run `canonical:postcheck` to confirm active run pointer moved.

## 5) Idempotency checks

Re-run the same feed apply command. Expected:
- no corruption
- stable run metadata
- deterministic validation result

## Notes

- Use `npm run ax -- ci` before production rollout where feasible.
- Keep artifact retention and retrieval aligned with content-hash policy in producer repo (`stfc.space`).
- Avoid `--db-url` in CLI history; prefer `DATABASE_URL` in shell/session environment.
