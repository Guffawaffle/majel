/**
 * trust.test.ts — Tests for fleet-tools trust classification
 *
 * Covers: getTrustLevel, isMutationTool, getDefaultTrustMap
 */

import { describe, it, expect, vi } from "vitest";
import { getTrustLevel, isMutationTool, getDefaultTrustMap, getMutationKey } from "../src/server/services/fleet-tools/trust.js";
import type { UserSettingsStore } from "../src/server/stores/user-settings-store.js";

// ─── isMutationTool ─────────────────────────────────────────

describe("isMutationTool", () => {
  it("returns true for tools listed in DEFAULT_TRUST", () => {
    expect(isMutationTool("set_officer_overlay")).toBe(true);
    expect(isMutationTool("create_bridge_core")).toBe(true);
    expect(isMutationTool("activate_preset")).toBe(true);
  });

  it("returns true for unlisted tools matching mutation name pattern", () => {
    expect(isMutationTool("create_something_new")).toBe(true);
    expect(isMutationTool("update_fleet_config")).toBe(true);
    expect(isMutationTool("delete_old_record")).toBe(true);
    expect(isMutationTool("set_warp_factor")).toBe(true);
    expect(isMutationTool("sync_data")).toBe(true);
    expect(isMutationTool("assign_crew")).toBe(true);
    expect(isMutationTool("remove_assignment")).toBe(true);
    expect(isMutationTool("complete_mission")).toBe(true);
  });

  it("returns false for read-only tools", () => {
    expect(isMutationTool("get_ship_info")).toBe(false);
    expect(isMutationTool("list_officers")).toBe(false);
    expect(isMutationTool("search_targets")).toBe(false);
    expect(isMutationTool("read_settings")).toBe(false);
  });
});

// ─── getDefaultTrustMap ─────────────────────────────────────

describe("getDefaultTrustMap", () => {
  it("returns a non-empty map", () => {
    const map = getDefaultTrustMap();
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });

  it("contains known auto-tier tools", () => {
    const map = getDefaultTrustMap();
    expect(map.set_officer_overlay).toBe("auto");
    expect(map.set_ship_overlay).toBe("auto");
    expect(map.create_target).toBe("auto");
    expect(map.record_goal_restatement).toBe("auto");
  });

  it("contains known approve-tier tools", () => {
    const map = getDefaultTrustMap();
    expect(map.create_bridge_core).toBe("approve");
    expect(map.create_loadout).toBe("approve");
  });

  it("contains known block-tier tools", () => {
    const map = getDefaultTrustMap();
    expect(map.activate_preset).toBe("block");
  });
});

// ─── getTrustLevel ──────────────────────────────────────────

describe("getTrustLevel", () => {
  const userId = "user-123";

  it("returns system default for auto-tier tools", async () => {
    expect(await getTrustLevel("set_officer_overlay", userId)).toBe("auto");
  });

  it("returns system default for approve-tier tools", async () => {
    expect(await getTrustLevel("create_bridge_core", userId)).toBe("approve");
  });

  it("returns system default for block-tier tools", async () => {
    expect(await getTrustLevel("activate_preset", userId)).toBe("block");
  });

  it("falls back to 'approve' for unknown tools", async () => {
    expect(await getTrustLevel("unknown_tool", userId)).toBe("approve");
  });

  it("applies user override from store", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ activate_preset: "auto" }),
        source: "user",
      }),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("activate_preset", userId, mockStore);
    expect(result).toBe("auto");
    expect(mockStore.getForUser).toHaveBeenCalledWith(userId, "fleet.trust");
  });

  it("ignores override with invalid trust level", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ activate_preset: "invalid_level" }),
        source: "user",
      }),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("activate_preset", userId, mockStore);
    expect(result).toBe("block"); // falls through to system default
  });

  it("ignores override when source is not 'user'", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ activate_preset: "auto" }),
        source: "default",
      }),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("activate_preset", userId, mockStore);
    expect(result).toBe("block"); // falls through to system default
  });

  it("falls through to system default when store throws", async () => {
    const mockStore = {
      getForUser: vi.fn().mockRejectedValue(new Error("DB error")),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("activate_preset", userId, mockStore);
    expect(result).toBe("block");
  });

  it("falls through to system default when store is null", async () => {
    const result = await getTrustLevel("activate_preset", userId, null);
    expect(result).toBe("block");
  });

  it("falls through to system default when store is undefined", async () => {
    const result = await getTrustLevel("activate_preset", userId, undefined);
    expect(result).toBe("block");
  });

  it("resolves user override for tool not in DEFAULT_TRUST", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ some_new_tool: "block" }),
        source: "user",
      }),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("some_new_tool", userId, mockStore);
    expect(result).toBe("block");
  });

  it("falls through when user JSON has no entry for the tool", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ other_tool: "auto" }),
        source: "user",
      }),
    } as unknown as UserSettingsStore;

    const result = await getTrustLevel("activate_preset", userId, mockStore);
    expect(result).toBe("block"); // falls through to system default
  });

  // ─── Ownership Creation Gate (ADR-049 Slice 2) ─────────────

  it("returns 'approve' for set_ship_overlay when isCreate is true", async () => {
    expect(await getTrustLevel("set_ship_overlay", userId, undefined, true)).toBe("approve");
  });

  it("returns 'approve' for set_officer_overlay when isCreate is true", async () => {
    expect(await getTrustLevel("set_officer_overlay", userId, undefined, true)).toBe("approve");
  });

  it("returns 'auto' for set_ship_overlay when isCreate is false (update)", async () => {
    expect(await getTrustLevel("set_ship_overlay", userId, undefined, false)).toBe("auto");
  });

  it("returns 'auto' for set_officer_overlay when isCreate is undefined (update)", async () => {
    expect(await getTrustLevel("set_officer_overlay", userId)).toBe("auto");
  });

  it("does not apply isCreate gate to other mutation tools", async () => {
    expect(await getTrustLevel("create_bridge_core", userId, undefined, true)).toBe("approve");
    // create_bridge_core is already "approve" by default — isCreate shouldn't change it
  });

  it("does not apply isCreate gate to auto-trust tools like update_inventory", async () => {
    expect(await getTrustLevel("update_inventory", userId, undefined, true)).toBe("auto");
  });

  it("user override takes precedence over isCreate gate", async () => {
    const mockStore = {
      getForUser: vi.fn().mockResolvedValue({
        key: "fleet.trust",
        value: JSON.stringify({ set_ship_overlay: "auto" }),
        source: "user",
      }),
    } as unknown as UserSettingsStore;

    // Even though isCreate=true would normally return "approve",
    // the user override to "auto" should take precedence
    const result = await getTrustLevel("set_ship_overlay", userId, mockStore, true);
    expect(result).toBe("auto");
  });
});

// ─── getMutationKey ─────────────────────────────────────────

describe("getMutationKey", () => {
  it("maps overlay tools to their cache keys", () => {
    expect(getMutationKey("set_officer_overlay")).toBe("officer-overlay");
    expect(getMutationKey("set_ship_overlay")).toBe("ship-overlay");
  });

  it("maps crew tools to their cache keys", () => {
    expect(getMutationKey("create_bridge_core")).toBe("bridge-core");
    expect(getMutationKey("create_loadout")).toBe("crew-loadout");
    expect(getMutationKey("create_variant")).toBe("crew-variant");
    expect(getMutationKey("assign_dock")).toBe("crew-dock");
    expect(getMutationKey("update_dock")).toBe("crew-dock");
    expect(getMutationKey("remove_dock_assignment")).toBe("crew-dock");
    expect(getMutationKey("set_reservation")).toBe("officer-reservation");
  });

  it("maps sync tools to import-commit for broad flush", () => {
    expect(getMutationKey("sync_overlay")).toBe("import-commit");
    expect(getMutationKey("sync_research")).toBe("import-commit");
  });

  it("maps activate_preset to fleet-preset", () => {
    expect(getMutationKey("activate_preset")).toBe("fleet-preset");
  });

  it("returns null for tools without client-side cache", () => {
    expect(getMutationKey("update_inventory")).toBeNull();
    expect(getMutationKey("create_target")).toBeNull();
    expect(getMutationKey("record_target_delta")).toBeNull();
  });

  it("returns null for read-only tools", () => {
    expect(getMutationKey("get_ship_info")).toBeNull();
    expect(getMutationKey("list_officers")).toBeNull();
  });
});
