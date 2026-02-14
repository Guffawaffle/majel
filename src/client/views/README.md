# views/

One folder per navigation destination. Each view is a self-contained module.

## Interface Contract

Every view module MUST export:
- `init()` — called by app.js at startup, registers with the view registry
- `refresh()` — called every time the view becomes active

Every view module MAY export:
- `destroy()` — cleanup when leaving the view (remove listeners, cancel timers)

## ViewConfig (registry contract)

```js
registerView('my-view', {
    area: HTMLElement,       // REQUIRED — container element (from index.html)
    icon: string,            // REQUIRED — emoji for title bar
    title: string,           // REQUIRED — title bar heading
    subtitle: string,        // REQUIRED — title bar subtitle
    cssHref?: string,        // OPTIONAL — lazy-loaded CSS file path
    init?: () => void,       // OPTIONAL — called once on first navigation
    refresh: () => void,     // REQUIRED — called every time view becomes active
    destroy?: () => void,    // OPTIONAL — cleanup when leaving view
    gate?: string,           // OPTIONAL — required role (e.g. 'admiral')
});
```

## How to Add a New View

1. Create `views/my-view/my-view.js` + `views/my-view/my-view.css`
2. Add `<section id="my-view-area" class="my-view-area hidden"></section>` to index.html
3. Add nav button: `<button class="sidebar-nav-btn" data-view="my-view">`
4. In `my-view.js`, call `registerView('my-view', { area, icon, title, ... })`
5. Import and call `init()` from `app.js`
6. That's it. No other files need editing.

## What NOT to Do

- Do NOT add show*() functions to app.js — use the registry
- Do NOT import from other view folders — views are independent
- Do NOT put API calls directly in view code — use api/ modules
- Do NOT add `<link>` tags for view CSS — use `cssHref` in the registry config

## File Header Template

```js
/**
 * @module views/my-view/my-view
 * @layer view
 * @domain my-domain
 * @depends api/my-domain, components/confirm-dialog
 * @exports init, refresh
 * @emits my-view:filter-change
 * @listens hashchange
 * @requires-dom #my-view-area
 * @state { items[], isLoading }
 */
```
