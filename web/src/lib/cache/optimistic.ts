/**
 * optimistic.ts — Optimistic mutation wrapper with rollback.
 *
 * ADR-032 Phase 3: Wrap mutations to immediately reflect changes
 * in a local state array, then reconcile with the server response.
 * If the mutation fails, the previous state is restored.
 *
 * Usage in Svelte components:
 *   items = await optimisticCreate(items, newItem, () => apiCreate(newItem));
 */

/**
 * Optimistically prepend an item, execute the mutation, then reconcile.
 * On failure, reverts to the original array and re-throws.
 */
export async function optimisticCreate<T extends { id: unknown }>(
  current: T[],
  optimistic: T,
  mutate: () => Promise<T>,
  setState: (items: T[]) => void,
): Promise<T[]> {
  const snapshot = current;
  const withOptimistic = [optimistic, ...current];
  setState(withOptimistic);

  try {
    const created = await mutate();
    // Replace the optimistic placeholder with the server's response
    const result = withOptimistic.map((item) =>
      item.id === optimistic.id ? created : item,
    );
    setState(result);
    return result;
  } catch (err) {
    setState(snapshot);
    throw err;
  }
}

/**
 * Optimistically update an item in the array, execute mutation, reconcile.
 * On failure, reverts to the original array and re-throws.
 */
export async function optimisticUpdate<T extends { id: unknown }>(
  current: T[],
  id: unknown,
  patch: Partial<T>,
  mutate: () => Promise<T>,
  setState: (items: T[]) => void,
): Promise<T[]> {
  const snapshot = current;
  const withPatch = current.map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  setState(withPatch);

  try {
    const updated = await mutate();
    const result = withPatch.map((item) =>
      item.id === id ? updated : item,
    );
    setState(result);
    return result;
  } catch (err) {
    setState(snapshot);
    throw err;
  }
}

/**
 * Optimistically remove an item from the array, execute mutation, reconcile.
 * On failure, reverts to the original array and re-throws.
 */
export async function optimisticDelete<T extends { id: unknown }>(
  current: T[],
  id: unknown,
  mutate: () => Promise<void>,
  setState: (items: T[]) => void,
): Promise<T[]> {
  const snapshot = current;
  setState(current.filter((item) => item.id !== id));

  try {
    await mutate();
    return current.filter((item) => item.id !== id);
  } catch (err) {
    setState(snapshot);
    throw err;
  }
}
