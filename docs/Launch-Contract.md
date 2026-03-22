# Majel Launch Contract v0.1

## Purpose

Launch Majel only when it can reliably ingest user data, preserve owned-state correctly enough to be trusted, and answer against that data without brittle tool-call failures.

This contract is about the minimum honest launchable product, not the ideal product.

---

## Core launch thesis

Majel is ready for first users when:

1. a player can get their data into the system without the app falling apart,
2. Majel can represent that owned data accurately enough to avoid misleading advice,
3. chat/import flows do not regularly derail on tool-call/import execution issues,
4. failures are diagnosable from Majel itself without requiring external log spelunking.

---

## Must-have before launch

### 1. Import reliability
Majel must reliably handle the main import paths you expect real users to use at launch.

Required:
- ingest pasted structured data without tool-call brittleness
- ingest uploaded export files in the supported formats
- normalize imported data deterministically
- tolerate partial or messy input without corrupting user state
- surface actionable import errors when normalization fails
- preserve enough import diagnostics to explain what happened later

Exit criteria:
- repeated imports of the same data do not create nonsense state
- malformed imports fail clearly, not silently
- import runs are observable enough to debug from Majel-side data

---

### 2. Per-run tool policy for chat/import execution
Majel must stop treating all STFC-shaped requests as tool-backed requests.

Required:
- bulk transform/extract/import-style requests run in toolless mode
- knowledge/recommendation requests can still use fleet tools
- malformed function-call failures trigger a safe retry path rather than replaying the same bad conditions
- cancelled runs do not continue into additional retries

Exit criteria:
- officer roster / CSV / pasted-table transforms no longer commonly trip fleet-tool mode
- normal advisory queries still work with tools enabled where appropriate
- failed runs expose attempt/mode/failure reason

---

### 3. Owned fleet model must support multiple instances of the same ship
Launch should not assume one owned ship per catalog ship.

Required:
- owned ship instances are modeled separately from catalog ship definitions
- a player can own two copies of the same ship type
- each owned instance can carry its own progression state
- import/update logic can reconcile instance state without collapsing duplicates into one record

Why this is launch-scope:
If Majel cannot represent "I have 2 K'Vorts" correctly, fleet advice and state trust both degrade too early.

Exit criteria:
- duplicate owned ships are stored as distinct instances
- fleet-facing views and reasoning can distinguish them
- imports do not merge distinct copies incorrectly

---

### 4. Clear catalog vs fleet boundary in the backend
Majel must separate reference knowledge from player-owned state.

Required:
- catalog layer = static/reference game data
- fleet layer = user-owned ships/officers/state
- tooling and reasoning paths use the right layer intentionally
- imports update fleet state, not catalog definitions

Exit criteria:
- code paths are understandable enough that an import or chat request is clearly acting on catalog or fleet
- no major ambiguity remains around where owned-state truth lives

---

### 5. Minimum observability for failed runs
A failed or cancelled run must still leave behind enough information to debug it from Majel artifacts.

Required:
- run ID / trace identity created before provider work
- attempt-level metadata for provider attempts
- tool mode, retry reason, finish reason, and key token diagnostics recorded where available
- failure path visible without requiring Cloud Logging as the only source of truth

Exit criteria:
- "what happened to this run?" is answerable from Majel-side data in most cases

---

## Should-have soon after launch

These are important, but not launch blockers unless one of them proves necessary during implementation.

### 1. Community mod ingestion
Treat as an optional accelerator, not the backbone of launch.

Desired:
- optional import path for power users
- explicit format contract
- graceful degradation if the mod/export format changes

Reason for defer pressure:
This is a convenience/expansion path, not the foundation Majel should depend on to be usable.

---

### 2. Better user-visible import controls
Examples:
- retry without tools
- import mode hints
- cleaner import error summaries
- explicit "replace vs merge" import behavior where relevant

Important, but secondary to making the backend correct first.

---

### 3. Failure/debug UI improvements
Examples:
- attempt timeline in Admiral
- richer failure cards
- more visible retry/fallback reasons

Useful, but the data plumbing matters first.

---

### 4. Smarter reconciliation rules for repeated imports
Examples:
- better duplicate matching
- import diff previews
- confidence indicators when matching entities

Good next-step work once the core import contract is stable.

---

## Explicitly deferred

These should not quietly creep into launch scope.

### 1. Making community mod ingestion the primary onboarding path
Deferred because it creates an unnecessary dependency on external tooling and format stability.

### 2. Broad token-budget tuning as the primary answer
Deferred because the real issue is mode selection and execution policy.

### 3. Large UX mode switch like "edit vs chat"
Deferred unless real usage proves auto-classification is insufficient.

### 4. Major tool declaration redesign
Possible later, but not required for the first stabilization pass.

### 5. Generalized ingestion framework for every possible source
Out of scope for launch. Support the launch-critical import paths first.

---

## Anti-goals

Majel launch does **not** require:
- perfect ingestion for every community data source
- full polished Admiral debugging UX
- solving every fleet/crafting/planning workflow before first users
- a universal one-click import ecosystem
- zero technical debt in the tool boundary

---

## Release gate

Majel is launchable when all of the following are true:

1. supported imports are reliable enough for real-world messy data,
2. bulk transform/import requests no longer regularly fail from inappropriate tool usage,
3. duplicate ship ownership is represented correctly enough to preserve trust,
4. catalog vs fleet ownership boundaries are no longer muddy,
5. failed runs are diagnosable from Majel-side telemetry/state.

If any of those are still false, launch is premature.

---

## Next-version scope

After launch, prioritize:

1. community mod ingestion as optional power-user fast path,
2. richer import reconciliation and dedupe UX,
3. better failure/debug presentation,
4. additional convenience import sources.

---

## Decision note

The launch blocker is not "support every ingestion path."
The launch blocker is "Majel must be trustworthy on the ingestion paths it does support."

[signed ~]