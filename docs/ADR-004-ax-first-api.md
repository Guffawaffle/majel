# ADR-004: AX-First API Design

**Status:** Accepted  
**Date:** 2026-02-08  
**Authors:** Guff, Opie (Claude)

## Context

Majel's API grew organically during MVP development. Each endpoint was added to handle a specific need, resulting in inconsistent error shapes, no request context, no discoverability, and no operational endpoints beyond a basic `/api/health`.

As we harden for open alpha, the API surface becomes the contract — both for the frontend client AND for Majel herself (the LLM needs reliable endpoints to reference when she can't self-report status).

"AX" = API Experience. The principle: **every consumer of this API — human, frontend, or LLM — should find it predictable, self-describing, and honest about what it can and cannot do.**

## Decision

### 1. Consistent Response Envelope

Every API response follows the same shape:

```typescript
// Success
{
  "ok": true,
  "data": { ... }        // endpoint-specific payload
  "meta"?: {              // optional operational metadata
    "requestId": string,
    "durationMs": number,
    "timestamp": string   // yyyy-mm-dd'T'HH:mm:ss.SSSZ
  }
}

// Error
{
  "ok": false,
  "error": {
    "code": string,       // machine-readable: "GEMINI_NOT_READY", "MISSING_PARAM"
    "message": string,    // human-readable explanation
    "detail"?: unknown    // optional extra context
  },
  "meta"?: { ... }
}
```

**Why:** The frontend currently checks for `data.error` on some endpoints and `data.answer` on others. The LLM prompt references specific endpoint paths. Both consumers need a predictable contract.

**Migration:** Existing endpoints will be wrapped incrementally. The `meta` envelope is optional in v0.3 (added by middleware when present) and required in v1.0.

### 2. API Discovery Endpoint

```
GET /api → { endpoints: [...], version, uptime }
```

Returns a machine-readable manifest of all available endpoints with their methods, descriptions, and parameter schemas. This serves three consumers:

- **Frontend:** Can dynamically discover available features
- **LLM (Majel):** Can be told "check /api for the list of available endpoints" instead of hardcoding paths in the system prompt
- **Developers:** Self-documenting API, no external docs needed for basics

### 3. Diagnostic Endpoint

```
GET /api/diagnostic → real-time subsystem status
```

This is the endpoint Majel references when she can't self-report. Returns actual data:

```typescript
{
  "ok": true,
  "data": {
    "system": {
      "version": "0.3.0",
      "uptime": "2h 14m",
      "nodeVersion": "22.x",
      "timestamp": "2026-02-08T04:30:00.000Z"
    },
    "gemini": {
      "status": "connected",
      "model": "gemini-2.5-flash-lite",
      "sessionMessageCount": 12,
      "promptTokenEstimate": 4200
    },
    "memory": {
      "status": "active",
      "frameCount": 19,
      "dbPath": ".smartergpt/lex/memory.db",
      "ftsIndexed": true
    },
    "settings": {
      "status": "active",
      "userOverrides": 0,
      "dbPath": ".smartergpt/lex/settings.db"
    },
    "fleet": {
      "status": "loaded",
      "sections": 3,
      "totalRows": 247,
      "totalChars": 18400,
      "spreadsheetId": "1abc...xyz"
    },
    "sheets": {
      "credentialsPresent": true,
      "oauthTokenCached": true
    }
  }
}
```

**Why:** This is the single source of truth for system state. The epistemic framework (ADR-003) tells Majel to direct users here instead of fabricating diagnostics. The frontend sidebar can show a live diagnostic panel. Developers can check system health beyond the basic `/api/health`.

### 4. Error Codes (Machine-Readable)

Every error gets a stable code that won't change between versions:

| Code | HTTP | Meaning |
|------|------|---------|
| `GEMINI_NOT_READY` | 503 | Engine not initialized |
| `MEMORY_NOT_AVAILABLE` | 503 | Lex memory not initialized |
| `SETTINGS_NOT_AVAILABLE` | 503 | Settings store not initialized |
| `MISSING_PARAM` | 400 | Required parameter absent |
| `INVALID_PARAM` | 400 | Parameter present but invalid |
| `UNKNOWN_CATEGORY` | 400 | Settings category not found |
| `SHEETS_NOT_CONFIGURED` | 400 | Spreadsheet ID missing |
| `GEMINI_ERROR` | 500 | Upstream Gemini API failure |
| `MEMORY_ERROR` | 500 | Lex operation failed |
| `SHEETS_ERROR` | 500 | Google Sheets fetch failed |

**Why:** The frontend currently string-matches error messages. Codes are stable, messages are for humans.

### 5. Health vs. Diagnostic Separation

| Endpoint | Purpose | Audience | Cost |
|----------|---------|----------|------|
| `GET /api/health` | "Is the server up and can it accept requests?" | Load balancers, uptime monitors, frontend status dot | Cheap — no DB calls |
| `GET /api/diagnostic` | "What's the detailed state of every subsystem?" | Admin dashboard, Majel (when asked), debugging | Moderate — queries DBs for counts |

Health stays fast and shallow. Diagnostic is thorough and can be slower.

### 6. Dates

All API dates use ISO 8601: `yyyy-mm-ddTHH:mm:ss.SSSZ`. No stardates, no locale-dependent formats, no Unix timestamps in user-facing responses.

## Current API Surface (v0.2)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Status check |
| GET | `/api/roster` | Fetch/refresh fleet data from Sheets |
| POST | `/api/chat` | Send message, get Gemini response |
| GET | `/api/history` | Conversation history (session + Lex) |
| GET | `/api/recall` | Search Lex memory |
| GET | `/api/settings` | All settings with resolved values |
| PATCH | `/api/settings` | Update settings |
| DELETE | `/api/settings/:key` | Reset setting to default |

## Planned API Surface (v0.3)

| Method | Path | Purpose | Change |
|--------|------|---------|--------|
| GET | `/api` | API discovery manifest | **New** |
| GET | `/api/health` | Fast health check | Envelope wrap |
| GET | `/api/diagnostic` | Deep subsystem status | **New** |
| GET | `/api/roster` | Fetch/refresh fleet data | Envelope wrap |
| POST | `/api/chat` | Chat with Gemini | Envelope wrap |
| GET | `/api/history` | Conversation history | Envelope wrap |
| GET | `/api/recall` | Search Lex memory | Envelope wrap |
| GET | `/api/settings` | Read settings | Envelope wrap |
| PATCH | `/api/settings` | Update settings | Envelope wrap |
| DELETE | `/api/settings/:key` | Reset setting | Envelope wrap |

## Migration Strategy

1. **v0.3:** Add `/api` and `/api/diagnostic`. Existing endpoints keep current shape but optionally add `meta` via middleware (no breaking changes).
2. **v0.3.x:** Wrap responses in `{ ok, data }` envelope. Frontend updated in same PR.
3. **v1.0 (SvelteKit):** Full envelope required. Error codes required. Old shapes removed.

## Consequences

### Positive
- Every consumer (frontend, LLM, developer) gets predictable responses
- Majel can reference real endpoints instead of fabricating diagnostics
- Error codes decouple frontend logic from error message text
- Discovery endpoint makes the API self-documenting
- Diagnostic endpoint gives full operational visibility

### Negative
- Envelope wrapping is boilerplate (mitigated by middleware helper)
- Migration requires frontend changes in lockstep with API changes

### Risk Mitigation
- Incremental migration — no big-bang rewrite
- Envelope helper function: `res.ok(data)` and `res.fail(code, message)`
- Tests validate both old and new shapes during transition

## References

- ADR-003 (Epistemic Framework — Majel directs to /api/diagnostic)
- ADR-005 (v0.3 Hardening — operability middleware adds `meta`)
- `src/server/index.ts` — current monolithic route definitions
