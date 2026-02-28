import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShipCdnIngestor, OfficerCdnIngestor, ReferenceCdnIngestor } from "../scripts/lib/cdn-ingest-pipeline.ts";

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

  it("ReferenceCdnIngestor upserts entries and prunes only from its own table", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "majel-cdn-ref-"));
    dirs.push(baseDir);
    await mkdir(join(baseDir, "research"), { recursive: true });
    await writeFile(join(baseDir, "research", "summary.json"), JSON.stringify([
      { id: 501 },
      { id: 502 },
      { id: 503 },
    ]));

    const seen = new Set<number>();
    const upsertOne = vi.fn(async (entry: { id: number }) => {
      if (seen.has(entry.id)) return "updated" as const;
      seen.add(entry.id);
      return "created" as const;
    });

    const pool = createMockPool(1); // 1 row pruned
    const ingestor = new ReferenceCdnIngestor<{ id: number }>({
      pool: pool as never,
      snapshotDir: baseDir,
      entity: "research",
      summaryRelativePath: "research/summary.json",
      idPrefix: "cdn:research:",
      tableName: "reference_research",
      upsertOne,
    });

    const first = await ingestor.run();
    expect(first?.upsert).toEqual({ created: 3, updated: 0, total: 3 });
    expect(first?.pruned).toEqual({ records: 1, overlays: 0, targets: 0 });

    // Prune should only DELETE from reference_research (no overlay/target queries)
    const pruneCall = pool.query.mock.calls[0];
    expect(pruneCall[0]).toContain("reference_research");
    expect(pruneCall[0]).toContain("cdn:research:");
    const pruneIds = pruneCall[1][0] as string[];
    expect(pruneIds).toEqual(["cdn:research:501", "cdn:research:502", "cdn:research:503"]);

    // Only 1 query (prune) — no overlay or target cleanup
    expect(pool.query).toHaveBeenCalledTimes(1);

    // Second run should show all updates (no creates)
    const second = await ingestor.run();
    expect(second?.upsert).toEqual({ created: 0, updated: 3, total: 3 });
  });
});
