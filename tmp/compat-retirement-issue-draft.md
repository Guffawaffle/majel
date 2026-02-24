## Compatibility Endpoint Retirement (Phase 3)

Tracks removal of legacy compatibility API endpoints that are no longer used by the web app and currently retained for backward compatibility.

### Scope
- Remove `GET /api/auth/status` legacy endpoint.
- Remove `POST /api/auth/redeem` legacy invite redemption endpoint.
- Remove deprecated `POST /api/catalog/sync` endpoint.
- Remove local npm helper scripts that call deprecated endpoints (`sync`, `sync:wait`, and any cloud sync wrapper if it only proxies this path).
- Update tests/docs to align with modern auth/session and ingestion flows.

### Rationale
- Endpoints are marked legacy/deprecated in route sources.
- Current web client does not call these endpoints.
- Keeping them increases surface area and test burden.

### Acceptance Criteria
- Legacy endpoints removed from server routes.
- No scripts/docs reference removed endpoints.
- Tests updated to modern flows.
- `npm run ax -- test` and `npm run ax -- typecheck` pass.

### Risk Controls
- Keep PM-visible issue + explicit changelog entry.
- No changes to modern auth routes (`/api/auth/signup`, `/api/auth/signin`, `/api/auth/me`, `/api/auth/logout`) or data ingestion path.
