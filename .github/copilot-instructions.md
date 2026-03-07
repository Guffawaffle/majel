# GitHub Copilot Instructions for Majel

## Critical Test Execution Rule

This repo has a large Vitest suite and many tests depend on PostgreSQL.

- Do not assume test commands should finish immediately.
- Do not treat partial output or a quiet terminal as a failure signal.
- Do not run raw `vitest` through shell pipelines like `| tail`, `| grep`, or `| tee` when checking repo health.
- Do not infer pass/fail from truncated terminal output.
- Always prefer the structured `ax` commands for validation.

Required defaults:

```bash
npm run ax -- test
npm run ax -- ci
```

Execution rules for agents:

- If Postgres may not be running, start or verify it first with `npm run pg`.
- For full validation, use `npm run ax -- ci` and wait for the command to finish.
- For test-only validation, use `npm run ax -- test` and wait for the command to finish.
- If a raw test command is absolutely necessary, run `npm test` or `npx vitest run` without shell post-processing and allow enough time for completion.
- If a command must run asynchronously, use a background process and explicitly wait for completion before reporting status.

Anti-patterns to avoid:

```bash
npx vitest run | tail -20
npx vitest run | grep Test
npx vitest run 2>&1 | tee /tmp/vitest.log
```

These patterns are unreliable in the agent terminal environment for this repo and have repeatedly caused false failure reads and premature cancellation.

## Validation Workflow (High Signal / Low Noise)

Prefer the `ax` command family for status and validation:

```bash
npm run ax -- status
npm run ax -- affected
npm run ax -- test
npm run ax -- typecheck
npm run ax -- lint
npm run ax -- ci
```

- Use `npm run ax -- ci` as the default end-to-end gate.
- Use `npm run ax -- affected` before broad test runs to reduce noise.
- `ax` output is structured JSON and should be treated as the primary source of pass/fail status.

## Fallback Path

If `ax` is unavailable or output is unreliable for the task, use the legacy flow:

```bash
npm run pg
npx vitest run
npx tsc --noEmit
npm run lint
```
