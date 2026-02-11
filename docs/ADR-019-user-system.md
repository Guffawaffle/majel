# ADR-019 — User System, RBAC & Data Isolation

**Status:** Proposed (Revision 2)  
**Date:** 2026-02-10  
**Supersedes:** Portions of ADR-018 Phase 2 (invite-only auth model)  
**References:** OWASP Authentication Cheat Sheet, OWASP Password Storage Cheat Sheet, NIST SP800-63B

---

## Context

Majel launched with an **anonymous tenant model** (ADR-018 Phase 2): an admin distributes invite codes, visitors redeem them for an opaque cookie, and all visitors share a single pool of data. There are no user accounts, no sign-in, no roles, and no data isolation. The admin is a single shared bearer token stored in an environment variable.

This was fine for invite-controlled alpha. It is not viable for:

1. **Multiple users managing their own fleets** — today, all docks/overlays/sessions/settings are global. User A's loadouts pollute User B's view.
2. **Graduated permissions** — we need chat access restricted to paying/approved users without giving them admin power.
3. **Accountability** — there's no audit trail linking actions to identities.
4. **Security posture** — the current admin token uses plain-text comparison (timing-attack vulnerable), invite codes are stored unhashed, and there's no rate limiting on auth endpoints.

This ADR plans a proper user system with modern security practices, GDPR-first data handling, token-based usage metering, a public landing page, and an interactive demo mode.

---

## Design Decisions (Resolved)

These questions were discussed and resolved before implementation:

| # | Question | Resolution |
|---|----------|-----------|
| 1 | Email service | **Gmail API** — already on GCP, simplest integration |
| 2 | Unverified email access? | **No.** Email must be verified before any access, including Ensign-level catalog. Looks more proper, prevents garbage sign-ups. |
| 3 | Lieutenant tier specifics | **10 chats/day + 50k token cap.** Overlays + fleet read. See D3. |
| 4 | Self-service promotion? | **Admin-only.** All promotions via backend CLI (`npm run promote`) or Admiral dashboard. "Coming soon" messaging if surfaced in UI. |
| 5 | Account deletion / GDPR | **Full GDPR compliance.** Right to deletion, data export, minimal collection, privacy-by-design. See D11. |

---

## Decision

### D1 — Role Hierarchy (Starfleet Ranks)

Four roles, strictly ordered. Higher roles inherit all permissions of lower roles.

```
┌──────────────────────────────────────────────────────────────┐
│  ROLE HIERARCHY                                              │
│                                                              │
│  Admiral  ★★★★  Full system access + user management         │
│  Captain  ★★★   High token cap, fleet management, chat      │
│  Lieutenant ★★  Limited chat (10/day), overlays, fleet read  │
│  Ensign   ★     Read-only catalog, own profile               │
└──────────────────────────────────────────────────────────────┘
```

| Role | Catalog | Profile | Fleet | Overlays | Chat | Daily Token Cap | User Mgmt | Admin |
|------|---------|---------|-------|----------|------|-----------------|-----------|-------|
| **Ensign** | Read | Edit | — | — | — | 0 | — | — |
| **Lieutenant** | Read | Edit | Read | R/W | 10 msgs/day | 50k tokens | — | — |
| **Captain** | Read | Edit | R/W | R/W | Unlimited msgs | 500k tokens | — | — |
| **Admiral** | R/W + Sync | Edit | R/W | R/W | Unlimited | Unlimited | Yes | Yes |

- **Ensign** = any newly registered user (post email-verification). Can browse the reference catalog and manage their profile. Cannot chat, create overlays, or manage fleet. Must be promoted by an Admiral to gain further access.
- **Lieutenant** = entry-level active tier. Gets overlay access (track which officers/ships they own, set targets), read-only fleet visibility, and **limited chat**: 10 messages per day OR 50k tokens (whichever hits first). Good for casual users.
- **Captain** = power user tier. Full fleet management (drydock loadouts, crew presets), unlimited chat messages, 500k daily token cap. Reserved for trusted/paying users — **Admiral-promoted only** (no self-service, "Coming Soon" in UI).
- **Admiral** = you + designated admins. Full system access: user management, wiki sync, diagnostics, demo data management, unlimited everything.

**Promotions are backend-controlled only.** The first Admiral is created via `npm run promote` (direct DB update). Subsequent promotions can be done via the Admiral dashboard (Phase 5) or CLI. No self-service tier upgrades. No hardcoded admin UUIDs in source code.

### D2 — User Accounts

Replace anonymous tenants with real user accounts.

```sql
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT,            -- NULL for OAuth-only accounts
    role            TEXT NOT NULL DEFAULT 'ensign'
                    CHECK (role IN ('ensign', 'lieutenant', 'captain', 'admiral')),
    locked_at       TIMESTAMPTZ,     -- non-NULL = account locked
    lock_reason     TEXT,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive email uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
```

**Key decisions:**
- `id` is UUIDv4 (prevents enumeration).
- `email` is the login identifier. **Must be verified before any access.** Unverified accounts exist in the DB but cannot create sessions.
- `password_hash` stores an Argon2id hash (see D5). NULL when created via future OAuth.
- `role` column with CHECK constraint — no separate roles/permissions table (YAGNI for 4 fixed roles).
- `locked_at` enables account lockout after brute-force attempts.

### D3 — Token Usage Metering

Track Gemini API token consumption per user per day. The `@google/generative-ai` SDK returns `usageMetadata` on every response with `promptTokenCount`, `candidatesTokenCount`, and `totalTokenCount`.

```sql
CREATE TABLE IF NOT EXISTS token_usage (
    id            SERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    TEXT,                -- chat session that generated usage
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens  INTEGER NOT NULL,
    model         TEXT NOT NULL,       -- e.g. "gemini-2.5-flash-lite"
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_day
    ON token_usage (user_id, (created_at::DATE));
```

**Usage tracking flow:**
1. After each `sendMessage()` call, extract `result.response.usageMetadata`
2. Insert a `token_usage` row with user_id, token counts, model
3. Before each chat request, check daily aggregate:
   ```sql
   SELECT COALESCE(SUM(total_tokens), 0) AS daily_total,
          COUNT(*) AS message_count
   FROM token_usage
   WHERE user_id = $1 AND created_at::DATE = CURRENT_DATE
   ```
4. If `daily_total >= role_cap` OR `message_count >= role_message_cap`, reject with 429:
   `"Daily limit reached. Your limit resets at midnight UTC."`

**Per-role daily caps:**

| Role | Daily Token Cap | Daily Message Cap | Notes |
|------|----------------|-------------------|-------|
| Ensign | 0 | 0 | No chat access |
| Lieutenant | 50,000 | 10 | Whichever limit hits first |
| Captain | 500,000 | Unlimited | ~200-300 conversations/day |
| Admiral | Unlimited | Unlimited | — |

**Why both token AND message caps for Lieutenant?** Token caps alone are opaque to users ("I used 47,231 tokens" means nothing). The 10-message cap is user-visible and understandable. Tokens are the safety backstop — a single prompt-injected message requesting a huge response can't blow our Gemini bill.

**Future enhancement:** Dashboard showing "You've used X of Y tokens today" and historical usage charts.

### D4 — Session Management

Replace the current `tenant_sessions` table with proper user sessions.

```sql
CREATE TABLE IF NOT EXISTS user_sessions (
    id           TEXT PRIMARY KEY,    -- crypto random 32-byte hex token
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address   INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at);
```

**Session design:**
- **Opaque tokens, not JWTs.** Simpler, instantly revocable (delete the row), don't leak claims client-side.
- **32 bytes of `crypto.randomBytes`** = 256 bits of entropy.
- **HttpOnly + SameSite=Strict + Secure cookies** — same existing pattern.
- **30-day expiry.** `last_seen_at` touched on each request.
- **Multiple concurrent sessions allowed** (phone + desktop).
- **Session invalidation:** Logout deletes the row. Password change kills all other sessions. Admiral can kill any session.
- **Verified email required:** Session creation blocked for `email_verified = false`.

### D5 — Password Security (OWASP Compliant)

**Algorithm: Argon2id** — winner of the 2015 Password Hashing Competition.

```
Configuration:
  memory:      19 MiB (m=19456)
  iterations:  2 (t=2)
  parallelism: 1 (p=1)
  hash length: 32 bytes
  salt length: 16 bytes (auto-generated)
```

**Library: `argon2` (npm)** — C binding, handles salt generation and output formatting.

**Password policy (NIST SP800-63B + OWASP):**
- Minimum 15 characters (no MFA at launch)
- Maximum 128 characters
- No composition rules (no forced uppercase/numbers/symbols)
- No periodic rotation
- Check against NCSC top 100k breached passwords (bundled, not API)
- Unicode and whitespace allowed

**Brute-force protection:**
- **Account lockout:** 5 failures → 15-min lock, exponential backoff
- **Rate limiting:** Auth endpoints: 10 req/min per IP
- **Timing-safe comparison:** `crypto.timingSafeEqual` for all token/hash comparisons
- **Generic error messages:** "Invalid email or password" — never reveals which field
- **Constant-time login:** Always hash input even when user doesn't exist

### D6 — Data Isolation (Per-User Tenancy)

**Strategy: `user_id` column + PostgreSQL Row-Level Security (RLS)**

Every user-specific table gets a `user_id UUID` column. RLS policies enforce isolation at the DB level — even a SQL injection can't cross user boundaries.

**Tables requiring `user_id`:**

| Table | Migration |
|-------|-----------|
| `sessions` (chat) | Add `user_id`, backfill as needed |
| `messages` | Inherits from sessions cascade |
| `settings` | Split: system settings (global) vs user preferences (per-user) |
| `officer_overlay` | Add `user_id`, change PK to `(user_id, ref_id)` |
| `ship_overlay` | Add `user_id`, change PK to `(user_id, ref_id)` |
| `drydock_loadouts` | Add `user_id`, change PK to `(user_id, dock_number)` |
| `dock_intents`, `dock_ships`, `crew_presets`, etc. | Follow FK cascades |

**Tables staying global (correct):**

| Table | Reason |
|-------|--------|
| `reference_officers`, `reference_ships` | Shared read-only catalog |
| `intent_catalog` | Shared intent definitions |
| `behavior_rules` | System-wide Bayesian priors |
| `invite_codes` | Admin feature |

**RLS policy pattern:**
```sql
ALTER TABLE officer_overlay ENABLE ROW LEVEL SECURITY;
CREATE POLICY officer_overlay_isolation ON officer_overlay
    USING (user_id = current_setting('app.current_user_id')::UUID);
```

Each request's middleware sets `SET LOCAL app.current_user_id = '<uuid>'` inside `withTransaction()`. RLS automatically filters all queries. We **also** add explicit `WHERE user_id = $1` in queries (belt-and-suspenders).

### D7 — Auth Endpoints

```
── Sign Up (Public) ─────────────────────────────────────────
POST /api/auth/signup
  Body: { email, password, displayName }
  → Validates input, checks breached passwords
  → Creates user (role: ensign, email_verified: false)
  → Sends verification email via Gmail API
  → Returns: 201 { message: "Verification email sent" }

POST /api/auth/verify-email
  Body: { token }
  → Sets email_verified = true
  → Returns: 200 { verified: true }

── Sign In ──────────────────────────────────────────────────
POST /api/auth/signin
  Body: { email, password }
  → Validates credentials (constant-time)
  → Rejects if not email_verified or locked
  → Creates session, sets HttpOnly cookie
  → Returns: 200 { user: { id, displayName, role } }

── Session ──────────────────────────────────────────────────
GET  /api/auth/me           → Current user + role + daily usage
POST /api/auth/logout       → Destroys current session
POST /api/auth/logout-all   → Destroys all user sessions

── Password ─────────────────────────────────────────────────
POST /api/auth/change-password
  Body: { currentPassword, newPassword }
  → Kills all other sessions after change

POST /api/auth/forgot-password
  Body: { email }
  → Always returns 200 (prevents enumeration)

POST /api/auth/reset-password
  Body: { token, newPassword }
  → One-time use, 1-hour expiry

── Invite Codes (kept — now "promotion codes") ──────────────
POST /api/auth/redeem
  Body: { code }
  → Promotes current user's role (per invite code config)
  → Requires active session (must be signed in)
```

### D8 — Middleware Refactor

Replace two-tier middleware with role-based system:

```typescript
function requireRole(minRole: Role): RequestHandler {
  return async (req, res, next) => {
    const session = await resolveSession(req);
    if (!session) return sendFail(res, 'UNAUTHORIZED', 401);

    const user = await getUser(session.userId);
    if (!user) return sendFail(res, 'UNAUTHORIZED', 401);
    if (!user.emailVerified) return sendFail(res, 'EMAIL_NOT_VERIFIED', 403);
    if (user.lockedAt) return sendFail(res, 'ACCOUNT_LOCKED', 403);
    if (roleLevel(user.role) < roleLevel(minRole)) {
      return sendFail(res, 'INSUFFICIENT_RANK', 403);
    }

    // Set transaction-scoped user context
    res.locals.userId = user.id;
    res.locals.userRole = user.role;
    next();
  };
}
```

**Route mapping:**
```
Public (no auth):     /api/health, /api (discovery), /api/catalog/officers,
                      /api/catalog/ships, /api/auth/*,
                      Landing page (/, /demo, /login, /signup)

requireRole('ensign'):      /api/auth/me, /api/auth/logout
requireRole('lieutenant'):  /api/overlay/*, /api/fleet/* (read),
                            /api/chat (with daily cap enforcement)
requireRole('captain'):     /api/docks/*, /api/chat (with token cap),
                            /api/sessions/*
requireRole('admiral'):     /api/admin/*, /api/catalog/sync,
                            /api/diagnostic/*, /api/demo/*
```

**Backward compatibility:** `MAJEL_ADMIN_TOKEN` bearer token continues to work as a bootstrap Admiral session during initial setup. The virtual Admiral's `userId` is derived via `HMAC-SHA256(adminToken, "majel-admin")` — unique per deployment, not guessable from source code. Once a real Admiral user exists, the token can be retired.

### D9 — Email Delivery (Gmail API)

**Service: Gmail API** — already on GCP, no additional vendor, no egress costs.

**Setup:**
1. Enable Gmail API in `smartergpt-majel` project
2. Create a service account with Gmail send delegation, OR use domain-wide delegation with a `noreply@smartergpt.dev` sender address
3. Store credentials in Secret Manager (existing pattern)

**Development mode:** No emails sent. Verification tokens logged to console. `GET /api/auth/dev-verify?email=x` endpoint available in non-production environments.

**Email templates (plain text + HTML):**
1. **Email verification** — "Welcome to Ariadne! Verify your email: [link]"
2. **Password reset** — "Reset your password: [link] (expires in 1 hour)"
3. **Account locked** — "Your account has been locked due to failed login attempts"
4. **Role change** — "Your rank has been updated to [Captain/Lieutenant]"
5. **Account deletion confirmation** — "Your account and all data have been deleted"

### D10 — Landing Page & Demo Mode

The current SPA (`src/client/index.html`) loads directly into the full app UI with sidebar navigation (Chat, Drydock, Catalog, Fleet, Diagnostics). We need a public-facing landing page and a sandboxed demo.

**Landing page (`/`):**
```
┌────────────────────────────────────────────────────┐
│  ⟐ ARIADNE                                        │
│  STFC Fleet Intelligence                           │
│                                                    │
│  [Hero copy: what Ariadne does, why it's useful]   │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Try Demo │  │  Log In  │  │ Sign Up  │        │
│  └──────────┘  └──────────┘  └──────────┘        │
│                                                    │
│  Features: Catalog • Fleet Mgmt • AI Advisor       │
│  ─────────────────────────────────────             │
│  Footer: GitHub • Privacy Policy • Terms           │
└────────────────────────────────────────────────────┘
```

**Route structure:**
- `/` — Landing page (public, no auth)
- `/demo` — Demo mode (public, sandboxed)
- `/login` — Sign-in form
- `/signup` — Sign-up form
- `/app` — Authenticated SPA (existing UI, behind auth)
- `/app/*` — SPA fallback for authenticated routes

**Demo mode (`/demo`):**

A sandboxed instance of the full SPA with **curated sample data**. Purpose: let visitors explore the interface without signing up.

Demo data lives in a special "demo tenant" namespace:
- **Demo user:** A real row in the `users` table with a randomly generated UUID (created by `POST /api/demo/seed`). **No hardcoded UUIDs** — the demo user ID is stored in a `settings` row (`demo.userId`) and looked up at runtime.
- **Demo data:** Pre-populated officers, ships, overlays, drydock loadouts — **managed by Admirals** via `/api/demo/*` endpoints.
- **Chat in demo:** Returns canned responses (no Gemini API calls) or uses a tiny token budget (1k tokens) for a "try it" taste.
- **No write persistence:** Demo visitors see demo data but cannot permanently modify it. Writes are session-scoped (gone on leave).

**Admiral demo management endpoints:**
```
GET    /api/demo/config        → Current demo state
PUT    /api/demo/config        → Update demo config (canned chat, feature flags)
POST   /api/demo/seed          → Reset demo data to a snapshot
PUT    /api/demo/overlays      → Set which officers/ships are "owned" in demo
PUT    /api/demo/docks         → Set demo drydock loadouts
DELETE /api/demo/reset         → Wipe and re-seed demo data
```

This lets you curate exactly what visitors see — show off a nicely configured fleet with interesting loadouts and good officer assignments.

### D11 — GDPR & Privacy-by-Design

Full GDPR compliance as a baseline. Zero interest in collecting or monetizing user data — only functional use of data for the system they're interacting with.

**Principles:**
1. **Data minimization** — collect only what's functionally needed (email, display name, fleet data). No tracking pixels, no analytics cookies, no third-party scripts.
2. **Purpose limitation** — data used only for fleet management and AI advisor. Never shared with third parties.
3. **Right to access** — users can export all their data.
4. **Right to erasure** — users can delete their account and all associated data.
5. **Right to portability** — data export in machine-readable JSON.
6. **Privacy by default** — all privacy-protective settings are the default. No dark patterns.

**Deletion implementation:**
```sql
-- DELETE FROM users WHERE id = $1 triggers:
--   → user_sessions (CASCADE)
--   → token_usage (CASCADE)
--   → sessions + messages (CASCADE)
--   → officer_overlay, ship_overlay (CASCADE)
--   → drydock_loadouts → dock_intents, dock_ships, crew_presets, etc. (CASCADE)
--   → user_settings (CASCADE)
-- One DELETE, everything gone. No orphans.
```

**Endpoints:**
```
GET    /api/account/export     → Download all user data as JSON
DELETE /api/account            → Delete account + all data
  Body: { password }          (re-authenticate to confirm)
  → Sends confirmation email
  → CASCADE deletes all user data
  → Clears session cookie
  → Returns: 200 { deleted: true }
```

**Data export format:**
```json
{
  "user": { "email": "...", "displayName": "...", "role": "...", "createdAt": "..." },
  "overlays": { "officers": [...], "ships": [...] },
  "docks": [...],
  "chatHistory": [...],
  "settings": {...},
  "tokenUsage": { "total": 12345, "daily": [...] },
  "exportedAt": "2026-02-10T..."
}
```

**What we DON'T store:**
- No IP-based geolocation
- No device fingerprinting
- No third-party analytics (no Google Analytics, no Mixpanel)
- No advertising identifiers
- Session IP/UA stored for security audit only, auto-purged with session expiry

**Privacy policy and Terms of Service:** Linked from landing page footer. Plain-language. Short enough to actually read.

### D12 — Google OAuth (Future)

Designed for but not built yet. `users.password_hash` is nullable — OAuth-only accounts work.

Future table:
```sql
CREATE TABLE IF NOT EXISTS user_oauth_providers (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,  -- 'google'
    provider_id TEXT NOT NULL,  -- Google sub claim
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, provider_id)
);
```

Requires Google OAuth consent screen verification (weeks). Email/password first.

### D13 — Lex DB Access for Admins

Lex memory data lives in a separate PG schema:

```sql
CREATE SCHEMA IF NOT EXISTS lex;
```

Only Admiral-role users can query via diagnostic endpoints. Clean boundary from `public` schema. Phase 8 concern.

---

## Phase Plan

### Phase 1 — Foundation: User Accounts, Auth & Landing Page

| # | Task | Scope |
|---|------|-------|
| 1.1 | `users` table + `user-store.ts` | New store |
| 1.2 | `user_sessions` table, session management | New store |
| 1.3 | Argon2id password module (`password.ts`) | New module |
| 1.4 | Sign-up / sign-in / logout endpoints | New routes |
| 1.5 | Email verification (Gmail API prod, console dev) | New `email.ts` |
| 1.6 | `requireRole()` middleware + role constants | Refactor `auth.ts` |
| 1.7 | Fix timing-safe comparison (existing bug) | `auth.ts` |
| 1.8 | Auth rate limiting (10 req/min per IP) | New middleware |
| 1.9 | Landing page (/, /login, /signup, /demo links) | New `landing.html` |
| 1.10 | Route split: `/` = landing, `/app` = authenticated SPA | `index.ts` |
| 1.11 | HMAC-derived userId for `MAJEL_ADMIN_TOKEN` (no hardcoded UUIDs) | `auth.ts` |
| 1.12 | `scripts/promote.ts` CLI for backend role promotion | New script |
| 1.13 | Tests for all auth flows | New test files |

**Estimated scope:** ~1200-1800 lines new code + tests.

### Phase 2 — Data Isolation

| # | Task | Scope |
|---|------|-------|
| 2.1 | Add `user_id` to all tenant tables | Migration SQL |
| 2.2 | Update all store queries to filter by `user_id` | 5 stores |
| 2.3 | Route handlers pass `userId` from middleware | All routes |
| 2.4 | PG Row-Level Security policies | Migration SQL |
| 2.5 | `app.current_user_id` session variable in transactions | `db.ts` |
| 2.6 | Migrate existing data to admin user | One-time migration |
| 2.7 | Isolation tests (user A ≠ user B) | New tests |

**Estimated scope:** ~600-900 lines of changes across many files.

### Phase 3 — Token Metering & Usage Tracking

| # | Task | Scope |
|---|------|-------|
| 3.1 | `token_usage` table + store | New store |
| 3.2 | Extract `usageMetadata` from Gemini responses | `gemini.ts` |
| 3.3 | Per-request token recording in chat route | `routes/chat.ts` |
| 3.4 | Daily cap enforcement middleware | New middleware |
| 3.5 | `GET /api/auth/me` includes daily usage stats | Route update |
| 3.6 | 429 responses with friendly limit messages | Envelope |

**Estimated scope:** ~400-600 lines.

### Phase 4 — Security Hardening

| # | Task | Scope |
|---|------|-------|
| 4.1 | NCSC breached password check (bundled 100k list) | `password.ts` |
| 4.2 | Account lockout with exponential backoff | `user-store.ts` |
| 4.3 | Password reset flow (forgot + reset) | Routes + email |
| 4.4 | CSRF token for cookie-based mutations | Middleware |
| 4.5 | Security headers (CSP, X-Frame-Options, HSTS) | Middleware |
| 4.6 | Auth event audit logging | Logger |

### Phase 5 — Demo Mode & Admiral Dashboard

| # | Task | Scope |
|---|------|-------|
| 5.1 | Demo virtual user + sandboxed data | Store + routes |
| 5.2 | Admiral demo management endpoints | New routes |
| 5.3 | Demo canned chat responses | `gemini.ts` |
| 5.4 | Admiral user management panel (list, promote, demote, lock) | Routes + UI |
| 5.5 | Invite codes → promotion codes refactor | `invite-store.ts` |

### Phase 6 — GDPR & Account Management

| # | Task | Scope |
|---|------|-------|
| 6.1 | `GET /api/account/export` — full data export (JSON) | New route |
| 6.2 | `DELETE /api/account` — CASCADE account deletion | New route |
| 6.3 | Privacy policy page | Static HTML |
| 6.4 | Terms of service page | Static HTML |
| 6.5 | Data retention policy (auto-purge expired sessions) | Cron |

### Phase 7 — Google OAuth

| # | Task | Scope |
|---|------|-------|
| 7.1 | GCP OAuth consent screen + credentials | GCP config |
| 7.2 | `user_oauth_providers` table | Migration |
| 7.3 | OAuth flow endpoints (authorize, callback) | New routes |
| 7.4 | Account linking (connect Google to existing account) | Route |

### Phase 8 — Lex Integration

| # | Task | Scope |
|---|------|-------|
| 8.1 | `lex` PG schema creation | Migration |
| 8.2 | Lex memory read endpoints for Admirals | New routes |
| 8.3 | Lex memory integration with user context | `memory.ts` |

---

## Security Threat Model

| Threat | Mitigation |
|--------|-----------|
| **SQL injection** | Parameterized queries everywhere (existing), PG RLS defense-in-depth |
| **Credential stuffing** | Rate limiting (10/min per IP), account lockout, breached password check |
| **Timing attacks** | `crypto.timingSafeEqual` for all comparisons, constant-time login |
| **Session hijacking** | HttpOnly + SameSite=Strict + Secure cookies |
| **User enumeration** | Generic errors, constant-time responses, no email existence disclosure |
| **Password cracking** | Argon2id with 19 MiB memory cost — GPU-resistant |
| **CSRF** | SameSite=Strict (Phase 1), explicit CSRF tokens (Phase 4) |
| **Privilege escalation** | Server-side role checks, role in DB not cookie/JWT, no hardcoded admin UUIDs in source |
| **Cross-user data leak** | `user_id` WHERE clauses + PG RLS (belt and suspenders) |
| **Token budget abuse** | Per-role daily caps, both message count AND token count limits |
| **Demo data pollution** | Demo writes are no-ops or session-scoped, Admirals control seed data |
| **Brute-force invite codes** | Invite codes now promotion codes (require auth first), rate limiting |

---

## Dependencies

| Dependency | Purpose | Size |
|-----------|---------|------|
| `argon2` | Password hashing (Argon2id) | ~2 MB (C native) |
| `express-rate-limit` | Per-IP rate limiting | ~50 KB |
| `googleapis` (gmail) | Email delivery via Gmail API | Already in GCP SDK |

**Explicitly NOT using:**
- **Passport.js** — heavyweight for 4 fixed roles + email/password
- **JWT** — unnecessary complexity, opaque sessions are simpler and revocable
- **bcrypt** — Argon2id is strictly superior (GPU-resistant, no 72-byte limit)
- **Auth0 / Firebase Auth** — vendor dependency, egress costs, latency
- **Google Analytics** — conflicts with privacy-by-design principle

---

## Migration Strategy

**Clean slate:** Production has 0 users, 0 tenant sessions. No existing user data to migrate.

**Admin token transition:** `MAJEL_ADMIN_TOKEN` stays as a bootstrap mechanism. The virtual Admiral identity is derived via `HMAC-SHA256(adminToken, "majel-admin")` truncated to UUID format — unique per deployment, never appears in source code, and cannot be guessed even if someone reads the codebase on GitHub.

**Bootstrap flow for first Admiral:**
```bash
# 1. Sign up (you're an Ensign)
curl -X POST https://aria.smartergpt.dev/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@email.com","password":"...","displayName":"Admiral"}'

# 2. Verify email (dev mode: /api/auth/dev-verify?email=you@email.com)
# 3. Promote to Admiral via CLI
npm run promote -- --email you@email.com --role admiral

# 4. Optionally: unset MAJEL_ADMIN_TOKEN in production
```

**No hardcoded UUIDs anywhere.** The demo user ID, admin virtual user ID, and all other identities are either:
- HMAC-derived from deployment-specific secrets (admin token → virtual Admiral)
- Randomly generated and stored in DB (demo user, real users)

**Invite codes:** Kept. Transformed from "access codes" → "promotion codes" (promote existing authenticated users to specified roles).

**Dockerfile update:** Add `build-essential` to build stage for `argon2` native compilation. Already using multi-stage build so prod image stays slim.

---

## Consequences

### Positive
- Real user identity with accountability and audit trails
- Per-user data isolation (finally — the multi-tenancy goal from ADR-018)
- Modern password security (Argon2id, per OWASP 2025)
- Token metering prevents runaway Gemini costs and enables future monetization
- GDPR-first design builds trust and avoids future compliance scrambles
- Landing page + demo creates a proper public-facing product
- Admiral-controlled demo lets you curate what visitors see
- OAuth-ready schema (nullable password_hash, future provider table)
- PG RLS defense-in-depth — SQL injection can't cross user boundaries

### Negative
- **Large migration scope** — every store needs `user_id` awareness
- **Native dependency** — `argon2` requires C compiler in Docker build stage
- **Email delivery dependency** — Gmail API setup, DKIM/SPF/DMARC for deliverability
- **Complexity increase** — auth is the #1 attack vector, rolling our own has risk
- **Argon2 memory cost** — 19 MiB per hash × concurrent logins on Cloud Run

### Risks & Mitigations
- **Email in spam** → Gmail API with proper DKIM/SPF/DMARC on `smartergpt.dev`
- **Argon2 memory pressure** → Rate limiting caps concurrent auth; scale Cloud Run memory if needed
- **Rolling our own auth** → Follow OWASP to the letter, comprehensive tests, don't invent crypto
- **Token counting accuracy** → Gemini SDK provides exact counts; we just record them
