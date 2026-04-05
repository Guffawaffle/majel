# ADR-005: v0.3 Hardening Roadmap

**Status:** Accepted  
**Date:** 2026-02-08  
**Authors:** Guff, Lex (ChatGPT advisor), Opie (Claude)

## Context

Majel v0.2 is a working MVP with 156 passing tests, a modern chat UI, epistemic framework, debug logging, and settings store. Both advisors (Lex and Opie) independently converged on the same assessment: the system works but has structural gaps that will bite hard if left unfixed before adding features.

### Known Structural Issues

1. **Shared Gemini session:** All requests share one `ChatSession`. If two tabs are open, their conversations interleave. The model sees context it shouldn't.

2. **Monolithic routes:** All endpoints live in `index.ts` (427 lines). Route logic, error handling, and startup are tangled. Adding endpoints means editing the one file everything depends on.

3. **Config double-resolution:** Environment variables are read at module scope AND the settings store is consulted at boot. The priority chain (user override → env → default) works but is implicit and scattered.

4. **No operational middleware:** No request IDs, no timeouts, no rate limiting, no body size limits, no consistent error shape. The API grew endpoint-by-endpoint.

### What We're NOT Doing

Per explicit decision, these are **shelved** for v0.3:

- Paid tier / subscriptions
- Plugin system
- Cloud deployment
- SvelteKit migration (ADR-002 — that's v1.0)
- Streaming responses (v1.0 with SvelteKit SSE)

v0.3 is about **making what exists reliable**, not adding features.

## Decision

Four phases, each independently deployable and testable. Each phase produces a working system — no half-implemented states.

### Phase 1: Session Isolation

**Problem:** Single shared `ChatSession` = conversation bleed between tabs/users.

**Solution:**

```typescript
// Current (broken for multi-tab)
state.geminiEngine = createGeminiEngine(apiKey, fleetData);
// One ChatSession, shared by all requests

// v0.3 (stateless by default, optional session by ID)
interface GeminiService {
  chat(message: string, sessionId?: string): Promise<string>;
  getHistory(sessionId: string): Array<{ role: string; text: string }>;
  closeSession(sessionId: string): void;
}
```

- Default: stateless — each request gets a fresh model context with system prompt
- Optional: pass `sessionId` header → gets/creates a session with conversation history
- Sessions have a TTL (configurable, default 30 minutes)
- Memory limit per session (configurable, default 50 turns)
- Session cleanup on interval

**Test strategy:**
- Concurrent requests with different sessionIds get independent histories
- Session TTL expiry works
- Stateless mode returns consistent results regardless of prior requests
- Memory limit triggers graceful truncation

### Phase 2: Route Split

**Problem:** `index.ts` is a 427-line monolith mixing routes, startup, shutdown, and configuration.

**Solution:**

```
src/server/
├── index.ts              # Boot + shutdown only (~60 lines)
├── app.ts                # createApp() + middleware stack
├── routes/
│   ├── health.ts         # GET /api/health
│   ├── diagnostic.ts     # GET /api/diagnostic (new)
│   ├── discovery.ts      # GET /api (new)
│   ├── chat.ts           # POST /api/chat
│   ├── history.ts        # GET /api/history
│   ├── recall.ts         # GET /api/recall
│   ├── roster.ts         # GET /api/roster
│   └── settings.ts       # GET/PATCH/DELETE /api/settings
├── middleware/
│   ├── envelope.ts       # { ok, data } / { ok, error } wrapper
│   ├── request-id.ts     # X-Request-Id header
│   └── error-handler.ts  # Catch-all error → envelope
└── services/             # Business logic (existing files stay)
    ├── gemini.ts
    ├── memory.ts
    ├── sheets.ts
    ├── settings.ts
    ├── fleet-data.ts
    └── debug.ts
```

**Rules:**
- Each route file exports a single `Router`
- Routes call services, never other routes
- Route files are thin — validation + service call + response
- Services are framework-independent (no `req`/`res`)
- `createApp()` composes middleware + routes

**Test strategy:**
- Existing 156 tests continue to pass through `createApp()` (no test rewrites)
- New route files get focused unit tests
- Integration tests via supertest unchanged

### Phase 3: Settings as Single Source of Truth

**Problem:** Config is resolved in two places:
1. Module-scope constants (`const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""`)
2. Boot-time settings store queries (`state.settingsStore?.get("sheets.spreadsheetId") || SPREADSHEET_ID`)

This means changing a setting at runtime doesn't take effect until restart, and the priority chain is implicit.

**Solution:**

```typescript
// config.ts — single resolution point
export function resolveConfig(settingsStore: SettingsStore | null): AppConfig {
  return {
    geminiApiKey: resolve("gemini.apiKey", settingsStore),
    spreadsheetId: resolve("sheets.spreadsheetId", settingsStore),
    tabMapping: resolve("sheets.tabMapping", settingsStore),
    port: resolve("server.port", settingsStore),
    // ... all config flows through here
  };
}

function resolve(key: string, store: SettingsStore | null): string {
  // Priority: user override → env var → default
  const userOverride = store?.get(key);
  if (userOverride !== undefined) return userOverride;
  // Env var mapping is defined in settings schema
  return getDefault(key);
}
```

- All configuration resolves through one function
- Settings store is the source of truth, env vars are the fallback
- Runtime setting changes can trigger config re-resolution
- Config object is typed — no more `process.env.THING || ""` scattered everywhere

**Test strategy:**
- Resolution priority chain tested explicitly (user > env > default)
- Runtime re-resolution tested
- No env vars read outside `config.ts`

### Phase 4: Operability Middleware

**Problem:** No request context, no timeouts, no limits, inconsistent errors.

**Solution — four middleware layers:**

| Middleware | Purpose |
|-----------|---------|
| `request-id` | Generate UUID, attach to `req`, set `X-Request-Id` response header |
| `body-limits` | `express.json({ limit: '100kb' })` — prevent payload bombs |
| `timeout` | Per-route timeouts (chat: 30s, health: 2s, sheets: 60s) |
| `envelope` | Wrap all responses in `{ ok, data }` / `{ ok, error }` shape (ADR-004) |
| `error-handler` | Catch-all: unhandled errors → envelope with request ID |

Plus logging enhancement:
- Every request logged with request ID, method, path, duration
- Errors logged with request ID for tracing

**Test strategy:**
- Request ID present on all responses
- Oversized bodies rejected with correct error code
- Timeout fires and returns 504 with error envelope
- Unhandled errors caught and wrapped

## Execution Order

```
Phase 1 (Session Isolation)  → Ship independently
Phase 2 (Route Split)        → Ship independently  
Phase 3 (Settings Wiring)    → Ship independently
Phase 4 (Middleware)          → Ship independently
```

Each phase is a PR. Each PR leaves all tests green. No phase depends on another being complete first, though the natural flow is 1→2→3→4.

**Estimated effort:** ~2-3 sessions per phase. Total: ~8-12 work sessions for v0.3.

## Consequences

### Positive
- Multi-tab/multi-user safe (session isolation)
- Maintainable route structure (route split) 
- Predictable configuration (single source of truth)
- Production-grade operational visibility (middleware)
- Each phase independently deployable — no big-bang risk
- Test suite grows organically with each phase

### Negative
- Four PRs of structural refactoring before any new features
- Route split moves files — git blame gets noisier
- Middleware adds latency (negligible — <1ms per layer)

### Risk Mitigation
- Each phase leaves all tests green — rollback is trivial
- Route split preserves `createApp()` contract — test changes minimal
- Middleware layers are optional (can disable per-route if needed)
- v0.2 tagged in git as fallback

## Non-Goals (Explicitly Shelved)

| Item | Why Not Now |
|------|-------------|
| SvelteKit migration | v1.0 scope (ADR-002). Server modules port directly. |
| Streaming responses | Requires SvelteKit SSE or WebSocket. v1.0. |
| Multi-user auth | Single-Admiral system for now. Session isolation handles multi-tab. |
| Cloud deployment | Local-first philosophy (ADR-001). Cloud is a deployment target, not an architecture decision. |
| Plugin system | No use case yet. Don't build hooks nobody's calling. |
| Rate limiting | Single-user system. Add when it's not. |

## References

- ADR-001 (Architecture — local-first, simple)
- ADR-002 (SvelteKit — v1.0 target, deferred)
- ADR-003 (Epistemic Framework — prompt architecture)
- ADR-004 (AX-First API — response envelope, error codes, /api/diagnostic)
- `src/server/index.ts` — current monolith (427 lines)
