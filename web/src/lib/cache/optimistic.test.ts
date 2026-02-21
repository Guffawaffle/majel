/**
 * optimistic.test.ts — Unit tests for optimistic mutation helpers.
 *
 * ADR-032 Phase 3: Tests create/update/delete with rollback.
 */

import { describe, it, expect, vi } from "vitest";
import { optimisticCreate, optimisticUpdate, optimisticDelete } from "./optimistic.js";

interface Item {
  id: number;
  name: string;
}

describe("optimisticCreate", () => {
  it("immediately adds the item then replaces with server response", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "A" }];
    const optimistic: Item = { id: -1, name: "Optimistic" };
    const serverItem: Item = { id: 2, name: "Server" };

    const result = await optimisticCreate(
      current,
      optimistic,
      async () => serverItem,
      setState,
    );

    // First setState: optimistic prepend
    expect(states[0]).toEqual([{ id: -1, name: "Optimistic" }, { id: 1, name: "A" }]);
    // Second setState: reconciled with server
    expect(states.length).toBeGreaterThanOrEqual(2);
    // Final result contains server item
    expect(result.some((i) => i.id === 2 && i.name === "Server")).toBe(true);
  });

  it("rolls back on mutation failure", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "A" }];
    const optimistic: Item = { id: -1, name: "Optimistic" };

    await expect(
      optimisticCreate(
        current,
        optimistic,
        async () => { throw new Error("Network error"); },
        setState,
      ),
    ).rejects.toThrow("Network error");

    // Last setState should be the rollback to original
    const lastState = states[states.length - 1];
    expect(lastState).toEqual([{ id: 1, name: "A" }]);
  });
});

describe("optimisticUpdate", () => {
  it("immediately patches then reconciles with server response", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
    const serverItem: Item = { id: 1, name: "Updated-Server" };

    const result = await optimisticUpdate(
      current,
      1,
      { name: "Updated-Optimistic" },
      async () => serverItem,
      setState,
    );

    // First setState: optimistic patch
    expect(states[0].find((i) => i.id === 1)?.name).toBe("Updated-Optimistic");
    // Final result has server value
    expect(result.find((i) => i.id === 1)?.name).toBe("Updated-Server");
    // Other items untouched
    expect(result.find((i) => i.id === 2)?.name).toBe("B");
  });

  it("rolls back on mutation failure", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "Original" }];

    await expect(
      optimisticUpdate(
        current,
        1,
        { name: "Patched" },
        async () => { throw new Error("fail"); },
        setState,
      ),
    ).rejects.toThrow("fail");

    const lastState = states[states.length - 1];
    expect(lastState).toEqual([{ id: 1, name: "Original" }]);
  });
});

describe("optimisticDelete", () => {
  it("immediately removes then confirms after mutation", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "A" }, { id: 2, name: "B" }];

    const result = await optimisticDelete(
      current,
      1,
      async () => {},
      setState,
    );

    // First setState: item removed
    expect(states[0]).toEqual([{ id: 2, name: "B" }]);
    // Final result
    expect(result).toEqual([{ id: 2, name: "B" }]);
  });

  it("rolls back on mutation failure", async () => {
    const states: Item[][] = [];
    const setState = (items: Item[]) => { states.push([...items]); };
    const current: Item[] = [{ id: 1, name: "A" }, { id: 2, name: "B" }];

    await expect(
      optimisticDelete(
        current,
        1,
        async () => { throw new Error("fail"); },
        setState,
      ),
    ).rejects.toThrow("fail");

    const lastState = states[states.length - 1];
    expect(lastState).toEqual([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
  });
});
