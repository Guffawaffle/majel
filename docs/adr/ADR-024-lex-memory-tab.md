# ADR-024: Lex Memory Tab

**Status:** Accepted  
**Date:** 2026-02-14  
**Issue:** [#29](https://github.com/Guffawaffle/majel/issues/29)

## Context

Lex Memory is a core differentiator — Majel remembers context across sessions via semantic memory frames stored in PostgreSQL (ADR-021). But there's no UI surface. The user can't browse what Aria remembers, search recall, or manage memory frames.

Currently, memory is accessible only via API:
- `GET /api/recall?q=...` — semantic search
- `GET /api/history?source=lex` — timeline
- Memory frame count appears in `/api/health`

Making it a first-class tab creates transparency: the user sees what the AI "knows" and can manage it.

## Decision

Add a **Memory** tab to the LCARS sidebar, following the existing view registry pattern (ADR-023).

### View Registration

```javascript
// src/client/views/memory/memory.js
registerView('memory', {
    area: $('#memory-area'),
    icon: '🧠',
    title: 'Memory',
    subtitle: 'What Aria remembers across sessions',
    cssHref: 'views/memory/memory.css',
    init, refresh,
});
```

This becomes the 8th view: `chat`, `drydock`, `loadouts`, `catalog`, `fleet`, `diagnostics`, `admiral`, **`memory`**.

### Tab Layout

```
┌─────────────────────────────────────────────────────────┐
│ 🧠 Memory — What Aria remembers across sessions        │
├─────────────────────────────────────────────────────────┤
│ [🔍 Search memory...                        ] [Search] │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📋 Frame: "Kirk/Spock/Bones PvP strategy"          │ │
│ │ 2026-02-14 09:30 · Relevance: 0.92 · chat          │ │
│ │ Admiral asked about optimal Explorer PvP crew...    │ │
│ │                                          [🗑 Delete]│ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ 📋 Frame: "Augur mining build priorities"           │ │
│ │ 2026-02-13 14:15 · Relevance: 0.87 · chat          │ │
│ │ Discussed tiering priority for Augur vs Voyager...  │ │
│ │                                          [🗑 Delete]│ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Showing 12 frames · 📊 Total: 47 frames                │
└─────────────────────────────────────────────────────────┘
```

### Features

| Feature | Priority | API | Notes |
|---------|----------|-----|-------|
| Browse all frames (paginated) | P0 | `GET /api/memory/frames` | New endpoint |
| Search by meaning | P0 | `GET /api/recall?q=...` | Existing |
| Delete individual frame | P1 | `DELETE /api/memory/frames/:id` | New endpoint |
| Frame count badge | P1 | `GET /api/health` | Existing |
| Recently-injected frames | P2 | — | Which frames fed into last chat |
| Bulk delete | P2 | `DELETE /api/memory/frames` | With filter |

### New API Endpoints

```
GET    /api/memory/frames          — List frames (paginated, newest first)
       ?limit=20&offset=0          — Pagination
       ?q=search+query             — Optional: filter by keyword
DELETE /api/memory/frames/:id      — Delete a single frame
DELETE /api/memory/frames          — Bulk delete (with ?olderThan=30d)
```

These supplement the existing `GET /api/recall?q=...` (semantic search) and `GET /api/history?source=lex` (timeline).

### Client Module Structure

```
src/client/
├── views/
│   ├── memory/
│   │   ├── memory.js       ← View registration, init, refresh
│   │   └── memory.css      ← LCARS-themed frame cards
│   └── ...
├── api/
│   └── memory-api.js       ← fetchFrames(), deleteFrame(), searchMemory()
```

Following existing patterns:
- `memory-api.js` wraps fetch calls (like `catalog-api.js`)
- `memory.js` handles DOM rendering and event binding (like `fleet.js`)
- LCARS card layout for frames (consistent with fleet/catalog card patterns)

### Frame Display

Each frame card shows:
- **Summary caption** — the frame's `summary_caption` field
- **Timestamp** — `created_at` in relative format ("2 hours ago")
- **Module scope** — which module created it (typically "chat")
- **Relevance score** — when displayed as search results
- **Content preview** — truncated `status_snapshot` text
- **Delete button** — with confirmation

### Integration Points

1. **Chat → Memory**: After chat responses, a subtle indicator shows "✓ Remembered" when a frame is persisted
2. **Memory → Chat**: Clicking a frame could pre-fill a recall query in chat
3. **Memory tab badge**: Show frame count in sidebar nav (like unread count)

### Auth & Scoping

- Memory is user-scoped via RLS (ADR-021 D4)
- Each user sees only their own frames
- New endpoints use existing `requireVisitor` + `attachScopedMemory` middleware chain
- Delete endpoints require `requireAdmiral` (destructive)

## Migration Path

### Phase 1: API + Basic Tab
1. Add `GET /api/memory/frames` and `DELETE /api/memory/frames/:id` routes
2. Create `memory-api.js` client module
3. Create `memory.js` view with browse + search
4. Add `memory.css` with LCARS frame card styles
5. Wire into app shell (DOM area, import map, sidebar)

### Phase 2: Polish
1. Pagination (infinite scroll or explicit pages)
2. Recently-injected frame highlighting
3. Bulk delete with age filter
4. Frame count badge in sidebar

### Phase 3: Integration
1. "Remembered" indicator in chat
2. Cross-linking between chat and memory
3. Memory retention policy in settings

## Consequences

### Positive
- Users see what Aria remembers — builds trust
- Memory management prevents stale context from degrading chat quality
- Natural home for recall functionality (currently hidden)
- Consistent with LCARS tab pattern — no new UI paradigms

### Negative
- One more tab in the sidebar (8 total — approaching cognitive limit)
- Frame deletion is permanent — no undo
- Semantic search quality depends on Lex frame construction

### Risks
- Large frame counts could make browsing slow → mitigate with pagination
- Users might delete frames that are actually useful → mitigate with confirmation dialog

## References

- [ADR-021](ADR-021-postgres-frame-store.md) — PostgreSQL FrameStore with RLS
- [ADR-023](ADR-023-architecture-restructure.md) — View registry pattern
- [ADR-017](ADR-017-fleet-tab-and-player-roadmap.md) — Fleet tab (pattern reference)
- [#29](https://github.com/Guffawaffle/majel/issues/29) — Tracking issue
