# ADR-009: Structured Logging with Pino

**Status:** Accepted  
**Date:** 2026-02-08  
**Authors:** Guff, Opie (Claude)

## Context

Majel's current logging is a patchwork:

1. **`debug.ts`** — A hand-rolled debug module with subsystem toggles (`MAJEL_DEBUG=lex,sheets,gemini`). Writes to `console.error`. Binary: either on or off per subsystem. No log levels, no structured output, no file persistence.

2. **~30 `console.log/error/warn` calls** — Scattered across `index.ts`, `sheets.ts`, and other modules. Emoji-prefixed (`⚡`, `✅`, `⚠️`, `🖖`). Human-readable in a terminal, unparseable by any log aggregator. No timestamps, no request context, no correlation IDs.

3. **`npm run dev`** — Runs `tsx watch` in the foreground. Logs to stdout. Close the terminal, lose everything. No log files, no way to review what happened during a session.

### What's Wrong

- **No log levels:** Can't distinguish "server started" (info) from "Gemini API quota exceeded" (error) from "fleet data stale" (warn) without reading the emoji.
- **No structured output:** Logs are freeform strings. Can't `grep` for all errors, can't pipe to a log viewer, can't aggregate.
- **No persistence:** Close the terminal, logs are gone. No way to review what happened during a session after the fact.
- **No request context:** When troubleshooting an API issue, there's no request ID linking "received POST /api/chat" to "Gemini error: quota exceeded" to "responded 500."
- **Debug module is isolated:** `debug.ts` is a separate system from the `console.*` calls. Two logging mechanisms that don't know about each other.

### Requirements

1. **Structured JSON logging** in production — machine-parseable, greppable, pipeable
2. **Human-readable pretty output** in development — no one wants to read raw JSON while coding
3. **Log levels** — `fatal`, `error`, `warn`, `info`, `debug`, `trace` — with runtime configurability
4. **Subsystem context** — every log line knows which module it came from (gemini, lex, sheets, etc.)
5. **Request context** — API request logs include method, path, status, duration, and a request ID
6. **File output** — logs persist to a file so sessions can be reviewed after the fact
7. **Background dev mode** — `npm run dev` can run backgrounded with logs captured to file
8. **Zero overhead when disabled** — debug/trace logging costs nothing when the level is set to info
9. **AX-rated** — the logging tool should be something the AI assistant knows deeply and can troubleshoot with effectively

## Decision

### Pino

**[Pino](https://github.com/pinojs/pino)** is the structured logging standard for Node.js:

- **Fastest Node.js logger** — 5x faster than winston, uses worker threads for async I/O
- **Structured JSON by default** — every log line is a valid JSON object
- **Log levels built-in** — `fatal` (60), `error` (50), `warn` (40), `info` (30), `debug` (20), `trace` (10)
- **Child loggers** — create subsystem loggers that inherit context: `logger.child({ subsystem: "gemini" })`
- **pino-pretty** — dev-only pretty-printer that makes JSON logs human-readable with colors
- **Transports** — built-in support for file output, log rotation, and custom destinations
- **Ecosystem** — `pino-http` for Express request/response logging with automatic duration tracking
- **Industry standard** — used by Fastify (built-in), NestJS, Platformatic, and most Node.js production systems
- **AI-friendly** — Claude, ChatGPT, and Copilot all have deep familiarity with pino's API and can troubleshoot it effectively

**Why not winston?** Slower, heavier, more configuration surface for the same result. Winston is Java-style logging bolted onto Node. Pino is Node-native.

**Why not bunyan?** Unmaintained since 2018. Pino is its spiritual successor with active development.

**Why not console.log?** It's what we have now and it's the problem we're solving.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Root Logger (pino)                   │
│  level: configurable via MAJEL_LOG_LEVEL              │
│  output: stdout (always) + file transport (optional)  │
├─────────────────────────────────────────────────────┤
│                   Child Loggers                       │
│  logger.child({ subsystem: "gemini" })               │
│  logger.child({ subsystem: "lex" })                  │
│  logger.child({ subsystem: "sheets" })               │
│  logger.child({ subsystem: "settings" })             │
│  logger.child({ subsystem: "fleet" })                │
│  logger.child({ subsystem: "boot" })                 │
├─────────────────────────────────────────────────────┤
│              Express Middleware (pino-http)            │
│  Auto-logs: method, url, statusCode, responseTime    │
│  Adds: req.log (child logger with request context)   │
│  Generates: reqId for request correlation            │
└─────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   ┌──────────┐                ┌─────────────────┐
   │  stdout   │                │  logs/majel.log  │
   │ (pretty   │                │ (JSON, rotating) │
   │  in dev)  │                │                  │
   └──────────┘                └─────────────────┘
```

### Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `MAJEL_LOG_LEVEL` | `info` (prod), `debug` (dev) | Minimum log level |
| `MAJEL_LOG_FILE` | `logs/majel.log` | Log file path (set to empty to disable) |
| `MAJEL_LOG_PRETTY` | auto-detected | Force pretty-print (auto: true in dev, false in prod) |

The old `MAJEL_DEBUG` env var becomes a shortcut: `MAJEL_DEBUG=true` sets level to `debug`, `MAJEL_DEBUG=gemini` sets level to `debug` + filters to that subsystem in pretty output.

### Log Level Usage Guide

| Level | When to Use | Example |
|-------|-------------|---------|
| `fatal` | Process cannot continue | DB corruption, missing critical config |
| `error` | Operation failed, request will get an error response | Gemini API error, Sheets auth failure |
| `warn` | Degraded but operational | Fleet data stale, memory save failed (fire-and-forget), no API key |
| `info` | Normal operational events | Server started, subsystem online, roster refreshed |
| `debug` | Development diagnostics | Chat message length, session created, frame stored |
| `trace` | Verbose internals | Full prompt text, raw API responses, SQL queries |

### Replacing debug.ts

The current `debug.ts` module gets replaced by pino child loggers:

```typescript
// Before (debug.ts)
import { debug } from "./debug.js";
debug.gemini("chat:send", { messageLen: 120 });

// After (pino child logger)
import { log } from "./logger.js";
log.gemini.debug({ messageLen: 120 }, "chat:send");
```

Same subsystem filtering, but now with proper levels, structured output, and file persistence.

### Replacing console.* Calls

Every `console.log/error/warn` in production code gets replaced:

```typescript
// Before
console.log("⚡ Majel initializing...");
console.error("⚠️  Gemini error:", errMessage);
console.warn("⚠️  GEMINI_API_KEY not set — chat disabled");

// After
log.boot.info("initializing");
log.gemini.error({ err: errMessage }, "gemini error");
log.boot.warn("GEMINI_API_KEY not set — chat disabled");
```

The emoji are dropped — pino-pretty adds color-coded level prefixes that serve the same purpose. In JSON mode (production), the level is a numeric field.

### Express Request Logging

`pino-http` middleware auto-logs every request:

```json
{"level":30,"time":1707350400000,"req":{"id":"abc-123","method":"POST","url":"/api/chat"},"res":{"statusCode":200},"responseTime":142,"msg":"request completed"}
```

In dev (pino-pretty):
```
[14:30:00.000] INFO: request completed
    req: { id: "abc-123", method: "POST", url: "/api/chat" }
    res: { statusCode: 200 }
    responseTime: 142ms
```

### Dev Background Mode

New npm scripts:

```json
{
  "dev": "tsx watch --import dotenv/config src/server/index.ts",
  "dev:bg": "npm run dev > logs/dev.log 2>&1 & echo $! > .dev.pid && echo '🖖 Majel running in background (PID: '$(cat .dev.pid)')' && echo '   Logs: tail -f logs/dev.log'",
  "dev:log": "tail -f logs/majel.log",
  "dev:stop": "kill $(cat .dev.pid 2>/dev/null) 2>/dev/null; rm -f .dev.pid; echo '🔪 Majel stopped'"
}
```

- `npm run dev` — foreground with pretty output (unchanged behavior)
- `npm run dev:bg` — background with logs to file, prints PID
- `npm run dev:log` — tail the structured log file
- `npm run dev:stop` — kill the background process

### Log File Management

- Default location: `logs/majel.log`
- `logs/` directory added to `.gitignore`
- `.dev.pid` added to `.gitignore`
- No log rotation in v0.3 (single file, manual truncation). Log rotation is a v1.0 concern when the server runs long-term.

## Implementation

### Dependencies

```
pino          — core structured logger
pino-pretty   — dev pretty-printer (devDependency)
pino-http     — Express request logging middleware
```

### New Files

- `src/server/logger.ts` — Root logger + child loggers per subsystem
- Remove `src/server/debug.ts` — Fully replaced by pino

### Migration Scope

| File | Changes |
|------|---------|
| `src/server/logger.ts` | NEW — root logger, child loggers, configuration |
| `src/server/debug.ts` | DELETED — replaced by logger.ts |
| `src/server/index.ts` | Replace all `console.*` with `log.*`, add pino-http middleware |
| `src/server/gemini.ts` | Replace `debug.gemini` → `log.gemini` |
| `src/server/sheets.ts` | Replace `console.*` → `log.sheets` |
| `src/server/memory.ts` | Replace `debug.lex` → `log.lex` |
| `src/server/settings.ts` | Replace `debug.settings` → `log.settings` |
| `package.json` | Add deps, add dev:bg/dev:log/dev:stop scripts |
| `.gitignore` | Add `logs/`, `.dev.pid` |

## Consequences

### Positive
- **One logging system** — pino replaces both `debug.ts` and scattered `console.*` calls
- **Machine-parseable** — JSON output enables grep, jq, log aggregators, and AI-assisted troubleshooting
- **Human-readable in dev** — pino-pretty makes development output clearer than emoji-prefixed console.log
- **Request tracing** — pino-http adds request IDs and timing to every API call automatically
- **Persistent logs** — sessions survive terminal closure, reviewable after the fact
- **Level-based filtering** — `MAJEL_LOG_LEVEL=warn` silences everything except problems
- **AI-troubleshootable** — pino is the most common Node.js logger in AI training data. Both Copilot and Majel's advisors can parse and diagnose pino JSON output effectively

### Negative
- **Two new production dependencies** (pino, pino-http) — small, well-maintained, no transitive bloat
- **Migration touches every server file** — one-time cost, mechanical replacement
- **JSON logs are noisy in raw form** — mitigated by pino-pretty for dev and `jq` for production

### Risks
- **Test output noise:** Pino logs during tests could pollute test output. Mitigation: set `level: "silent"` when `NODE_ENV=test` (same as current debug.ts behavior).
- **Breaking existing debug workflows:** Users with `MAJEL_DEBUG=gemini` scripts need migration. Mitigation: `MAJEL_DEBUG` still works, mapped to pino levels internally.

## References

- ADR-004 (AX-First API — request logging feeds into diagnostic capabilities)
- ADR-005 (v0.3 Hardening — operational middleware, request context)
- [Pino](https://github.com/pinojs/pino) — Node.js structured logger
- [pino-http](https://github.com/pinojs/pino-http) — Express/HTTP request logging
- [pino-pretty](https://github.com/pinojs/pino-pretty) — Human-readable dev output
