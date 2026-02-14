# styles/

Foundation CSS loaded by `<link>` tags in `index.html`. Always present, never lazy-loaded.

## Files

| File | Section | Source Lines (from monolith) |
|------|---------|----------------------------|
| `variables.css` | `:root` custom properties | styles.css 1–15 |
| `base.css` | Reset, html/body, typography, scrollbar | styles.css 16–52 |
| `layout.css` | #app flex, sidebar, title bar, mobile header | styles.css 53–361 |
| `input.css` | Chat input, form controls, buttons, badges | styles.css 547–585 |
| `responsive.css` | `@media` queries (768px, 480px) | styles.css 2260–2305 + 335–361 |

## Rules

- Foundation CSS must NOT contain view-specific selectors
- View CSS lives in `views/<name>/<name>.css` (loaded lazily)
- Component CSS lives in `components/<name>.css`
- All custom properties go in `variables.css`
