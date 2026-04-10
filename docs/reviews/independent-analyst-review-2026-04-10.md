# Independent Analyst Review - Majel

**Date:** 2026-04-10  
**Scope:** Current code state in `main`, active planning surface in `docs/ROADMAP-2026.md`, live status in `BACKLOG.md`, and adjacent data-pipeline dependency in `stfc.space`  
**Review posture:** Best-case technical, architectural, and strategic assessment. This review is intentionally opinionated toward what the system should become if optimized correctly, not what is merely acceptable in the current moment.

## Executive Summary

Majel is no longer a prototype looking for a product. It is a product looking for consolidation. The codebase already contains the ingredients of a serious personal AI operating surface: explicit architectural decisions, a well-factored store layer, a disciplined tool registry, real operational tooling, and a roadmap that understands sequencing better than most early-stage products do. The strongest signal is not the feature list. It is the repeated pattern of turning discovered failures into architecture and tests instead of tribal knowledge.

The primary weakness is not technical incompetence, nor even technical debt in the usual sense. The weakness is dispersion. Too much of the system's sophistication lives in parallel surfaces that have not yet fully converged: prompt hardening, MicroRunner, Lex memory, effect reasoning, tool routing, the future `stfc.space` feed, and UI/tab rationalization. The project risks becoming "rich but not yet sharp" if it continues adding capability without forcing earlier surfaces to become simpler and more truthful.

The roadmap is directionally strong. The recent decision to move E3 instance modeling earlier is correct and should be treated as a structural correction, not a preference change. The next phase should prioritize schema truth, pipeline legitimacy, and enforced quality gates before adding more presentation or externalization surfaces. In other words: make the state model honest, make the reference layer authoritative, and make regressions non-optional.

## Method

This review is grounded in the current repository state, especially these files:

- `BACKLOG.md`
- `docs/ROADMAP-2026.md`
- `package.json`
- `src/server/index.ts`
- `src/server/routes/chat.ts`
- `src/server/services/gemini/system-prompt.ts`
- `src/server/services/micro-runner.ts`
- `src/server/services/gamedata-ingest.ts`
- `src/server/services/fleet-tools/tool-registry.ts`
- `src/server/stores/reference-store.ts`
- `src/server/stores/overlay-store.ts`
- `web/src/App.svelte`
- `docs/adr/ADR-004-ax-first-api.md`
- `docs/adr/ADR-051-instance-modeling.md`
- `docs/DATA_PIPELINE_CONTRACT.md`

Supporting quantitative signals used in this review:

- `2541` passing tests in CI
- `20` route files
- `30` store files
- `32` fleet tool service files
- `75` docs files
- `123` test files
- `945` lines in `src/server/index.ts`
- `1007` lines in `src/server/routes/chat.ts`
- `546` lines in `src/server/services/fleet-tools/tool-registry.ts`
- Dirty working tree currently limited to `docs/ROADMAP-2026.md`

## What Majel Is Actually Becoming

Majel is evolving from a currently single-operator deployment into a multi-tenant, reference-grounded, stateful AI operations console for STFC. Today there is only one live user; that should not dictate the architectural target. The data model, store boundaries, auth layer, and audit surfaces should be built as if secure tenant isolation is a permanent requirement. That is more precise than "chat app with tools" and more honest than "general assistant." The real product is a three-layer system:

1. A normalized game-reference and user-overlay model.
2. A controlled reasoning layer that can query, mutate, and explain against that state.
3. A user surface that increasingly treats chat as the primary operator interface and the conventional UI as fallback instrumentation.

That framing matters because it clarifies which work is foundational and which work is decorative. Instance modeling, feed legitimacy, mutation auditability, prompt regression gating, tenant-safe identity boundaries, and clean tool contracts are foundational. Cards, slash commands, and tab cleanup are decorative until the foundation is correct.

## Current Strengths

### 1. The project has genuine architectural discipline

Majel is unusually explicit about decisions. The ADR habit is not cargo-cult documentation. It is clearly being used to force tradeoff visibility before implementation. `docs/adr/ADR-004-ax-first-api.md` shows this directly: the API envelope, diagnostics, and discovery principles are described as contracts, not as incidental route behavior. `docs/adr/ADR-051-instance-modeling.md` likewise frames schema truth as a product requirement, not a low-level migration detail.

This matters because the project already spans several failure-prone domains at once: LLM orchestration, mutable user state, structured reference data, operational tooling, and frontend interaction design. Without explicit decisions, this kind of system usually collapses into hidden coupling. Majel has avoided that more successfully than most comparable projects.

### 2. The store layer is cleaner than the application shell

The most mature architectural seam in the codebase is the store/factory pattern. `src/server/app-context.ts` makes the dependency graph visible, and the user-scoped factory model is the right long-term move. `src/server/stores/overlay-store.ts` and the other store modules show that row-level scoping is treated as a structural invariant, not a convention.

This is a major strength because it means later changes to reasoning, routing, or UI do not require rethinking persistence boundaries from scratch. The domain model is not perfect yet, but the access pattern is correct.

### 3. Tooling and operations are taken seriously

`package.json` and the `ax` command family show strong operational hygiene. The project has already crossed the threshold where local CI, cloud deploy workflows, data hygiene checks, and typed operational scripts are part of the product, not side chores. This is reinforced by the backlog's use of CI pass counts and deployed revision references as planning inputs.

This is strategically important. AI-heavy products fail when they cannot distinguish model quality problems from operational drift. Majel has already invested in that distinction.

### 4. The product framing is sharper than the surface currently reveals

The roadmap is not a feature bucket. It has a coherent thesis: truth floor first, then data legitimacy, then domain honesty, then surface upgrade, then externalization and quality gates. That ordering is intellectually correct. It recognizes that the value of an AI operator surface depends on groundedness, not charm.

In particular, the milestone framing in `docs/ROADMAP-2026.md` is strong. "M1 becomes testable, not a belief" is the right level of rigor.

### 5. The project learns from failures instead of hiding them

The recent work around hostile/system filters, prompt hardening, regression baselines, and the armada-context tool suggests a healthy development pattern: find a real failure mode, isolate root cause, add tests, harden the contract, then move on. This is the right pattern for AI-integrated software. It reduces the chance of building an impressive but non-repeatable demo.

## Principal Limitations and Risks

### 1. The chat execution path is the main architectural hotspot

`src/server/routes/chat.ts` is too central. It does too much: context building, token budget checks, run orchestration, cancellation, event emission, memory recording, proposal handling, and trace packaging. Even if the code is internally reasonable, the file is acting as an execution chokepoint.

This is not just a cleanliness complaint. It raises the cost of changing reasoning behavior. Every new capability that touches chat has to be introduced near the hottest path in the system. That increases regression risk and slows experimentation. The codebase needs a `chat-executor` or equivalent service boundary so the route becomes transport-only.

### 2. The application shell is more mature than the execution internals suggest

`src/server/index.ts` is still a large composition root. Large composition roots are not inherently bad, but this one now carries enough boot and middleware responsibility that it deserves further separation. The codebase has clean stores and a decent route split, but the startup shell is still carrying historical mass.

This is survivable, not urgent. But it is a sign that architecture has advanced faster at the domain layer than at the orchestration layer.

### 3. The roadmap still has a convergence problem

Majel has several advanced subsystems whose value is not yet fully compounded:

- MicroRunner exists, but its current gating in `src/server/services/micro-runner.ts` is intentionally thin.
- Lex exists, but mutation events are not yet part of the memory story.
- The effects stack appears substantial, but its leverage in mainstream Aria interactions is not yet obvious from the top-level product framing.
- The `stfc.space` crawler and Majel ingest story are conceptually aligned, but not yet one system.

This creates a strategic danger: adding more surfaces before current ones converge into a tighter whole.

### 4. Documentation drift is real

The roadmap and backlog are more current than the README. The README still describes earlier test counts, surface counts, and architecture summaries that no longer match the live state. For an internal personal project, that is tolerable. For a system increasingly treated as a platform, it becomes misleading.

This is not a branding problem. It is a trust problem between the declared system and the actual one. The backlog is behaving like the true operating ledger; the README is behaving like a stale brochure.

### 5. The state model is still not fully honest

This is the most important functional limitation. `src/server/stores/overlay-store.ts` still encodes a one-row-per-ship identity model. `docs/adr/ADR-051-instance-modeling.md` correctly identifies why this is wrong. The project is now mature enough that this cannot be treated as a nice-to-have. If the system cannot faithfully represent duplicate ships, some of its strategic reasoning is definitionally compromised.

This is why moving E3 earlier was correct. It is not about user preference. It is about model honesty.

### 6. The reference pipeline is in transition, which means the product is in epistemic transition

`src/server/services/gamedata-ingest.ts` still reflects the current CDN-centered import path, while `docs/DATA_PIPELINE_CONTRACT.md` and the roadmap make clear that `stfc.space` is the intended future authority. That means Majel is currently between truth sources.

This is manageable, but it needs to be treated with architectural seriousness. While the pipeline is bifurcated, every new tool that depends on reference truth increases the eventual cutover burden. E2 is therefore not just a data task. It is a truth-layer migration.

Just as important, `stfc.space` should be treated as an upstream crawl-and-feed source, not as a runtime query dependency for Majel. The crawler workspace itself already encodes a respectful access model: a 24-hour minimum run policy, conditional requests, `Retry-After` honoring, low request cadence, explicit request-policy receipts, content-hash reuse, and retention/prune behavior for exported feed artifacts. That is a strong signal that the right integration surface is versioned exported feeds and ingest snapshots, not on-demand remote lookups at Majel scale.

### 7. Prompt quality is ahead of enforcement quality

The prompt and tool-use contract in `src/server/services/gemini/system-prompt.ts` is sophisticated. That is a strength. But it also means more responsibility is still living in prompt text than in enforced runtime behavior. The project knows this, which is why regression work exists, but E6 remains later than it should be.

The minimal correction is to make deterministic prompt-regression checks part of the non-optional CI surface immediately. The baseline exists. It should now become binding.

### 8. The UI still exposes more structure than the product actually wants

`web/src/App.svelte` still presents the full eight-view topology. The roadmap explicitly says this should eventually collapse, demote, or merge. The issue is not the number of tabs itself. The issue is that the UI still reflects the system's construction history more than its intended operational model.

That is fine for now, but only if the project remains disciplined about not polishing deprecated surfaces faster than it consolidates the reasoning model underneath them.

## Roadmap Assessment

The roadmap is broadly strong. Its biggest virtue is that it distinguishes foundational work from presentation work. That alone puts it ahead of many technical plans.

The recent adjustment to move E3 instance modeling into Phase B is correct on technical, architectural, and strategic grounds.

### Why the E3 move is correct

E3 is not downstream of the ingest pipeline in any meaningful way. It touches the overlay truth model, not reference data legitimacy. That makes it parallelizable with E2.2.

More importantly, E3 is upstream of later work whether the roadmap used to admit it or not. The following areas should not harden on top of the wrong identity model:

- E4.2 response cards
- E4.4 Lex mutation memory
- E5.1 MCP surface

If those surfaces ship before E3, the retrofit cost multiplies. If E3 lands first, those later epics become cleaner by default.

### Where the roadmap is strongest

- Phase A / M1 was exactly the right first milestone.
- E2 as a legitimacy layer is correctly framed as foundational.
- The plan does not confuse UI simplification with product maturity.
- The plan understands that externalization via MCP should lag internal truth.

### Where the roadmap is still vulnerable

- E6 is placed too politely. Deterministic regression enforcement should partially move left now.
- E4.4 Lex mutation memory is later than ideal given how cheaply some of its value could be captured earlier.
- E1.4 Slice 2 risks expanding into game-mechanics complexity before the effect/debuff model is sufficiently explicit.

## What Should Happen Next

If the project is optimized for best-case technical and strategic outcome, the next sequence should be:

1. **E3 instance modeling**
   Lock the identity model before new display and external interfaces harden.

2. **E2.2 ingestor in parallel**
   Move the reference layer toward a single trustworthy authority built on exported feeds and retained snapshots, not direct runtime queries.

3. **Immediate CI elevation of deterministic prompt-regression checks**
   Do not wait for full E6 to make the baseline binding.

4. **Mutation-event capture into Lex, even before full E4.4**
   Start collecting decision memory now. Perfect retrieval can come later.

5. **Refactor the chat execution path into a service boundary**
   Reduce the blast radius of future reasoning changes.

6. **Only then continue surface work and MCP externalization**
   Cards and MCP should expose a correct model, not a legacy one.

## Strategic Gaps

### Where the project is missing the mark

Majel occasionally behaves as if more capability automatically equals more maturity. It does not. The project's biggest need is not another clever feature. It is consolidation pressure. Several strong subsystems now exist, but they do not yet compound as a single coherent product as much as they should.

The main missing discipline is forced simplification. Each time a new layer proves out, an older surface should either shrink, lose authority, or become explicitly instrumental. Otherwise the project accumulates parallel truths: prompt truth, route truth, UI truth, roadmap truth, and operator truth.

### Where the biggest opportunity is being underused

The biggest underused asset is Lex, not as generic chat history but as operational memory. Majel is unusually well-positioned to become a true decision-memory system for game operations because it already has structured mutations, a time-aware planning surface, and a user-specific domain model. If mutation frames, target evolution, and dock changes become first-class memory artifacts, the system gains longitudinal intelligence that most assistants never achieve.

The second underused opportunity is explicit "reference freshness" as a user-visible concept. Once the feed pipeline stabilizes, Majel should expose when data was last ingested, what source it came from, and what uncertainty class applies. That would turn epistemic honesty into a product feature rather than a hidden implementation virtue.

## Final Judgment

Majel is credible. That matters more than polish. The architecture is real, the roadmap is mostly coherent, the testing culture is serious, and the product thesis is stronger than the current surface suggests. The codebase is not in trouble. It is entering the more difficult phase where success depends less on invention and more on pruning, convergence, and order of operations.

If the project stays disciplined about truth-model correctness, data legitimacy, and enforced regression gates before further surface expansion, it has a strong chance of becoming a genuinely differentiated personal AI system rather than an unusually ambitious hobby app.

If it does not, the likely failure mode is not collapse. It is dilution: too many good subsystems, not enough forced coherence.