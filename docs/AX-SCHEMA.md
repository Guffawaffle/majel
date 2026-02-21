# AX Schema Reference

Two response formats exist for AI agent consumption:

## 1. Cloud CLI (`--ax` flag)

```jsonc
{
  "command": "cloud:<name>",      // Which command ran
  "success": true|false,          // Did it succeed?
  "timestamp": "ISO-8601",        // When it completed
  "durationMs": 1234,             // How long it took
  "data": { ... },                // Command-specific payload
  "errors?": ["..."],             // Present on failure — what went wrong
  "hints?": ["..."]               // Present on failure — how to recover
}
```

**TypeScript type:** `AxCommandOutput` in `src/shared/ax.ts` (consumed by `scripts/cloud.ts`)

All `process.exit(1)` paths emit valid JSON in AX mode.
All failures include both `errors` (what happened) and `hints` (what to try).

### Discovery

```bash
npm run cloud -- help --ax    # Lists all commands with arg schemas
```

## 2. API Envelope (ADR-004)

### Success
```jsonc
{
  "ok": true,
  "data": { ... },
  "meta": { "requestId": "uuid", "timestamp": "ISO-8601", "durationMs": 42 }
}
```

### Error
```jsonc
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",        // Machine-readable (see ErrorCode enum)
    "message": "Human summary",  // What went wrong
    "detail?": { ... },          // Structured context (e.g., validModels)
    "hints?": ["..."]            // Recovery guidance for the agent
  },
  "meta": { "requestId": "uuid", "timestamp": "ISO-8601", "durationMs": 42 }
}
```

**TypeScript types:** `ApiSuccess`, `ApiErrorResponse` in `src/shared/ax.ts` (re-exported from `src/server/envelope.ts`)

### Discovery

```
GET /api          # Full endpoint list with auth tiers and param schemas
GET /api/health   # Subsystem status (includes retryAfterMs when initializing)
GET /api/models   # Available models with current + default
```

### Auth Tiers

Every endpoint in `GET /api` includes an `auth` field:
- `none` — No authentication required
- `lieutenant` — Session cookie or Bearer token
- `admiral` — Admiral-level access

### Error Codes

Defined in `src/server/envelope.ts` → `ErrorCode` object.
Module-specific extension convention uses `defineModuleErrorCodes(namespace, codes)`
to generate stable namespaced values (e.g. `IMPORT_PARSE_FAILED`).
Key codes for agents:
- `GEMINI_NOT_READY` — check `detail.reason` for "initializing" vs "no API key"
- `MISSING_PARAM` — check `hints` for required fields
- `INVALID_PARAM` — check `detail` for valid values (e.g., `validModels`)
- `UNAUTHORIZED` — check `hints` for auth methods
- `INSUFFICIENT_RANK` — check message/hints for required role context
