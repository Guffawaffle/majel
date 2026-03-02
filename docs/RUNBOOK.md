# Majel Operations Runbook

> GCP Cloud Logging queries, monitoring recipes, and incident response for the Majel auth system.

---

## Prerequisites

- GCP project: `smartergpt-majel`
- Cloud Run service: `majel` (region `us-central1`)
- All queries target the **Cloud Logging** Logs Explorer: <https://console.cloud.google.com/logs/query>

### Log structure

Majel uses **pino** structured logging. In production, all log lines are JSON written to stdout and automatically ingested by Cloud Logging into `jsonPayload`:

```json
{
  "severity": "INFO",
  "service": "majel",
  "subsystem": "auth",
  "component": "auth",
  "event": "auth.signin.success",
  "userId": "uuid",
  "ip": "1.2.3.4",
  "message": "audit: auth.signin.success",
  "time": "2025-01-15T12:00:00.000Z"
}
```

Key fields:
| Field | Description |
|-------|-------------|
| `severity` | GCP log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`) |
| `subsystem` | Majel subsystem (`auth`, `boot`, `gemini`, `fleet`, `http`, etc.) |
| `component` | Functional area (always `"auth"` for audit events) |
| `event` | Audit event type (see list below) |
| `userId` | Actor who triggered the event |
| `targetId` | User affected by the event (for admin actions) |
| `ip` | Client IP address |
| `detail` | Additional event-specific JSONB data |

### Audit event types

| Event | Category | Description |
|-------|----------|-------------|
| `auth.signup` | Auth | New user registration |
| `auth.signin.success` | Auth | Successful sign-in |
| `auth.signin.failure` | Auth | Failed sign-in attempt |
| `auth.logout` | Auth | Single session logout |
| `auth.logout_all` | Auth | All sessions destroyed |
| `auth.verify_email` | Auth | Email verification completed |
| `auth.password.change` | Password | Password changed |
| `auth.password.reset_request` | Password | Password reset requested |
| `auth.password.reset_complete` | Password | Password reset completed |
| `admin.role_change` | Admin | User role modified |
| `admin.bootstrap` | Admin | Bearer token used in bootstrap mode |
| `admin.lock_user` | Admin | User account locked |
| `admin.unlock_user` | Admin | User account unlocked |
| `admin.delete_user` | Admin | User account deleted |
| `auth.invite.redeem` | Legacy | Invite code redeemed |
| `auth.session.expired_cleanup` | Auth | Expired sessions garbage-collected |

---

## Cloud Logging Query Recipes

### 1. Failed sign-ins in the last hour

Detects brute-force or credential-stuffing attempts.

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="auth.signin.failure"
timestamp >= "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"
```

**Logs Explorer filter (paste directly):**
```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="auth"
jsonPayload.event="auth.signin.failure"
```
Then set the time range to "Last 1 hour" in the UI.

### 2. Role changes in the last 24 hours

Track privilege escalation and administrative role assignments.

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="admin.role_change"
```
Set time range to "Last 24 hours".

To see who was promoted to Admiral specifically:
```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="admin.role_change"
jsonPayload.detail.newRole="admiral"
```

### 3. Admin token usage (bootstrap mode)

During the Phase B transition, the Bearer admin token only works when no Admiral user exists yet (bootstrap mode). Monitor for any token usage:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="auth"
("Bearer token" OR "bootstrap")
```

After the first Admiral is created, any Bearer token attempt should fail. If you see successful Bearer auth post-bootstrap, investigate immediately.

### 4. Rate limit hits

Detects clients hitting rate limits (auth endpoints are rate-limited to prevent brute-force):

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
severity="WARNING"
jsonPayload.event="rate_limit.hit"
```

### 5. All auth events for a specific user

Replace `TARGET_USER_ID` with the UUID:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="auth"
(jsonPayload.userId="TARGET_USER_ID" OR jsonPayload.targetId="TARGET_USER_ID")
```

### 6. Account lockouts

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="admin.lock_user"
```

### 7. All admin actions

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event=~"^admin\."
```

### 8. Audit write failures

If the audit store fails to write (DB issues), errors are still logged:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
severity="ERROR"
jsonPayload.subsystem="auth"
"audit log write failed"
```

### 9. Password reset abuse (W18)

Detects bulk password reset requests (potential enumeration or abuse):

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="auth.password.reset_request"
```

Group by IP to find bulk senders. >10 requests per hour from one IP is suspicious.

### 10. Signup spikes (W18)

Monitor for registration spam or coordinated account creation:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.event="auth.signup"
```

Set time range to "Last 1 hour" and group by `jsonPayload.ip`.

### 11. 5xx server errors (W18)

Track internal server errors across all subsystems:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
severity="ERROR"
httpRequest.status>=500
```

Or via application-level errors:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
severity=("ERROR" OR "CRITICAL")
```

### 12. Boot events and startup failures (W18)

Track server startup and any fatal boot errors:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="boot"
```

Filter to only failures:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="boot"
severity=("ERROR" OR "CRITICAL")
```

### 13. IP allowlist blocks (W18)

Monitor requests blocked by the IP allowlist:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
severity="WARNING"
jsonPayload.subsystem="http"
"Blocked by IP allowlist"
```

---

## Cloud Monitoring Alerts

### Alert: >10 failed logins per hour

**Setup via GCP Console → Monitoring → Alerting → Create Policy:**

1. **Metric:** Log-based metric
   - Go to **Logging → Log-based Metrics → Create Metric**
   - Name: `auth_signin_failures`
   - Filter:
     ```
     resource.type="cloud_run_revision"
     resource.labels.service_name="majel"
     jsonPayload.event="auth.signin.failure"
     ```
   - Type: Counter

2. **Alert condition:**
   - Resource type: Cloud Run Revision
   - Metric: `logging.googleapis.com/user/auth_signin_failures`
   - Condition: `> 10` over 1-hour rolling window
   - Aggregation: Sum

3. **Notification:**
   - Email, Slack, or PagerDuty channel as configured

### Alert: Any admin.delete_user event

1. **Metric:** Log-based metric `admin_user_deletions` with filter:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="majel"
   jsonPayload.event="admin.delete_user"
   ```

2. **Condition:** `> 0` over 1-minute window

---

## Incident Response

### Suspected brute-force attack

1. Run query #1 (failed sign-ins) to identify the source IP
2. Group by IP: add `jsonPayload.ip` as a label in the log-based metric
3. If a single IP has >50 failures, add it to the IP blocklist:
   ```bash
   # In .env or Secret Manager:
   MAJEL_ALLOWED_IPS=<your-ip>  # Restrict to known IPs only
   ```
4. Redeploy or restart the Cloud Run service

### Unauthorized role escalation

1. Run query #2 (role changes) to find the event
2. Check `jsonPayload.userId` (who did it) and `jsonPayload.targetId` (who was promoted)
3. If unauthorized, immediately:
   ```sql
   -- Connect to Cloud SQL
   UPDATE users SET role = 'ensign', locked_at = NOW() WHERE id = '<target_user_id>';
   DELETE FROM user_sessions WHERE user_id = '<target_user_id>';
   ```
4. Review the audit trail for the actor's other actions

### Audit store write failures

1. Run query #8 (audit write failures)
2. Check Cloud SQL instance health in Console → SQL
3. Common causes: connection pool exhaustion, disk full, instance stopped
4. The auth system continues to function even when audit writes fail (fire-and-forget design)

---

## Incident Plan — Aria Could Not Update Officers

Use this playbook when a user confirms a mutation failed (for example: officer updates not applied).

### Trigger Conditions

- UI shows proposal apply failure (conflict/error), or
- User reports no officer state change after approval, or
- UI shows "Proposal args have been tampered with" / trust block / tool validation error.

### Evidence to Collect (first 60 seconds)

1. Ask for the **Trace (Admiral)** box content from the chat response (copy/paste JSON).
2. Capture timestamp (UTC), session ID, proposal ID (if present), and request ID (if present).
3. Confirm whether user clicked **Approve** and whether card moved to failure state.

Expected trace keys:

- `timestamp`
- `requestId`
- `sessionId`
- `userId`
- `proposalCount`
- `proposalIds`
- `error` (when request failed)

### Triage Flow

1. **Request failed before apply path**
   - Symptom: no proposal ID, trace contains `error`, API returned 500/429/etc.
   - Action: inspect chat route + Gemini/tool logs around `requestId`.

2. **Proposal existed but apply was rejected**
   - Symptom: `proposalIds` present, apply returned 409/404.
   - Action: inspect proposal status (`proposed|declined|expired|applied`) and reason.

3. **Apply succeeded but data appears unchanged**
   - Symptom: apply returned success + receipt, user sees no updated officers.
   - Action: inspect `sync_overlay` summary/receipt and verify overlay rows for that `user_id`.

### Cloud Logging Queries

Use Logs Explorer with service filter:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
```

#### Query A — by requestId (primary)

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.requestId="REQUEST_ID_HERE"
```

#### Query B — proposal apply failures

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="fleet"
"proposal apply failed"
```

#### Query C — tool-level mutation errors

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="gemini"
jsonPayload.event=~"tool:result:error|chat:empty-answer"
```

### Classification Matrix

- **`CONFLICT` + tampered** → canonicalization/hash mismatch or stale payload.
- **`CONFLICT` + blocked by trust settings** → policy block, not runtime failure.
- **`CONFLICT` + tool validation text** → bad input parse or unsupported entity mapping.
- **`NOT_FOUND` proposal/session** → expired proposal or wrong owner/session context.
- **`INTERNAL_ERROR`/`GEMINI_ERROR`** → backend/model execution failure.

### Immediate Operator Actions

1. Preserve the trace JSON in incident notes.
2. Save matching log snippets (requestId window ±2 min).
3. Record final class: `policy`, `input`, `state`, `backend`, or `unknown`.
4. If unknown, open follow-up with:
   - trace JSON
   - logs query results
   - proposal ID + receipt ID (if any)
   - user-visible symptom text

### Privacy Guardrail

Do not request or inspect another user's session transcript for debugging. Use trace payload + structured server logs + receipts only.

## Async Chat Run Queue (ADR-036 Day 4)

Use this section to diagnose durable async chat execution (`chat_runs` + SSE lifecycle events).

### Fast Triage Fields

- `runId`
- `traceId` (request ID when present, otherwise run ID fallback)
- `requestId` (when available)
- `sessionId`, `tabId`, `userId`
- terminal status: `failed|cancelled|timed_out`
- `errorCode` / `errorMessage` from `GET /api/chat/runs/:runId`

### Cloud Logging Queries (Async Queue)

#### Query D — claim loop failures

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="gemini"
jsonPayload.event="chat_run.claim_loop.error"
```

#### Query E — stale run recovery (watchdog/requeue)

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="gemini"
jsonPayload.event="chat_run.requeue_stale"
```

#### Query F — single run trace (recommended)

Replace `TRACE_ID_HERE` with `traceId` from API/UI:

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.traceId="TRACE_ID_HERE"
```

#### Query G — terminal worker failures

```
resource.type="cloud_run_revision"
resource.labels.service_name="majel"
jsonPayload.subsystem="gemini"
jsonPayload.event=~"chat_run.failed|chat_run.worker.failed"
```

### Operator Workflow

1. Start with `GET /api/chat/runs/:runId` and capture `status`, `traceId`, `errorCode`, `errorMessage`.
2. Run Query F by `traceId` to reconstruct full timeline.
3. If status is `timed_out`, check Query E for stale-run recovery spikes.
4. If status is `failed`, check Query G and verify upstream Gemini/tool errors.
5. If status is `cancelled`, confirm expected source (`queued` vs `running`) from cancellation events.

### Escalation Thresholds

- More than 5 `chat_run.claim_loop.error` events in 10 minutes.
- Repeated `chat_run.requeue_stale` events (possible worker starvation or lock churn).
- Multiple `timed_out` runs for same user/session in short window.

### CLI Triage Shortcut (Pricing-Aware)

Use the cloud CLI helper to gather a compact diagnostic bundle by ID:

```
npm run cloud:triage -- --run-id crun_...
npm run cloud:triage -- --trace-id <traceId> --minutes 120 --limit 300
npm run cloud:triage -- --request-id <requestId> --ax
npm run ax -- triage:bundle --run-id crun_...
```

Guardrails baked into command defaults:

- default window: 60 minutes (min 5, max 360)
- default limit: 200 rows (min 20, max 500)
- max rows are capped to avoid high-noise/high-read triage runs

Cost principle:

- Keep logs useful but compact; narrow first by `runId`/`traceId`/`requestId`.
- Widen time window and row limit only when first pass is inconclusive.
- Logging ingestion volume is the main driver of Cloud Logging cost; read/triage breadth also has operational overhead.
