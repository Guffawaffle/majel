# ADR-026a — Startup + Import UX Addendum: Guided Setup, Aria Gating, Layer Boundary, Resolve Persistence

**Status:** Accepted  
**Date:** 2026-02-15  
**Authors:** Guff, Opie (Claude), with review from Lex  
**Amends:** ADR-026 (Startup + Import UX Contract)  
**Extended by:** ADR-026b (Safe Mutation Proposal/Apply)  
**References:** ADR-025 (Crew Composition), ADR-026 (Startup + Import UX)

---

## Context

ADR-026 establishes the canonical pipeline (Parse → Preview → Fix → Commit → Receipt + Undo), multi-path hub, AI-optional guarantee, composition opt-in gate, and auto-seed. All of that stands.

This addendum locks down four product-level constraints that emerged during implementation planning. These are surgical additions — they do not change any existing ADR-026 decision.

---

## Additions

### A1 — Guided Setup is a 5th entry path (no file, no chat required)

ADR-026 D3 defines 4 entry paths. Add a 5th:

| Path | Description |
|------|-------------|
| **Guided Setup (templates)** | User picks common activity templates (Mining / Swarm / Borg / PvP / Armadas) and confirms which officers they have via click-select crew cards |

This is the bridge between "click everything manually in the catalog" (Quick Setup) and "tell Aria what you run" (chat-first). The user picks an activity, sees the recommended officers for it, and checks the ones they own.

**Flow:**
1. Hub → "Guided Setup" → activity template picker
2. User picks "Mining" → system shows crew cards for common mining officers (Uhura, Chen, T'Laan, etc.), pre-filtered from reference catalog
3. User clicks officers they own → ownership overlays created
4. Repeat for additional activities, or skip
5. **Pipeline compliance:** Preview shows "Parsed Ownership" (counts, what was marked) → Commit → Receipt

**Contract behavior:**
- Funnels into the same ADR-026 D2 pipeline: Preview + Fix + Commit + Receipt
- Respects ADR-026 D6: import never auto-creates composition without opt-in
- End step can offer opt-in: "Also create BridgeCores/Loadouts from these selections?" with preview + edit
- No AI required — templates are static, derived from reference data + intent catalog

**Activity templates are curated, not generated.** Each template is a named list of officer IDs + ship IDs commonly used for that activity, stored as a JSON fixture. Templates evolve with game patches alongside the game data.

### A2 — Aria introduction + gating contract (no paywall on critical path)

ADR-026 D5 says "AI optional, never blocks setup." This formalizes the UX contract:

Checklist for implementation/review: [AI UX Review Checklist](./AI-UX-REVIEW-CHECKLIST.md)

**Non-blocking introduction:**
- Aria is introduced via a small, dismissible panel/tooltip on first visit to the hub
- Aria is never a required step in any flow
- If the user has no Gemini API key configured, all flows still work — Aria sections show "Configure AI assistant in Settings" with a link, not a blocker

**Metered action guardrails (if Aria actions are subscription/token-gated):**
- Every AI-assisted action MUST have a **manual fallback action adjacent** in the UI
  - "Let Aria map columns" button sits next to the manual column mapper
  - "Let Aria suggest crews" button sits next to the manual crew builder
- UI shows remaining free allowance (if a free daily tier exists)
- Setup completion is NEVER blocked by exhausted AI allowance
- No AI upsell modals during active import/setup flow

**Assisted action definition** (for metering/quotas):
An "assisted action" is one discrete AI invocation:
- Suggest column mapping for unknown schema import
- Suggest crew templates from owned officer roster
- Run a single "optimize loadout/preset" suggestion
- Suggest repairs for unresolved items in resolve queue

This is a UX-level contract, not a billing implementation. Billing specifics are out of scope.

### A3 — User imports NEVER write to Reference catalog

ADR-026 D1 separates Reference (admin-only) and Ownership (any user) layers. This tightens the boundary:

**Hard rule:** User-initiated imports (file upload, paste, community export) write **only** to overlay tables. They do NOT create, update, or delete rows in `reference_officers` or `reference_ships`.

**Why this matters:**
- Prevents typos, naming variants, and community-specific formatting from poisoning the canonical reference catalog
- The reference catalog remains a single-source-of-truth synced from the vetted game data
- Aligns with "do not build around third-party backend endpoints / scraping" — user data is inherently unvetted

**What happens to unknown items:**
- If an import file contains an officer/ship name that doesn't fuzzy-match any reference entry, it enters the **Resolve Queue** as "unrecognized"
- Unrecognized items are NOT silently added to reference — the user must either:
  - Map it to an existing reference entry (typo correction)
  - Skip it (acknowledge it's unknown)
  - (Admin only) Manually add it to reference via the admin catalog sync path
- The resolve queue surfaces these clearly: "3 officers not found in catalog — map or skip"

**Exception:** The auto-seed path (D8) and admin-triggered game data sync (`POST /api/catalog/sync`) DO write to reference — they are admin-gated operations using vetted data.

### A4 — Resolve Queue persistence guarantee

ADR-026 D2 mentions a resolve queue in the pipeline. This locks down persistence:

**Requirement:** Unresolved items MUST be persisted in the import receipt's `unresolved` JSONB field.

**"Continue resolving later" flow:**
- After a commit, any unresolved items are stored in the receipt
- The user can revisit import history → select a receipt → see unresolved items
- "Continue Resolving" re-opens the resolve queue UI pre-populated from the receipt
- Resolved items update the receipt and apply additional overlay changes (with a new receipt or an amendment to the existing one)
- Unresolved items that remain after the second pass stay in the receipt indefinitely — they're an audit trail, not a blocking error

**No forced resolution:** The user can commit an import with unresolved items. The committed portion applies; unresolved items are skipped and recorded. This prevents "all-or-nothing" frustration on messy spreadsheets.

### A5 — Confirmation-gated safe mutation path for agent-driven writes

As setup/import natural language support grows, stochastic model output must not directly commit high-impact writes without explicit user confirmation.

**Contract:** mutation tools that can affect many rows (starting with `sync_overlay`) use a two-step flow:

1. **Plan** (non-mutating): returns `proposal_id` + deterministic `changes_preview` + risk metadata.
2. **Apply** (mutating): requires explicit user accept from UI (`proposal_id`, optional signed confirmation token), then commits transaction + receipt.

**UI requirement:** show a confirmation modal/dialog: **"The following changes will be made"** with Accept / Decline.

**Safety requirements:**
- Apply must reject unknown/expired/tampered proposal IDs.
- Apply must be idempotent (double-apply prevented).
- Decline records outcome and performs no write.
- Receipts/audit entries must link applied changes to `proposal_id`.

This keeps AI assistance optional and safe: models may propose, users decide to apply.

**Model compatibility note:** this contract is model-agnostic and works with fast/chat-oriented models (e.g., Gemini 2.5 Flash class) because safety is enforced by backend state + UI confirmation, not by model determinism alone.

---

## Updated Entry Path Table (D3 + A1)

| # | Path | Reference? | Ownership? | AI Required? |
|---|------|-----------|-----------|-------------|
| 1 | Quick Setup (catalog clicks) | No (pre-seeded) | **Yes** | No |
| 2 | **Guided Setup (templates)** | No (pre-seeded) | **Yes** | No |
| 3 | Import a file (spreadsheet) | **No** (A3: never) | **Yes** | No (AI optional) |
| 4 | Supported community export | **No** (A3: never) | **Yes** | No |
| 5 | Developer/Sandbox | Admin only | Both | No |

---

## Impact on Existing Issues

| Issue | Change |
|-------|--------|
| #67 (Start/Sync Hub) | Add Guided Setup as 5th path in hub layout |
| #68 (File Import Pipeline) | A3: import writes to overlay only, unknown → resolve queue. A4: resolve queue persisted in receipt |
| #66 (Auto-seed + Receipts) | A4: receipt `unresolved` field used for resolve persistence |
| #93 (Safe mutation proposal/apply) | A5: confirmation-gated plan/apply flow for agent-driven writes |
| New issue | Guided Setup Templates (A1) — curated activity templates |
| New issue | Aria Gating UX Contract (A2) — manual fallback adjacent, no paywall on setup |

---

## References
- ADR-026 (Startup + Import UX Contract) — parent document, unchanged
- ADR-025 (Crew Composition Model) — composition opt-in gate (D6)
- ADR-015 (Canonical Entity Identity) — `raw:officer:<gameId>` format
- AI UX Review Checklist (Reusable)
