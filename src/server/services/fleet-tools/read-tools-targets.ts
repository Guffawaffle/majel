/**
 * read-tools-targets.ts — Target/goal tracking, experience metrics, conflict detection
 */

import type { ToolEnv } from "./declarations.js";
import { detectTargetConflicts } from "../target-conflicts.js";

const ETA_CONFIDENCE_THRESHOLD = 0.75;
const SOURCE_ATTRIBUTION_TARGET_PCT = 90;
const CORRECTION_RECALIBRATION_TARGET_MINUTES = 5;
const REMINDER_USEFULNESS_TARGET_PCT = 70;
const REPEAT_QUESTION_REDUCTION_TARGET_DIRECTION = "downward";
const APPROVED_STREAM_SOURCES = new Set(["stfc.space", "spocks.club"]);

export async function listTargets(
  targetType: string | undefined,
  status: string | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { error: "Target system not available." };
  }

  const filters: Record<string, unknown> = {};
  if (targetType) filters.targetType = targetType;
  if (status) filters.status = status;
  else filters.status = "active";

  const targets = await ctx.deps.targetStore.list(
    Object.keys(filters).length > 0 ? filters as never : undefined,
  );

  const deltasByTarget = new Map<number, Array<Record<string, unknown>>>();
  await Promise.all(targets.map(async (target) => {
    const deltas = await ctx.deps.targetStore!.listDeltas(target.id, 5);
    deltasByTarget.set(target.id, deltas.map((d) => ({
      id: d.id,
      metric: d.metric,
      delta: d.delta,
      absoluteValue: d.absoluteValue,
      source: d.source,
      note: d.note,
      createdAt: d.createdAt,
    })));
  }));

  const reminderFeedback = await ctx.deps.targetStore.listReminderFeedback(1000);
  const reminderByTarget = new Map<number, Array<Record<string, unknown>>>();
  for (const entry of reminderFeedback) {
    if (entry.targetId == null) continue;
    const bucket = reminderByTarget.get(entry.targetId) ?? [];
    bucket.push({
      id: entry.id,
      reminderKey: entry.reminderKey,
      usefulness: entry.usefulness,
      source: entry.source,
      note: entry.note,
      createdAt: entry.createdAt,
    });
    reminderByTarget.set(entry.targetId, bucket);
  }

  return {
    targets: targets.map((t) => ({
      ...(() => {
        const recentDeltas = deltasByTarget.get(t.id) ?? [];
        const recentReminderFeedback = (reminderByTarget.get(t.id) ?? []).slice(0, 5);
        const lastContinuityEventAt = [
          ...recentDeltas.map((entry) => String(entry.createdAt ?? "")),
          ...recentReminderFeedback.map((entry) => String(entry.createdAt ?? "")),
        ].filter(Boolean).sort().reverse()[0] ?? null;

        return {
          recentDeltas,
          recentReminderFeedback,
          continuity: {
            hasRecentCorrections: recentDeltas.length > 0,
            hasReminderFeedback: recentReminderFeedback.length > 0,
            lastContinuityEventAt,
          },
        };
      })(),
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      targetTier: t.targetTier,
      targetRank: t.targetRank,
      targetLevel: t.targetLevel,
      reason: t.reason,
      priority: t.priority,
      status: t.status,
      autoSuggested: t.autoSuggested,
      achievedAt: t.achievedAt,
    })),
    totalTargets: targets.length,
  };
}

export async function getAgentExperienceMetrics(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { error: "Target system not available." };
  }

  const activeTargets = await ctx.deps.targetStore.list({ status: "active" } as never);
  const deltaGroups = await Promise.all(activeTargets.map(async (target) => ({
    target,
    deltas: await ctx.deps.targetStore!.listDeltas(target.id, 200),
  })));

  const allDeltas = deltaGroups.flatMap((entry) =>
    entry.deltas.map((delta) => ({ ...delta, targetId: entry.target.id, targetType: entry.target.targetType })),
  );

  const now = Date.now();
  const last24hMs = 24 * 60 * 60 * 1000;
  const last7dMs = 7 * 24 * 60 * 60 * 1000;

  const countSince = (windowMs: number): number => allDeltas.filter((entry) => {
    const ts = Date.parse(entry.createdAt);
    return Number.isFinite(ts) && now - ts <= windowMs;
  }).length;

  const bySource = new Map<string, number>();
  const byMetric = new Map<string, number>();
  let withAbsoluteValue = 0;

  for (const entry of allDeltas) {
    bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
    byMetric.set(entry.metric, (byMetric.get(entry.metric) ?? 0) + 1);
    if (entry.absoluteValue != null) withAbsoluteValue += 1;
  }

  const approvedSourceCount = Array.from(bySource.entries())
    .filter(([source]) => APPROVED_STREAM_SOURCES.has(source))
    .reduce((sum, [, count]) => sum + count, 0);
  const approvedSourcePct = allDeltas.length === 0
    ? null
    : Math.round((approvedSourceCount / allDeltas.length) * 1000) / 10;

  const reminderFeedback = await ctx.deps.targetStore.listReminderFeedback(1000);
  const reminderUsefulCount = reminderFeedback.filter((entry) => entry.usefulness === "useful").length;
  const reminderNotUsefulCount = reminderFeedback.filter((entry) => entry.usefulness === "not_useful").length;
  const reminderUsefulnessPct = reminderFeedback.length === 0
    ? null
    : Math.round((reminderUsefulCount / reminderFeedback.length) * 1000) / 10;
  const reminderFeedbackLast7d = reminderFeedback.filter((entry) => {
    const ts = Date.parse(entry.createdAt);
    return Number.isFinite(ts) && now - ts <= last7dMs;
  }).length;

  const goalRestatements = await ctx.deps.targetStore.listGoalRestatements(1000);
  const goalRestatementsLast7d = goalRestatements.filter((entry) => {
    const ts = Date.parse(entry.createdAt);
    return Number.isFinite(ts) && now - ts <= last7dMs;
  }).length;
  const restatementsByGoal = new Map<string, number>();
  for (const entry of goalRestatements) {
    restatementsByGoal.set(entry.goalKey, (restatementsByGoal.get(entry.goalKey) ?? 0) + 1);
  }
  const repeatedGoalKeyCount = Array.from(restatementsByGoal.values()).filter((count) => count > 1).length;
  const uniqueGoalKeyCount = restatementsByGoal.size;
  const restatementsPerActiveTarget = activeTargets.length === 0
    ? null
    : Math.round((goalRestatements.length / activeTargets.length) * 100) / 100;

  return {
    policy: {
      sourceAttributionTargetPct: SOURCE_ATTRIBUTION_TARGET_PCT,
      reminderUsefulnessTargetPct: REMINDER_USEFULNESS_TARGET_PCT,
      repeatQuestionReductionTargetDirection: REPEAT_QUESTION_REDUCTION_TARGET_DIRECTION,
      correctionRecalibrationTargetMinutes: CORRECTION_RECALIBRATION_TARGET_MINUTES,
      etaConfidenceThreshold: ETA_CONFIDENCE_THRESHOLD,
      approvedStreams: Array.from(APPROVED_STREAM_SOURCES),
      correctionPersistenceMode: "immediate_silent_log",
    },
    observed: {
      activeTargets: activeTargets.length,
      totalCorrectionDeltas: allDeltas.length,
      correctionDeltasLast24h: countSince(last24hMs),
      correctionDeltasLast7d: countSince(last7dMs),
      deltasWithAbsoluteValue: withAbsoluteValue,
      sourceMix: Object.fromEntries(Array.from(bySource.entries()).sort(([a], [b]) => a.localeCompare(b))),
      metricMix: Object.fromEntries(Array.from(byMetric.entries()).sort(([a], [b]) => a.localeCompare(b))),
      approvedSourcePct,
      correctionRecalibrationLatencyMsP95: 0,
      reminderFeedbackTotal: reminderFeedback.length,
      reminderUsefulCount,
      reminderNotUsefulCount,
      reminderUsefulnessPct,
      reminderFeedbackLast7d,
      goalRestatementTotal: goalRestatements.length,
      goalRestatementLast7d: goalRestatementsLast7d,
      uniqueRestatedGoalKeys: uniqueGoalKeyCount,
      repeatedGoalKeyCount,
      restatementsPerActiveTarget,
      repeatQuestionReductionSignal: repeatedGoalKeyCount === 0 ? "stable_or_improving" : "needs_reduction",
      etaPolicyMode: "thresholded_numeric_or_qualitative",
    },
    notes: [
      ...(allDeltas.length === 0
        ? [
        "No correction deltas recorded yet — once record_target_delta is used, this report will populate trend metrics.",
      ]
        : [
        "Recalibration latency is immediate by design for persisted correction deltas.",
      ]),
      ...(reminderFeedback.length === 0
        ? [
          "No reminder feedback recorded yet — use record_reminder_feedback to populate usefulness KPI metrics.",
        ]
        : []),
      ...(goalRestatements.length === 0
        ? [
          "No goal restatement events recorded yet — use record_goal_restatement to start repeat-question reduction tracking.",
        ]
        : []),
    ],
  };
}

export async function detectConflicts(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.targetStore) {
    return { error: "Target system not available." };
  }
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const conflicts = await detectTargetConflicts(ctx.deps.targetStore, ctx.deps.crewStore);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const c of conflicts) {
    byType[c.conflictType] = (byType[c.conflictType] ?? 0) + 1;
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
  }

  return {
    conflicts: conflicts.map((c) => ({
      conflictType: c.conflictType,
      severity: c.severity,
      resource: c.resource,
      description: c.description,
      suggestion: c.suggestion,
      targetA: c.targetA,
      targetB: c.targetB,
    })),
    summary: {
      totalConflicts: conflicts.length,
      byType,
      bySeverity,
    },
  };
}
