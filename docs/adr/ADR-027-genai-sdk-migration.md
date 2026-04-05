# ADR-027: Gen AI SDK Migration & Web Lookup

**Status:** Accepted  
**Date:** 2026-02-16  
**Supersedes:** None  
**Related:** ADR-004 (Ax-first API), ADR-007 (Fleet Management), ADR-025 (Crew Composition)

## Context

Majel uses `@google/generative-ai` v0.21.0 — the **legacy** Gemini SDK. Google has released `@google/genai` (the "Gen AI SDK"), now at v1.41.0 and GA. The legacy SDK:

1. **No longer receives new Gemini 2.0+ features** (per Google's migration docs)
2. **Cannot use Google Search Grounding** — needed for web lookup capabilities
3. **Cannot use URL Context** — needed for fetching specific STFC data pages
4. **Cannot use the Interactions API** — needed for future agent capabilities
5. Uses a deprecated API surface (`getGenerativeModel` → `startChat` → `sendMessage`)

The new SDK is required before implementing web lookup tools for STFC data.

## Decision

### Phase 1: SDK Migration (this ADR)

Replace `@google/generative-ai` with `@google/genai` across all touchpoints:

| Old SDK | New SDK |
|---------|---------|
| `GoogleGenerativeAI` | `GoogleGenAI` |
| `genAI.getGenerativeModel(opts)` → `model.startChat()` | `ai.chats.create({ model, config })` |
| `chatSession.sendMessage(msg)` → `result.response.text()` | `chat.sendMessage({ message })` → `response.text` |
| `result.response.functionCalls()` | `response.functionCalls` |
| `SchemaType` | `Type` |
| `FunctionDeclaration.parameters` (SchemaType-based) | `FunctionDeclaration.parametersJsonSchema` (JSON Schema) |
| `HarmCategory` / `HarmBlockThreshold` enums | String constants in `SafetySetting` |
| `Part` with `functionResponse` | `Part` with `functionResponse` (same shape) |

**Files affected:**
- `src/server/services/gemini/index.ts` — engine implementation
- `src/server/services/gemini/system-prompt.ts` — safety settings
- `src/server/services/fleet-tools/declarations.ts` — tool declarations
- `test/gemini.test.ts` — mock update
- `package.json` — dependency swap

### Phase 2: Web Lookup (future ADR)

With the new SDK in place, implement gated web lookup via:
- Custom `webLookup` fleet tool (domain-allowlisted)
- Potential Google Search Grounding for broader queries
- URL Context for specific STFC data pages

## Consequences

### Positive
- Access to all Gemini 3.x features (URL Context, Search Grounding, Interactions API)
- Future-proofed against legacy SDK deprecation
- Cleaner API surface (centralized client vs `getGenerativeModel`)

### Negative
- Breaking change in mock surface for tests
- `FunctionDeclaration` schema format changes (SchemaType → JSON Schema)
- One-time migration effort (~200 lines changed)

### Neutral
- Chat behavior is functionally identical (stateful sessions preserved)
- No changes to GeminiEngine public interface
- No changes to fleet tool logic
