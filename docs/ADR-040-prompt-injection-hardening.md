# ADR-040: Prompt Injection & LLM Safety Hardening

**Status:** Accepted  
**Date:** 2026-03-10  
**Authors:** Guff, GitHub Copilot (Claude Opus 4.6)  
**References:** ADR-003 (epistemic framework), ADR-014 (micro-runner), ADR-038 (agent experience policy), ADR-039 (request context)

---

## Context

Majel's LLM integration touches user-controlled data at multiple points:

1. **Tool responses**: Fleet tool output contains user-authored fields (target `reason`,
   loadout `notes`, officer `reservedFor`, bridge core names) that are serialized as JSON
   and fed back to Gemini as function responses.

2. **User message augmentation**: The micro-runner prepends contextual blocks
   (`[CONTEXT FOR THIS QUERY ...]`, `[END CONTEXT]`) and the chat route appends
   `[FLEET CONFIG]` / `[INTENT CONFIG]` blocks before sending to the model.

3. **Memory frames**: Conversation turns (question + answer) are persisted as Lex frames
   and recalled into future prompts via semantic search.

4. **External content**: The `web_lookup` tool fetches HTML from allowlisted domains,
   strips tags, and returns plain text to the model.

A security audit (2026-03-10) identified that the existing sanitization layer
(`INJECTION_PATTERNS` regex in `gemini/index.ts`, delimiter stripping in `buildAugmentedMessage`)
covers only a subset of the markers used in the system prompt. An attacker who can write
user data (targets, notes, etc.) can embed markers like `[FLEET CONFIG]` or `[INTENT CONFIG]`
that bypass the existing regex but are semantically meaningful to the model.

### Threat Model

| Vector | Entry Point | Data Flow | Current Mitigation |
|--------|------------|-----------|-------------------|
| Stored field injection | Target reason, loadout notes, reservedFor | DB → tool response → Gemini | `INJECTION_PATTERNS` regex (incomplete) |
| User message delimiter injection | Chat input | User message → `buildAugmentedMessage` → Gemini | Two specific regexes (incomplete) |
| Memory frame poisoning | Conversation turns | `remember()` → DB → `recall()` → future prompts | None |
| External content injection | web_lookup | Allowlisted site HTML → `toPlainText()` → Gemini | Tag stripping only |
| Preview string injection | Tool argument values | Args → `generatePreview()` → function response → Gemini | None |

---

## Decision

### D1: Unified Sanitization Function

Create a single `sanitizeForModel(text: string): string` function that strips all
bracket-delimited uppercase markers matching the pattern `[UPPERCASE WORDS...]` and
XML-like directive tags. This replaces the current `INJECTION_PATTERNS` regex and
the ad-hoc `buildAugmentedMessage` stripping.

The function is applied at all trust boundaries where untrusted text enters model context:
- Tool response sanitization (`sanitizeToolResponse`)
- User message augmentation (`buildAugmentedMessage`)
- `generatePreview()` argument interpolation
- Memory frame content on recall (not on storage — preserves raw data for debugging)

### D2: Preview String Sanitization

`generatePreview()` applies `sanitizeForModel()` to all interpolated argument values
and truncates each value to a safe length (100 chars).

### D3: Memory Recall Sanitization

Frames returned by `recall()` and `timeline()` pass through `sanitizeForModel()`
before being assembled into model context. Raw frames are preserved in the database
for audit/debugging.

### D4: Web Lookup Output Sanitization

`web_lookup` results pass through `sanitizeForModel()` after tag stripping,
before being returned as tool response text.

### D5: No Storage-Time Filtering

User data is stored as-is. Sanitization happens at the trust boundary (model input),
not at the data layer. This preserves data fidelity and avoids lossy transformations
that could confuse users who see their data modified.

---

## Consequences

### Positive

- Single sanitization function eliminates pattern-coverage drift between entry points
- All known system prompt delimiters are stripped from untrusted input
- No data loss — raw data preserved in DB, sanitization at model boundary only
- Defense-in-depth: even if a new delimiter is added to the system prompt, the
  general `[UPPERCASE...]` pattern catches it

### Negative

- Legitimate user data containing bracket-delimited uppercase text will be stripped
  (e.g., a user naming a target `[MINING PRIORITY]`). Acceptable trade-off.
- Adds ~5ms of regex processing per tool response cycle. Negligible.

### Risks

- New delimiter patterns not matching `[A-Z ]+` (e.g., `## SECTION`) would bypass
  the regex. The system prompt should avoid introducing non-bracketed delimiters.

---

## Implementation Plan

| Phase | Scope | Issue |
|-------|-------|-------|
| 1 | `sanitizeForModel()` function + expanded `INJECTION_PATTERNS` + unit tests | #195 |
| 2 | Wire into `generatePreview()`, `buildAugmentedMessage`, memory recall, web_lookup | #195 |
| 3 | Fuzz tests with known prompt injection payloads | #195 |
