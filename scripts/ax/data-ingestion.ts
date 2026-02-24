import type { AxCommand, AxResult } from "./types.js";
import { getFlag, hasFlag, makeResult, runCapture } from "./runner.js";

function usageHint(): string {
  return "Use: npm run ax -- data:ingestion --mode=validate|load|diff|status --feed <id-or-path> [--feeds-root path] [--activate-runtime-dataset] [--retention-keep-runs <n>] [--scope global] [--limit <n>] [--a <id-or-path> --b <id-or-path>] (prefer DATABASE_URL env over --db-url)";
}

function redactSecrets(value: string): string {
  return value.replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1<redacted>");
}

const command: AxCommand = {
  name: "data:ingestion",
  description: "Run data ingestion validate/load/diff through ax",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const mode = (getFlag(args, "mode") ?? "validate").toLowerCase();
    const feedsRoot = getFlag(args, "feeds-root");
    const dbUrl = getFlag(args, "db-url");
    const feed = getFlag(args, "feed");
    const a = getFlag(args, "a");
    const b = getFlag(args, "b");

    if (!["validate", "load", "diff", "status"].includes(mode)) {
      return makeResult("data:ingestion", start, { mode }, {
        success: false,
        errors: [`Invalid mode '${mode}'`],
        hints: [usageHint()],
      });
    }

    if (dbUrl) {
      return makeResult("data:ingestion", start, { mode }, {
        success: false,
        errors: ["--db-url is disabled for security; use DATABASE_URL environment variable"],
        hints: ["Example: DATABASE_URL=<postgres-url> npm run ax -- data:ingestion --mode=load --feed <id-or-path>"],
      });
    }

    const cmdArgs = ["scripts/data-ingestion.ts", mode];
    if (mode === "diff") {
      if (!a || !b) {
        return makeResult("data:ingestion", start, { mode, a, b }, {
          success: false,
          errors: ["diff mode requires --a and --b"],
          hints: [usageHint()],
        });
      }
      cmdArgs.push("--a", a, "--b", b);
    } else if (mode === "validate" || mode === "load") {
      if (!feed) {
        return makeResult("data:ingestion", start, { mode, feed }, {
          success: false,
          errors: [`${mode} mode requires --feed`],
          hints: [usageHint()],
        });
      }
      cmdArgs.push("--feed", feed);
    }

    if (feedsRoot) cmdArgs.push("--feeds-root", feedsRoot);
    if (mode === "load" && hasFlag(args, "allow-partial")) cmdArgs.push("--allow-partial");
    if (mode === "load" && hasFlag(args, "activate-runtime-dataset")) cmdArgs.push("--activate-runtime-dataset");
    if (mode === "load") {
      const retentionKeepRuns = getFlag(args, "retention-keep-runs");
      if (retentionKeepRuns) cmdArgs.push("--retention-keep-runs", retentionKeepRuns);
    }
    if (mode === "status") {
      const scope = getFlag(args, "scope");
      const limit = getFlag(args, "limit");
      if (scope) cmdArgs.push("--scope", scope);
      if (limit) cmdArgs.push("--limit", limit);
    }

    const exec = runCapture("tsx", cmdArgs, { ignoreExit: true });

    const sanitizedCommand = redactSecrets(["tsx", ...cmdArgs].join(" "));
    const sanitizedStdout = redactSecrets(exec.stdout.trim());
    const sanitizedStderr = redactSecrets(exec.stderr.trim());

    return makeResult("data:ingestion", start, {
      mode,
      command: sanitizedCommand,
      exitCode: exec.exitCode,
      stdout: sanitizedStdout,
      stderr: sanitizedStderr,
    }, {
      success: exec.exitCode === 0,
      errors: exec.exitCode === 0 ? undefined : ["data ingestion command failed"],
      hints: exec.exitCode === 0 ? undefined : [usageHint()],
    });
  },
};

export default command;
