# ADR-041 — Multi-Provider LLM Engine (Claude via Vertex AI)

**Status:** Accepted  
**Date:** 2026-03-10  
**Author:** PM + Copilot (Senior Architect)  
**Program umbrella:** #199

---

## Context

Majel currently runs exclusively on Google Gemini via the `@google/genai` SDK.
The engine interface (`GeminiEngine`) is tightly coupled to Gemini:

- Model registry contains only Gemini models
- Tool declarations use `@google/genai` `FunctionDeclaration[]` format
- Session management relies on Gemini SDK `Chat` objects
- System prompt builder includes Gemini-specific safety settings
- Boot-time wiring creates a single `GeminiEngine` instance

Google Cloud Platform offers Claude (Anthropic) models through Vertex AI
Model Garden, billed through the same GCP account. The admiral wants
Claude available as an alternative engine — particularly the frontier
tier — accessible through the existing model selector.

## Decision

Introduce a **provider-neutral `ChatEngine` interface** that both Gemini and
Claude implement, with a unified model registry that includes provider
metadata. Claude is admiral-only initially. The model selector becomes a
multi-provider picker.

### Architecture

```
                        ┌─────────────────────┐
                        │   Model Registry    │
                        │  (unified, multi-   │
                        │   provider ModelDef) │
                        └────────┬────────────┘
                                 │
                        ┌────────▼────────────┐
                        │   EngineManager     │
                        │  implements         │
                        │  ChatEngine         │
                        │                     │
                        │  • activeProvider   │
                        │  • setModel() →     │
                        │    detects provider │
                        │    boundary, swaps  │
                        └───┬────────────┬────┘
                            │            │
                   ┌────────▼──┐    ┌────▼───────┐
                   │ Gemini    │    │ Claude     │
                   │ Provider  │    │ Provider   │
                   │           │    │            │
                   │ @google/  │    │ @anthropic-│
                   │ genai SDK │    │ ai/vertex  │
                   └───────────┘    └────────────┘
```

### Key Design Decisions

1. **`ChatEngine` interface** — extracted from current `GeminiEngine`.
   Same shape: `chat()`, `setModel()`, `getModel()`, `getHistory()`,
   `closeSession()`, `getSessionCount()`, `close()`. Routes type
   against `ChatEngine`, never a provider-specific class.

2. **`EngineManager` implements `ChatEngine`** — Thin delegating
   wrapper. Holds a map of initialized providers. `setModel()` detects
   whether the new model belongs to a different provider than the
   current one — if so, creates/swaps the active provider instance and
   clears all sessions.

3. **`ModelDef` gains `provider` field** — `"gemini" | "claude"`.
   Existing 5 Gemini models get `provider: "gemini"`. Claude models
   added with `provider: "claude"`.

4. **`ModelDef` gains optional `roleGate` field** — `"admiral"` means
   only admirals can see/select the model. Omitted = visible to all
   roles. Claude models ship with `roleGate: "admiral"`.

5. **Tool declaration translation** — `ToolRegistry` already has
   provider-agnostic `ToolDef` from ADR-039 Phase 10. Add
   `toClaudeTools()` alongside existing `toDeclarations()` (Gemini).
   The canonical source is `ToolDef`; SDK-specific formats are
   derived.

6. **Claude session management** — Claude API is stateless; the
   provider manages its own message history arrays per session key,
   mirroring the session semantics Gemini gets from its SDK `Chat`
   objects.

7. **System prompt adaptation** — Claude has different prompt
   conventions. The prompt builder gains a provider switch that
   adjusts persona framing and removes Gemini-specific safety
   settings when targeting Claude.

8. **Auth on Vertex AI** — Claude via Vertex uses GCP Application
   Default Credentials or a service account, not an API key. The
   `ClaudeProvider` authenticates via the Vertex SDK's built-in
   credential resolution (same as other GCP services).

9. **Cost model** — Claude `costRelative` values set relative to
   existing Gemini scale. Claude Sonnet ≈ 3, Claude Opus ≈ 5.

10. **Rollback safety** — If Claude provider fails to initialize
    (missing credentials, API not enabled), the engine manager falls
    back to Gemini-only mode and logs a warning. Claude models are
    removed from the registry response.

### Non-Goals

- **Streaming** — Both providers support streaming, but the current
  chat flow is synchronous request/response. Streaming is a separate
  concern (ADR-037).
- **Per-user provider preferences** — Not in this program. Admiral
  selects globally.
- **OpenAI** — Not available on GCP. Out of scope.
- **Cost tracking** — Token-level billing per provider is a future
  concern.

## Phased Implementation

### Phase 1 — ChatEngine Interface Extraction (#200)

Extract `ChatEngine` from `GeminiEngine`. Add `provider` and
`roleGate` fields to `ModelDef`. All routes and tests type against
`ChatEngine`. No functional change — pure refactor.

**Files:**
- `src/server/services/engine.ts` (new — `ChatEngine` interface)
- `src/server/services/gemini/index.ts` (implements `ChatEngine`)
- `src/server/services/gemini/model-registry.ts` (`provider` field)
- `src/server/index.ts` (type annotation)
- `src/server/routes/chat.ts` (type annotation)
- `web/src/lib/types/shared-core.ts` (`provider` in `ModelDef`)

### Phase 2 — Tool Declaration Abstraction (#201)

Add `toClaudeTools()` to `ToolRegistry`. Claude tool format:
`{ name, description, input_schema }` (JSON Schema, not OpenAPI).
Canonical source remains `ToolDef`.

**Files:**
- `src/server/services/fleet-tools/tool-registry.ts`
- `test/tool-registry.test.ts`

### Phase 3 — Claude Provider Implementation (#202)

Install `@anthropic-ai/vertex-sdk`. Implement `ClaudeChatEngine`
with self-managed sessions, tool loop, and system prompt adaptation.

**Files:**
- `src/server/services/claude/index.ts` (new)
- `src/server/services/claude/claude-tools.ts` (new — tool response marshaling)
- `src/server/services/claude/claude-prompt.ts` (new — prompt adaptation)
- `package.json` (new dependency)

### Phase 4 — Engine Manager + Registry Integration (#203)

Implement `EngineManager`, add Claude models to registry with
`roleGate: "admiral"`, wire into server bootstrap. Model selector
becomes multi-provider.

**Files:**
- `src/server/services/engine-manager.ts` (new)
- `src/server/services/gemini/model-registry.ts` (Claude entries)
- `src/server/index.ts` (bootstrap wiring)
- `src/server/routes/chat.ts` (role-filtered model list)
- `web/src/components/ChatInput.svelte` (provider badge)
- `web/src/lib/types/shared-core.ts` (provider in response types)

### Phase 5 — GCP Setup + E2E Validation (#204)

Enable Vertex AI API on `smartergpt-majel`. Test Claude end-to-end
in deployed environment. Verify tool calling, session management,
and provider switching.

**GCP tasks:**
- Enable `aiplatform.googleapis.com` on `smartergpt-majel`
- Verify Cloud Run service account has Vertex AI User role
- Add `VERTEX_PROJECT_ID` and `VERTEX_REGION` to Secret Manager

## Consequences

- Routes and fleet tools remain provider-agnostic
- Admiral can switch between Gemini and Claude in the model selector
- New providers can be added by implementing `ChatEngine` + adding
  models to the registry
- Session clearing on provider switch is expected (different history
  formats)
- Vertex AI billing flows through existing GCP account

## Related

- ADR-027 — GenAI SDK Migration (Gemini SDK setup)
- ADR-039 — Request Context (ToolDef / defineTool)
- ADR-038 — Agent Experience Policy (persona/prompt)
