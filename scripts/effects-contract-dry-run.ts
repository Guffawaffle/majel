import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  summarizeEffectsContractArtifact,
  type EffectsSeedFile,
  validateEffectsSeedForV3,
} from "../src/server/services/effects-contract-v3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const seedPath = resolve(repoRoot, "data", "seed", "effect-taxonomy.json");
const officerFixturePath = resolve(repoRoot, "data", "seed", "effect-taxonomy.officer-fixture.v1.json");

async function main(): Promise<void> {
  const raw = await readFile(seedPath, "utf-8");
  const seed = JSON.parse(raw) as EffectsSeedFile;

  try {
    const fixtureRaw = await readFile(officerFixturePath, "utf-8");
    const fixture = JSON.parse(fixtureRaw) as { officers?: EffectsSeedFile["officers"] };
    if (Array.isArray(fixture.officers)) {
      seed.officers = fixture.officers;
    }
  } catch {
    seed.officers = seed.officers ?? [];
  }

  const validation = validateEffectsSeedForV3(seed);
  const artifact = buildEffectsContractV3Artifact(seed);
  const hash = hashEffectsContractArtifact(artifact);

  const repeatedArtifact = buildEffectsContractV3Artifact(seed, {
    generatedAt: artifact.generatedAt,
    snapshotVersion: artifact.source.snapshotVersion,
    generatorVersion: artifact.source.generatorVersion,
  });
  const repeatedHash = hashEffectsContractArtifact(repeatedArtifact);

  const summary = summarizeEffectsContractArtifact(artifact);
  const report = {
    ok: validation.ok && hash === repeatedHash,
    seedPath,
    officerFixturePath,
    validation,
    determinism: {
      hash,
      repeatedHash,
      stable: hash === repeatedHash,
    },
    artifact: {
      schemaVersion: artifact.schemaVersion,
      artifactVersion: artifact.artifactVersion,
      generatedAt: artifact.generatedAt,
      source: artifact.source,
    },
    summary,
    issuesPreview: validation.issues.slice(0, 20),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
