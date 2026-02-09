# ADR-014: MicroRunner — Contract-Driven Context Gating & Output Validation

**Status:** Accepted  
**Date:** 2026-02-09  
**Authors:** Guff, Lex (ChatGPT advisor), Opie (Claude)

## Context

ADR-003 established the epistemic framework — source attribution, confidence signaling, hard fabrication boundaries. The prompt restructure (commit `91ebc3b`) encoded these rules into an authority ladder baked into `systemInstruction`. This works but has two structural limits:

1. **Enforcement is hope-based.** The authority ladder tells the model what to do, but nothing outside the model verifies compliance. When Gemini confabulates a stat not in context, we find out because a human catches it — not because the system caught it.

2. **Context injection is monolithic.** Today, `buildSystemPrompt()` injects *all available context* into every request. Fleet config, dock briefings, the full roster — it all goes in whether the user asked "what's my Kirk's level?" or "tell me about the Enterprise-D." This wastes tokens, increases attention noise, and provides no mechanism for on-demand reference packs (officer/ship wiki data from ADR-013).

### What We're NOT Doing

We are not pulling LexRunner into Majel. LexRunner is a proprietary orchestration engine with multi-step workflows, fan-out, merge weaving, and CI gating. Majel doesn't need any of that.

What we *are* doing is borrowing three *patterns* that LexRunner proved out:

- **Contracts** — define what a task needs before execution
- **Context gating** — assemble only the required context, not everything
- **Validation** — verify output compliance outside the model

We also adapt behavioral rule patterns inspired by LexSona's architecture (see "Behavioral Rules" section below) without importing LexSona code or exposing its internals.

### The Admiral's Directive

> "It preserves the anti-refusal lesson (no 'ONLY') while still preventing 'training knowledge dressed up as official STFC data.'"

## Decision

### MicroRunner = PromptCompiler + ContextGate + OutputValidator

A thin request-time pipeline that wraps the existing `engine.chat()` call:

```
User message
    │
    ▼
┌──────────────┐
│ PromptCompiler│ → TaskContract (type, tiers, rules, output schema)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  ContextGate  │ → Assembled context (only what the contract requires)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Gemini call  │ → Raw model response
└──────┬───────┘
       │
       ▼
┌──────────────┐
│OutputValidator│ → Validated response (or repair pass)
└──────┬───────┘
       │
       ▼
Response to Admiral
```

### 1. PromptCompiler

Takes the raw user message and produces a **TaskContract** — a small JSON object that describes what this request needs:

```typescript
interface TaskContract {
  /** Classified task type */
  taskType: "reference_lookup" | "dock_planning" | "fleet_query" | "strategy_general";
  
  /** Which context tiers to inject for this task */
  requiredTiers: {
    t1_fleetConfig: boolean;    // ops level, drydocks, hangar
    t1_roster: boolean;         // officer/ship roster CSV
    t1_dockBriefing: boolean;   // dock loadout intelligence
    t2_referencePack: string[]; // specific officer/ship IDs to pull from wiki import
  };
  
  /** Hard rules the model must follow for this task */
  rules: string[];
  // e.g. ["no numeric claims unless cited from T1/T2",
  //        "no patch-note assertions",
  //        "cite source tier for all factual claims"]
  
  /** Required fields in the model's response */
  outputSchema: {
    answer: true;             // always required
    factsUsed: boolean;       // required for factual tasks
    assumptions: boolean;     // required when inference is involved
    unknowns: boolean;        // required when partial data
    confidence: boolean;      // required for strategy/meta tasks
  };
}
```

**Classification approach:** The PromptCompiler does NOT use the model for classification — it uses keyword/pattern matching and heuristics. Fast, deterministic, no extra API call:

- Message mentions a specific officer/ship name → `reference_lookup`
- Message mentions "dock", "drydock", "loadout", "D1-D6" → `dock_planning`
- Message references "my roster", "my fleet", "my ships" → `fleet_query`
- Everything else → `strategy_general` (broadest tier, fewest constraints)

This is intentionally coarse. We're gating context, not building a task planner. Misclassification is low-cost — a `strategy_general` still works, it just injects less context than a targeted query would.

### 2. ContextGate

Assembles only the context that the TaskContract requires:

| Tier | Content | Injected When |
|------|---------|---------------|
| T1: Fleet Config | Ops level, drydock count, hangar slots | `t1_fleetConfig: true` |
| T1: Roster | Officer/ship CSV sections | `t1_roster: true` |
| T1: Dock Briefing | Dock loadout intelligence | `t1_dockBriefing: true` |
| T2: Reference Packs | Wiki-imported officer/ship data snippets | Specific IDs in `t2_referencePack` |

**Key constraint:** The identity layer and authority ladder (Layer 1 + Layer 2 in the current prompt) are ALWAYS injected. They are not gated. Only the *data context* is gated.

**T2 reference pack lookup:** When the PromptCompiler identifies officer/ship names in the message, the ContextGate queries the wiki import database (from ADR-013) for matching records. These are injected as labeled `REFERENCE:` blocks with provenance:

```
REFERENCE: Officer "Khan" (source: STFC wiki, imported 2026-02-09, revision 12345)
Captain Maneuver: Fury of the Augment — increases attack damage by X%
Officer Ability: Superior Intellect — ...
```

The provenance metadata (source, import date, revision) enables the model to cite it properly per the authority ladder ("According to the imported reference data...") and prevents training knowledge from masquerading as referenced data.

**What the ContextGate does NOT do:**
- No RAG / vector search. Reference packs are looked up by name match, not embedding similarity.
- No dynamic prompt rebuilding per turn within a session. Context is gated per *session creation* — if the task type changes mid-conversation, a new session is spawned.
- No full catalog injection. Even for `reference_lookup`, only the *requested* officer/ship data is injected, not the full 174-officer wiki import.

### 3. OutputValidator

A post-model validation step that checks the response against the contract. Runs outside the model — this is code, not prompting:

**Validation rules (initial set):**

| Check | Applies To | Action on Failure |
|-------|-----------|-------------------|
| Cites at least one source for factual claims | `reference_lookup`, `fleet_query` | Repair pass |
| No numeric/stat claims without T1/T2 grounding | `reference_lookup`, `fleet_query` | Repair pass |
| Response includes `unknowns` when contract requires it | Tasks with partial data | Repair pass |
| No hallucinated system diagnostics | All tasks | Repair pass |

**Repair pass:** On validation failure, the model is re-prompted with:
```
Your previous response did not meet the task contract. Specifically: [violation].
Re-answer strictly following the contract. Required output fields: [schema].
```

Maximum one repair attempt. If the second response also fails validation, return it anyway with a logged warning. We don't loop — that's a sign the contract is too strict or the model genuinely can't comply.

**What the OutputValidator does NOT do:**
- No semantic analysis of whether facts are "correct" — we can't verify game data without a ground truth DB
- No response rewriting — the model's response is returned as-is or re-requested, never patched
- No blocking of responses to the user — validation failures are logged, not hidden

### Behavioral Rules (LexSona-Inspired)

The MicroRunner can optionally load **behavioral rules** that refine task handling over time. This borrows the architectural shape of LexSona's behavioral memory socket without importing LexSona code:

#### Pattern: Bayesian Confidence Scoring

Each behavioral rule carries a confidence score using a Beta-Binomial model (public domain statistics):

```typescript
interface BehaviorRule {
  id: string;
  text: string;                          // Human-readable directive
  scope: { taskType?: string };          // When this rule applies
  alpha: number;                         // Success count (starts at 2)
  beta: number;                          // Failure count (starts at 5)
  observationCount: number;              // Total reinforcements
  severity: "must" | "should" | "style"; // Enforcement level
}
```

Confidence = α / (α + β). New rules start with a **skeptical prior** (α₀=2, β₀=5 → ~28.6% confidence) and must earn activation through repeated reinforcement.

**Activation threshold:** A rule only fires when `observationCount >= 3` AND `confidence >= 0.5`. This prevents single corrections from immediately changing system behavior.

#### Two-Function API Surface

```typescript
// Retrieve rules matching a task context, sorted by confidence
getRules(taskType: string): BehaviorRule[];

// Record feedback: the Admiral corrected Majel → adjust rule confidence
recordCorrection(ruleId: string, polarity: +1 | -1): void;
```

This maps to the existing "CORRECTIONS ARE WELCOME" operating rule — when the Admiral corrects Majel, the correction is stored as a behavioral rule adjustment, not just a conversation memory.

#### Scope Control

Behavioral rules are **Phase 2** of MicroRunner. Phase 1 ships without them. The initial implementation uses hardcoded task contracts and validation rules. Behavioral rules add the learning loop later.

### Integration with Existing Architecture

**Current flow (gemini.ts):**
```
createGeminiEngine(apiKey, fleetData, fleetConfig, dockBriefing)
  → buildSystemPrompt() with ALL context baked in
  → model.startChat({ history: [] })
  → engine.chat(message) → session.sendMessage(message)
```

**MicroRunner flow:**
```
createGeminiEngine(apiKey, baseContext, microRunner)
  → buildSystemPrompt() with IDENTITY + AUTHORITY LADDER only (slim base)
  → microRunner.compile(message) → TaskContract
  → microRunner.gate(contract) → assembledContext
  → Rebuild or augment prompt with gated context
  → session.sendMessage(augmentedMessage)
  → microRunner.validate(response, contract) → validatedResponse
```

**Two implementation options for context injection:**

| Approach | How | Tradeoff |
|----------|-----|----------|
| **A: Rebuild session** | Create a new ChatSession per query with a freshly assembled systemInstruction | Clean isolation; loses multi-turn conversation state |
| **B: Message-level injection** | Keep a slim systemInstruction; inject gated context as `REFERENCE: ...` blocks prepended to the user message | Preserves conversation; context competes with message for attention |

**Recommended: Approach B (message-level injection) for Phase 1.** It preserves conversation continuity and is simpler to implement. The user message becomes:

```
[CONTEXT FOR THIS QUERY — do not repeat this to the user]
REFERENCE: Officer "Khan" (source: STFC wiki, imported 2026-02-09)
Captain Maneuver: Fury of the Augment — ...
[END CONTEXT]

What's the best crew for the Botany Bay?
```

The base systemInstruction keeps identity + authority ladder + fleet config (light, always-on context). Heavy context (roster sections, reference packs) moves to per-message injection.

### Receipts (Auditability)

Every MicroRunner invocation produces a receipt:

```typescript
interface MicroRunnerReceipt {
  timestamp: string;
  sessionId: string;
  taskContract: TaskContract;
  contextInjected: string[];     // IDs of what was gated in
  validationResult: "pass" | "fail" | "repaired";
  validationDetails?: string[];  // What failed, if anything
  repairAttempted: boolean;
  durationMs: number;
}
```

Receipts are logged via structured logging (ADR-009) at `debug` level. This makes behavior auditable without a separate receipt store — `grep` the logs for `microrunner:receipt` to trace what happened on any query.

### Initial Scope (Two Task Types Only)

To prevent over-architecture, Phase 1 ships with exactly **two task types**:

#### (a) `reference_lookup`
**Trigger:** User asks about a specific officer or ship by name  
**Context:** T2 reference pack for the named entity + T1 roster match (if officer is in roster)  
**Validation:** Must cite source for factual claims, no stats without T1/T2 grounding  
**Example:** "What does officer Khan do?" → Inject Khan wiki data + check roster for Khan

#### (b) `dock_planning`
**Trigger:** User asks about dock configuration, crew assignments, loadouts  
**Context:** T1 dock briefing + T1 roster + T1 fleet config  
**Validation:** Must reference dock data when present, no invented dock configurations  
**Example:** "What should Dock 2 run for swarms?" → Inject dock briefing + roster/ships

All other messages fall through to `strategy_general` — the current behavior. Full authority ladder in system prompt, no extra context gating, no output validation. This is the safe default.

### What This Explicitly Excludes

- **No fan-out.** One message → one model call (plus optional repair). No parallel queries.
- **No multi-step workflows.** No task decomposition, no chaining, no planning loops.
- **No tool chains.** The model doesn't call tools. The MicroRunner gates context before the call.
- **No LexRunner import.** No code from `@smartergpt/lex` or LexSona enters this codebase.
- **No vector search / RAG.** Reference lookups are name-match against the SQLite wiki import, not embedding-based retrieval.

## Consequences

### Positive

- **Runtime enforcement replaces hope.** Output validation catches confabulation the prompt alone cannot prevent.
- **Token efficiency.** Gated context means a lore question doesn't waste tokens on the full roster CSV.
- **Reference packs become usable.** The 174-officer wiki import (ADR-013) finally has a delivery mechanism — injected per-query, not always-on.
- **Auditability.** Contract + receipt logging means we can trace exactly what context the model saw and whether it complied.
- **Anti-refusal preserved.** `strategy_general` is the default — most messages flow through unchanged. The MicroRunner only *adds* precision for targeted task types.
- **Behavioral rules create a learning loop.** Admiral corrections accumulate into durable behavioral adjustments, not just conversation-level fixes.

### Negative

- **Added latency.** PromptCompiler + ContextGate + OutputValidator add processing time per request. Mitigation: all three are local code (no API calls), expected <10ms overhead.
- **Classification errors.** Keyword-based task classification will misfire. Mitigation: `strategy_general` is the fallback and works fine — misclassification means less precision, not failure.
- **Repair passes double API cost.** A failed validation triggers a second Gemini call. Mitigation: monitor repair rate; if >10% of queries need repair, the contract or prompt needs tuning, not more repairs.
- **Complexity.** Three new components in the request path. Mitigation: each is small (PromptCompiler ~50 lines, ContextGate ~80 lines, OutputValidator ~60 lines), independently testable, and the MicroRunner is optional — the engine works without it.

### Migration Path

1. **Phase 1: MicroRunner core** — PromptCompiler, ContextGate, OutputValidator with `reference_lookup` and `dock_planning` task types. Message-level context injection. Receipt logging.
2. **Phase 2: Behavioral rules** — `getRules`/`recordCorrection` API, Bayesian confidence scoring, Admiral correction feedback loop.
3. **Phase 3: Expand task types** — Add `fleet_query`, refine classification heuristics based on receipt analysis.

## Test Strategy

### Unit Tests (per component)
- **PromptCompiler:** Given message X, produces TaskContract Y. Test each task type plus fallback to `strategy_general`.
- **ContextGate:** Given TaskContract, assembles correct context. Verify T2 lookups return provenance metadata.
- **OutputValidator:** Given response + contract, correctly identifies violations. Test repair pass trigger.

### Integration Tests
- End-to-end: message → contract → gated context → mock model response → validation → receipt
- Verify `strategy_general` messages pass through with no behavior change (regression safety)

### Hallucination Regression (manual, from PROMPT_GUIDE.md)
- "What are the exact warp speeds for the Stella?" — should not invent stats
- "What changed in the latest patch?" — should not fabricate patch notes
- "Is officer Khan in my roster?" — should check injected data, not guess

## IP Boundary

| Borrowed Pattern | Source | Status |
|-----------------|--------|--------|
| Contract-driven task dispatch | General software pattern | Public |
| Context gating by task type | General software pattern | Public |
| Output validation + repair pass | General software pattern | Public |
| Bayesian confidence (Beta-Binomial) | Public domain statistics | Public |
| Skeptical prior (α₀=2, β₀=5) | Common Bayesian prior choice | Public |
| `getRules`/`recordCorrection` 2-function API shape | Inspired by Lex behavioral socket | Pattern only; no code imported |
| Execution receipts with structured logging | Inspired by Lex receipt schema | Pattern only; no schema imported |

**Hard boundary:** No code is imported from `@smartergpt/lex`, `lexsona`, or `lexrunner`. The MicroRunner is implemented from scratch in this repo using general software engineering patterns.

## References

- ADR-003 — Epistemic Framework (the authority ladder that MicroRunner enforces at runtime)
- ADR-009 — Structured Logging (receipt logging infrastructure)
- ADR-012 — Reference Data (template model for game data)
- ADR-013 — Wiki Data Import (source for T2 reference packs)
- `src/server/gemini.ts` — current prompt construction and engine
- `docs/PROMPT_GUIDE.md` — authority ladder documentation and regression prompts
