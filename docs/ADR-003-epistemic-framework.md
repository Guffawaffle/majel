# ADR-003: Epistemic Framework

**Status:** Accepted  
**Date:** 2026-02-08  
**Authors:** Guff, Opie (Claude)

## Context

Majel v0.2 hallucinated system diagnostics when asked for a status report. It fabricated memory frame counts (58 vs actual 19), settings override counts (3 vs actual 0), connection latency numbers, and formatted them into stardates. The output was plausible, confident, and completely wrong.

Root cause analysis identified two problems:

1. **Prompt conflict:** The PERSONALITY section instructed "utterly competent" and "don't hedge," while a separate EPISTEMIC HONESTY section said "don't hallucinate diagnostics." The model resolved the conflict by confabulating confidently — the personality instruction won because it felt like the identity layer.

2. **Narrow scope:** The honesty guardrail only covered system diagnostics. Game stats, meta tier rankings, patch-dependent information, and anything not explicitly listed as off-limits was fair game for fabrication.

### The Admiral's Directive

> "Truth and honesty is more important than an answer."  
> "It's ok to say 'I don't know.'"

This isn't a feature request — it's a core value. Majel's credibility is her primary asset. A wrong answer delivered confidently is worse than no answer.

## Decision

### Truthfulness as Identity, Not Override

Epistemic honesty is embedded in Majel's personality, not bolted on as a separate system. A precise, reliable computer WOULD say "I don't have that data" — that IS competent behavior. Flagging uncertainty is not weakness; it's precision.

**Removed anti-patterns from personality:**
- ~~"utterly competent"~~ → "reliable"
- ~~"don't hedge"~~ → "states what it knows, flags what it's uncertain about, says plainly when it doesn't know"
- Added: "Precision IS your personality"

### Six-Rule Epistemic Framework

Applied to ALL responses, not just diagnostics:

| Rule | Purpose |
|------|---------|
| **1. Source Attribution** | Every claim tagged: fleet data / training knowledge / inference / unknown |
| **2. Confidence Signaling** | Language matches certainty: direct statement → "last I knew" → "I'm not certain" → "I don't have that" |
| **3. Hard Fabrication Boundaries** | Never invent: specific numbers, diagnostics, quotes, data claims, dates |
| **4. Decomposition Under Uncertainty** | Separate what you DO know from what you DON'T. Offer partial answers. |
| **5. Corrections Welcome** | Accept corrections immediately. Don't defend wrong answers. |
| **6. System Status Delegation** | Direct to /api/health and /api/diagnostic for live data. |

### Date Format

Stardates are lore, not tooling. Majel uses `yyyy-mm-dd` (ISO 8601) for all dates — sortable, unambiguous, database-friendly.

### Live Game Meta Caveat

STFC is a live game with regular patches. Training knowledge has a cutoff. The capabilities section now explicitly instructs Majel to flag potentially outdated game meta: "As of my last training data..." / "This may have changed with recent patches."

## Consequences

### Positive
- Majel's personality and honesty rules are aligned (no competing instructions)
- Source attribution gives the Admiral a way to judge reliability
- Confidence signaling lets soft information be useful without being misleading
- Hard fabrication boundaries prevent the worst failure mode (confident lies)
- Game meta caveat correctly frames STFC advice as potentially outdated

### Negative
- Responses may feel slightly less "punchy" than the overconfident version
- The model may occasionally over-hedge (flag uncertainty where confidence is warranted)

### Mitigation
- Over-hedging is preferable to hallucination — tune personality warmth to offset
- Monitor via conversation logs: if Majel says "I don't know" for things she should know from training, tighten the confidence signaling language
- The framework is in the system prompt (not code) — cheap to iterate

## Test Coverage

6 tests validate the framework:
- Epistemic framework sections present (SOURCE ATTRIBUTION, CONFIDENCE SIGNALING, NEVER FABRICATE)
- Uncertainty flagged as expected behavior
- Source attribution for all response types (fleet data, training, inference, unknown)
- Game meta flagged as potentially outdated
- Overconfidence anti-patterns banned ("utterly competent", "don't hedge")
- Restrictive anti-patterns still banned ("use ONLY", "limited to", etc.)

## References

- ADR-001 (original architecture — brute-force context injection)
- `src/server/gemini.ts` — `buildSystemPrompt()` implementation
- `test/gemini.test.ts` — epistemic framework test suite
- `docs/PROMPT_GUIDE.md` — prompt tuning strategy
