/**
 * fleet-tools/targets.test.ts — Target tracking mutation tests
 *
 * Tests for: create_target, update_target, complete_target,
 * record_target_delta, record_reminder_feedback, record_goal_restatement.
 *
 * Extracted from fleet-tools.test.ts (#193).
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockTargetStore,
} from "./helpers.js";

// ─── Target Mutation Tools (#80) ────────────────────────────

describe("create_target", () => {
  it("creates an officer target with ref_id", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: 1,
          targetType: "officer",
          refId: "wiki:officer:james-t-kirk",
          loadoutId: null,
          priority: 1,
          reason: "Need for PvP crew",
          status: "active",
          autoSuggested: false,
          createdAt: "2026-02-17",
          updatedAt: "2026-02-17",
          achievedAt: null,
        }),
      }),
    });
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:james-t-kirk",
      priority: 1,
      reason: "Need for PvP crew",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_target");
    expect(result.created).toBe(true);
    expect(result.nextSteps).toBeDefined();
    const target = result.target as Record<string, unknown>;
    expect(target.id).toBe(1);
    expect(target.targetType).toBe("officer");
    expect(target.refId).toBe("wiki:officer:james-t-kirk");
    expect(target.priority).toBe(1);
  });

  it("creates a ship target with default priority", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: 2,
          targetType: "ship",
          refId: "cdn:ship:1234",
          loadoutId: null,
          priority: 2,
          reason: null,
          status: "active",
          autoSuggested: false,
          createdAt: "2026-02-17",
          updatedAt: "2026-02-17",
          achievedAt: null,
        }),
      }),
    });
    const result = await executeFleetTool("create_target", {
      target_type: "ship",
      ref_id: "cdn:ship:1234",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.priority).toBe(2);
  });

  it("detects duplicate active targets", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([{
          id: 5,
          targetType: "officer",
          refId: "wiki:officer:spock",
          status: "active",
          priority: 2,
          reason: "Old reason",
        }]),
      }),
    });
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:spock",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_target");
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(5);
    expect(result.nextSteps).toBeDefined();
  });

  it("allows target if existing ref_id is not active", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([{
          id: 5,
          targetType: "officer",
          refId: "wiki:officer:spock",
          status: "achieved",
          priority: 2,
        }]),
        create: vi.fn().mockResolvedValue({
          id: 6, targetType: "officer", refId: "wiki:officer:spock",
          loadoutId: null, priority: 2, reason: null, status: "active",
          autoSuggested: false, createdAt: "2026-02-17", updatedAt: "2026-02-17", achievedAt: null,
        }),
      }),
    });
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:spock",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
  });

  it("returns error for invalid target_type", async () => {
    const ctx = toolEnv({ targetStore: createMockTargetStore() });
    const result = await executeFleetTool("create_target", {
      target_type: "weapon",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Invalid target_type");
  });

  it("returns error for officer target without ref_id", async () => {
    const ctx = toolEnv({ targetStore: createMockTargetStore() });
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ref_id");
  });

  it("returns error for invalid priority", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
      }),
    });
    const result = await executeFleetTool("create_target", {
      target_type: "ship",
      ref_id: "cdn:ship:1",
      priority: 5,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Priority");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("create_target", {
      target_type: "officer", ref_id: "x",
    }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("update_target", () => {
  it("updates target priority and reason", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active", reason: null,
        }),
        update: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 1, status: "active", reason: "Top priority",
        }),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      priority: 1,
      reason: "Top priority",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("update_target");
    expect(result.updated).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.priority).toBe(1);
    expect(target.reason).toBe("Top priority");
  });

  it("abandons a target", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise", priority: 2, status: "active",
        }),
        update: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise", priority: 2, status: "abandoned", reason: null,
        }),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      status: "abandoned",
    }, ctx) as Record<string, unknown>;
    expect(result.updated).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.status).toBe("abandoned");
  });

  it("redirects achieved status to complete_target", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      status: "achieved",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("complete_target");
    expect(result.nextSteps).toBeDefined();
  });

  it("returns error for target not found", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 999,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("not found");
  });

  it("returns error for no update fields", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("No fields");
  });

  it("returns error for invalid priority", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    });
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      priority: 0,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Priority");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("update_target", { target_id: 1 }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing target_id", async () => {
    const ctx = toolEnv({ targetStore: createMockTargetStore() });
    const result = await executeFleetTool("update_target", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("target_id");
  });
});

describe("complete_target", () => {
  it("marks an active target as achieved", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "wiki:officer:kirk",
          priority: 1, status: "active", reason: "PvP crew",
        }),
        markAchieved: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "wiki:officer:kirk",
          priority: 1, status: "achieved", reason: "PvP crew",
          achievedAt: "2026-02-17T12:00:00Z",
        }),
      }),
    });
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("complete_target");
    expect(result.completed).toBe(true);
    expect(result.nextSteps).toBeDefined();
    const target = result.target as Record<string, unknown>;
    expect(target.id).toBe(1);
    expect(target.status).toBe("achieved");
    expect(target.achievedAt).toBe("2026-02-17T12:00:00Z");
  });

  it("returns already_achieved for completed targets", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise",
          status: "achieved", achievedAt: "2026-02-17",
        }),
      }),
    });
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("complete_target");
    expect(result.status).toBe("already_achieved");
    expect(result.message).toBeDefined();
  });

  it("returns error for abandoned targets", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", status: "abandoned",
        }),
      }),
    });
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("abandoned");
  });

  it("returns error for target not found", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool("complete_target", {
      target_id: 999,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("not found");
  });

  it("returns error for missing target_id", async () => {
    const ctx = toolEnv({ targetStore: createMockTargetStore() });
    const result = await executeFleetTool("complete_target", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("target_id");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("complete_target", { target_id: 1 }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("record_target_delta", () => {
  it("persists correction delta and returns recalibration summary", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({ id: 11, targetType: "ship", refId: "ship-voyager", status: "active" }),
        recordDelta: vi.fn().mockResolvedValue({
          id: 90,
          targetId: 11,
          metric: "voyager_blueprints",
          delta: 1,
          absoluteValue: 33,
          source: "manual",
          note: "Hirogen refinery chest",
          createdAt: "2026-03-03T10:00:00.000Z",
        }),
        listDeltas: vi.fn().mockResolvedValue([
          {
            id: 90,
            targetId: 11,
            metric: "voyager_blueprints",
            delta: 1,
            absoluteValue: 33,
            source: "manual",
            note: "Hirogen refinery chest",
            createdAt: "2026-03-03T10:00:00.000Z",
          },
        ]),
      }),
    });

    const result = await executeFleetTool("record_target_delta", {
      target_id: 11,
      metric: "voyager_blueprints",
      delta: 1,
      absolute_value: 33,
      note: "Hirogen refinery chest",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("record_target_delta");
    expect(result.persisted).toBe(true);
    expect((result.recalibration as Record<string, unknown>).mode).toBe("immediate");
    expect((result.logging as Record<string, unknown>).mode).toBe("silent");
  });

  it("returns error when target is missing", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({ get: vi.fn().mockResolvedValue(null) }),
    });
    const result = await executeFleetTool("record_target_delta", {
      target_id: 404,
      metric: "voyager_blueprints",
      delta: 1,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

describe("record_reminder_feedback", () => {
  it("persists reminder usefulness feedback", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        recordReminderFeedback: vi.fn().mockResolvedValue({
          id: 71,
          targetId: 11,
          reminderKey: "voyager_daily_loop",
          usefulness: "useful",
          source: "manual",
          note: null,
          createdAt: "2026-03-03T12:00:00.000Z",
        }),
        get: vi.fn().mockResolvedValue({ id: 11, targetType: "ship", refId: "ship-voyager", status: "active" }),
      }),
    });

    const result = await executeFleetTool("record_reminder_feedback", {
      reminder_key: "voyager_daily_loop",
      usefulness: "useful",
      target_id: 11,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("record_reminder_feedback");
    expect(result.persisted).toBe(true);
    expect((result.logging as Record<string, unknown>).mode).toBe("silent");
  });

  it("returns validation error for invalid usefulness", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore(),
    });

    const result = await executeFleetTool("record_reminder_feedback", {
      reminder_key: "voyager_daily_loop",
      usefulness: "meh",
    }, ctx) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
  });
});

describe("record_goal_restatement", () => {
  it("persists goal restatement events", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        recordGoalRestatement: vi.fn().mockResolvedValue({
          id: 81,
          targetId: 11,
          goalKey: "voyager_blueprints",
          source: "manual",
          note: null,
          createdAt: "2026-03-04T12:00:00.000Z",
        }),
        get: vi.fn().mockResolvedValue({ id: 11, targetType: "ship", refId: "ship-voyager", status: "active" }),
      }),
    });

    const result = await executeFleetTool("record_goal_restatement", {
      goal_key: "voyager_blueprints",
      target_id: 11,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("record_goal_restatement");
    expect(result.persisted).toBe(true);
    expect((result.logging as Record<string, unknown>).mode).toBe("silent");
  });

  it("returns validation error for missing goal_key", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore(),
    });

    const result = await executeFleetTool("record_goal_restatement", {
      goal_key: "",
    }, ctx) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
  });
});
