# ADR-002: Framework Selection for Majel v1.0

**Status:** Superseded by [ADR-031](ADR-031-svelte-migration.md)  
**Date:** 2026-02-08  
**Authors:** Opie (Claude), Guff

> **Note (2026-02-19):** This ADR recommended SvelteKit with adapter-node. After implementation analysis, the SvelteKit approach was rejected due to SSR overhead for an auth-gated app, API proxy indirection, and Svelte version instability risk. ADR-031 adopts Svelte 5 + Vite without Kit — keeping the component/reactivity benefits without meta-framework lock-in. Express API stays untouched.

## Context

Majel v0.2 is a working MVP: Express server, vanilla HTML/JS frontend, Lex memory, Gemini chat. It proves the architecture works. Now we need to plan the "proper app" — a real frontend framework for features like:

- Session management (multiple conversations)
- Settings UI (API keys, sheet config, model selection)
- Conversation browser (search, filter, export Lex history)
- Roster viewer / data explorer
- Real-time status + streaming responses

### Requirements

| Priority | Requirement |
|----------|-------------|
| **Must** | Simple — small learning curve, minimal boilerplate |
| **Must** | TypeScript native — full type safety end-to-end |
| **Must** | Long-term viable — active ecosystem, not fad-driven |
| **Must** | Session management — conversation state, persistence |
| **Must** | Secure defaults — CSRF, input sanitization, no eval() |
| **Should** | Local-first — works great without cloud deployment |
| **Should** | Streaming support — SSE/WebSocket for Gemini responses |
| **Should** | Lightweight — fast startup, small bundle |
| **Nice** | Single-port — no separate frontend dev server |

## Options Evaluated

### 1. SvelteKit ⭐ Recommended

| Aspect | Assessment |
|--------|------------|
| Simplicity | Lowest boilerplate of major frameworks. `.svelte` files = HTML+JS+CSS in one file |
| TypeScript | First-class, template-level type checking |
| Longevity | Backed by Vercel, v2 (Svelte 5) just shipped, growing fast |
| Sessions | Built-in server hooks, `$page.data`, form actions |
| Security | Auto-escaped templates, built-in CSRF for form actions |
| Local-first | `adapter-node` produces a self-contained Node server |
| Streaming | Native SSE support, `ReadableStream` in server endpoints |
| Bundle | Compiles components away — smallest runtime of any framework |

**Why it fits Majel:**
- Single file components = fast iteration for a solo/small team
- Server routes (`+server.ts`) replace Express endpoints directly
- Form actions handle Settings/Config UI with zero client-side JS
- Adapter-node = `npm start` launches everything on one port
- No hydration overhead — pages render instantly

### 2. Next.js (App Router)

| Aspect | Assessment |
|--------|------------|
| Simplicity | Moderate — App Router has a learning curve (RSC, layouts, client/server boundaries) |
| TypeScript | Excellent, but template types lag behind Svelte |
| Longevity | Most popular React framework, Vercel-backed |
| Sessions | Manual — need `iron-session` or similar |
| Security | React auto-escaping, but no built-in CSRF |
| Local-first | Works, but designed for Vercel deployment |
| Bundle | Larger runtime than Svelte — React hydration overhead |

**Verdict:** Powerful but heavier than needed. The RSC mental model adds complexity Majel doesn't need.

### 3. Remix

| Aspect | Assessment |
|--------|------------|
| Simplicity | Moderate — good loader/action patterns |
| TypeScript | Good, React-based |
| Longevity | Now merged with React Router 7, future uncertain |
| Sessions | Built-in session management (cookie/file-based) |

**Verdict:** Great patterns, but the Remix→React Router merge creates uncertainty.

### 4. Express + htmx

| Aspect | Assessment |
|--------|------------|
| Simplicity | Very simple — server-rendered HTML, progressive enhancement |
| TypeScript | Express side only — no template types |
| Longevity | htmx is stable but niche |
| Sessions | Manual (`express-session`) |
| Streaming | SSE works, but no component-level reactivity |

**Verdict:** Appealing for simplicity, but lacks component model for the richer UI features planned (conversation browser, settings panels).

### 5. Hono + Vite + Preact

| Aspect | Assessment |
|--------|------------|
| Simplicity | Moderate — need to wire pieces together |
| TypeScript | Hono is excellent, Preact is good |
| Bundle | Very lightweight |

**Verdict:** Good for APIs, but "assemble your own framework" = more work.

## Decision

**SvelteKit** with `adapter-node`.

### Migration Path (v0.2 → v1.0)

```
Phase 1: Scaffold                              ← Week 1
├── npx sv create (SvelteKit + TypeScript)
├── Move server modules to src/lib/server/
├── Convert Express endpoints to +server.ts
└── Basic layout with LCARS theme

Phase 2: Core Pages                             ← Week 2  
├── / (chat) ← main interface
├── /history ← conversation browser (Lex timeline)
├── /settings ← API keys, sheet config
└── Streaming chat (SSE from Gemini)

Phase 3: Polish                                 ← Week 3
├── Session management (multiple conversations)
├── Roster data viewer
├── Export/import conversations
└── Light/dark theme toggle
```

### Architecture (v1.0)

```
/srv/majel/
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   ├── sheets.ts       # Ported from v0.2
│   │   │   ├── gemini.ts       # Ported, add streaming
│   │   │   └── memory.ts       # Ported from v0.2
│   │   ├── components/
│   │   │   ├── ChatMessage.svelte
│   │   │   ├── StatusBar.svelte
│   │   │   └── RosterBadge.svelte
│   │   └── stores/
│   │       └── chat.ts         # Svelte stores for UI state
│   ├── routes/
│   │   ├── +layout.svelte      # LCARS shell
│   │   ├── +page.svelte        # Chat interface
│   │   ├── history/
│   │   │   └── +page.svelte    # Lex conversation browser
│   │   ├── settings/
│   │   │   ├── +page.svelte    # Config UI
│   │   │   └── +page.server.ts # Form actions for settings
│   │   └── api/
│   │       ├── chat/+server.ts # POST — Gemini chat (SSE)
│   │       ├── health/+server.ts
│   │       └── roster/+server.ts
│   └── app.html
├── static/
├── svelte.config.js
├── vite.config.ts
└── package.json
```

### Key Dependencies (v1.0)

```json
{
  "@sveltejs/kit": "^2",
  "@sveltejs/adapter-node": "^5",
  "svelte": "^5",
  "@smartergpt/lex": "^2.2.0",
  "@google/generative-ai": "^0.21.0",
  "googleapis": "^140.0.0"
}
```

No Express needed — SvelteKit handles HTTP natively.

## Consequences

### Positive
- Single codebase, single port, single build
- Type-safe templates catch errors at build time
- Streaming responses improve chat UX significantly
- Built-in form handling for settings page (no client JS needed)
- Smallest bundle of any major framework

### Negative
- New framework to learn (though Svelte is widely considered the easiest)
- Migration effort from current Express+vanilla setup
- Fewer npm packages than React ecosystem (rarely an issue)

### Risk Mitigation
- Keep v0.2 as fallback (`legacy/` or git tag)
- Server modules (`sheets.ts`, `gemini.ts`, `memory.ts`) are framework-independent — they port directly
- SvelteKit's server routes are just functions — easy to reason about

## References

- [SvelteKit Docs](https://kit.svelte.dev/docs)
- [Svelte 5 Runes](https://svelte.dev/docs/svelte/what-are-runes)
- [adapter-node](https://kit.svelte.dev/docs/adapter-node)
- ADR-001 (Brute-force context injection — unchanged)
