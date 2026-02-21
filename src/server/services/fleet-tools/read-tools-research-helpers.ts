import type { ResearchBuff, ResearchNodeRecord } from "../../stores/research-store.js";
import { computeLatestResearchTimestamp } from "./read-tools-data-helpers.js";

const RESEARCH_STALE_DAYS = 7;

type ResearchPriority = "none" | "low" | "medium";

interface ResearchAdvisory {
  status: "none" | "sparse" | "partial" | "strong";
  priority: ResearchPriority;
  confidencePct: number;
  reasons: string[];
  summary: {
    totalNodes: number;
    totalTrees: number;
    completedNodes: number;
    completionPct: number;
    lastUpdatedAt: string | null;
    daysSinceUpdate: number | null;
    stale: boolean;
  };
  recommendedUsage: string;
}

export function calculateResearchAdvisory(nodes: ResearchNodeRecord[]): ResearchAdvisory {
  const totalNodes = nodes.length;
  const trees = new Set(nodes.map((node) => node.tree));
  const completedNodes = nodes.filter((node) => node.completed).length;
  const completionRatio = totalNodes > 0 ? completedNodes / totalNodes : 0;
  const completionPct = Math.round(completionRatio * 1000) / 10;
  const lastUpdatedAt = computeLatestResearchTimestamp(nodes);
  const daysSinceUpdate = lastUpdatedAt
    ? Math.round(((Date.now() - Date.parse(lastUpdatedAt)) / 86_400_000) * 10) / 10
    : null;
  const stale = daysSinceUpdate !== null && daysSinceUpdate > RESEARCH_STALE_DAYS;

  const reasons: string[] = [];
  if (totalNodes === 0) {
    reasons.push("no_research_data");
  }
  if (totalNodes > 0 && totalNodes < 10) {
    reasons.push("sparse_node_coverage");
  }
  if (trees.size > 0 && trees.size < 2) {
    reasons.push("limited_tree_coverage");
  }
  if (stale) {
    reasons.push("stale_snapshot");
  }

  const breadthScore = Math.min(1, totalNodes / 40);
  const completionScore = completionRatio;
  const freshnessScore = daysSinceUpdate === null ? 0.4 : Math.max(0, 1 - Math.max(0, daysSinceUpdate - 1) / 28);
  const confidencePct = Math.round((breadthScore * 0.6 + completionScore * 0.2 + freshnessScore * 0.2) * 100);

  if (totalNodes === 0) {
    return {
      status: "none",
      priority: "none",
      confidencePct: 0,
      reasons,
      summary: {
        totalNodes,
        totalTrees: trees.size,
        completedNodes,
        completionPct,
        lastUpdatedAt,
        daysSinceUpdate,
        stale,
      },
      recommendedUsage: "Research effects unavailable. Use base roster/ship context only.",
    };
  }

  let status: ResearchAdvisory["status"] = "partial";
  let priority: ResearchPriority = "medium";
  if (confidencePct < 45 || reasons.includes("sparse_node_coverage") || reasons.includes("limited_tree_coverage")) {
    status = "sparse";
    priority = "low";
  } else if (confidencePct >= 80 && !stale) {
    status = "strong";
  }

  return {
    status,
    priority,
    confidencePct,
    reasons,
    summary: {
      totalNodes,
      totalTrees: trees.size,
      completedNodes,
      completionPct,
      lastUpdatedAt,
      daysSinceUpdate,
      stale,
    },
    recommendedUsage:
      priority === "low"
        ? "Treat research bonuses as advisory only; prioritize base officer/ship fit."
        : "Research bonuses are reliable enough to influence tie-breakers and optimization.",
  };
}

export function normalizePercentValue(value: number): number {
  if (Math.abs(value) > 1) {
    return value / 100;
  }
  return value;
}

function metricMatchesIntent(metric: string, intentKey: string | undefined): boolean {
  const normalized = metric.toLowerCase();
  const generic = ["attack", "weapon", "hull", "shield", "defense", "mitigation", "crit", "health", "officer"];
  const combat = ["pvp", "armada", "hostile", "combat", "damage", "impulse", "base"];
  const mining = ["mining", "cargo", "protected", "opc"];

  const matchesAny = (keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword));

  if (!intentKey) {
    return matchesAny(generic) || matchesAny(combat);
  }

  if (intentKey.startsWith("mining")) {
    return matchesAny(generic) || matchesAny(mining);
  }

  return matchesAny(generic) || matchesAny(combat);
}

export function extractRelevantBuffs(
  nodes: ResearchNodeRecord[],
  intentKey: string | undefined,
): Array<ResearchBuff & { nodeId: string; nodeName: string }> {
  const buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }> = [];

  for (const node of nodes) {
    if (!node.completed && node.level <= 0) continue;
    for (const buff of node.buffs) {
      if (!metricMatchesIntent(buff.metric, intentKey)) continue;
      buffs.push({ ...buff, nodeId: node.nodeId, nodeName: node.name });
    }
  }

  return buffs;
}

function formatBuffValue(buff: ResearchBuff): string {
  if (buff.unit === "percent") {
    const percentValue = normalizePercentValue(buff.value) * 100;
    return percentValue % 1 === 0 ? `${percentValue}%` : `${percentValue.toFixed(1)}%`;
  }
  if (buff.unit === "multiplier") {
    return `${buff.value.toFixed(3)}x`;
  }
  return Number.isInteger(buff.value) ? String(buff.value) : buff.value.toFixed(2);
}

export function buildResearchCitations(
  buffs: Array<ResearchBuff & { nodeId: string; nodeName: string }>,
  limit = 6,
): Array<{ nodeId: string; nodeName: string; metric: string; value: string; citation: string }> {
  return buffs.slice(0, limit).map((buff) => {
    const value = formatBuffValue(buff);
    const citation = `${buff.nodeName} (${buff.nodeId}) adds ${value} ${buff.metric}`;
    return {
      nodeId: buff.nodeId,
      nodeName: buff.nodeName,
      metric: buff.metric,
      value,
      citation,
    };
  });
}