# api/

API client modules. One file per backend domain.

Each module imports `_fetch.js` and exports thin fetch wrappers.

## Interface Contract

Every API module exports named functions following these naming conventions:
- `fetchX` — GET requests (read)
- `createX` — POST requests (create)
- `updateX` — PUT/PATCH requests (update)
- `deleteX` — DELETE requests (delete)

All functions return the unwrapped `body.data` from the server envelope.
All functions throw `ApiError` on non-2xx responses (from `_fetch.js`).

## Files

| Module | Domain | Server Routes |
|--------|--------|---------------|
| `_fetch.js` | — | Shared fetch wrapper, CSRF, error class |
| `index.js` | — | Barrel re-export (**migration only — do not import from views**) |
| `auth.js` | Auth | `/api/auth/*` |
| `chat.js` | Chat | `/api/chat`, `/api/history`, `/api/recall` |
| `sessions.js` | Sessions | `/api/sessions/*` |
| `settings.js` | Settings | `/api/settings/*` |
| `catalog.js` | Catalog | `/api/catalog/*` |
| `fleet.js` | Fleet | `/api/catalog/ships/merged`, `/api/catalog/officers/merged` |
| `docks.js` | Docks | `/api/dock/*` |
| `loadouts.js` | Loadouts | `/api/loadouts/*` |
| `plan.js` | Plan | `/api/plan/*` |
| `intents.js` | Intents | `/api/dock/intents` |
| `admiral.js` | Admiral | `/api/admiral/*`, `/api/auth/admiral/*` |

## Barrel Import Warning

⚠️ With no bundler, importing from `index.js` causes the browser to fetch ALL modules.
Views must import directly from domain modules:

```js
// ✅ YES — 1 network request
import { fetchShips } from 'api/fleet.js';

// ❌ NO — triggers 12 requests (barrel fan-out)
import * as api from 'api/index.js';
```
