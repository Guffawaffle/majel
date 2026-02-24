# routes/

HTTP route handlers for API endpoints.

## Route modules

| File | Domain |
|---|---|
| `auth.ts` | Authentication and account access |
| `catalog.ts` | Catalog sync and retrieval |
| `chat.ts` | Chat endpoints and AI interactions |
| `core.ts` | Core health and base API routes |
| `crews.ts` | Crew composition and recommendations |
| `effects.ts` | Effects endpoints and evaluation surfaces |
| `imports.ts` | Data import endpoints |
| `proposals.ts` | Proposal workflows |
| `receipts.ts` | Receipt retrieval endpoints |
| `sessions.ts` | Session lifecycle routes |
| `settings.ts` | Fleet and app settings |
| `targets.ts` | Target planning and conflict checks |
| `translator.ts` | Translation and localization endpoints |
| `user-settings.ts` | Per-user preference APIs |
| `admiral.ts` | Admiral-facing endpoints |
| `diagnostic-query.ts` | Diagnostic and query utilities |

## Common commands

```bash
npm run test -- test/*routes*.test.ts
npm run ax -- test
```
