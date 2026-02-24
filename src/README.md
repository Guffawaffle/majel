# src/

Application source for Majel backend and embedded landing assets.

## Key directories

| Path | Purpose |
|---|---|
| `landing/` | Static landing page assets copied into `dist/landing` during build |
| `server/` | Express API server, routes, services, data stores, and middleware |
| `shared/` | Shared runtime helpers used across server modules |

## Common commands

```bash
npm run dev         # API dev server (tsx watch)
npm run build       # TypeScript build + landing assets + web build
npm run typecheck   # TypeScript checks
npm run ax -- ci    # Preferred full validation gate
```
