# services/

Non-store business logic — AI engines, sync, email, auth, briefing generators.

## Files

| Service | Purpose |
|---------|---------|
| `auth.ts` | Password hashing (argon2), session token management |
| `dock-briefing.ts` | Generate dock status briefings for chat |
| `email.ts` | Verification + password reset emails |
| `frame-maintenance.ts` | Lex frame cleanup + archival |
| `gemini.ts` | Google Gemini AI engine (chat, tool calling) |
| `memory-middleware.ts` | Per-request scoped memory (ADR-021) |
| `memory.ts` | Lex memory service (frames, recall, search) |
| `micro-runner.ts` | MicroRunner tool execution engine |
| `password.ts` | Password validation rules |
| `plan-briefing.ts` | Fleet plan status briefings |
