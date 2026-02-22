import { describe, expect, it } from "vitest";
import {
  createInitialQuickCrewState,
  routeQuickCrewCommand,
} from "../web/src/lib/quick-crew-commands.js";

describe("quick-crew-commands", () => {
  it("recommendation/select fills all selected slots", () => {
    const state = createInitialQuickCrewState();
    const next = routeQuickCrewCommand(state, {
      type: "recommendation/select",
      index: 2,
      slots: {
        captain: "kirk",
        bridge_1: "spock",
        bridge_2: "mccoy",
      },
    });

    expect(next.selectedRecommendation).toBe(2);
    expect(next.selectedSlots).toEqual({
      captain: "kirk",
      bridge_1: "spock",
      bridge_2: "mccoy",
    });
  });

  it("recommendation/select closes picker state", () => {
    const state = {
      ...createInitialQuickCrewState(),
      pickerSlot: "bridge_1" as const,
      pickerSearch: "spi",
      saveSuccess: "Saved!",
    };

    const next = routeQuickCrewCommand(state, {
      type: "recommendation/select",
      index: 0,
      slots: {
        captain: "uhura",
        bridge_1: "sulu",
        bridge_2: "scotty",
      },
    });

    expect(next.pickerSlot).toBeNull();
    expect(next.pickerSearch).toBe("");
    expect(next.saveSuccess).toBe("");
    expect(next.selectedSlots).toEqual({
      captain: "uhura",
      bridge_1: "sulu",
      bridge_2: "scotty",
    });
  });
});
