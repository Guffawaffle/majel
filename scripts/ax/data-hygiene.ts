import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, hasFlag, makeResult, runCapture } from "./runner.js";

interface HygieneFinding {
  file: string;
  reason: string;
}

const FORBIDDEN_PATH_PREFIXES = [
  "data/.stfc-snapshot/",
  "data/raw-cdn/",
  "data/cdn-raw/",
  "tmp/cdn/",
];

const RAW_SIGNATURE_KEYS = [
  '"officer_ability_desc"',
  '"officer_ability_short_desc"',
  '"captain_ability_desc"',
  '"icon_asset"',
  '"ability_id"',
];

const DATA_JSON_SIZE_BLOCK_BYTES = 1_000_000;

const DATA_JSON_ALLOWLIST = new Set([
  "data/seed/effect-taxonomy.json",
  "data/seed/effect-taxonomy.officer-fixture.v1.json",
  "data/seed/effects-overrides.v1.json",
  "data/seed/effects-ci-budget.v1.json",
]);

function listGitFiles(): string[] {
  const listed = runCapture("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split("\0").map((value) => value.trim()).filter(Boolean);
}

function listStagedFiles(): string[] {
  const listed = runCapture("git", ["diff", "--cached", "--name-only", "-z"]);
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split("\0").map((value) => value.trim()).filter(Boolean);
}

const NON_AUTHORITATIVE_GENERATED_PATTERNS: RegExp[] = [
  /^tmp\//,
  /^logs\/ax-last-run\.json$/,
  /^logs\/ax-runs\.ndjson$/,
  /^receipts\/effects-build\..+\.json$/,
  /^receipts\/load-receipt\..+\.json$/,
  /^receipts\/load-receipt\.json$/,
];

const command: AxCommand = {
  name: "data:hygiene",
  description: "Guardrail scaffold for blocking raw CDN data and oversized payload commits",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const strict = hasFlag(args, "strict");
    const files = listGitFiles();
    const stagedFiles = listStagedFiles();

    const violations: HygieneFinding[] = [];
    const warnings: HygieneFinding[] = [];

    for (const file of files) {
      if (FORBIDDEN_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))) {
        violations.push({ file, reason: "forbidden raw snapshot/cdn path" });
      }

      if (file.startsWith("data/") && file.endsWith(".json") && !DATA_JSON_ALLOWLIST.has(file)) {
        try {
          const size = statSync(resolve(ROOT, file)).size;
          if (size > DATA_JSON_SIZE_BLOCK_BYTES) {
            violations.push({ file, reason: `data json exceeds ${DATA_JSON_SIZE_BLOCK_BYTES} bytes` });
          }
        } catch {
          warnings.push({ file, reason: "unable to stat file during size check" });
        }
      }

      if (!file.endsWith(".json")) continue;
      try {
        const body = readFileSync(resolve(ROOT, file), "utf-8");
        const matches = RAW_SIGNATURE_KEYS.filter((sig) => body.includes(sig));
        if (matches.length >= 2) {
          warnings.push({ file, reason: `raw-cdn signature keys detected (${matches.slice(0, 3).join(", ")})` });
        }
      } catch {
        warnings.push({ file, reason: "unable to read json for signature scan" });
      }
    }

    for (const staged of stagedFiles) {
      if (NON_AUTHORITATIVE_GENERATED_PATTERNS.some((pattern) => pattern.test(staged))) {
        violations.push({ staged, reason: "staged non-authoritative generated artifact" });
      }
    }

    const success = strict ? (violations.length === 0 && warnings.length === 0) : violations.length === 0;

    return makeResult("data:hygiene", start, {
      strict,
      scannedFiles: files.length,
      forbiddenPathPrefixes: FORBIDDEN_PATH_PREFIXES,
      sizeBlockBytes: DATA_JSON_SIZE_BLOCK_BYTES,
      allowlistCount: DATA_JSON_ALLOWLIST.size,
      stagedFiles: stagedFiles.length,
      generatedArtifactPatterns: NON_AUTHORITATIVE_GENERATED_PATTERNS.map((pattern) => pattern.source),
      violations,
      warnings,
    }, {
      success,
      errors: violations.length > 0
        ? violations.map((violation) => `${violation.file}: ${violation.reason}`)
        : undefined,
      hints: [
        "Policy reference: DATA_HYGIENE.md",
        "Run strict mode: npm run ax -- data:hygiene --strict",
      ],
    });
  },
};

export default command;
