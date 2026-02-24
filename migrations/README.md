# migrations/

Database schema migrations for Majel.

## Structure

| Path | Purpose |
|---|---|
| `canonical/` | Canonical schema SQL migration files |
| `canonical/001_canonical_schema.sql` | Baseline canonical schema migration |

## Common commands

```bash
npm run canonical:migrate
npm run canonical:migrate:status
```
