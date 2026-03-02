import type { AxCommand } from "./types.js";
import { makeResult, runCapture } from "./runner.js";

const triageBundle: AxCommand = {
  name: "triage:bundle",
  description: "Build a Cloud Logging triage bundle (markdown + structured data)",
  run: async (args) => {
    const start = Date.now();
    const commandIndex = args.findIndex((arg) => arg === "triage:bundle");
    const forwarded = (commandIndex >= 0 ? args.slice(commandIndex + 1) : args)
      .filter((arg) => arg !== "--");
    const exec = runCapture("tsx", ["scripts/cloud.ts", "triage:bundle", "--ax", ...forwarded], { ignoreExit: true });

    let parsed: Record<string, unknown> | null = null;
    const raw = exec.stdout.trim();
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    const success = exec.exitCode === 0 && !!parsed;
    if (!success) {
      return makeResult("triage:bundle", start, {
        exitCode: exec.exitCode,
        stdout: exec.stdout.trim(),
        stderr: exec.stderr.trim(),
      }, {
        success: false,
        errors: ["cloud triage bundle failed"],
        hints: [
          "Run directly for details: npm run cloud:triage:bundle -- --run-id <id>",
          "Ensure gcloud auth and logging.viewer permission",
        ],
      });
    }

    const data = (parsed?.data as Record<string, unknown> | undefined) ?? {};
    return makeResult("triage:bundle", start, data, {
      success: Boolean(parsed?.success ?? true),
      errors: (parsed?.errors as string[] | undefined) ?? undefined,
      hints: (parsed?.hints as string[] | undefined) ?? undefined,
    });
  },
};

export default triageBundle;
