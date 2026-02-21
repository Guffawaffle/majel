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
