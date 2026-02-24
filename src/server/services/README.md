# services/

Non-store business logic — AI engines, sync, email, auth, briefing generators.

## Files

| Service | Purpose |
|---------|---------|
| `auth.ts` | Password hashing (argon2), session token management |
| `dock-briefing.ts` | Generate dock status briefings for chat |
| `email.ts` | Verification + password reset emails |
| `gemini.ts` | Google Gemini AI engine (chat, tool calling) |
| `memory-middleware.ts` | Per-request scoped memory (ADR-021) |
| `memory.ts` | Lex memory service (frames, recall, search) |
| `micro-runner.ts` | MicroRunner tool execution engine |
| `password.ts` | Password validation rules |
