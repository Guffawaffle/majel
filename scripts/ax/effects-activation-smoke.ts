import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";

interface RuntimeHealthResponse {
  schemaVersion: string;
  generatedAt: string;
  status: "ok" | "degraded";
  activeRun: {
    runId: string;
    datasetKind: string;
    contentHash: string;
    activatedAt: string | null;
  } | null;
  sample: {
    requested: number;
    sampledKeys: string[];
    lookupByKey: Array<{
      naturalKey: string;
      runId: string;
      abilityCount: number;
    }>;
  };
  fallback: {
    zeroResultStable: boolean;
  };
}

function normalizeBaseUrl(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

const command: AxCommand = {
  name: "effects:activation:smoke",
  description: "Run runtime activation smoke checks against local/cloud target",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const target = (getFlag(args, "target") ?? "local").toLowerCase();
    const baseUrlFlag = getFlag(args, "base-url");

    let baseUrl: string;
    if (target === "local") {
      const port = process.env.MAJEL_PORT ?? "3000";
      baseUrl = normalizeBaseUrl(baseUrlFlag ?? `http://localhost:${port}`);
    } else if (target === "cloud") {
      const cloudBase = baseUrlFlag ?? process.env.MAJEL_CLOUD_URL ?? process.env.MAJEL_BASE_URL;
      if (!cloudBase) {
        return makeResult("effects:activation:smoke", start, { target }, {
          success: false,
          errors: ["Missing cloud base URL (use --base-url or MAJEL_CLOUD_URL)"] ,
          hints: ["Example: npm run ax -- effects:activation:smoke --target cloud --base-url https://majel-<id>-uc.a.run.app"],
        });
      }
      baseUrl = normalizeBaseUrl(cloudBase);
    } else {
      return makeResult("effects:activation:smoke", start, { target }, {
        success: false,
        errors: ["Invalid target; use --target local|cloud"],
      });
    }

    const url = `${baseUrl}/api/effects/runtime/health`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      return makeResult("effects:activation:smoke", start, { target, baseUrl, url }, {
        success: false,
        errors: [error instanceof Error ? `Request failed: ${error.message}` : "Request failed"],
      });
    }

    if (!response.ok) {
      return makeResult("effects:activation:smoke", start, {
        target,
        baseUrl,
        url,
        status: response.status,
      }, {
        success: false,
        errors: [`Runtime health endpoint returned HTTP ${response.status}`],
      });
    }

    let payload: RuntimeHealthResponse;
    try {
      payload = await response.json() as RuntimeHealthResponse;
    } catch (error) {
      return makeResult("effects:activation:smoke", start, {
        target,
        baseUrl,
        url,
      }, {
        success: false,
        errors: [error instanceof Error ? `Invalid JSON payload: ${error.message}` : "Invalid JSON payload"],
      });
    }

    const activeRunResolved = Boolean(payload.activeRun?.runId);
    const lookupHasCoverage = payload.sample.lookupByKey.some((entry) => entry.abilityCount > 0);
    const lookupRunIdsResolved = payload.sample.lookupByKey.every((entry) => typeof entry.runId === "string" && entry.runId.length > 0);
    const lookupSampleValid = payload.sample.lookupByKey.length === payload.sample.sampledKeys.length;
    const zeroResultStable = payload.fallback.zeroResultStable === true;

    const checks = {
      activeRunResolved,
      lookupHasCoverage,
      lookupRunIdsResolved,
      lookupSampleValid,
      zeroResultStable,
      endpointStatusOk: payload.status === "ok",
    };

    const failedChecks = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    return makeResult("effects:activation:smoke", start, {
      target,
      baseUrl,
      url,
      runId: payload.activeRun?.runId ?? null,
      sampledKeys: payload.sample.sampledKeys,
      lookupByKey: payload.sample.lookupByKey,
      checks,
      endpointStatus: payload.status,
    }, {
      success: failedChecks.length === 0,
      errors: failedChecks.length > 0
        ? [`Smoke checks failed: ${failedChecks.join(", ")}`]
        : undefined,
      hints: failedChecks.length > 0
        ? ["Inspect /api/effects/runtime/health payload and runtime dataset activation state"]
        : undefined,
    });
  },
};

export default command;
