# scripts/

Operational and developer automation scripts.

## Key files and directories

| Path | Purpose |
|---|---|
| `ax.ts` | Unified task entrypoint (`npm run ax -- <command>`) |
| `ax/` | Subcommands for CI, lint, typecheck, tests, effects, and reporting |
| `cloud.ts` | Cloud deploy, env, health, and DB operational commands |
| `canonical-migrate.ts` | Canonical schema migration runner/status |
| `data-ingestion.ts` | Validate/load/diff data ingestion flows |
| `validate-cdn-parity.ts` | CDN parity checks |
| `pg-autofix.mjs` | Local PostgreSQL troubleshooting helper |
| `lib/` | Shared script modules (CDN ingest and upsert helpers) |

## Common commands

```bash
npm run ax -- status
npm run ax -- affected
npm run ax -- ci
npm run canonical:migrate -- --status
npm run ax -- data:ingestion --mode=validate --feed <id-or-path>
```
