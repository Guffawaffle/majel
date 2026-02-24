import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, getFlag, makeResult } from "./runner.js";
import { createPool } from "../../src/server/db.js";
import type { EffectsContractArtifact } from "../../src/server/services/effects-contract-v3.js";
import { summarizeEffectsContractArtifact } from "./effects-harness.js";
import { evaluateActivationGates, type ActivationMetrics } from "./effects-gate-evaluator.js";

interface ActiveBaselineRow {
  run_id: string;
  metrics_json: string | null;
}

function deriveMetrics(artifact: EffectsContractArtifact): ActivationMetrics {
  const summary = summarizeEffectsContractArtifact(artifact);
  const mappedAbilitiesCount = Math.max(0, summary.abilities - summary.unmappedEntries);
  const mappedAbilitiesPercent = summary.abilities > 0
    ? (mappedAbilitiesCount / summary.abilities) * 100
    : 0;
  const inferredPromotedCount = artifact.officers
    .flatMap((officer) => officer.abilities)
    .flatMap((ability) => ability.effects)
    .filter((effect) => effect.inferred && effect.promotionReceiptId != null).length;
  const inferredPromotedRatio = summary.effects > 0 ? inferredPromotedCount / summary.effects : 0;

  return {
    officerCount: summary.officers,
    abilityCount: summary.abilities,
    mappedAbilitiesCount,
    mappedAbilitiesPercent,
    unmappedEntries: summary.unmappedEntries,
    inferredPromotedRatio,
  };
}

function parseBaselineMetrics(row: ActiveBaselineRow | undefined): ActivationMetrics | null {
  if (!row?.metrics_json) return null;
  try {
    return JSON.parse(row.metrics_json) as ActivationMetrics;
  } catch {
    return null;
  }
}

const command: AxCommand = {
  name: "effects:gates",
  description: "Evaluate activation gates for an effects artifact using policy profiles",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const inputPath = getFlag(args, "input");
    const profile = getFlag(args, "profile") ?? undefined;
    const datasetKind = getFlag(args, "dataset-kind") ?? "hybrid";
    const dbUrlFlag = getFlag(args, "db-url");
    if (dbUrlFlag) {
      return makeResult("effects:gates", start, {}, {
        success: false,
        errors: ["--db-url is disabled for security; use DATABASE_URL environment variable"],
        hints: ["Example: DATABASE_URL=<postgres-url> npm run ax -- effects:gates --input <contractPath> --dataset-kind hybrid"],
      });
    }
    const dbUrl = process.env.DATABASE_URL ?? "postgres://majel:majel@localhost:5432/majel";

    if (!inputPath) {
      return makeResult("effects:gates", start, {}, {
        success: false,
        errors: ["Missing required flag: --input <effects-contract-path>"],
        hints: ["Example: DATABASE_URL=<postgres-url> npm run ax -- effects:gates --input tmp/effects/runs/<run>/artifacts/effects-contract.v3.<hash>.json --profile local_dev --dataset-kind hybrid"],
      });
    }

    const resolvedInputPath = resolve(ROOT, inputPath);
    let artifact: EffectsContractArtifact;
    try {
      const raw = await readFile(resolvedInputPath, "utf-8");
      artifact = JSON.parse(raw) as EffectsContractArtifact;
    } catch (error) {
      return makeResult("effects:gates", start, {
        inputPath: resolvedInputPath,
      }, {
        success: false,
        errors: [error instanceof Error ? `Failed reading artifact: ${error.message}` : "Failed reading artifact"],
      });
    }

    const metrics = deriveMetrics(artifact);

    const pool = createPool(dbUrl);
    try {
      const baselineResult = await pool.query<ActiveBaselineRow>(
        `SELECT r.run_id, r.metrics_json
         FROM effect_dataset_active a
         JOIN effect_dataset_run r ON r.run_id = a.run_id
         WHERE a.scope = 'global'`,
      );

      const baselineRow = baselineResult.rows[0];
      const baselineMetrics = parseBaselineMetrics(baselineRow);

      const gateResult = await evaluateActivationGates({
        datasetKind,
        profile,
        metrics,
        baselineMetrics,
      });

      return makeResult("effects:gates", start, {
        inputPath: resolvedInputPath,
        profile: gateResult.profile,
        datasetKind,
        metrics,
        baseline: baselineRow
          ? {
              runId: baselineRow.run_id,
              metrics: baselineMetrics,
            }
          : null,
        gate: gateResult,
      }, {
        success: gateResult.ok,
        errors: gateResult.ok ? undefined : gateResult.violations,
      });
    } finally {
      await pool.end();
    }
  },
};

export default command;
