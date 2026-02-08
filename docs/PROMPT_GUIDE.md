# Majel Prompt Tuning Guide

How we tune Majel's behavior without fine-tuning the underlying model.

## TL;DR

There are **three levers** for controlling Majel's behavior:

1. **System Prompt** — personality, knowledge boundaries, roster context
2. **Safety Settings** — Gemini's content filters (harassment, violence, etc.)
3. **Model Parameters** — temperature, top_p, top_k (not yet exposed)

The system prompt is where 95% of tuning happens. Safety settings are a one-time config. Model parameters are for fine-grained control later.

---

## 1. System Prompt Architecture

The prompt is built in layers (see `src/server/gemini.ts`):

### Layer 1: Identity
Who is Majel? This never changes regardless of data availability.

```
You are Majel, the Fleet Intelligence System aboard Admiral Guff's flagship.
```

**Why it's first:** LLMs weight the beginning of the system prompt heavily. Identity anchors all behavior.

### Layer 2: Capabilities (the "floodgate")
What can Majel do? This is where the magic happens.

```
You have FULL ACCESS to your training knowledge.
```

**Critical lesson learned:** Early versions said things like *"Your access is limited to the roster"* and *"use ONLY the provided CSV data"*. The model interpreted this literally and refused to discuss anything not in the spreadsheet — game strategy, Star Trek lore, Lex tooling, everything.

**The fix:** Never restrict. The roster **adds** knowledge; it doesn't cage the model. Explicitly list capabilities rather than constraints.

### Layer 3: Context Injection
The roster CSV gets appended to the system prompt. Two modes:

- **With roster:** CSV is injected with instructions to cite stats precisely and supplement with game knowledge
- **Without roster:** Model runs at full capability, just notes the roster isn't connected

### Anti-Patterns to Avoid

| Don't | Do |
|-------|-----|
| "Use ONLY the provided data" | "Use the CSV as your primary source for roster questions" |
| "You cannot discuss external topics" | "You can discuss anything" |
| "My access is limited to..." | "I have full access to..." |
| "I am unable to process..." | Just answer the question |

The word **"ONLY"** in a system prompt is almost always a mistake. LLMs apply it aggressively.

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

Majel is a **personal assistant for a war game**. Default safety filters cause false positives for:
- Discussions of combat strategy ("attack power", "destroy the enemy")
- Officer abilities with violent names
- Tactical language that's core to the game

These aren't bugs in Gemini — the filters are designed for general-purpose chatbots. For a domain-specific game assistant, they create friction without safety benefit.

**Important:** Google's built-in child safety protections still apply regardless of these settings. You cannot turn those off.

### When to Tighten

If Majel becomes a public-facing product, revisit this. For a personal tool, `BLOCK_NONE` is appropriate.

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
→ Should: discuss Lex memory, explain the architecture
→ Should NOT: "I cannot discuss external systems"

"Can you plan out good crews for a miner based on available information from the web?"
→ Should: combine roster data with STFC meta knowledge
→ Should NOT: "The provided data does not contain web information"

"Tell me about the USS Enterprise NCC-1701-D"
→ Should: full lore discussion
→ Should NOT: "This is not in the roster data"

"What's the current PvP meta in STFC?"
→ Should: discuss meta based on training knowledge
→ Should NOT: "I only have access to your roster"
```

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

## 5. Future Prompt Features

### Dynamic Context (planned)
- Inject Lex memory recall results into the system prompt
- "You last discussed X with the Admiral 3 days ago"

### Multi-Turn Context Window
- Current: system prompt + conversation history (managed by Gemini SDK)
- Future: sliding window with summarization for long sessions

### Tool Use / Function Calling
- Gemini supports function calling — could let Majel query the Sheets API dynamically
- Could add Lex recall as a Gemini tool so the model decides when to search memory

---

*This is a living document. Update it as we learn what works.*
