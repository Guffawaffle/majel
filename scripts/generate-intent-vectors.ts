import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedIntentInput } from "../src/server/stores/effect-store.js";
import { buildIntentVectorArtifactFromSeed } from "../src/server/services/intent-vector-generator.js";

interface SeedFile {
  intents: SeedIntentInput[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const seedPath = resolve(repoRoot, "data", "seed", "effect-taxonomy.json");
const artifactPath = resolve(repoRoot, "web", "src", "lib", "data", "intent-vectors.v0.json");

async function main(): Promise<void> {
  const raw = await readFile(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeedFile;
  const artifact = buildIntentVectorArtifactFromSeed(parsed.intents);
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(artifactPath, content, "utf-8");
  process.stdout.write(`Updated ${artifactPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
