# Effects Activation Smoke Contract

This document defines the runtime smoke contract used before cloud activation/promote.

## Endpoint

`GET /api/effects/runtime/health`

### Response shape

```json
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-02-23T09:00:00.000Z",
  "status": "ok|degraded",
  "activeRun": {
    "runId": "string",
    "datasetKind": "string",
    "contentHash": "string",
    "activatedAt": "string|null"
  },
  "sample": {
    "requested": 5,
    "sampledKeys": ["officer-id"],
    "lookupByKey": [
      {
        "naturalKey": "officer-id",
        "runId": "active-run-id",
        "abilityCount": 1
      }
    ]
  },
  "fallback": {
    "zeroResultStable": true
  }
}
```

## Required smoke checks

- Active run pointer resolves (`activeRun.runId` exists).
- Sampled runtime lookups show non-empty coverage (`lookupByKey[].abilityCount > 0` for at least one sampled key).
- Sampled runtime lookups have resolved run IDs (`lookupByKey[].runId` is non-empty for every sampled key).
- Sample payload integrity holds (`lookupByKey.length == sampledKeys.length`).
- Endpoint health status is `ok`.
- Fallback semantics remain stable (`fallback.zeroResultStable == true`).

## AX command

Local:

`npm run ax -- effects:activation:smoke --target local`

Cloud:

`npm run ax -- effects:activation:smoke --target cloud --base-url https://<service-url>`

The command emits machine-readable output including `runId` and `sampledKeys`.

## Promote precondition

When activating to cloud target via `effects:promote:db`, smoke is a required precondition:

`npm run ax -- effects:promote:db ... --activate --activation-target cloud --smoke-base-url https://<service-url>`

If smoke fails, promote refuses activation.
