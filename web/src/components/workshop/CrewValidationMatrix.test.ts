import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import CrewValidationMatrix from "./CrewValidationMatrix.svelte";
import type { CrewValidation } from "../../lib/crew-validator.js";

function makeValidation(officerCount: number): CrewValidation {
  const officerIds = ["kirk", "spock", "mccoy"].slice(0, officerCount);
  const officerNames = ["Kirk", "Spock", "McCoy"].slice(0, officerCount);
  return {
    officers: officerIds.map((officerId, index) => ({
      officerId,
      officerName: officerNames[index]!,
      slot: index === 0 ? "captain" : index === 1 ? "bridge_1" : "bridge_2",
      slotContext: index === 0 ? "captain" : "bridge",
      verdict: index === 0 ? "works" : "partial",
      totalScore: 5,
      topIssues: [],
      evaluation: {
        officerId,
        slot: index === 0 ? "captain" : "bridge",
        totalScore: 5,
        issues: index === 0 ? [] : [{
          type: "requires_attacking",
          severity: "conditional",
          message: "Only works when attacking",
        }],
        abilities: [
          {
            abilityId: `${officerId}:oa`,
            slot: "oa",
            isInert: false,
            effects: [
              {
                effectId: `${officerId}:oa:damage`,
                effectKey: "damage_dealt",
                status: index === 0 ? "works" : "conditional",
                applicabilityMultiplier: index === 0 ? 1 : 0.5,
                issues: index === 0 ? [] : [{
                  type: "requires_attacking",
                  severity: "conditional",
                  message: "Only works when attacking",
                }],
              },
            ],
          },
        ],
      },
    })),
    totalScore: 12,
    verdict: "partial",
    summary: ["Sample validation summary"],
  };
}

describe("CrewValidationMatrix", () => {
  it("renders matrix for one officer crew", () => {
    render(CrewValidationMatrix, { validation: makeValidation(1) });

    expect(screen.getByText("Does it work? Validation Matrix")).toBeTruthy();
    expect(screen.getByText("Kirk")).toBeTruthy();
    expect(screen.getByText("damage dealt")).toBeTruthy();
    expect(screen.getByText(/Crew fitness/i)).toBeTruthy();
  });

  it("renders matrix for three officer crew", () => {
    render(CrewValidationMatrix, { validation: makeValidation(3) });

    expect(screen.getByText("Kirk")).toBeTruthy();
    expect(screen.getByText("Spock")).toBeTruthy();
    expect(screen.getByText("McCoy")).toBeTruthy();
  });

  it("shows conditional issue details on click", async () => {
    render(CrewValidationMatrix, { validation: makeValidation(2) });

    const conditionalCells = screen.getAllByRole("button", { name: /damage dealt/i });
    expect(conditionalCells.length).toBeGreaterThan(1);

    await fireEvent.click(conditionalCells[1]!);
    expect(screen.getByText("Only works when attacking")).toBeTruthy();
  });
});
