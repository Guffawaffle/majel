import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import effectsSnapshotExport from "../scripts/ax/effects-snapshot-export.js";

describe("effects-snapshot-export inert parsing", () => {
  it("marks CM as inert for both phrases and leaves non-CM non-inert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "majel-effects-feed-"));
    const outPath = join(dir, "snapshot.json");

    try {
      const manifest = {
        schemaVersion: "1.0.0",
        feedId: "stfc-en-test",
        runId: "20260224T000000Z",
        sourceLabel: "stfc.space",
        sourceVersion: "test",
        snapshotId: "snapshot-test",
        generatedAt: "2026-02-24T00:00:00.000Z",
        schemaHash: "sha256:test",
        contentHash: "sha256:test",
        entityFiles: {
          officer: "officer.json",
          "translation.en.officer_buffs": "translation.officer_buffs.json",
        },
      };

      const officers = {
        records: [
          {
            game_id: 101,
            captain_ability: { id: 5001, loca_id: 9001 },
            ability: { id: 5002, loca_id: 9002 },
          },
          {
            game_id: 102,
            captain_ability: { id: 5003, loca_id: 9003 },
          },
        ],
      };

      const translations = {
        records: [
          {
            translation_external_id: 9001,
            translation_key: "officer_ability_9001",
            translation_text: "Provides NO Benefit.",
          },
          {
            translation_external_id: 9002,
            translation_key: "officer_ability_9002",
            translation_text: "Provides no benefit in this context",
          },
          {
            translation_external_id: 9003,
            translation_key: "officer_ability_9003",
            translation_text: "This does not have a captain",
          },
        ],
      };

      await writeFile(join(dir, "feed.json"), JSON.stringify(manifest, null, 2));
      await writeFile(join(dir, "officer.json"), JSON.stringify(officers, null, 2));
      await writeFile(join(dir, "translation.officer_buffs.json"), JSON.stringify(translations, null, 2));

      const result = await effectsSnapshotExport.run(["--feed", dir, "--out", outPath]);
      expect(result.success).toBe(true);

      const raw = await readFile(outPath, "utf-8");
      const payload = JSON.parse(raw) as {
        officers: Array<{
          officerId: string;
          abilities: Array<{ abilityId: string; slot: "cm" | "oa" | "bda"; isInert: boolean }>;
        }>;
      };

      const byAbility = new Map<string, { slot: "cm" | "oa" | "bda"; isInert: boolean }>();
      for (const officer of payload.officers) {
        for (const ability of officer.abilities) {
          byAbility.set(ability.abilityId, { slot: ability.slot, isInert: ability.isInert });
        }
      }

      expect(byAbility.get("cdn:ability:5001")).toEqual({ slot: "cm", isInert: true });
      expect(byAbility.get("cdn:ability:5002")).toEqual({ slot: "oa", isInert: false });
      expect(byAbility.get("cdn:ability:5003")).toEqual({ slot: "cm", isInert: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
