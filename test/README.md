# test/

Vitest suites for API, stores, services, middleware, and integration-style flows.

## Structure

| Path | Purpose |
|---|---|
| `*.test.ts` | Main test suites grouped by domain |
| `helpers/` | Test helpers, fixtures, and request/state utilities |

## Common commands

```bash
npm run test
npm run test:watch
npm run test:coverage
npm run ax -- test
npm run ax -- ci
```
