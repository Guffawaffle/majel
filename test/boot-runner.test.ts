import { describe, it, expect } from "vitest";
import { runStage } from "../src/server/boot-runner.js";
import pino from "pino";

// Silent logger for tests
const logger = pino({ level: "silent" });

describe("boot-runner", () => {
  describe("runStage — serial (concurrency: 1)", () => {
    it("runs tasks in order and returns timing", async () => {
      const order: string[] = [];
      const result = await runStage("test-stage", [
        { name: "a", fn: async () => { order.push("a"); } },
        { name: "b", fn: async () => { order.push("b"); } },
        { name: "c", fn: async () => { order.push("c"); } },
      ], logger, { concurrency: 1 });

      expect(order).toEqual(["a", "b", "c"]);
      expect(result.stage).toBe("test-stage");
      expect(result.tasks).toHaveLength(3);
      expect(result.failed).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      for (const task of result.tasks) {
        expect(task.ok).toBe(true);
        expect(task.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("throws aggregate error if a task fails", async () => {
      const order: string[] = [];
      await expect(runStage("fail-stage", [
        { name: "a", fn: async () => { order.push("a"); } },
        { name: "b", fn: async () => { throw new Error("boom"); } },
        { name: "c", fn: async () => { order.push("c"); } },
      ], logger, { concurrency: 1 })).rejects.toThrow('Stage "fail-stage" failed: b');

      // Serial: "a" runs, "b" fails, "c" should NOT run (stage aborts after collecting "b" failure)
      // Actually with our runner, serial mode runs all tasks and collects results, then throws
      // Wait — let me check: executeTask catches errors, so all tasks will run
      expect(order).toContain("a");
    });

    it("collects all failures before throwing", async () => {
      try {
        await runStage("multi-fail", [
          { name: "a", fn: async () => { throw new Error("fail-a"); } },
          { name: "b", fn: async () => { throw new Error("fail-b"); } },
        ], logger, { concurrency: 1 });
        expect.fail("should have thrown");
      } catch (err) {
        const e = err as Error & { stageResult: { failed: number; tasks: Array<{ name: string; ok: boolean }> } };
        expect(e.message).toBe('Stage "multi-fail" failed: a, b');
        expect(e.stageResult.failed).toBe(2);
        expect(e.stageResult.tasks[0]!.ok).toBe(false);
        expect(e.stageResult.tasks[1]!.ok).toBe(false);
      }
    });
  });

  describe("runStage — concurrent (concurrency > 1)", () => {
    it("respects concurrency limit", async () => {
      let maxConcurrent = 0;
      let current = 0;

      const makeTask = (name: string) => ({
        name,
        fn: async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise((r) => setTimeout(r, 20));
          current--;
        },
      });

      const result = await runStage("bounded", [
        makeTask("a"), makeTask("b"), makeTask("c"),
        makeTask("d"), makeTask("e"), makeTask("f"),
      ], logger, { concurrency: 2 });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(result.tasks).toHaveLength(6);
      expect(result.failed).toBe(0);
    });

    it("runs all tasks even with full parallelism", async () => {
      const names: string[] = [];
      const result = await runStage("full-parallel", [
        { name: "a", fn: async () => { names.push("a"); } },
        { name: "b", fn: async () => { names.push("b"); } },
        { name: "c", fn: async () => { names.push("c"); } },
        { name: "d", fn: async () => { names.push("d"); } },
      ], logger, { concurrency: 4 });

      expect(names.sort()).toEqual(["a", "b", "c", "d"]);
      expect(result.tasks).toHaveLength(4);
      expect(result.failed).toBe(0);
    });

    it("collects failures across concurrent tasks", async () => {
      try {
        await runStage("concurrent-fail", [
          { name: "a", fn: async () => { /* ok */ } },
          { name: "b", fn: async () => { throw new Error("b-fail"); } },
          { name: "c", fn: async () => { /* ok */ } },
          { name: "d", fn: async () => { throw new Error("d-fail"); } },
        ], logger, { concurrency: 4 });
        expect.fail("should have thrown");
      } catch (err) {
        const e = err as Error & { stageResult: { failed: number } };
        expect(e.stageResult.failed).toBe(2);
        expect(e.message).toContain("b");
        expect(e.message).toContain("d");
      }
    });
  });

  describe("runStage — default concurrency", () => {
    it("defaults to serial (concurrency: 1)", async () => {
      const order: string[] = [];
      await runStage("default", [
        { name: "a", fn: async () => { order.push("a"); await new Promise(r => setTimeout(r, 5)); } },
        { name: "b", fn: async () => { order.push("b"); } },
      ], logger);

      expect(order).toEqual(["a", "b"]);
    });
  });

  describe("runStage — empty", () => {
    it("handles empty task list", async () => {
      const result = await runStage("empty", [], logger);
      expect(result.tasks).toHaveLength(0);
      expect(result.failed).toBe(0);
    });
  });

  describe("timing accuracy", () => {
    it("records per-task duration", async () => {
      const result = await runStage("timing", [
        { name: "slow", fn: async () => { await new Promise(r => setTimeout(r, 50)); } },
        { name: "fast", fn: async () => { /* instant */ } },
      ], logger, { concurrency: 1 });

      const slow = result.tasks.find(t => t.name === "slow")!;
      const fast = result.tasks.find(t => t.name === "fast")!;
      expect(slow.durationMs).toBeGreaterThanOrEqual(40); // allow some timer imprecision
      expect(fast.durationMs).toBeLessThan(slow.durationMs);
    });
  });
});
