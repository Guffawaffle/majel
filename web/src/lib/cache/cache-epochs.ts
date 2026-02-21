let globalEpoch = 0;
const exactEpochs = new Map<string, number>();
const prefixEpochs = new Map<string, number>();

export function captureEpoch(key: string): number {
  const exact = exactEpochs.get(key) ?? 0;
  let prefix = 0;
  for (const [pfx, epoch] of prefixEpochs.entries()) {
    if (key.startsWith(pfx) && epoch > prefix) prefix = epoch;
  }
  return Math.max(exact, prefix);
}

export function bumpEpochForPattern(pattern: string): void {
  globalEpoch += 1;
  if (pattern.endsWith("*")) {
    prefixEpochs.set(pattern.slice(0, -1), globalEpoch);
    return;
  }
  exactEpochs.set(pattern, globalEpoch);
}

export function bumpEpochForPatterns(patterns: string[]): void {
  for (const pattern of patterns) bumpEpochForPattern(pattern);
}

export function resetEpochsForTests(): void {
  globalEpoch = 0;
  exactEpochs.clear();
  prefixEpochs.clear();
}
