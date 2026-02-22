import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "effects:apply-decisions",
  description: "Guarded placeholder for decision application (enabled in later phase)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const runId = getFlag(args, "run");
    const decisionsPath = getFlag(args, "decisions");

    if (!runId || !decisionsPath) {
      return makeResult("effects:apply-decisions", start, {
        runId: runId ?? null,
        decisionsPath: decisionsPath ?? null,
      }, {
        success: false,
        errors: ["Missing required flags --run and/or --decisions"],
        hints: ["Use: npm run ax -- effects:apply-decisions --run=<runId> --decisions=decisions.<runId>.json"],
      });
    }

    return makeResult("effects:apply-decisions", start, {
      runId,
      decisionsPath,
      applied: false,
      phase: "scaffold-only",
      safety: "Canonical artifacts are immutable from AI decisions in this phase",
    }, {
      success: false,
      errors: ["Decision application is intentionally disabled until Phase 3/4 gate flow is implemented"],
      hints: [
        "Current flow: effects:build --mode=hybrid -> effects:review-pack",
        "Use human-reviewed override/rule PRs for canonical changes",
      ],
    });
  },
};

export default command;
