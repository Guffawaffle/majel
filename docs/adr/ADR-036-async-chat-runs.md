# ADR-036: Async Chat Runs for Long-Running AI Workflows

**Status:** Accepted (implemented 2026-03)  
**Date:** 2026-03-02  
**Authors:** Guff, GitHub Copilot (GPT-5.3-Codex)  
**References:** ADR-004 (AX envelope), ADR-009 (logging), ADR-019 (user/privacy), ADR-026b (proposal/apply safety), ADR-027 (GenAI SDK), ADR-031 (Svelte migration), ADR-032 (cache), ADR-037 (realtime event streaming)

---

## Context

`POST /api/chat` currently performs end-to-end AI execution in one request/response cycle. This fails operationally for multi-minute workloads (tool chains, large multimodal prompts, upstream latency spikes):

- Route timeout triggers first (currently 60s), returning 504.
- Backend work can continue after timeout and later attempts to write another response.
- This creates noisy failures (`Cannot set headers after they are sent to the client`) and poor user experience.
- Raw timeout increases do not fix reliability under client disconnects, proxies, or browser tab churn.

We need a durable architecture for long-running chat operations that is resilient, observable, and privacy-preserving.

---

## Decision

Adopt an **asynchronous chat run model**:

1. `POST /api/chat` becomes a **submission endpoint** that validates input, creates a persisted run, and returns quickly.
2. Execution happens in a background processor that updates persisted run state.
3. UI reads progress via server-sent events (SSE) as the primary transport (`GET /api/chat/runs/:runId/events`), with polling/snapshot only as degraded fallback.
4. Final answer, proposals, and trace metadata are persisted on the run and replayable after refresh/reconnect.
5. Request timeouts remain short and deterministic; long runtime is managed by run lifecycle controls instead of open HTTP sockets.

---

## Architecture

### 1) API Contract

#### Submit
`POST /api/chat`

Request:

```json
{
  "message": "...",
  "sessionId": "...",
  "tabId": "client-tab-uuid",
  "image": { "data": "...", "mimeType": "image/png" },
  "idempotencyKey": "client-generated-uuid"
}
```

Response (`202 Accepted`):

```json
{
  "runId": "crun_01...",
  "status": "queued",
  "submittedAt": "2026-03-02T00:00:00.000Z"
}
```

Rules:
- Submission must not block on full AI completion.
- Reusing `idempotencyKey` for same user/session returns the existing run.
- If a duplicate key has mismatched payload, return `409 CONFLICT`.
- Every run binds to a routing identity tuple: `(runId, sessionId, tabId)`.

#### Status
`GET /api/chat/runs/:runId`

Response (`200 OK`):

```json
{
  "runId": "crun_01...",
  "sessionId": "session-abc",
  "tabId": "tab-uuid-123",
  "status": "running",
  "phase": "tool_execution",
  "progress": { "completedSteps": 2, "totalSteps": 5 },
  "answer": null,
  "proposals": [],
  "trace": {
    "requestId": "...",
    "startedAt": "...",
    "updatedAt": "...",
    "attempt": 1
  }
}
```

Final states include `answer` and `proposals`.

Note:
- This endpoint is authoritative snapshot state and degraded fallback.
- Realtime UX is delivered by SSE per ADR-037.

#### Cancel
`POST /api/chat/runs/:runId/cancel`

- Allowed while `queued` or `running`.
- Sets status `cancelled` and emits a cancellation signal to the worker.

#### Streaming (Phase 1)
`GET /api/chat/runs/:runId/events` (SSE)

- Emits structured events: `run.started`, `run.progress`, `run.proposal`, `run.completed`, `run.failed`.
- Every SSE payload includes `sessionId` and `tabId` so UI can route updates to the originating tab.

---

### 2) Lifecycle State Machine

States:

- `queued`
- `running`
- `waiting_input` (future: agent asks for clarification)
- `succeeded`
- `failed`
- `timed_out`
- `cancelled`

Transitions:
- `queued -> running`
- `running -> succeeded | failed | timed_out | cancelled | waiting_input`
- `waiting_input -> running | cancelled`

Invariants:
- Terminal states are immutable.
- At most one active worker claim per run.
- Every transition appends an auditable event row.

---

### 3) Persistence Model

Create `chat_runs` and `chat_run_events`.

```sql
CREATE TABLE chat_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_input','succeeded','failed','timed_out','cancelled')),
  phase TEXT,
  request_json JSONB NOT NULL,
  answer_text TEXT,
  proposals_json JSONB,
  trace_json JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, session_id, tab_id, idempotency_key)
);

CREATE TABLE chat_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_runs_user_created ON chat_runs(user_id, created_at DESC);
CREATE INDEX idx_chat_runs_status_created ON chat_runs(status, created_at);
CREATE INDEX idx_chat_run_events_run_created ON chat_run_events(run_id, created_at);
```

Retention:
- Keep run records for debugging/audit (e.g., 30 days default).
- Keep event payloads compact; avoid storing raw image blobs in event rows.

---

### 4) Worker Execution Model

Phase 1 (simple, low-risk):
- In-process background scheduler (`setInterval` claim loop).
- Worker claims `queued` runs with row-level lock (`FOR UPDATE SKIP LOCKED`).
- Single-run lease with heartbeat (`updated_at`) and stale-lease recovery.

Phase 2 (scale-out):
- External queue/worker runtime (Cloud Tasks / Pub/Sub / dedicated worker service).

Timeout model:
- **HTTP timeout**: short (e.g., 20–30s) for submission/status endpoints.
- **Run timeout**: long (e.g., 5–10 minutes), enforced by worker watchdog.
- No long-held frontend request is required for completion.

---

### 5) UX Contract

- User sends message and immediately sees `queued/running` state with live progress.
- Leaving and returning to the session rehydrates run status from backend.
- Events are routed by `(sessionId, tabId)` so results return to the exact originating chat tab.
- Final output appears when run reaches `succeeded`.
- On `failed`/`timed_out`, UI shows durable error details and run trace ID for support.
- Retry action creates a new run linked to previous run (`parentRunId`) for lineage.

---

### 6) Security & Privacy

- Run ownership is strictly user-scoped (same invariant as sessions in ADR-019).
- No cross-user run reads, including admiral role.
- Admiral trace visibility remains metadata-only and only for own runs.
- Stored payloads redact secrets and avoid raw credential material.

---

### 7) Observability & Ops

Emit structured logs with fields:
- `runId`, `requestId`, `userId`, `sessionId`, `status`, `phase`, `attempt`, `durationMs`.

Metrics:
- `chat_runs_submitted_total`
- `chat_runs_completed_total{status=...}`
- `chat_run_duration_ms`
- `chat_run_queue_latency_ms`
- `chat_run_timeout_total`

SLO target (initial):
- $P95$ end-to-end completion under 120s for non-image chat runs.

Incident triage:
- Support can search by `runId` and reconstruct timeline from `chat_run_events`.

---

## Alternatives Considered

### A) Increase route timeout to several minutes
- Pros: minimal code changes.
- Cons: fragile, poor resilience to disconnects, wastes resources, still risks double-send races.
- Rejected.

### B) Keep synchronous route and chunk partial text
- Pros: incremental UX improvement.
- Cons: still tied to fragile long-lived HTTP connection.
- Rejected as primary architecture.

### C) Full external queue immediately
- Pros: strongest scalability.
- Cons: higher delivery risk/time.
- Deferred to Phase 2 after in-process model proves contract.

---

## Rollout Plan

### Phase 1 — Durable Streaming
- Add `chat_runs` + `chat_run_events` schema.
- Convert `POST /api/chat` to submit-and-return-202.
- Add `GET /api/chat/runs/:runId`, `events`, and `cancel` endpoints.
- Add in-process worker and SSE status streaming in web chat.
- Persist proposal IDs and final answer through run completion.

### Phase 2 — Hardened Reconnect
- Add replay semantics (`Last-Event-ID`) and fallback snapshot recovery.
- Tune keepalive/backoff behavior for Cloud Run/proxy idle windows.

### Phase 3 — Queue Externalization
- Move run execution off API process into dedicated worker runtime.
- Keep API contract unchanged.

---

## Acceptance Criteria

- No `/api/chat` request depends on multi-minute open HTTP response.
- No header double-send errors on timeout path.
- Chat completion survives refresh and client disconnect.
- Idempotency prevents duplicate execution on retries.
- Ownership tests prove no cross-user run access.
- Multi-tab tests prove responses route to the initiating tab/session tuple.
- Runbook includes run-based incident triage steps.

---

## Notes for PM Tracking

This ADR intentionally separates **contract first** (API + state machine + persistence) from worker scaling strategy. That lets engineering ship Phase 1 quickly while preserving a clean path to Cloud Tasks/PubSub without breaking clients.
