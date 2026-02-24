# Contributing to Majel

Thank you for considering contributing to Majel! This document outlines the process and guidelines for contributing to the project.

## Code of Conduct

This project adheres to the Contributor Covenant [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Project Status

Majel is currently in **open alpha** (v0.x):

- Breaking changes may occur between minor versions
- API contracts are not yet stable (stable at v1.0)
- Migration paths for breaking changes are not guaranteed
- Documentation may lag behind implementation

Alpha users accept these terms. We document breaking changes in `CHANGELOG.md` but prioritize forward progress over backward compatibility.

## Getting Started

### Prerequisites

- Node.js 22+ (LTS recommended)
- npm 10+
- Git
- A Google Gemini API key ([free tier works](https://aistudio.google.com/apikey))

### Development Setup

1. **Fork and clone:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/majel.git
   cd majel
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env — at minimum, set GEMINI_API_KEY
   ```

4. **Run development server:**
   ```bash
   npm run dev
   ```

5. **Verify setup:**
   - Open http://localhost:3000
   - Check `/api/health` — should show `"status": "online"`

## Development Workflow

### Branch Strategy

- `main` — production-ready code, tagged releases
- Feature branches: `feature/your-feature-name`
- Bug fixes: `fix/issue-description`
- Documentation: `docs/what-youre-documenting`

**Always branch from `main`:**
```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature
```

### Making Changes

1. **Keep changes focused:**
   - One feature or fix per PR
   - Related changes can be grouped (e.g., "Add crew preset endpoints + tests")
   - Avoid unrelated refactoring in feature PRs

2. **Follow existing patterns:**
   - Match the code style of surrounding code
   - Use existing abstractions (envelope responses, middleware, stores)
   - Check `docs/ADR-*.md` for architectural decisions

3. **Type safety:**
   ```bash
   npm run typecheck  # Must pass before committing
   ```

4. **Write tests:**
   - New features require tests in `test/` directory
   - Use Vitest (`npm run test`)
   - Aim for coverage parity with existing modules
   - See `test/api.test.ts` for endpoint test patterns

5. **Run local CI:**
   ```bash
   npm run local-ci  # typecheck + coverage + build
   ```

### Code Style

ESLint plus server/web type checks are enforced in pre-commit. Run:

```bash
npm run lint
npm run typecheck
npm run check:web
```

Follow these conventions:

#### TypeScript/JavaScript

- **Indentation:** 2 spaces, no tabs
- **Quotes:** Double quotes for strings (`"like this"`)
- **Semicolons:** Always use them
- **Line length:** ~120 characters (not strict)
- **Naming:**
  - `camelCase` for variables/functions (`fleetStore`, `createGeminiEngine`)
  - `PascalCase` for types/interfaces (`AppState`, `FleetConfig`)
  - `SCREAMING_SNAKE_CASE` for constants (`SETTINGS_SCHEMA`, `DEFAULT_PORT`)

#### File Organization

- **One export per file** for stores/services (`settings.ts` exports `SettingsStore`)
- **Group related routes** in route modules (`routes/core.ts`, `routes/catalog.ts`, `routes/docks.ts`)
- **Comments:** Use JSDoc for public APIs, `//` for inline clarifications
- **Imports:** Group by external deps → internal modules → types

#### API Conventions (ADR-004)

All API responses must use the envelope pattern:

```typescript
// Success
sendOk(res, { loaded: true, count: 42 });

// Failure
sendFail(res, ErrorCode.NOT_FOUND, "Ship not found", 404);
```

No raw `res.json()` or `res.status()` in route handlers.

### Commit Messages

Use conventional format:

```
type(scope): brief description

Longer explanation if needed (optional).

Fixes #123
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation changes
- `test` — test additions/fixes
- `refactor` — code restructuring, no behavior change
- `chore` — dependency updates, tooling

**Examples:**
```
feat(fleet): add crew preset tagging
fix(catalog): handle wiki sync timeout gracefully
docs(adr): add ADR-016 for catalog-overlay model
test(memory): cover recall edge cases
```

### Pull Request Process

1. **Before opening:**
   - [ ] `npm run local-ci` passes
   - [ ] Commits are clean and descriptive
   - [ ] No unrelated changes included
   - [ ] `.env` or sensitive files not committed

2. **PR description:**
   ```markdown
   ## Summary
   Brief description of what this PR does.

   ## Changes
   - Added X
   - Fixed Y
   - Updated Z

   ## Testing
   How you validated the changes.

   ## Related Issues
   Fixes #123
   ```

3. **Review process:**
   - Maintainer reviews within ~1 week (no SLA, best effort)
   - Address feedback in new commits (don't force-push unless asked)
   - Squashing happens at merge time

4. **After merge:**
   - Your branch is deleted automatically
   - Changes appear in next release

## Testing Guidelines

### Running Tests

```bash
npm run test          # Run all tests once
npm run test:watch    # Watch mode during development
npm run test:coverage # Generate coverage report
```

### Writing Tests

Use Vitest + Supertest for API tests:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/index.js";

describe("GET /api/your-endpoint", () => {
  let app: Express;

  beforeAll(async () => {
    app = await createApp();
  });

  it("should return expected data", async () => {
    const res = await request(app).get("/api/your-endpoint");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty("someField");
  });
});
```

**Key patterns:**
- Use `beforeAll`/`afterAll` for setup/teardown
- Test success and error cases
- Verify envelope structure (`ok`, `data`/`error`)
- Mock external dependencies (Gemini API) when needed

## Project Structure

```
majel/
├── src/
│   ├── server/
│   │   ├── index.ts          # App factory + server boot
│   │   ├── routes/           # Route modules (core, chat, catalog, docks, sessions, settings)
│   │   ├── config.ts         # Unified configuration resolver
│   │   ├── settings.ts       # SQLite settings store
│   │   ├── gemini.ts         # LLM engine wrapper
│   │   ├── memory.ts         # Lex integration
│   │   ├── sessions.ts       # Chat session store
│   │   ├── reference-store.ts # Reference catalog (wiki-sourced officers/ships)
│   │   ├── overlay-store.ts  # User ownership & target overlay
│   │   ├── crew-store.ts     # Crew composition (ADR-025)
│   │   └── [utilities]
│   └── client/               # Static frontend (vanilla JS)
├── test/                     # Vitest test suite
├── docs/                     # ADRs + guides
├── schemas/                  # Data schemas (JSON)
└── [config files]
```

## Architectural Decision Records (ADRs)

Major architectural decisions are documented in `docs/ADR-*.md`. **Read these before contributing:**

- [ADR-001: Architecture](docs/ADR-001-architecture.md) — Local-first philosophy
- [ADR-002: Framework](docs/ADR-002-framework.md) — Original SvelteKit recommendation (superseded by ADR-031)
- [ADR-003: Epistemic Framework](docs/ADR-003-epistemic-framework.md) — Source attribution
- [ADR-004: AX-First API](docs/ADR-004-ax-first-api.md) — Envelope pattern
- [ADR-005: v0.3 Hardening](docs/ADR-005-v03-hardening.md) — Route split, middleware
- [ADR-006: Open Alpha](docs/ADR-006-open-alpha.md) — This phase
- [ADR-007: Fleet Management](docs/ADR-007-fleet-management.md) — Drydock, crew (superseded by ADR-016)
- [ADR-008: Image Interpretation](docs/ADR-008-image-interpretation.md) — Screenshot pipeline (planned)
- [ADR-009: Structured Logging](docs/ADR-009-structured-logging.md) — Pino JSON logs
- [ADR-010: Drydock Loadouts](docs/ADR-010-drydock-loadouts.md) — Ship configurations
- [ADR-011: Data Sovereignty](docs/ADR-011-data-sovereignty.md) — Sheet-as-bootstrap, app-as-truth
- [ADR-012: Reference Data](docs/ADR-012-reference-data.md) — Localization templates + user input
- [ADR-013: Wiki Data Import](docs/ADR-013-wiki-data-import.md) — Attribution, consent & ingest
- [ADR-014: MicroRunner](docs/ADR-014-microrunner.md) — Runtime prompt enforcement
- [ADR-015: Canonical Entity Identity](docs/ADR-015-canonical-entity-identity.md) — Wiki-based entity IDs
- [ADR-016: Catalog-Overlay Model](docs/ADR-016-catalog-overlay-model.md) — Reference + overlay architecture
- [ADR-017: Fleet Tab & Player Roadmap](docs/ADR-017-fleet-tab-and-player-roadmap.md) — Inline-editable roster
- [ADR-018: Cloud Deployment](docs/ADR-018-cloud-deployment.md) — GCP Cloud Run + Cloud SQL
- [ADR-019: User System](docs/ADR-019-user-system.md) — 4-tier RBAC (visitor → admiral)
- [ADR-020: Admiral Console](docs/ADR-020-admiral-console.md) — Admin diagnostic tooling
- [ADR-021: Postgres Frame Store](docs/ADR-021-postgres-frame-store.md) — Lex memory on PostgreSQL with RLS
- [ADR-022: Loadout Architecture](docs/ADR-022-loadout-architecture.md) — Store-inversion pattern
- [ADR-023: Architecture Restructure](docs/ADR-023-architecture-restructure.md) — MVC-by-concern client refactor
- [ADR-025: AI Tools & Briefing](docs/ADR-025-ai-tools-briefing.md) — Crew composition tools
- [ADR-027: GenAI SDK Migration](docs/ADR-027-genai-sdk-migration.md) — @google/generative-ai → @google/genai
- [ADR-028: Data Pipeline Roadmap](docs/ADR-028-data-pipeline-roadmap.md) — CDN data ingest
- [ADR-029: Package Upgrades](docs/ADR-029-package-upgrades.md) — Dependency modernization
- [ADR-030: View Consolidation](docs/ADR-030-view-consolidation.md) — 10 views → 7 views
- [ADR-031: Svelte Migration](docs/ADR-031-svelte-migration.md) — Svelte 5 + Vite (no Kit)
- [ADR-032: Local-First Cache](docs/ADR-032-local-first-cache.md) — IndexedDB + SWR strategy
- [ADR-033: Timer Overlay](docs/ADR-033-timer-overlay.md) — Multi-timer with audio alerts

If your change challenges an ADR decision, discuss it in an issue before coding.

## Feature Requests & Bug Reports

### Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml):

- Include steps to reproduce
- Provide relevant logs (`npm run dev` output)
- Mention your environment (Node version, OS)
- Check `/api/diagnostic` output

### Requesting Features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml):

- Describe the use case, not just the solution
- Explain who benefits (STFC players? Lex showcase? Maintainers?)
- Acknowledge alpha status — some features are shelved intentionally (see ADR-006)

## What We're NOT Accepting (Alpha Boundaries)

These are explicitly shelved for v1.0 or later. PRs adding these will be declined:

- Plugin/extension systems
- SvelteKit migration (v1.0 scope)
- Mobile native apps
- Alliance/guild features (multi-tenant)
- Third-party OAuth providers (Google, Discord, etc.)
- Horizontal scaling / multi-region deployment

Note: Multi-user auth (ADR-019), cloud deployment (ADR-018), and model selection (ADR-020) have shipped.
See [ADR-006](docs/ADR-006-open-alpha.md) for the original shelved features list.

## Communication

- **GitHub Issues** — bug reports, feature requests, discussions
- **Pull Requests** — code contributions
- **No chat/Discord yet** — project is too early for community management overhead

Response times are best-effort. Majel is a side project.

## License

By contributing, you agree that your contributions will be licensed under the same [ISC License](LICENSE) that covers the project.

---

**Thank you for helping make Majel better!** 🖖

*Live long and prosper.*
