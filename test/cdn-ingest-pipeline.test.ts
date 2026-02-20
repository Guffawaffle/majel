import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShipCdnIngestor, OfficerCdnIngestor } from "../scripts/lib/cdn-ingest-pipeline.ts";

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function createMockPool(rowCount = 0): MockPool {
  return {
    query: vi.fn().mockResolvedValue({ rowCount, rows: [] }),
  };
}

describe("cdn-ingest-pipeline", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("preserves ship idempotent upsert semantics and prune ID set", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "majel-cdn-ship-"));
    dirs.push(baseDir);
    await mkdir(join(baseDir, "ship"), { recursive: true });
    await writeFile(join(baseDir, "ship", "summary.json"), JSON.stringify([{ id: 101 }, { id: 102 }]));

    const seen = new Set<number>();
    const upsertOne = vi.fn(async (ship: { id: number }) => {
      if (seen.has(ship.id)) return "updated" as const;
      seen.add(ship.id);
      return "created" as const;
    });

    const pool = createMockPool(0);
    const ingestor = new ShipCdnIngestor<{ id: number }>({
      pool: pool as never,
      snapshotDir: baseDir,
      upsertOne,
    });

    const first = await ingestor.run();
    const second = await ingestor.run();

    expect(first?.upsert).toEqual({ created: 2, updated: 0, total: 2 });
    expect(second?.upsert).toEqual({ created: 0, updated: 2, total: 2 });

    const firstPruneArgs = pool.query.mock.calls[0]?.[1]?.[0] as string[];
    expect(firstPruneArgs).toEqual(["cdn:ship:101", "cdn:ship:102"]);
    expect(pool.query).toHaveBeenCalledTimes(6);
  });

  it("preserves officer prune/update flow with officer ID prefix", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "majel-cdn-officer-"));
    dirs.push(baseDir);
    await mkdir(join(baseDir, "officer"), { recursive: true });
    await writeFile(join(baseDir, "officer", "summary.json"), JSON.stringify([{ id: 201 }]));

    const pool = createMockPool(1);
    const upsertOne = vi.fn(async () => "updated" as const);
    const ingestor = new OfficerCdnIngestor<{ id: number }>({
      pool: pool as never,
      snapshotDir: baseDir,
      upsertOne,
    });

    const result = await ingestor.run();

    expect(result?.upsert).toEqual({ created: 0, updated: 1, total: 1 });
    expect(result?.pruned).toEqual({ records: 1, overlays: 1, targets: 1 });

    const firstPruneArgs = pool.query.mock.calls[0]?.[1]?.[0] as string[];
    expect(firstPruneArgs).toEqual(["cdn:officer:201"]);
  });
});
