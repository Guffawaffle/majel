/**
 * fleet-tools/read-targets.test.ts — Tests for target/goal read tools
 *
 * Covers: list_targets, get_agent_experience_metrics, detect_target_conflicts
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockTargetStore,
  createMockCrewStore,
} from "./helpers.js";

describe("list_targets", () => {
  const FIXTURE_TARGET = {
    id: 1,
    targetType: "officer" as const,
    refId: "officer-kirk",
    loadoutId: null,
    targetTier: null,
    targetRank: "Commander",
    targetLevel: 40,
    reason: "Strong captain maneuver",
    priority: 1,
    status: "active" as const,
    autoSuggested: false,
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    achievedAt: null,
  };

  it("returns active targets by default", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([FIXTURE_TARGET]),
      }),
    });
    const result = await executeFleetTool("list_targets", {}, ctx) as Record<string, unknown>;
    expect(result.totalTargets).toBe(1);
    const targets = result.targets as Array<Record<string, unknown>>;
    expect(targets[0].refId).toBe("officer-kirk");
    expect(targets[0].priority).toBe(1);
    expect(targets[0].status).toBe("active");
    // Verify default status filter
    expect(ctx.deps.targetStore!.list).toHaveBeenCalledWith({ status: "active" });
  });

  it("passes target_type filter", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    });
    await executeFleetTool("list_targets", { target_type: "ship" }, ctx);
    expect(ctx.deps.targetStore!.list).toHaveBeenCalledWith({
      targetType: "ship",
      status: "active",
    });
  });

  it("passes explicit status filter", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    });
    await executeFleetTool("list_targets", { status: "achieved" }, ctx);
    expect(ctx.deps.targetStore!.list).toHaveBeenCalledWith({ status: "achieved" });
  });

  it("passes both filters together", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    });
    await executeFleetTool("list_targets", { target_type: "crew", status: "abandoned" }, ctx);
    expect(ctx.deps.targetStore!.list).toHaveBeenCalledWith({
      targetType: "crew",
      status: "abandoned",
    });
  });

  it("maps all target fields to response", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([FIXTURE_TARGET]),
        listReminderFeedback: vi.fn().mockResolvedValue([]),
      }),
    });
    const result = await executeFleetTool("list_targets", {}, ctx) as Record<string, unknown>;
    const target = (result.targets as Array<Record<string, unknown>>)[0];
    expect(target).toEqual({
      id: 1,
      targetType: "officer",
      refId: "officer-kirk",
      loadoutId: null,
      targetTier: null,
      targetRank: "Commander",
      targetLevel: 40,
      reason: "Strong captain maneuver",
      priority: 1,
      status: "active",
      autoSuggested: false,
      achievedAt: null,
      recentDeltas: [],
      recentReminderFeedback: [],
      continuity: {
        hasRecentCorrections: false,
        hasReminderFeedback: false,
        lastContinuityEventAt: null,
      },
    });
  });

  it("includes per-target reminder continuity context", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([FIXTURE_TARGET]),
        listDeltas: vi.fn().mockResolvedValue([
          {
            id: 10,
            targetId: 1,
            metric: "officer_shards",
            delta: 3,
            absoluteValue: 73,
            source: "manual",
            note: null,
            createdAt: "2026-03-04T10:00:00.000Z",
          },
        ]),
        listReminderFeedback: vi.fn().mockResolvedValue([
          {
            id: 201,
            targetId: 1,
            reminderKey: "kirk_shard_checkin",
            usefulness: "useful",
            source: "manual",
            note: null,
            createdAt: "2026-03-04T11:00:00.000Z",
          },
        ]),
      }),
    });

    const result = await executeFleetTool("list_targets", {}, ctx) as Record<string, unknown>;
    const target = (result.targets as Array<Record<string, unknown>>)[0];

    expect((target.recentReminderFeedback as Array<Record<string, unknown>>).length).toBe(1);
    expect((target.continuity as Record<string, unknown>).hasRecentCorrections).toBe(true);
    expect((target.continuity as Record<string, unknown>).hasReminderFeedback).toBe(true);
    expect((target.continuity as Record<string, unknown>).lastContinuityEventAt).toBe("2026-03-04T11:00:00.000Z");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("list_targets", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

describe("get_agent_experience_metrics", () => {
  it("returns policy and observed correction metrics", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([
          { id: 11, targetType: "ship", refId: "ship-voyager", status: "active" },
        ]),
        listDeltas: vi.fn().mockResolvedValue([
          {
            id: 1,
            targetId: 11,
            metric: "voyager_blueprints",
            delta: 1,
            absoluteValue: 33,
            source: "spocks.club",
            note: null,
            createdAt: new Date().toISOString(),
          },
        ]),
        listReminderFeedback: vi.fn().mockResolvedValue([
          {
            id: 1,
            targetId: 11,
            reminderKey: "voyager_daily_loop",
            usefulness: "useful",
            source: "manual",
            note: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: 2,
            targetId: null,
            reminderKey: "research_checkin",
            usefulness: "not_useful",
            source: "manual",
            note: null,
            createdAt: new Date().toISOString(),
          },
        ]),
        listGoalRestatements: vi.fn().mockResolvedValue([
          {
            id: 12,
            targetId: 11,
            goalKey: "voyager_blueprints",
            source: "manual",
            note: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: 13,
            targetId: null,
            goalKey: "voyager_blueprints",
            source: "manual",
            note: null,
            createdAt: new Date().toISOString(),
          },
        ]),
      }),
    });

    const result = await executeFleetTool("get_agent_experience_metrics", {}, ctx) as Record<string, unknown>;
    const policy = result.policy as Record<string, unknown>;
    const observed = result.observed as Record<string, unknown>;

    expect(policy.etaConfidenceThreshold).toBe(0.75);
    expect(policy.sourceAttributionTargetPct).toBe(90);
    expect(policy.reminderUsefulnessTargetPct).toBe(70);
    expect(policy.repeatQuestionReductionTargetDirection).toBe("downward");
    expect(observed.totalCorrectionDeltas).toBe(1);
    expect(observed.reminderFeedbackTotal).toBe(2);
    expect(observed.reminderUsefulnessPct).toBe(50);
    expect(observed.goalRestatementTotal).toBe(2);
    expect(observed.repeatedGoalKeyCount).toBe(1);
    expect(observed.etaPolicyMode).toBe("thresholded_numeric_or_qualitative");
    expect(observed.sourceMix).toBeDefined();
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("get_agent_experience_metrics", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});


describe("detect_target_conflicts", () => {
  it("returns conflicts with summary", async () => {
    // Mock the detection: we test the detection engine separately in target-conflicts.test.ts.
    // Here we verify that the tool wiring works and returns the expected shape.
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    });
    const result = await executeFleetTool("detect_target_conflicts", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("conflicts");
    expect(result).toHaveProperty("summary");
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalConflicts).toBe(0);
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("detect_target_conflicts", {}, toolEnv());
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Target");
  });

  it("returns error when crew store unavailable", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore(),
    });
    const result = await executeFleetTool("detect_target_conflicts", {}, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Crew");
  });
});

// ─── suggest_targets: Ready to Upgrade (#75) ───────────────

