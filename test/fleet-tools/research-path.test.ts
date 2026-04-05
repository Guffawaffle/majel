/**
 * fleet-tools/research-path.test.ts — Tests for get_research_path tool
 */

import { describe, it, expect, vi } from "vitest";
import { executeFleetTool, toolEnv } from "./helpers.js";
import type { ResearchStore } from "../../src/server/stores/research-store.js";
import type { ResearchPathResult } from "../../src/server/stores/research-store.js";

describe("get_research_path", () => {
  it("returns empty chain when target is already completed", async () => {
    const mockResult: ResearchPathResult = {
      targetNodeId: "node-x",
      targetName: "Combat Research",
      chain: [],
      targetCompleted: true,
    };

    const researchStore = {
      getResearchPath: vi.fn().mockResolvedValue(mockResult),
      listNodes: vi.fn().mockResolvedValue([]),
      listByTree: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ nodes: 0, trees: 0, completed: 0 }),
      replaceSnapshot: vi.fn(),
      close: vi.fn(),
    } satisfies ResearchStore;

    const ctx = toolEnv({ userId: "local", researchStore });

    const result = await executeFleetTool(
      "get_research_path",
      { target_node_id: "node-x" },
      ctx,
    ) as ResearchPathResult;

    expect(result.chain).toHaveLength(0);
    expect(result.targetCompleted).toBe(true);
    expect(researchStore.getResearchPath).toHaveBeenCalledWith("node-x");
  });

  it("returns incomplete prerequisites in dependency order", async () => {
    const mockResult: ResearchPathResult = {
      targetNodeId: "node-combat-1",
      targetName: "Combat Specialist",
      chain: [
        {
          nodeId: "node-prereq-1",
          name: "Basic Combat",
          tree: "Combat",
          currentLevel: 0,
          maxLevel: 5,
          completed: false,
          buffs: [],
        },
        {
          nodeId: "node-prereq-2",
          name: "Advanced Tactics",
          tree: "Combat",
          currentLevel: 2,
          maxLevel: 5,
          completed: false,
          buffs: [],
        },
      ],
      targetCompleted: false,
    };

    const researchStore = {
      getResearchPath: vi.fn().mockResolvedValue(mockResult),
      listNodes: vi.fn().mockResolvedValue([]),
      listByTree: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ nodes: 0, trees: 0, completed: 0 }),
      replaceSnapshot: vi.fn(),
      close: vi.fn(),
    } satisfies ResearchStore;

    const ctx = toolEnv({ userId: "local", researchStore });

    const result = await executeFleetTool(
      "get_research_path",
      { target_node_id: "node-combat-1" },
      ctx,
    ) as ResearchPathResult;

    expect(result.chain).toHaveLength(2);
    expect(result.chain[0].nodeId).toBe("node-prereq-1");
    expect(result.chain[0].name).toBe("Basic Combat");
    expect(result.chain[1].nodeId).toBe("node-prereq-2");
    expect(result.targetCompleted).toBe(false);
  });

  it("returns error when research store not available", async () => {
    const ctx = toolEnv({ userId: "local" });

    const result = await executeFleetTool(
      "get_research_path",
      { target_node_id: "node-x" },
      ctx,
    ) as { error: string };

    expect(result).toHaveProperty("error");
  });

  it("returns error when target_node_id is missing", async () => {
    const researchStore = {
      getResearchPath: vi.fn(),
      listNodes: vi.fn().mockResolvedValue([]),
      listByTree: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({ nodes: 0, trees: 0, completed: 0 }),
      replaceSnapshot: vi.fn(),
      close: vi.fn(),
    } satisfies ResearchStore;

    const ctx = toolEnv({ userId: "local", researchStore });

    const result = await executeFleetTool(
      "get_research_path",
      {},
      ctx,
    ) as { error: string };

    expect(result).toHaveProperty("error");
    expect(researchStore.getResearchPath).not.toHaveBeenCalled();
  });
});
