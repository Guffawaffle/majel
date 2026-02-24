import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, getFlag, makeResult, runCapture } from "./runner.js";

function parseAxJson(stdout: string): Record<string, unknown> {
  const match = stdout.match(/\{[\s\S]*\}\s*$/);
  if (!match) {
    throw new Error("Unable to parse AX JSON output");
  }
  return JSON.parse(match[0]) as Record<string, unknown>;
}

interface ContractAbility {
  isInert: boolean;
  effects: unknown[];
}

interface ContractOfficer {
  abilities: ContractAbility[];
}

const command: AxCommand = {
  name: "effects:coverage",
  description: "Run full-feed coverage measurement and enforce minimum officer coverage",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const feed = getFlag(args, "feed");
    if (!feed) {
      return makeResult("effects:coverage", start, {}, {
        success: false,
        errors: ["Missing required flag: --feed <feedId-or-path>"],
        hints: ["Example: npm run ax -- effects:coverage --feed /srv/crawlers/stfc.space/data/feeds/stfc-en-20260223/20260223T090000Z --min-officer-coverage 50"],
      });
    }

    const feedsRoot = getFlag(args, "feeds-root") ?? resolve("/srv", "crawlers", "stfc.space", "data", "feeds");
    const mode = (getFlag(args, "mode") ?? "hybrid").toLowerCase();
    const minOfficerCoverage = Number.parseFloat(getFlag(args, "min-officer-coverage") ?? "50");
    const outPath = getFlag(args, "out") ?? resolve(ROOT, "tmp", "effects", "exports", "effects-snapshot.coverage.json");

    const exportRun = runCapture("tsx", [
      "scripts/ax.ts",
      "effects:snapshot:export",
      "--feed",
      feed,
      "--feeds-root",
      feedsRoot,
      "--out",
      outPath,
    ]);

    if (exportRun.exitCode !== 0) {
      return makeResult("effects:coverage", start, {
        feed,
        feedsRoot,
        exportStdout: exportRun.stdout.trim(),
        exportStderr: exportRun.stderr.trim(),
      }, {
        success: false,
        errors: ["Snapshot export failed"],
      });
    }

    const buildRun = runCapture("tsx", [
      "scripts/ax.ts",
      "effects:build",
      "--mode",
      mode,
      "--input",
      outPath,
    ]);

    if (buildRun.exitCode !== 0) {
      return makeResult("effects:coverage", start, {
        feed,
        mode,
        snapshotPath: outPath,
        buildStdout: buildRun.stdout.trim(),
        buildStderr: buildRun.stderr.trim(),
      }, {
        success: false,
        errors: ["Effects build failed"],
      });
    }

    const buildJson = parseAxJson(buildRun.stdout);
    const buildData = (buildJson.data as Record<string, unknown> | undefined) ?? {};
    const deterministic = (buildData.deterministic as Record<string, unknown> | undefined) ?? {};
    const contractPath = deterministic.contractPath;

    if (typeof contractPath !== "string" || contractPath.length === 0) {
      return makeResult("effects:coverage", start, {
        feed,
        mode,
        snapshotPath: outPath,
        build: buildData,
      }, {
        success: false,
        errors: ["Build output missing deterministic contract path"],
      });
    }

    const contractRaw = await readFile(contractPath, "utf-8");
    const contract = JSON.parse(contractRaw) as { officers?: ContractOfficer[] };
    const officers = Array.isArray(contract.officers) ? contract.officers : [];

    let mappedOfficers = 0;
    let totalAbilities = 0;
    let mappedAbilities = 0;

    for (const officer of officers) {
      let officerMapped = false;
      for (const ability of officer.abilities ?? []) {
        totalAbilities += 1;
        const mapped = ability.isInert || (Array.isArray(ability.effects) && ability.effects.length > 0);
        if (mapped) {
          mappedAbilities += 1;
          officerMapped = true;
        }
      }
      if (officerMapped) mappedOfficers += 1;
    }

    const officerCoveragePercent = officers.length > 0
      ? (mappedOfficers / officers.length) * 100
      : 0;
    const abilityCoveragePercent = totalAbilities > 0
      ? (mappedAbilities / totalAbilities) * 100
      : 0;

    const success = officerCoveragePercent >= minOfficerCoverage;
    return makeResult("effects:coverage", start, {
      feed,
      mode,
      threshold: {
        minOfficerCoverage,
      },
      output: {
        snapshotPath: outPath,
        contractPath,
      },
      officers: {
        total: officers.length,
        mapped: mappedOfficers,
        coveragePercent: Number(officerCoveragePercent.toFixed(2)),
      },
      abilities: {
        total: totalAbilities,
        mapped: mappedAbilities,
        coveragePercent: Number(abilityCoveragePercent.toFixed(2)),
      },
    }, {
      success,
      errors: success ? undefined : [
        `Officer coverage ${officerCoveragePercent.toFixed(2)}% is below threshold ${minOfficerCoverage.toFixed(2)}%`,
      ],
    });
  },
};

export default command;
