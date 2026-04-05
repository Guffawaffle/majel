# ADR-048 — Per-Rank & Per-User Token Budgets

**Status:** Proposed  
**Date:** 2026-03-17  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect)  
**Program umbrella:** #235  
**Related:** #234 (Cost & Runaway Safety Audit), ADR-019 (API Envelope & Rate Limiting)

---

## Context

Majel uses Gemini (and optionally Claude) for chat, scan, and tool-calling
operations. Token usage is currently **logged** via `usageMetadata` on every
`sendMessage()` call but **not persisted** or enforced. Rate limiting is
request-count-only (20 req/min chat, 120 req/min global) and applies uniformly
regardless of user role.

This means:

1. A single captain can burn through the entire API budget with large
   multi-tool conversations.
2. There is no way for an admiral to allocate different spending
   limits to different users or ranks.
3. Token cost data evaporates when the process restarts — no historical
   visibility for cost attribution or trend analysis.

The existing RBAC model defines four ranks with ascending privilege:
`ensign → lieutenant → captain → admiral`. Token budgets should follow
the same hierarchy — higher ranks get higher default budgets, and
admirals can override per-user.

---

## Decision

### 1. Token Ledger Table

Persist token usage in a new `token_ledger` table, appended to on every
LLM API call (chat, scan, tool-call). Each row records the user, model,
operation type, and token counts (input + output).

```sql
CREATE TABLE IF NOT EXISTS token_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('chat','scan','tool_call')),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_token_ledger_user_period ON token_ledger (user_id, created_at);
```

Retention: 90 days (hooked into the existing hourly GC timer alongside
`operation_events` and `chat_runs`).

### 2. Budget Configuration

Two levels of budget configuration:

**Rank defaults** — stored in the `settings` table (admin-writable,
boot-loaded). One row per rank with a daily token cap:

| Rank | Default Daily Budget | Rationale |
|------|---------------------|-----------|
| ensign | 0 (no LLM access) | Read-only tier |
| lieutenant | 50 000 | Light chat usage |
| captain | 200 000 | Full fleet management |
| admiral | unlimited | System operators |

**Per-user overrides** — a new `token_budget_overrides` table lets
admirals set a custom daily cap for specific users, overriding
their rank default:

```sql
CREATE TABLE IF NOT EXISTS token_budget_overrides (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_limit INTEGER,          -- NULL = use rank default
  note        TEXT,             -- admin memo (e.g., "temporary boost for fleet merge")
  set_by      UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`daily_limit = NULL` means "use rank default". `daily_limit = -1` means
"unlimited" (same as admiral default).

### 3. Enforcement Point

A new `checkTokenBudget(userId, role)` function runs **before** each
LLM API call in the Gemini/Claude service layer. It:

1. Queries `token_ledger` for the user's total tokens consumed today.
2. Resolves the effective limit: per-user override → rank default → unlimited.
3. If consumed ≥ limit, throws a `TOKEN_BUDGET_EXCEEDED` error.
4. The chat/scan route catches this and returns a 429 with a clear message
   including remaining budget and reset time (midnight UTC).

This is a **pre-flight check**, not a mid-stream kill. Once a request
starts, it completes — the budget is checked before the first API call
in each request.

### 4. Recording

After each LLM call, the service layer appends a row to `token_ledger`
with the actual token counts from `usageMetadata`. This happens in the
same code path that currently logs token usage — minimal new wiring.

### 5. Admin Panel — Budget Management Tab

Add a "Budgets" tab to AdmiralView with:

- **Rank defaults table** — editable daily limits per rank.
- **Per-user overrides list** — searchable table showing users with
  custom budgets. Inline edit to set/clear override + note field.
- **Usage dashboard** — daily token consumption per user (bar chart
  or table), filterable by date range. Data sourced from `token_ledger`
  aggregation queries.

API endpoints under `/api/admiral/budgets`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/rank-defaults` | List current rank budget defaults |
| PUT | `/rank-defaults` | Update rank budget defaults |
| GET | `/overrides` | List all per-user overrides |
| PUT | `/overrides/:userId` | Set/clear a per-user override |
| GET | `/usage` | Aggregated token usage (filterable) |

All endpoints require admiral role.

### 6. User Visibility

Non-admiral users see their own budget status via:

- **Chat input area** — subtle indicator showing remaining daily budget
  (e.g., "42K tokens remaining"). Turns amber at 80%, red at 95%.
- **GET `/api/me/budget`** — returns `{ dailyLimit, consumed, remaining,
  resetsAt }` for the authenticated user.

---

## Phased Implementation

| Phase | Scope | Depends On |
|-------|-------|------------|
| A | Token ledger table + recording (append on every LLM call) | — |
| B | Budget config tables + rank defaults + enforcement pre-flight check | A |
| C | Admin panel — budget management tab + usage dashboard | B |
| D | Per-user overrides + user-facing budget indicator | C |

---

## Consequences

### Positive

- Cost attribution: know exactly who is consuming API budget.
- Tiered access: lieutenants get chat access without unlimited spend.
- Admin control: admirals can boost trusted users or throttle abuse.
- Visibility: both admins and users see budget status.

### Negative

- One additional DB query per LLM call (pre-flight check). Mitigated
  by the index on `(user_id, created_at)` — single-user daily
  aggregation is fast.
- Token ledger grows ~1 row per LLM call. 90-day retention keeps it
  bounded. At peak usage (100 calls/day × 10 users), ~90K rows max.

### Risks

- Budget check adds latency to chat response. Target: < 5ms via
  indexed aggregation query.
- Clock skew on daily reset could cause brief over/under-counting.
  Use UTC consistently and document the reset boundary.

---

## Alternatives Considered

1. **Sliding window (hourly/minute) budgets** — More complex to reason
   about and configure. Daily is intuitive for admins and aligns with
   billing cycles.

2. **Token budgets in application memory only** — Lost on restart,
   no historical cost attribution. Rejected.

3. **External cost management (GCP billing alerts)** — Too coarse.
   Doesn't differentiate by user or rank. Useful as a safety net
   but not a replacement for application-level control.
