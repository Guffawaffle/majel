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

### D1 — Owner-Only Access Gate

The Admiral Console is restricted to a single owner identity, not merely any `admiral`-role user.

**Mechanism:** A new environment variable `MAJEL_OWNER_EMAIL` (default: not set). A new `requireOwner(appState)` middleware:

1. Runs after `requireAdmiral` (must already be admiral)
2. If `MAJEL_OWNER_EMAIL` is not set → allow any admiral (dev mode / backwards-compatible)
3. If set → assert `resolvedIdentity.email === MAJEL_OWNER_EMAIL`
4. For Bearer token (virtual admiral): map the virtual identity email to `MAJEL_OWNER_EMAIL` instead of `admin@majel.local`

**Production config:**
```env
MAJEL_OWNER_EMAIL=guff@smartergpt.dev
```

This cleanly separates the "admiral" role (fleet power-user permissions) from "owner" (system administration). A future admiral who isn't the owner would see the Diagnostics tab but **not** the Admiral Console.

**Routes protected by `requireOwner`:**
- `GET /api/admin/*` (all existing admin routes)
- `POST/DELETE /api/auth/admin/*` (user management routes)
- The console view itself (client-side gating via `/api/auth/me` response)

### D2 — Console View Architecture

A new `admin` view added to the SPA, rendered by a new `admin.js` module.

**Sidebar:** New button `🛡️ Admiral Console` — visible only when `me.email === ownerEmail` (returned from an enhanced `/api/auth/me` response that includes `isOwner: true`).

**Navigation:** Added to `VALID_VIEWS` as `'admin'`, gated like diagnostics.

### D3 — Console Panels

The console contains 3 panels, each with a tab:

#### Panel 1: Users
| Feature | API | Description |
|---------|-----|-------------|
| User list | `GET /api/auth/admin/users` | Table: email, display name, role, verified status, created date, locked status |
| Role dropdown | `POST /api/auth/admin/set-role` | Inline select: ensign/lieutenant/captain/admiral — disabled for owner's own row |
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
| Kill all | (new) `DELETE /api/admin/sessions` | Nuke all non-owner sessions |

### D4 — `/api/auth/me` Enhancement

The `/api/auth/me` response gets an `isOwner` flag:

```json
{
  "user": {
    "id": "...",
    "email": "guff@smartergpt.dev",
    "displayName": "Guffawaffle",
    "role": "admiral",
    "isOwner": true
  }
}
```

This flag is derived server-side: `isOwner = identity.email === config.ownerEmail`. The client uses it for sidebar gating — the `🛡️ Admiral Console` button is only visible when `isOwner === true`.

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
| Owner-only access | `requireOwner` middleware on all admin routes |
| No self-deletion | Owner row in user list has delete button disabled |
| No self-demotion | Role dropdown disabled on owner's own row |
| Cascading delete | User deletion removes: sessions, overlays, settings, dock presets |
| Confirm dialogs | All destructive actions (delete user, revoke code, kill session) require confirmation |
| Audit visibility | All admin actions logged at `info` level with actor identity |

### D7 — Virtual Admiral Email Mapping

The Bearer-token virtual admiral currently resolves to `admin@majel.local`. This ADR changes it to resolve to `MAJEL_OWNER_EMAIL` when set:

```typescript
// auth.ts — resolveIdentity, Bearer token path
return {
  userId: deriveAdminUserId(appState.config.adminToken),
  role: "admiral",
  email: appState.config.ownerEmail || "admin@majel.local",
  displayName: "Admiral",
  emailVerified: true,
  lockedAt: null,
  source: "admin-token",
};
```

This ensures the Bearer-token admin and the `guff@smartergpt.dev` session-based admin are treated as the same owner identity.

---

## Implementation Phases

### Phase 1 — Owner Gating (server)

| # | Task | Scope |
|---|------|-------|
| 1.1 | Add `MAJEL_OWNER_EMAIL` to config | `config.ts` |
| 1.2 | Map virtual admiral email to `ownerEmail` | `auth.ts` |
| 1.3 | Create `requireOwner` middleware | `auth.ts` |
| 1.4 | Apply `requireOwner` to `/api/admin/*` and `/api/auth/admin/*` | Routes |
| 1.5 | Add `isOwner` flag to `GET /api/auth/me` | `routes/auth.ts` |

### Phase 2 — Console UI

| # | Task | Scope |
|---|------|-------|
| 2.1 | Add admin API functions to `api.js` | Client |
| 2.2 | Create `admin.js` module (3-tab panel) | Client |
| 2.3 | Add admin sidebar button + section to `index.html` | Client |
| 2.4 | Add `'admin'` to `VALID_VIEWS`, wire gating in `app.js` | Client |
| 2.5 | Add admin panel CSS | `styles.css` |

### Phase 3 — New Endpoints

| # | Task | Scope |
|---|------|-------|
| 3.1 | `PATCH /api/auth/admin/lock` — lock/unlock user | `routes/auth.ts` |
| 3.2 | `DELETE /api/admin/sessions` — kill all non-owner sessions | `routes/admin.ts` |

### Phase 4 — Tests

| # | Task | Scope |
|---|------|-------|
| 4.1 | `requireOwner` middleware unit tests | Test |
| 4.2 | Owner-only route integration tests | Test |
| 4.3 | Admin API function tests | Test |

---

## Alternatives Considered

| Alternative | Rejected Because |
|------------|------------------|
| Reuse diagnostics tab for admin panels | Diagnostics is system inspection; admin is mutation. Different audiences (any admiral vs. owner only). Mixing them confuses the trust boundary. |
| Admin as a sub-route of diagnostics | Same problem — an admiral promoted for fleet oversight shouldn't see user management tools. |
| Hardcode `guff@smartergpt.dev` in source | Violates ADR-019 principle: "No hardcoded admin UUIDs in source code." Config-driven is correct. |
| No owner distinction (any admiral = full access) | Unsafe — promoting a trusted friend to admiral for fleet features shouldn't grant them user deletion power. |

---

## Consequences

- **Owner is config-driven**, not role-driven. A system can have multiple admirals but only one owner.
- **Bearer-token admin is the owner** by definition (they control the env var).
- **Diagnostics tab remains admiral-accessible.** The new console is a separate, more restricted view.
- **Future multi-admin** could extend `MAJEL_OWNER_EMAIL` to a comma-separated list, but this is out of scope.
