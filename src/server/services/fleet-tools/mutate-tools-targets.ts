/**
 * fleet-tools/mutate-tools-targets.ts — Target tracking mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Create, update, complete targets + silent delta/feedback/restatement logging.
 * Extracted from mutate-tools.ts (#193).
 */

import type { ToolEnv } from "./declarations.js";
import type { TargetStatus, TargetType, UpdateTargetInput } from "../../stores/target-store.js";
import { VALID_TARGET_TYPES, VALID_TARGET_STATUSES } from "../../stores/target-store.js";
import { log } from "../../logger.js";
import { str, MAX_NOTES_LEN } from "./mutate-tools-helpers.js";

// ─── Create Target ──────────────────────────────────────────

export async function createTargetTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "create_target", error: "Target system not available." };
  }

  const targetType = str(args, "target_type") as TargetType;
  if (!targetType || !VALID_TARGET_TYPES.includes(targetType)) {
    return {
      tool: "create_target",
      error: `Invalid target_type. Must be one of: ${VALID_TARGET_TYPES.join(", ")}.`,
      input: { target_type: targetType || null },
    };
  }

  const refId = str(args, "ref_id") || null;
  const loadoutId = args.loadout_id != null ? Number(args.loadout_id) : null;

  // officer/ship targets should have a ref_id; crew targets should have a loadout_id
  if ((targetType === "officer" || targetType === "ship") && !refId) {
    return {
      tool: "create_target",
      error: `ref_id is required for ${targetType} targets.`,
      input: { target_type: targetType, ref_id: null },
    };
  }
  if (targetType === "crew" && !loadoutId && !refId) {
    return {
      tool: "create_target",
      error: "crew targets require either loadout_id or ref_id.",
      input: { target_type: targetType, loadout_id: null, ref_id: null },
    };
  }

  // Dupe detection — check for active targets with the same ref_id
  if (refId) {
    const existing = await ctx.deps.targetStore.listByRef(refId);
    const activeMatch = existing.find((t) => t.status === "active");
    if (activeMatch) {
      return {
        tool: "create_target",
        status: "duplicate_detected",
        existingId: activeMatch.id,
        existingType: activeMatch.targetType,
        existingPriority: activeMatch.priority,
        existingReason: activeMatch.reason,
        message: `An active ${activeMatch.targetType} target for ${refId} already exists (ID ${activeMatch.id}).`,
        nextSteps: [
          `Use update_target to modify the existing target (ID ${activeMatch.id}).`,
          "Use list_targets to see all current targets.",
        ],
      };
    }
  }

  const priority = args.priority != null ? Number(args.priority) : 2;
  if (priority < 1 || priority > 3) {
    return {
      tool: "create_target",
      error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
      input: { priority },
    };
  }

  const reason = str(args, "reason") || null;
  const targetTier = args.target_tier != null ? Number(args.target_tier) : null;
  const targetLevel = args.target_level != null ? Number(args.target_level) : null;
  const targetRank = str(args, "target_rank") || null;

  const target = await ctx.deps.targetStore.create({
    targetType,
    refId,
    loadoutId,
    priority,
    reason: reason ? reason.slice(0, MAX_NOTES_LEN) : null,
    targetTier,
    targetLevel,
    targetRank,
  });

  return {
    tool: "create_target",
    created: true,
    target: {
      id: target.id,
      targetType: target.targetType,
      refId: target.refId,
      loadoutId: target.loadoutId,
      priority: target.priority,
      reason: target.reason,
      status: target.status,
    },
    nextSteps: [
      "Use list_targets to see all current targets.",
      "Use suggest_targets to get AI-driven acquisition recommendations.",
      "Use complete_target when this goal is achieved.",
    ],
  };
}

// ─── Update Target ──────────────────────────────────────────

export async function updateTargetTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "update_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "update_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.deps.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "update_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  const fields: UpdateTargetInput = {};
  let hasUpdates = false;

  if (args.priority != null) {
    const p = Number(args.priority);
    if (p < 1 || p > 3) {
      return {
        tool: "update_target",
        error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
        input: { target_id: targetId, priority: args.priority },
      };
    }
    fields.priority = p;
    hasUpdates = true;
  }

  if (args.status != null) {
    const s = str(args, "status") as TargetStatus;
    if (!VALID_TARGET_STATUSES.includes(s)) {
      return {
        tool: "update_target",
        error: `Invalid status. Must be one of: ${VALID_TARGET_STATUSES.join(", ")}.`,
        input: { target_id: targetId, status: s },
      };
    }
    // For "achieved", direct to complete_target which uses markAchieved
    if (s === "achieved") {
      return {
        tool: "update_target",
        error: "To mark a target achieved, use complete_target instead — it records the achievement timestamp.",
        input: { target_id: targetId, status: s },
        nextSteps: [`Call complete_target with target_id ${targetId}.`],
      };
    }
    fields.status = s;
    hasUpdates = true;
  }

  if (args.reason != null) {
    fields.reason = str(args, "reason").slice(0, MAX_NOTES_LEN) || null;
    hasUpdates = true;
  }
  if (args.target_tier != null) {
    fields.targetTier = Number(args.target_tier);
    hasUpdates = true;
  }
  if (args.target_level != null) {
    fields.targetLevel = Number(args.target_level);
    hasUpdates = true;
  }
  if (args.target_rank != null) {
    fields.targetRank = str(args, "target_rank") || null;
    hasUpdates = true;
  }

  if (!hasUpdates) {
    return {
      tool: "update_target",
      error: "No fields to update — provide at least one of: priority, status, reason, target_tier, target_level, target_rank.",
      input: { target_id: targetId },
    };
  }

  const updated = await ctx.deps.targetStore.update(targetId, fields);
  if (!updated) {
    return { tool: "update_target", error: `Failed to update target ${targetId}.` };
  }

  return {
    tool: "update_target",
    updated: true,
    target: {
      id: updated.id,
      targetType: updated.targetType,
      refId: updated.refId,
      priority: updated.priority,
      status: updated.status,
      reason: updated.reason,
    },
    nextSteps: [
      "Use list_targets to see updated target list.",
      updated.status === "abandoned"
        ? "Target has been abandoned — it will no longer appear in active recommendations."
        : "Use complete_target when this goal is achieved.",
    ],
  };
}

// ─── Complete Target ────────────────────────────────────────

export async function completeTargetTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "complete_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "complete_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.deps.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "complete_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  if (existing.status === "achieved") {
    return {
      tool: "complete_target",
      status: "already_achieved",
      target: {
        id: existing.id,
        targetType: existing.targetType,
        refId: existing.refId,
        achievedAt: existing.achievedAt,
      },
      message: "This target was already marked as achieved.",
    };
  }

  if (existing.status === "abandoned") {
    return {
      tool: "complete_target",
      error: "Cannot complete an abandoned target. Use update_target to reactivate it first (set status to 'active').",
      input: { target_id: targetId },
    };
  }

  const achieved = await ctx.deps.targetStore.markAchieved(targetId);
  if (!achieved) {
    return { tool: "complete_target", error: `Failed to mark target ${targetId} as achieved.` };
  }

  return {
    tool: "complete_target",
    completed: true,
    target: {
      id: achieved.id,
      targetType: achieved.targetType,
      refId: achieved.refId,
      priority: achieved.priority,
      reason: achieved.reason,
      status: achieved.status,
      achievedAt: achieved.achievedAt,
    },
    nextSteps: [
      "Use suggest_targets for new acquisition recommendations.",
      "Use list_targets with status 'achieved' to review accomplishments.",
    ],
  };
}

// ─── Record Target Delta ────────────────────────────────────

export async function recordTargetDeltaTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "record_target_delta", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return {
      tool: "record_target_delta",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const metric = str(args, "metric");
  if (!metric) {
    return {
      tool: "record_target_delta",
      error: "metric is required.",
      input: { metric: args.metric ?? null },
    };
  }

  const delta = Number(args.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    return {
      tool: "record_target_delta",
      error: "delta must be a non-zero number.",
      input: { delta: args.delta ?? null },
    };
  }

  const absoluteValue = args.absolute_value == null ? null : Number(args.absolute_value);
  if (absoluteValue != null && (!Number.isFinite(absoluteValue) || absoluteValue < 0)) {
    return {
      tool: "record_target_delta",
      error: "absolute_value must be a non-negative number when provided.",
      input: { absolute_value: args.absolute_value },
    };
  }

  const existing = await ctx.deps.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "record_target_delta",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  const source = str(args, "source") || "manual";
  const note = str(args, "note") || null;

  const deltaRecord = await ctx.deps.targetStore.recordDelta({
    targetId,
    metric,
    delta,
    absoluteValue,
    source,
    note,
  });

  if (!deltaRecord) {
    return {
      tool: "record_target_delta",
      error: `Failed to persist correction delta for target ${targetId}.`,
      input: { target_id: targetId, metric, delta },
    };
  }

  log.fleet.info(
    {
      event: "target.delta_recorded",
      userId: ctx.userId,
      targetId,
      metric,
      delta,
      absoluteValue,
      source,
    },
    "silent correction delta persisted",
  );

  const recent = await ctx.deps.targetStore.listDeltas(targetId, 20);
  const metricRecent = recent.filter((entry) => entry.metric === metric);
  const netDelta = Math.round(metricRecent.reduce((sum, entry) => sum + entry.delta, 0) * 1000) / 1000;

  return {
    tool: "record_target_delta",
    persisted: true,
    target: {
      id: existing.id,
      targetType: existing.targetType,
      refId: existing.refId,
      status: existing.status,
    },
    delta: {
      id: deltaRecord.id,
      metric: deltaRecord.metric,
      delta: deltaRecord.delta,
      absoluteValue: deltaRecord.absoluteValue,
      source: deltaRecord.source,
      note: deltaRecord.note,
      createdAt: deltaRecord.createdAt,
    },
    recalibration: {
      mode: "immediate",
      metric,
      netDelta,
      latestAbsoluteValue: absoluteValue,
    },
    logging: {
      mode: "silent",
      confirmationRequired: false,
    },
    nextSteps: [
      "Use list_targets to view updated recent delta history.",
      "If an absolute count is known, include absolute_value on the next delta for tighter ETA confidence.",
    ],
  };
}

// ─── Record Reminder Feedback ───────────────────────────────

export async function recordReminderFeedbackTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "record_reminder_feedback", error: "Target system not available." };
  }

  const usefulness = str(args, "usefulness");
  if (usefulness !== "useful" && usefulness !== "not_useful") {
    return {
      tool: "record_reminder_feedback",
      error: "usefulness must be one of: useful, not_useful.",
      input: { usefulness: args.usefulness ?? null },
    };
  }

  const reminderKey = str(args, "reminder_key");
  if (!reminderKey) {
    return {
      tool: "record_reminder_feedback",
      error: "reminder_key is required.",
      input: { reminder_key: args.reminder_key ?? null },
    };
  }

  const targetId = args.target_id == null ? null : Number(args.target_id);
  if (targetId != null && (!Number.isInteger(targetId) || targetId <= 0)) {
    return {
      tool: "record_reminder_feedback",
      error: "target_id must be a positive integer when provided.",
      input: { target_id: args.target_id },
    };
  }

  if (targetId != null) {
    const existing = await ctx.deps.targetStore.get(targetId);
    if (!existing) {
      return {
        tool: "record_reminder_feedback",
        error: `Target not found with ID ${targetId}.`,
        input: { target_id: targetId },
      };
    }
  }

  const source = str(args, "source") || "manual";
  const note = str(args, "note") || null;

  const feedback = await ctx.deps.targetStore.recordReminderFeedback({
    targetId,
    reminderKey,
    usefulness,
    source,
    note,
  });

  if (!feedback) {
    return {
      tool: "record_reminder_feedback",
      error: "Failed to persist reminder feedback event.",
      input: {
        reminder_key: reminderKey,
        usefulness,
        target_id: targetId,
      },
    };
  }

  log.fleet.info(
    {
      event: "reminder.feedback_recorded",
      userId: ctx.userId,
      targetId,
      reminderKey,
      usefulness,
      source,
    },
    "silent reminder feedback persisted",
  );

  return {
    tool: "record_reminder_feedback",
    persisted: true,
    feedback: {
      id: feedback.id,
      targetId: feedback.targetId,
      reminderKey: feedback.reminderKey,
      usefulness: feedback.usefulness,
      source: feedback.source,
      note: feedback.note,
      createdAt: feedback.createdAt,
    },
    logging: {
      mode: "silent",
      confirmationRequired: false,
    },
    nextSteps: [
      "Use get_agent_experience_metrics to review reminder usefulness KPI trends.",
    ],
  };
}

// ─── Record Goal Restatement ────────────────────────────────

export async function recordGoalRestatementTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { tool: "record_goal_restatement", error: "Target system not available." };
  }

  const goalKey = str(args, "goal_key");
  if (!goalKey) {
    return {
      tool: "record_goal_restatement",
      error: "goal_key is required.",
      input: { goal_key: args.goal_key ?? null },
    };
  }

  const targetId = args.target_id == null ? null : Number(args.target_id);
  if (targetId != null && (!Number.isInteger(targetId) || targetId <= 0)) {
    return {
      tool: "record_goal_restatement",
      error: "target_id must be a positive integer when provided.",
      input: { target_id: args.target_id },
    };
  }

  if (targetId != null) {
    const existing = await ctx.deps.targetStore.get(targetId);
    if (!existing) {
      return {
        tool: "record_goal_restatement",
        error: `Target not found with ID ${targetId}.`,
        input: { target_id: targetId },
      };
    }
  }

  const source = str(args, "source") || "manual";
  const note = str(args, "note") || null;

  const restatement = await ctx.deps.targetStore.recordGoalRestatement({
    targetId,
    goalKey,
    source,
    note,
  });

  if (!restatement) {
    return {
      tool: "record_goal_restatement",
      error: "Failed to persist goal restatement event.",
      input: {
        goal_key: goalKey,
        target_id: targetId,
      },
    };
  }

  log.fleet.info(
    {
      event: "goal.restatement_recorded",
      userId: ctx.userId,
      targetId,
      goalKey,
      source,
    },
    "silent goal restatement persisted",
  );

  return {
    tool: "record_goal_restatement",
    persisted: true,
    restatement: {
      id: restatement.id,
      targetId: restatement.targetId,
      goalKey: restatement.goalKey,
      source: restatement.source,
      note: restatement.note,
      createdAt: restatement.createdAt,
    },
    logging: {
      mode: "silent",
      confirmationRequired: false,
    },
    nextSteps: [
      "Use get_agent_experience_metrics to review repeat-question reduction proxy metrics.",
    ],
  };
}
