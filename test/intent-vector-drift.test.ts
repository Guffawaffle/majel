import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SeedIntentInput } from "../src/server/stores/effect-store.js";
import { buildIntentVectorArtifactFromSeed } from "../src/server/services/intent-vector-generator.js";

interface SeedFile {
  intents: SeedIntentInput[];
}

describe("intent vector artifact drift", () => {
  it("matches canonical vectors generated from effect taxonomy seed", async () => {
    const seedPath = resolve(process.cwd(), "data", "seed", "effect-taxonomy.json");
    const artifactPath = resolve(process.cwd(), "web", "src", "lib", "data", "intent-vectors.v0.json");

    const seedRaw = await readFile(seedPath, "utf-8");
    const artifactRaw = await readFile(artifactPath, "utf-8");

    const seed = JSON.parse(seedRaw) as SeedFile;
    const checkedInArtifact = JSON.parse(artifactRaw) as unknown;

    const generatedArtifact = buildIntentVectorArtifactFromSeed(seed.intents);

    expect(checkedInArtifact).toEqual(generatedArtifact);
  });
});
