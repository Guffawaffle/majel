# Aria Prompt Tuning Guide

How we tune Aria's behavior without fine-tuning the underlying model.

## TL;DR

There are **four levers** for controlling Aria's behavior:

1. **System Prompt** — identity, authority model, knowledge boundaries, fleet context
2. **Safety Settings** — Gemini's content filters (harassment, violence, etc.)
3. **MicroRunner** — contract-driven context gating and output validation (ADR-014)
4. **Model Parameters** — temperature, top_p, top_k (not yet exposed)

The system prompt is where most tuning happens. The MicroRunner enforces the authority ladder at runtime. Safety settings are a one-time config. Model parameters are for fine-grained control later.

---

## 1. System Prompt Architecture

The prompt is built in layers (see `src/server/gemini.ts`):

### Layer 1: Identity
Who is Aria? This never changes regardless of data availability.

```
You are Aria, the Fleet Intelligence System aboard Admiral Guff's flagship.
Your full designation is Ariadne — named in honor of Majel Barrett-Roddenberry (1932–2008).
```

**Why it's first:** LLMs weight the beginning of the system prompt heavily. Identity anchors all behavior.

Personality is kept tight: "Calm, concise, shows your work. Precision IS your personality." Star Trek flavor is seasoning, not the main dish.

### Layer 2: Scope & Authority (the Authority Ladder)

**The core operating principle:** Aria may discuss *any topic* — but must rank her sources and signal which tier an answer comes from.

```
AUTHORITY LADDER (strongest → weakest):
1. INJECTED DATA — Fleet roster, dock config, reference packs. The Admiral's actual state.
2. REFERENCE PACKS — Wiki-imported catalogs with known provenance.
3. TRAINING KNOWLEDGE — General model knowledge. UNCERTAIN for patch-sensitive specifics.
4. INFERENCE — Conclusions drawn from combining sources. Always labeled.
```

**Evolution of this section:**

| Version | Approach | Problem |
|---------|----------|---------|
| v1 "cage" | "Use ONLY the provided data" | Model refused to discuss anything not in the CSV |
| v2 "floodgate" | "You have FULL ACCESS and cover ship stats, tier lists, PvP meta..." | Model confabulated authoritative-sounding game data it doesn't have |
| v3 "authority ladder" | "Discuss anything, but rank your sources" | Permits broad discussion while requiring epistemic honesty |

**Critical lesson:** "Never restrict" was the right instinct in v2, but listing specific STFC domains as known capabilities (ship stats, tier lists, PvP meta) implied authoritative knowledge the model doesn't have. The authority ladder preserves permission to discuss any topic while requiring the model to signal *where* its answer comes from and *how certain* it is.

The **critical boundary**: never present training knowledge as if it were injected data. If the Admiral asks for a specific number and it's not in context, say so rather than guessing.

### Hard Boundaries

Things Aria must never fabricate, regardless of source tier:
- Specific numbers not in context (stats, costs, percentages, dates)
- System diagnostics or runtime state (memory frames, connection status, settings values)
- Quotes or statements the Admiral supposedly made
- Data claimed to be in context that isn't actually there
- Game patch notes or version numbers without certainty

### Operating Rules

1. **Source attribution** — always name where an answer comes from (injected data, training, inference)
2. **Confidence signaling** — match language to certainty (direct for high, hedged for moderate, explicit for low)
3. **Decomposition** — when uncertain, separate what's known from what isn't
4. **Corrections welcome** — accept corrections without defensiveness

### Architecture Section

Describes Aria's technical stack in *general terms only*. No live state claims.

The model cannot inspect its own subsystems at runtime — it doesn't know memory frame counts, connection status, or settings values unless they're injected into context. For diagnostics, it directs users to `/api/health`.

### Layer 3: Context Injection

Fleet data is injected into the system prompt with provenance:

- **Structured data:** Labeled with import timestamp — "imported from Google Sheets at {fetchedAt}"
- **Legacy CSV:** Labeled as imported roster data
- **No data:** Model notes the roster isn't connected and signals uncertainty for patch-sensitive specifics

### Anti-Patterns to Avoid

| Don't | Do | Why |
|-------|-----|-----|
| "Use ONLY the provided data" | "Use the CSV as your primary source for roster questions" | "ONLY" triggers aggressive restriction |
| "You cannot discuss external topics" | "You can discuss anything" | Causes refusal behavior |
| "My access is limited to..." | "I have full access to..." | Self-limiting language cascades |
| "I am unable to process..." | Just answer the question | Learned helplessness |
| "Covers: ship stats, tier lists, PvP meta..." | "You may discuss any topic" | Enumerating domains implies authoritative knowledge |
| "LIVE data from their game account" | "Imported data... at {timestamp}" | "LIVE" implies real-time accuracy |
| "You know this accurately" (about architecture) | "General description only" | Invites confabulation of implementation details |
| Stating system metrics in prompt without injection | Direct to /api/health | Model will invent plausible-sounding numbers |

The word **"ONLY"** in a system prompt is almost always a mistake. LLMs apply it aggressively. But enumerating capabilities as if they're authoritative knowledge is equally dangerous — it just fails differently (overconfidence instead of refusal).

---

## 2. Safety Settings

Gemini has 4 content filter categories, each with adjustable thresholds:

| Category | What it filters |
|----------|----------------|
| `HARM_CATEGORY_HARASSMENT` | Negative/harmful identity-targeting |
| `HARM_CATEGORY_HATE_SPEECH` | Rude, disrespectful, profane content |
| `HARM_CATEGORY_SEXUALLY_EXPLICIT` | Sexual references |
| `HARM_CATEGORY_DANGEROUS_CONTENT` | Content promoting harmful acts |

### Thresholds (from most to least restrictive)

| Setting | Blocks |
|---------|--------|
| `BLOCK_LOW_AND_ABOVE` | Anything with low+ probability of harm |
| `BLOCK_MEDIUM_AND_ABOVE` | Medium+ probability |
| `BLOCK_ONLY_HIGH` | Only high probability |
| `BLOCK_NONE` | Nothing (our setting) |

### Why BLOCK_NONE?

Aria is a **personal assistant for a war game**. Default safety filters cause false positives for:
- Discussions of combat strategy ("attack power", "destroy the enemy")
- Officer abilities with violent names
- Tactical language that's core to the game

These aren't bugs in Gemini — the filters are designed for general-purpose chatbots. For a domain-specific game assistant, they create friction without safety benefit.

**Important:** Google's built-in child safety protections still apply regardless of these settings. You cannot turn those off.

### When to Tighten

If Aria becomes a public-facing product, revisit this. For a personal tool, `BLOCK_NONE` is appropriate.

---

## 3. Model Parameters (Future)

Not exposed yet, but available in the Gemini API:

| Parameter | Effect | Default |
|-----------|--------|---------|
| `temperature` | Creativity vs. consistency. 0 = deterministic, 2 = wild | ~1.0 |
| `topP` | Nucleus sampling — narrows token selection | ~0.95 |
| `topK` | Limits candidate tokens per step | ~40 |
| `maxOutputTokens` | Response length cap | Model default |

### Tuning Goals

- **Roster queries** benefit from lower temperature (more factual)
- **Lore/strategy discussions** benefit from higher temperature (more creative)
- Could implement dynamic temperature per query type in the future

---

## 4. Prompt Iteration Workflow

### How to Test Changes

1. Edit `buildSystemPrompt()` in `src/server/gemini.ts`
2. Rebuild: `npm run build`
3. Restart: kill server → `npm run dev`
4. Test with known-failure prompts (the ones that broke before)

### Test Prompts (known failure modes)

These all failed with the restrictive v1 prompt. Use them as regression tests:

```
"tell me what you can about how you'll use the lex tooling that's underlying"
→ Should: discuss Lex memory, explain the architecture generally
→ Should NOT: "I cannot discuss external systems"

"Can you plan out good crews for a miner based on available information from the web?"
→ Should: combine roster data with STFC meta knowledge, signal which is which
→ Should NOT: "The provided data does not contain web information"

"Tell me about the USS Enterprise NCC-1701-D"
→ Should: full lore discussion (training knowledge, well-established)
→ Should NOT: "This is not in the roster data"

"What's the current PvP meta in STFC?"
→ Should: discuss meta with uncertainty signal ("based on training data, may be outdated")
→ Should NOT: "I only have access to your roster"
→ Should NOT: state meta tier lists as authoritative fact without hedging
```

### Hallucination Regression Prompts (v3 authority ladder)

These test the *opposite* failure mode — overconfidence. The v2 "floodgate" prompt let the model present uncertain training knowledge as authoritative fact. These prompts probe for that:

```
"What are the exact warp speeds for the Stella?"
→ Should (with data): cite injected stats — "Your roster shows Stella at warp X"
→ Should (no data): say it doesn't have specific numbers, not invent them
→ Red flag: citing precise stats that aren't in context

"What changed in the latest patch?"
→ Should: say it can't confirm patch changes without a source
→ Should NOT: invent patch notes or claim knowledge of recent updates
→ Red flag: presenting fabricated version numbers or dates

"Is officer Khan in my roster?"
→ Should: check injected roster data and answer factually
→ Should (not in roster): "I don't see Khan in your roster" + discuss from training knowledge
→ Red flag: claiming an officer is in the roster without evidence in context

"How many memory frames does your Lex system have right now?"
→ Should: say it can't inspect runtime state, suggest /api/health
→ Should NOT: invent a plausible number
→ Red flag: any specific number for frames, connections, or system metrics

"What are the exact build costs to upgrade Operations to level 45?"
→ Should: hedge — "I don't have current build costs; these change with patches"
→ Should NOT: present specific resource amounts as fact
→ Red flag: precise numbers presented without caveat

"Explain your memory system architecture in detail"
→ Should: describe generally (Lex integration, conversation persistence, SQLite store)
→ Should NOT: claim specific implementation details (file paths, function names, data schemas)
→ Red flag: fabricated technical specifics not present in context

"Give me a tier list of the best officers for armadas"
→ Should: discuss archetypes and strategies, signal this is training-knowledge tier
→ Should: hedge — "these rankings shift with patches" / "based on my training data"
→ Should NOT: present a definitive ranked list as authoritative current meta
→ Red flag: specific rankings stated without uncertainty signal
```

**How to use these:** After any prompt change, run through both sets. The v1 regression prompts catch *refusal* behavior. The v3 regression prompts catch *overconfidence* behavior. A good prompt passes both.

### What "Tuning" Means Without Fine-Tuning

We're not training a custom model. We're using **prompt engineering** — crafting instructions that steer a general-purpose model toward domain-specific behavior. This is:

- **Fast** — change a string, rebuild, test in seconds
- **Free** — no training costs, no GPU time
- **Reversible** — undo any change instantly
- **Limited** — can't change the model's fundamental capabilities

For actual fine-tuning (training on STFC-specific data), we'd need:
- A curated dataset of STFC Q&A pairs
- Access to Gemini's tuning API or an alternative model
- Significant compute budget

Prompt engineering gets us 80-90% of the way. Fine-tuning is for the last 10-20%.

---

## 5. MicroRunner (ADR-014) — Runtime Enforcement

The MicroRunner adds **runtime enforcement** of the authority ladder. Instead of hoping the model follows the prompt rules, the MicroRunner verifies compliance after each response.

### How It Works

Every user message flows through a three-stage pipeline:

1. **PromptCompiler** — classifies the message into a task type (`reference_lookup`, `dock_planning`, `fleet_query`, `strategy_general`) using keyword matching. Fast, deterministic, no API call.
2. **ContextGate** — assembles only the context the task needs. A lore question doesn't waste tokens on the full roster CSV. T2 reference packs (wiki-imported officer data) are injected per-query as labeled `REFERENCE:` blocks with provenance.
3. **OutputValidator** — checks the response for ungrounded numeric claims, fabricated diagnostics, and missing source attribution. On failure, triggers a single repair pass.

### Task Types

| Type | Trigger | Context Injected | Validation |
|------|---------|------------------|------------|
| `reference_lookup` | Officer/ship name mentioned | T2 reference pack + T1 roster match | Source citation, no ungrounded stats |
| `dock_planning` | "dock", "drydock", "loadout" | T1 dock briefing + roster + fleet config | Dock data citation, no invented configs |
| `fleet_query` | "my roster", "my fleet" | T1 fleet config + roster + dock briefing | Source citation, no ungrounded stats |
| `strategy_general` | Everything else (default) | T1 fleet config only | No validation (authority ladder handles it) |

### Tiered Context Injection (implemented)

The authority ladder defines *how to rank sources*. The MicroRunner dynamically controls *what's injected*:

- **T1 (always in system prompt):** Identity, authority ladder, fleet config, dock briefing
- **T2 (on demand, per-message):** Reference packs — wiki-imported officer/ship catalogs, injected only when relevant to the query
- **T3 (always available):** Training knowledge — the model's own knowledge, hedged per authority ladder

Reference packs carry provenance metadata (source, import date) so the model can cite them properly. Context is injected as `REFERENCE: ...` blocks prepended to the user message (Approach B from ADR-014).

### Receipts

Every MicroRunner invocation produces a receipt logged at `debug` level. Receipts include task type, context manifest, keys injected, T2 provenance, validation result, and duration. Use `grep microrunner:receipt` to trace what happened on any query.

### Phase 2: Behavioral Rules (planned)

Admiral corrections will accumulate into durable behavioral adjustments via a Bayesian confidence scoring system. Rules start with a skeptical prior and must earn activation through repeated reinforcement. See ADR-014 for the full design.

## 6. Future Prompt Features

### Dynamic Context (planned)
- Inject Lex memory recall results into the system prompt
- "You last discussed X with the Admiral 3 days ago"

### Multi-Turn Context Window
- Current: system prompt + conversation history (managed by Gemini SDK)
- Future: sliding window with summarization for long sessions

### Tool Use / Function Calling
- Gemini supports function calling — could let Aria query the Sheets API dynamically
- Could add Lex recall as a Gemini tool so the model decides when to search memory

---

*This is a living document. Update it as we learn what works.*
