# api/

API client modules. One file per backend domain.

Each module imports `_fetch` (legacy wrapper) and exports thin fetch wrappers
that manually unwrap the server envelope. Return types vary per function.

`apiFetch` is the new uniform wrapper (5xx sanitization, `ApiError` throws,
`body.data` unwrap) — domain modules will migrate to it incrementally.

## Interface Contract

Every API module exports named functions following these naming conventions:
- `fetchX` — GET requests (read)
- `createX` — POST requests (create)
- `updateX` — PUT/PATCH requests (update)
- `deleteX` — DELETE requests (delete)

Functions currently use `_fetch` (legacy) and return ad-hoc shapes
(`{ ok, data, error }`, arrays, objects, or `null`).
New code should use `apiFetch` which returns the unwrapped `body.data`
and throws `ApiError` on non-2xx responses.

## Files

| Module | Domain | Server Routes |
|--------|--------|---------------|
| `_fetch.js` | — | Shared fetch wrapper, CSRF, `ApiError` class |
| `index.js` | — | Barrel re-export (**migration only — do not import from views**) |
| `auth.js` | Auth | `/api/auth/*` |
| `health.js` | Health | `/api/health` |
| `chat.js` | Chat | `/api/chat`, `/api/history`, `/api/recall` |
| `sessions.js` | Sessions | `/api/sessions/*` |
| `settings.js` | Settings | `/api/settings/*` |
| `catalog.js` | Catalog | `/api/catalog/*` |
| `docks.js` | Docks | `/api/dock/*` |
| `admiral.js` | Admiral | `/api/auth/admin/*`, `/api/admin/*` |

## Barrel Import Warning

⚠️ With no bundler, importing from `index.js` causes the browser to fetch ALL modules.
Views must import directly from domain modules:

```js
// ✅ YES — 1 network request
import { fetchShips } from 'api/catalog.js';

// ❌ NO — triggers 10 requests (barrel fan-out)
import * as api from 'api/index.js';
```
