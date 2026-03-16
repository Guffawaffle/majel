/**
 * boot-runner.ts — Staged boot orchestration with bounded concurrency and timing
 *
 * ADR-047: Provides `runStage()` for executing named async tasks within a stage,
 * with configurable concurrency, per-task timing, and aggregate failure reporting.
 */

import type { Logger } from "pino";

// ─── Types ──────────────────────────────────────────────────────

export interface BootTask {
  /** Short kebab-case name for logging (e.g. "reference-store", "effect-seed") */
  name: string;
  /** Async initializer function */
  fn: () => Promise<void>;
}

export interface StageOptions {
  /** Max concurrent tasks (default: 1 = serial) */
  concurrency?: number;
}

export interface TaskResult {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: unknown;
}

export interface StageResult {
  stage: string;
  durationMs: number;
  tasks: TaskResult[];
  failed: number;
}

// ─── Stage Runner ───────────────────────────────────────────────

/**
 * Run a named stage of boot tasks with bounded concurrency.
 *
 * - Executes tasks respecting the concurrency limit
 * - Logs per-task timing via `boot.task`
 * - Logs stage summary via `boot.stage`
 * - Collects all results before deciding to throw
 * - Throws an aggregate error if any task failed
 */
export async function runStage(
  stageName: string,
  tasks: BootTask[],
  logger: Logger,
  options?: StageOptions,
): Promise<StageResult> {
  const concurrency = options?.concurrency ?? 1;
  const stageStart = Date.now();
  const results: TaskResult[] = [];

  if (concurrency <= 1) {
    // Serial execution
    for (const task of tasks) {
      const result = await executeTask(stageName, task, logger);
      results.push(result);
    }
  } else {
    // Bounded concurrent execution
    let index = 0;
    const pending = new Set<Promise<void>>();

    while (index < tasks.length || pending.size > 0) {
      // Fill up to concurrency limit
      while (index < tasks.length && pending.size < concurrency) {
        const task = tasks[index++]!;
        const p = executeTask(stageName, task, logger).then((result) => {
          results.push(result);
          pending.delete(p);
        });
        pending.add(p);
      }
      // Wait for at least one to complete before filling again
      if (pending.size > 0) {
        await Promise.race(pending);
      }
    }
  }

  const stageDurationMs = Date.now() - stageStart;
  const failed = results.filter((r) => !r.ok).length;

  logger.info(
    { stage: stageName, durationMs: stageDurationMs, tasks: results.length, failed },
    "boot.stage",
  );

  const stageResult: StageResult = {
    stage: stageName,
    durationMs: stageDurationMs,
    tasks: results,
    failed,
  };

  if (failed > 0) {
    const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
    const err = new Error(
      `Stage "${stageName}" failed: ${failedNames.join(", ")}`,
    );
    (err as Error & { stageResult: StageResult }).stageResult = stageResult;
    throw err;
  }

  return stageResult;
}

// ─── Task Executor ──────────────────────────────────────────────

async function executeTask(
  stageName: string,
  task: BootTask,
  logger: Logger,
): Promise<TaskResult> {
  const taskStart = Date.now();
  try {
    await task.fn();
    const durationMs = Date.now() - taskStart;
    logger.info(
      { stage: stageName, task: task.name, durationMs, ok: true },
      "boot.task",
    );
    return { name: task.name, ok: true, durationMs };
  } catch (error) {
    const durationMs = Date.now() - taskStart;
    logger.error(
      { stage: stageName, task: task.name, durationMs, ok: false, err: error instanceof Error ? error.message : String(error) },
      "boot.task",
    );
    return { name: task.name, ok: false, durationMs, error };
  }
}
