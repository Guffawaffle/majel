# styles/

Foundation CSS loaded by `<link>` tags in `index.html`. Always present, never lazy-loaded.

## Files

| File | Section | Source Lines (from monolith) |
|------|---------|----------------------------|
| `variables.css` | `:root` custom properties | styles.css 17–40 |
| `base.css` | Reset, html/body, dialogs, setup guide, scrollbar | styles.css 9–15, 42–52, 586–622, 750–787, 796–804 |
| `layout.css` | #app flex, sidebar, session list, title bar, mobile header, sidebar overlay | styles.css 53–361, 788–795 |
| `responsive.css` | `@media` queries (768px, 480px) | styles.css 2260–2303 |

## Rules

- Foundation CSS must NOT contain view-specific selectors
- View CSS lives in `views/<name>/<name>.css` (loaded lazily in Phase 3)
- Component CSS lives in `components/<name>.css`
- All custom properties go in `variables.css`
