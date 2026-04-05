# ADR-020 — Admiral Console

**Status:** Proposed  
**Date:** 2026-02-11  
**References:** ADR-019 Phase 5.4 (Admiral user management panel), ADR-018 D2 (Tiered Access)

---

## Context

Majel has 8 admin management API endpoints that are fully implemented and tested:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/invites` | POST | Create invite code |
| `/api/admin/invites` | GET | List all invite codes |
| `/api/admin/invites/:code` | DELETE | Revoke invite code |
| `/api/admin/sessions` | GET | List all tenant sessions |
| `/api/admin/sessions/:id` | DELETE | Delete a tenant session |
| `/api/auth/admin/users` | GET | List all users |
| `/api/auth/admin/user` | DELETE | Delete user by email |
| `/api/auth/admin/set-role` | POST | Set user role |

All of these are **only accessible via curl** with a `Bearer` token matching `MAJEL_ADMIN_TOKEN`. There is no client-side UI for any of them. The existing Diagnostics tab covers system health and data inspection but does not include user or invite management.

ADR-019 allocated this to "Phase 5.4" as a one-liner. This ADR expands the spec.

---

## Decision

### D1 — Admiral-Gated Access

The Admiral Console reuses the existing `requireAdmiral` middleware. Any user with the `admiral` role can access it — the same gate already protecting the Diagnostics tab. No new environment variables, no hardcoded emails, no special "owner" concept.

**Routes protected by `requireAdmiral`:**
- `GET/POST/DELETE /api/admin/*` (existing admin routes — already gated)
- `GET/POST/DELETE /api/auth/admin/*` (user management routes — already gated via Bearer token, updated to also accept admiral sessions)

**Client-side gating:** The sidebar button is visible when `me.role === 'admiral'`, identical to how the Diagnostics button is gated today.

### D2 — Console View Architecture

A new `admin` view added to the SPA, rendered by a new `admin.js` module.

**Sidebar:** New button `🛡️ Admiral Console` — visible only to admirals (same gating as Diagnostics).

**Navigation:** Added to `VALID_VIEWS` as `'admin'`, gated identically to `'diagnostics'`.

### D3 — Console Panels

The console contains 3 panels, each with a tab:

#### Panel 1: Users
| Feature | API | Description |
|---------|-----|-------------|
| User list | `GET /api/auth/admin/users` | Table: email, display name, role, verified status, created date, locked status |
| Role dropdown | `POST /api/auth/admin/set-role` | Inline select: ensign/lieutenant/captain/admiral — disabled for the current user's own row |
| Lock/unlock | (new) `PATCH /api/auth/admin/lock` | Toggle `locked_at` — prevents login without deletion |
| Delete user | `DELETE /api/auth/admin/user` | Confirm dialog, cascades overlays/sessions/settings |

#### Panel 2: Invite Codes
| Feature | API | Description |
|---------|-----|-------------|
| Create code | `POST /api/admin/invites` | Form: max uses (1-100), expiry (1h-30d), optional label |
| Code list | `GET /api/admin/invites` | Table: code (masked), uses/max, expiry, created, status |
| Revoke | `DELETE /api/admin/invites/:code` | Confirm dialog |
| Copy code | — | Clipboard copy button for sharing |

#### Panel 3: Sessions
| Feature | API | Description |
|---------|-----|-------------|
| Session list | `GET /api/admin/sessions` | Table: session ID, user email, created, last active, IP |
| Kill session | `DELETE /api/admin/sessions/:id` | Force logout a specific session |
| Kill all | (new) `DELETE /api/admin/sessions` | Nuke all sessions except the caller's |

### D4 — Session-Based Admiral Access to Admin Routes

Currently the `/api/auth/admin/*` routes (set-role, users, delete-user) only accept Bearer token authentication. This ADR extends them to also accept session-cookie admirals via `requireAdmiral`, so the console UI can call them without the raw admin token.

The existing Bearer-token path remains functional for CLI/automation use.

### D5 — Client Module Structure

```
src/client/
├── admin.js          ← NEW: Admiral Console module
├── app.js            ← Updated: add 'admin' to VALID_VIEWS, gating
├── api.js            ← Updated: add admin API functions
├── styles.css        ← Updated: admin panel styles
└── index.html        ← Updated: admin sidebar button + section
```

**`admin.js` exports:**
- `init()` — no-op stub (dynamic render)
- `refresh()` — fetches all 3 data sets, renders active tab

### D6 — Security Constraints

| Constraint | Implementation |
|-----------|----------------|
| Admiral-only access | Existing `requireAdmiral` middleware on all admin routes |
| No self-deletion | Current user's row in user list has delete button disabled |
| No self-demotion | Role dropdown disabled on current user's own row |
| Cascading delete | User deletion removes: sessions, overlays, settings, dock presets |
| Confirm dialogs | All destructive actions (delete user, revoke code, kill session) require confirmation |
| Audit logging | All admin actions logged at `info` level with actor identity |

---

## Implementation Phases

### Phase 1 — Route Updates (server)

| # | Task | Scope |
|---|------|-------|
| 1.1 | Update `/api/auth/admin/*` routes to accept session-cookie admirals (not just Bearer token) | `routes/auth.ts` |
| 1.2 | Add `PATCH /api/auth/admin/lock` endpoint | `routes/auth.ts` |
| 1.3 | Add `DELETE /api/admin/sessions` (kill-all) endpoint | `routes/admin.ts` |

### Phase 2 — Console UI

| # | Task | Scope |
|---|------|-------|
| 2.1 | Add admin API functions to `api.js` | Client |
| 2.2 | Create `admin.js` module (3-tab panel) | Client |
| 2.3 | Add admin sidebar button + section to `index.html` | Client |
| 2.4 | Add `'admin'` to `VALID_VIEWS`, wire gating in `app.js` | Client |
| 2.5 | Add admin panel CSS | `styles.css` |

### Phase 3 — Tests

| # | Task | Scope |
|---|------|-------|
| 3.1 | Admiral-gated route integration tests | Test |
| 3.2 | Admin API function tests | Test |

---

## Alternatives Considered

| Alternative | Rejected Because |
|------------|------------------|
| Reuse diagnostics tab for admin panels | Diagnostics is system inspection; admin is mutation. Mixing them in one tab creates clutter and conflates read-only diagnostics with destructive admin actions. |
| Separate "owner" role above admiral | Over-engineered for a single-instance app. The RBAC system already has admiral as the top role; adding another layer adds complexity without clear benefit. Any admiral is trusted. |
| Hardcoded email allowlists | Violates ADR-019 principle: "No hardcoded admin UUIDs in source code." Role-based gating is the correct approach. |

---

## Consequences

- **Any admiral can access the console.** Promotion to admiral grants full admin UI access.
- **No new env vars or config changes required.** The existing `requireAdmiral` middleware + RBAC handles everything.
- **Diagnostics and Admiral Console are both admiral-gated** but remain separate views — diagnostics for inspection, console for management.
- **Bearer-token CLI access is preserved** alongside the new session-based UI access.
