# ADR-037: Realtime Event Streaming (SSE-First) for Long-Running Operations

**Status:** Proposed  
**Date:** 2026-03-02  
**Authors:** Guff, GitHub Copilot (GPT-5.3-Codex)  
**References:** ADR-004 (AX envelope), ADR-009 (logging), ADR-014 (MicroRunner), ADR-018 (cloud), ADR-019 (user/privacy), ADR-036 (async chat runs)

---

## Context

Majel is moving toward long-running, multi-step operations where users need live progress visibility:

- Chat run execution (tool chains, multimodal analysis)
- Runner-style orchestration and phase transitions
- Import/sync workflows with staged progress

Polling can work, but it is wasteful and provides coarse UX. The desired experience is the same live “working…” progression used by coding agents: users should see streamed state changes as they happen.

We need one reusable realtime contract across subsystems instead of per-feature ad hoc progress APIs.

---

## Decision

Adopt an **SSE-first realtime event architecture** for all long-running user-visible operations.

1. Primary transport is **Server-Sent Events** (SSE) over HTTP.
2. Every long-running operation emits typed lifecycle events to a persisted event log.
3. Clients subscribe to an operation stream and render incremental updates.
4. Reconnect uses `Last-Event-ID` with replay from durable event storage.
5. Polling is not the primary UX path; it is an optional degraded fallback only.

---

## Scope

### In Scope (Phase 1)
- Chat run progress/status events
- Unified event envelope and stream endpoint contract
- Durable event persistence + replay
- Client subscription manager with reconnect/backoff

### In Scope (Phase 2)
- Runner orchestration progress events (lex-runner style phases)
- Import/sync progress events
- Shared progress components in web UI

### Out of Scope (initial)
- Bidirectional protocol (WebSockets)
- Cross-user collaborative event channels
- Public external event subscriptions

---

## API Contract

### Stream endpoint
`GET /api/events/stream?topic=<topic>&id=<operationId>`

Examples:
- `/api/events/stream?topic=chat_run&id=crun_01...`
- `/api/events/stream?topic=runner_job&id=rjob_01...`

Headers:
- `Accept: text/event-stream`
- Optional `Last-Event-ID: <eventId>` for resume replay

Response:
- `200 OK`
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`

### Event format

```text
id: 142
event: run.progress
data: {"topic":"chat_run","id":"crun_01...","status":"running","phase":"tool_execution","progress":{"completedSteps":2,"totalSteps":5},"timestamp":"2026-03-02T00:00:00.000Z"}

```

Required fields in `data`:
- `topic`
- `id`
- `status`
- `timestamp`
- `sessionId`
- `tabId`

Optional fields:
- `phase`
- `progress`
- `message`
- `trace`
- `payload`

### Heartbeats
- Emit `event: keepalive` every 15s when no domain events are emitted.
- Clients must ignore keepalive payload for business state.

### Snapshot endpoint
`GET /api/events/snapshot?topic=<topic>&id=<operationId>`

- Returns latest consolidated operation state for first paint and fallback recovery.

---

## Persistence

Use a durable operation event log:

```sql
CREATE TABLE operation_events (
  seq BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_operation_events_topic_id_seq
  ON operation_events(topic, operation_id, seq);

CREATE INDEX idx_operation_events_user_created
  ON operation_events(user_id, created_at DESC);
```

Replay semantics:
- If `Last-Event-ID` is present, stream missed events where `seq > lastEventId`.
- If event gap exceeds retention, send `event: stream.reset` and require client snapshot refresh.

Retention:
- Keep compact event rows for 30 days by default.
- Periodically prune old events while retaining operation summary rows elsewhere.

---

## Client Contract

Client behavior:
- Open one EventSource per active operation view.
- Render events incrementally in operation-specific UI.
- Route events using `(sessionId, tabId)` to the exact originating chat tab.
- On disconnect, retry with exponential backoff and `Last-Event-ID`.
- If retries exceed threshold, show “Reconnecting…” state and use snapshot endpoint.

UI primitives (shared):
- `ProgressTimeline` (phase list + timestamps)
- `ProgressBar` (if numeric progress exists)
- `LiveStatusPill` (`queued|running|waiting|failed|succeeded|cancelled|timed_out`)
- `TracePanel` (admiral-only metadata)

---

## Security & Privacy

- Streams are user-scoped: only operation owner can subscribe.
- No cross-user stream reads, including admiral role.
- Topic/id validation is strict and deny-by-default.
- Sensitive payload fields are redacted before persistence and stream emission.

---

## Reliability

- Each producer emits events via one internal helper (`emitOperationEvent`).
- Event IDs are monotonic (`seq`) and stable for replay.
- Stream handler must tolerate slow clients and terminate idle/broken sockets safely.
- Keepalive prevents intermediate proxies from closing quiet streams.

---

## Observability

Log fields:
- `topic`, `operationId`, `eventType`, `seq`, `userId`, `subscriberCount`, `replayFrom`

Metrics:
- `event_stream_connections_active`
- `event_stream_reconnect_total`
- `event_stream_events_sent_total{topic,eventType}`
- `event_stream_replay_events_total`
- `event_stream_disconnect_total{reason}`

SLO (initial):
- $P95$ event delivery latency under 1.5s from emit to client receive in normal operation.

---

## Alternatives Considered

### A) Polling-first
- Pros: simple backend.
- Cons: delayed UX, higher request load, weaker progress fidelity.
- Rejected as primary architecture.

### B) WebSockets first
- Pros: bidirectional and low-latency.
- Cons: more operational complexity than needed for current unidirectional requirements.
- Deferred.

### C) Vendor push channels only
- Pros: offloads infrastructure.
- Cons: lock-in and weaker local/control-plane semantics.
- Rejected.

---

## Rollout Plan

### Phase 1 — Core Stream Plane
- Add `operation_events` schema and event helper.
- Add `/api/events/stream` and `/api/events/snapshot`.
- Integrate chat-run producer events + web EventSource consumer.

### Phase 2 — Runner Integration
- Emit runner job phase events via same stream contract.
- Add reusable progress UI across chat + runner views.

### Phase 3 — Wider Adoption
- Migrate import/sync progress to stream contract.
- Keep polling only as degraded fallback path.

---

## Acceptance Criteria

- Long-running chat operations show live progress without polling-first UX.
- Reconnect restores missed progress via `Last-Event-ID` replay.
- Multi-tab UI routing is deterministic via `sessionId` + `tabId` on every event.
- Operation streams remain owner-scoped with explicit cross-user denial tests.
- Shared stream plane supports both chat runs and runner jobs.
- Runbook includes SSE incident diagnostics (disconnect, replay gaps, backpressure).
