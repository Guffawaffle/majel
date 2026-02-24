# server/

Backend runtime for the Majel API.

## Key files and directories

| Path | Purpose |
|---|---|
| `index.ts` | Server bootstrap and startup wiring |
| `routes/` | HTTP route modules under `/api/*` |
| `services/` | Domain/business services (AI, ingestion, auth helpers, etc.) |
| `stores/` | PostgreSQL-backed domain stores |
| `types/` | Shared server-side TypeScript contracts |
| `config.ts` | Environment and runtime configuration |
| `db.ts` | PostgreSQL pool and DB helpers |
| `safe-router.ts` | Route safety utilities and wrappers |

## Common commands

```bash
npm run dev
npm run test
npm run ax -- affected
npm run ax -- ci
```
