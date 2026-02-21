export interface UpgradeRequirement {
  key: string;
  resourceId: string | null;
  name: string;
  amount: number;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function extractBuildCostEntries(raw: unknown): UpgradeRequirement[] {
  if (!Array.isArray(raw)) return [];
  const requirements: UpgradeRequirement[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;

    const amount = toNumberOrNull(item.amount ?? item.value ?? item.quantity);
    if (amount == null || amount <= 0) continue;

    const idValue = item.resource_id ?? item.resourceId ?? item.id ?? item.type ?? null;
    const resourceId = idValue == null ? null : String(idValue);

    const name = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : resourceId
        ? `resource:${resourceId}`
        : "unknown_resource";

    const key = normalizeToken(resourceId ?? name);
    requirements.push({ key, resourceId, name, amount });
  }

  return requirements;
}

function aggregateRequirements(entries: UpgradeRequirement[]): UpgradeRequirement[] {
  const totals = new Map<string, UpgradeRequirement>();
  for (const entry of entries) {
    const existing = totals.get(entry.key);
    if (!existing) {
      totals.set(entry.key, { ...entry });
      continue;
    }
    existing.amount += entry.amount;
  }
  return Array.from(totals.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function extractTierRequirements(
  tiers: Record<string, unknown>[] | null,
  fromTierExclusive: number,
  toTierInclusive: number,
): UpgradeRequirement[] {
  if (!tiers || tiers.length === 0) return [];

  const requirements: UpgradeRequirement[] = [];
  for (const tierEntry of tiers) {
    const tierValue = toNumberOrNull((tierEntry as Record<string, unknown>).tier);
    if (tierValue == null) continue;
    if (tierValue <= fromTierExclusive || tierValue > toTierInclusive) continue;

    const components = (tierEntry as Record<string, unknown>).components;
    if (!Array.isArray(components)) continue;

    for (const component of components) {
      if (!component || typeof component !== "object") continue;
      const buildCost = (component as Record<string, unknown>).build_cost
        ?? (component as Record<string, unknown>).buildCost;
      requirements.push(...extractBuildCostEntries(buildCost));
    }
  }

  return aggregateRequirements(requirements);
}

export function inferDefaultDailyRate(requirementName: string): number {
  const normalized = requirementName.toLowerCase();
  if (normalized.includes("ore")) return 120;
  if (normalized.includes("gas")) return 100;
  if (normalized.includes("crystal")) return 80;
  if (normalized.includes("part")) return 40;
  if (normalized.includes("blueprint")) return 8;
  if (normalized.includes("latinum") || normalized.includes("credit")) return 60;
  return 50;
}

export function resolveOverrideDailyRate(
  requirementName: string,
  resourceId: string | null,
  overrides: Map<string, number>,
): number | undefined {
  const requirementKey = normalizeToken(requirementName);
  const direct = overrides.get(requirementKey);
  if (direct != null) return direct;

  if (resourceId) {
    const byId = overrides.get(normalizeToken(resourceId));
    if (byId != null) return byId;
  }

  for (const [key, value] of overrides.entries()) {
    if (requirementKey.includes(key) || key.includes(requirementKey)) {
      return value;
    }
  }

  return undefined;
}