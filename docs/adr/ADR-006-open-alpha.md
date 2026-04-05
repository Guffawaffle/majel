# ADR-006: Open Alpha Strategy

**Status:** Accepted  
**Date:** 2026-02-08  
**Authors:** Guff, Lex (ChatGPT advisor), Opie (Claude)

## Context

Majel is public on GitHub (`Guffawaffle/majel`, MIT license) and functional as a personal tool. The question: **what needs to be true before we actively invite people to try it?**

This ADR captures the decisions made about what "open alpha" means, who it's for, what's supported, and what's explicitly not.

## Decision

### What "Open Alpha" Means

Majel is usable, not polished. The alpha boundary:

- **Works:** Chat with Gemini, fleet data from Sheets, conversation memory, modern UI
- **Rough edges expected:** Single-session, monolithic server, manual setup, no streaming
- **No guarantees:** Breaking changes between versions, schema migrations may require fresh DBs
- **Audience:** Technically comfortable STFC players who can follow a setup guide, set env vars, and run `npm run dev`

### Zero Backwards Compatibility (Pre-Alpha)

Majel is days old. There are **zero external users** and zero production databases. During this pre-alpha phase:

- **No migration code.** Schema changes are made directly. If your local DB is stale, delete it and re-import.
- **No deprecation cycles.** APIs, schemas, and interfaces change freely.
- **No semver obligations.** The version number is aspirational, not contractual.
- **"Delete and re-create" is an acceptable migration path** for any local state.

This policy holds until the first external user runs `npm run dev` against their own fleet data. At that point we start caring about data preservation. Until then, we build it right instead of building it backwards-compatible.

### The Lex Proof-of-Concept Angle

Majel's secondary purpose is demonstrating [Lex](https://github.com/Guffawaffle/lex) in a real application. This shapes what we prioritize:

| Lex Feature | Majel Demonstrates |
|-------------|-------------------|
| Frame-based memory | Every chat turn → Lex frame |
| Semantic recall | `/api/recall?q=kirk` searches by meaning |
| Timeline queries | `/api/history?source=lex` |
| Workspace isolation | Majel's DB separate from global Lex |
| Zero-config setup | `createFrameStore()` handles SQLite automatically |

This means **memory features stay prominent** — they're not just Majel features, they're Lex showcase features. Documentation should highlight the integration pattern.

### Documentation Bar for Alpha

| Document | Purpose | Status |
|----------|---------|--------|
| `README.md` | First impression, quick start, architecture overview | Exists — needs update for v0.3 |
| `docs/SETUP.md` | Step-by-step setup (Gemini key, Sheets OAuth) | Exists — complete |
| `docs/PROMPT_GUIDE.md` | How we tune Majel's behavior | Exists |
| `CONTRIBUTING.md` | How to contribute, code style, PR process | **Needed** |
| `CHANGELOG.md` | What changed per version | **Needed** |
| `.env.example` | Template with all config vars documented | Exists — needs update |
| ADRs | Why decisions were made | 6 written (001–006) |

### What New Users Must Bring

These are **their** problem, not ours:

1. A Google account (for Gemini API key — free tier works)
2. A Google Cloud project (for Sheets OAuth — optional)
3. An STFC roster spreadsheet (optional — Majel works without it)
4. Node.js 22+ installed
5. Ability to run terminal commands and edit a `.env` file

We don't hand-hold past the setup guide. If someone can't `npm install`, this isn't the project for them yet.

### What We Ship vs. What We Shelve

**Ships with open alpha (v0.3):**

| Feature | Notes |
|---------|-------|
| Chat with Gemini | Full training knowledge + fleet data |
| Epistemic framework | Source attribution, confidence signaling, no hallucination |
| Google Sheets multi-tab | Officer, ship, and custom data sections |
| Lex conversation memory | Persist, recall, timeline |
| Settings store | SQLite-backed, API-accessible |
| Modern chat UI | Markdown, copy buttons, sidebar, responsive |
| Debug logging | `MAJEL_DEBUG` toggle for all subsystems |
| `/api/diagnostic` | Real system status (not fabricated) |
| Session isolation | Multi-tab safe |
| Consistent API envelope | `{ ok, data }` / `{ ok, error }` |

**Explicitly shelved (not in alpha):**

| Feature | Why Not |
|---------|---------|
| Multi-user auth | Single-Admiral tool. No use case. |
| Paid tier / subscriptions | Premature monetization kills OSS goodwill |
| Cloud deployment | Local-first philosophy (ADR-001) |
| Plugin system | No consumers. Don't build hooks nobody calls. |
| Streaming responses | Requires SvelteKit (v1.0) |
| SvelteKit migration | v1.0 scope. Express works for alpha. |
| Mobile app | Web UI is responsive. Native app is overkill. |
| Alliance/guild features | Multi-user problem. Shelved with auth. |
| Custom model selection | Flash-Lite works. Model picker is settings UI work for v1.0. |
### Planned Architectural Improvements (pre-1.0)

These are accepted directions captured during alpha usage. They don't gate any release but will land when adjacent work makes them natural:

| Improvement | Rationale |
|-------------|----------|
| **Client modularization** — `app.js` → thin wrapper + command/connector modules | `app.js` is growing monolithically. API calls, session management, UI rendering, and event wiring should separate into focused modules (e.g., `api.js`, `sessions.js`, `commands.js`). This also preps the path to SvelteKit by making responsibilities clear before the rewrite. |
| **Feature gating** — runtime toggle system for capabilities | Alpha features need a way to be shipped behind flags (e.g., fleet management, image interpretation) so partially-built features don't break the core experience. Gates should be server-driven (settings store or env) and reflected in both API responses and UI. A simple `features` object in `/api/health` is the likely shape. |
### Versioning Strategy

Semantic versioning with these expectations:

| Version | Meaning |
|---------|---------|
| `0.x.y` | Alpha — breaking changes possible between minor versions |
| `0.3.0` | Hardened alpha (session isolation, route split, middleware) |
| `0.4.0` | Fleet management data layer, crew assignments, enhanced Sheets import |
| `0.5.0` | Model tool-use (Gemini function calling), fleet UI, multimodal chat (images) |
| `0.5.x` | Client modularization (app.js → thin wrapper + command modules), feature gating |
| `0.6.0` | Structured screenshot extraction, smart import pipeline |
| `1.0.0` | SvelteKit rewrite, stable API contract, no breaking changes without major bump |

Pre-1.0: we communicate breaking changes in `CHANGELOG.md` but don't guarantee migration paths. Alpha users accept this.

### Security Posture

| Concern | Approach |
|---------|----------|
| API keys in env | `.env` in `.gitignore`, `.env.example` committed |
| OAuth credentials | `credentials.json` and `token.json` in `.gitignore` |
| SQLite DBs | `.smartergpt/` in `.gitignore` |
| No auth on API | Acceptable — local-only server, no public exposure |
| Content filters | All set to `BLOCK_NONE` — documented, personal tool |
| Dependency audit | `npm audit` on every release |

**Not in scope for alpha:** HTTPS, rate limiting, CORS restrictions, CSP headers. These matter when the server is public-facing. It isn't.

### Community Setup

| Item | Decision |
|------|----------|
| License | MIT (done) |
| Issues | GitHub Issues, no templates yet (add for v0.4) |
| PRs | Welcome, but no guarantee of review timeline |
| Discord/Chat | Not yet — too early for community management overhead |
| Code of Conduct | Add standard Contributor Covenant for v0.4 |

## Consequences

### Positive
- Clear expectations for alpha users (no support promises, breaking changes expected)
- Documentation bar is achievable (SETUP.md is already the hardest part)
- Lex PoC angle gives Majel a purpose beyond "another chat wrapper"
- Shelved features list prevents scope creep
- Security posture is appropriate for the threat model (local personal tool)

### Negative
- Alpha audience is small (technically comfortable STFC players who use terminal)
- No community infrastructure yet (issues only, no chat)
- Pre-1.0 versioning means early adopters may hit breaking changes

### Risk Mitigation
- `CHANGELOG.md` documents every breaking change
- Git tags mark stable points (`v0.2.0`, `v0.3.0`)
- Shelved items documented here — prevents "when will you add X?" cycles
- Setup guide is thorough enough to be self-serve

## References

- ADR-001 (Architecture — local-first, privacy-focused)
- ADR-002 (Framework — SvelteKit is v1.0, not alpha)
- ADR-003 (Epistemic Framework — core differentiator for alpha)
- ADR-004 (AX-First API — contract for alpha API surface)
- ADR-005 (v0.3 Hardening — technical prerequisites for alpha)
- ADR-007 (Fleet Management — dry dock, crew assignments, model tool-use)
- ADR-008 (Image Interpretation — screenshot-to-data pipeline)
- [Lex](https://github.com/Guffawaffle/lex) — memory framework Majel demonstrates
