import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createResearchStoreFactory, type ReplaceResearchSnapshotInput } from "../src/server/stores/research-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

function makeSnapshot(): ReplaceResearchSnapshotInput {
  return {
    source: "import",
    capturedAt: "2026-02-21T00:00:00Z",
    nodes: [
      {
        nodeId: "r1",
        tree: "Galaxy",
        name: "Node A",
        maxLevel: 10,
        dependencies: [],
        buffs: [{ kind: "ship", metric: "attack", value: 5, unit: "percent" }],
      },
      {
        nodeId: "r2",
        tree: "Galaxy",
        name: "Node B",
        maxLevel: 20,
        dependencies: ["r1"],
        buffs: [{ kind: "combat", metric: "damage", value: 10, unit: "percent" }],
      },
      {
        nodeId: "r3",
        tree: "Station",
        name: "Node C",
        maxLevel: 5,
        dependencies: [],
        buffs: [{ kind: "resource", metric: "ore", value: 100, unit: "flat" }],
      },
    ],
    state: [
      { nodeId: "r1", level: 10, completed: true, updatedAt: "2026-02-21T00:00:01Z" },
      { nodeId: "r2", level: 5, completed: false, updatedAt: "2026-02-21T00:00:02Z" },
      { nodeId: "r3", level: 0, completed: false, updatedAt: null },
    ],
  };
}

describe("ResearchStore", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("replaces snapshot and returns expected counts", async () => {
    const factory = await createResearchStoreFactory(pool);
    const store = factory.forUser("u1");

    const result = await store.replaceSnapshot(makeSnapshot());
    expect(result).toEqual({ nodes: 3, trees: 2 });

    const counts = await store.counts();
    expect(counts).toEqual({ nodes: 3, trees: 2, completed: 1 });

    const nodes = await store.listNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes[0].tree).toBe("Galaxy");
    expect(nodes[0].source).toBe("import");
  });

  it("groups by tree with filters and aggregate totals", async () => {
    const factory = await createResearchStoreFactory(pool);
    const store = factory.forUser("u1");
    await store.replaceSnapshot(makeSnapshot());

    const allTrees = await store.listByTree();
    expect(allTrees).toHaveLength(2);

    const galaxy = allTrees.find((entry) => entry.tree === "Galaxy");
    expect(galaxy).toBeDefined();
    expect(galaxy!.totals.nodes).toBe(2);
    expect(galaxy!.totals.completed).toBe(1);
    expect(galaxy!.totals.inProgress).toBe(1);
    expect(galaxy!.totals.avgCompletionPct).toBe(62.5);

    const activeOnly = await store.listByTree({ includeCompleted: false });
    expect(activeOnly.find((entry) => entry.tree === "Galaxy")?.nodes).toHaveLength(1);

    const stationOnly = await store.listByTree({ tree: " station " });
    expect(stationOnly).toHaveLength(1);
    expect(stationOnly[0].tree).toBe("Station");
  });

  it("isolates data per user", async () => {
    const factory = await createResearchStoreFactory(pool);
    const a = factory.forUser("user-a");
    const b = factory.forUser("user-b");

    await a.replaceSnapshot(makeSnapshot());
    await b.replaceSnapshot({
      source: null,
      capturedAt: null,
      nodes: [
        {
          nodeId: "z1",
          tree: "Prime",
          name: "Node Z",
          maxLevel: 3,
          dependencies: [],
          buffs: [],
        },
      ],
      state: [{ nodeId: "z1", level: 1, completed: false, updatedAt: null }],
    });

    expect((await a.counts()).nodes).toBe(3);
    expect((await b.counts()).nodes).toBe(1);
    expect((await b.listNodes())[0].nodeId).toBe("z1");
  });
});
