const LONG_DECIMAL_PATTERN = /\d+\.\d{10,}/;

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function deepRoundNumbers<T>(value: T, decimals: number): T {
  if (typeof value === "number") {
    return (Number.isFinite(value) ? roundTo(value, decimals) : value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepRoundNumbers(entry, decimals)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = deepRoundNumbers(entry, decimals);
    }
    return output as T;
  }

  return value;
}

export function serializeNormalizedJson(
  value: unknown,
  fieldName: string,
  decimals = 6,
): string | null {
  if (value == null) return null;

  const normalized = deepRoundNumbers(value, decimals);
  const serialized = JSON.stringify(normalized);

  if (LONG_DECIMAL_PATTERN.test(serialized)) {
    throw new Error(`Long-decimal numeric tail detected in ${fieldName}`);
  }

  return serialized;
}
