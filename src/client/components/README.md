# components/

Shared UI components used across multiple views.

## Interface Contract

Components are standalone modules with no view-specific dependencies.
Each component has its own JS + CSS file pair.

## Files

| Component | Purpose |
|-----------|---------|
| `confirm-dialog.js` + `.css` | Reusable confirmation/alert dialog |

## Rules

- Components must NOT import from `views/` — they're shared infrastructure
- Components CAN import from `api/` if they need backend data
- CSS selectors should be prefixed with the component name (e.g. `.confirm-dialog-*`)
