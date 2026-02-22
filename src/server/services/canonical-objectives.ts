import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedIntentInput } from "../stores/effect-store.js";
import {
  buildIntentVectorArtifactFromSeed,
  type IntentVectorArtifact,
} from "./intent-vector-generator.js";

interface SeedFile {
  intents: SeedIntentInput[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = resolve(__dirname, "..", "..", "..", "data", "seed", "effect-taxonomy.json");

let cachedArtifact: IntentVectorArtifact | null = null;

export async function getCanonicalObjectiveArtifact(): Promise<IntentVectorArtifact> {
  if (cachedArtifact) return cachedArtifact;

  const raw = await readFile(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeedFile;
  cachedArtifact = buildIntentVectorArtifactFromSeed(parsed.intents);
  return cachedArtifact;
}

export async function getCanonicalObjectiveKeys(): Promise<Set<string>> {
  const artifact = await getCanonicalObjectiveArtifact();
  return new Set(artifact.intents.map((intent) => intent.intentKey));
}
