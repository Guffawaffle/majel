/**
 * gemini.test.ts — Tests for system prompt construction and engine creation.
 *
 * Tests the core prompt engineering — the thing that most affects Majel's behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt, createGeminiEngine } from "../src/server/gemini.js";
import { buildSection, buildFleetData, type FleetData } from "../src/server/fleet-data.js";

// ─── buildSystemPrompt ──────────────────────────────────────────

describe("buildSystemPrompt", () => {
  describe("identity layer (always present)", () => {
    it("includes Majel identity regardless of roster", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("You are Majel");
      expect(prompt).toContain("Fleet Intelligence System");
      expect(prompt).toContain("Admiral Guff");
    });

    it("includes Majel Barrett-Roddenberry tribute", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("Majel Barrett-Roddenberry");
      expect(prompt).toContain("1932–2008");
    });

    it("establishes personality traits", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("PERSONALITY:");
      expect(prompt).toContain("dry wit");
      expect(prompt).toContain("Admiral");
    });
  });

  describe("capabilities layer", () => {
    it("declares training knowledge coverage", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("training knowledge");
      expect(prompt).toContain("CAPABILITIES:");
    });

    it("explicitly lists STFC-relevant capabilities", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("Star Trek Fleet Command");
      expect(prompt).toContain("crew compositions");
      expect(prompt).toContain("Star Trek canon lore");
    });

    it("discloses underlying systems (Lex, Gemini)", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("Lex");
      expect(prompt).toContain("Gemini");
      expect(prompt).toContain("Google Sheets");
    });

    it("includes comprehensive epistemic framework", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("EPISTEMIC FRAMEWORK");
      expect(prompt).toContain("SOURCE ATTRIBUTION");
      expect(prompt).toContain("CONFIDENCE SIGNALING");
      expect(prompt).toContain("NEVER FABRICATE");
    });

    it("signals uncertainty is expected behavior", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("I don't have that information");
      expect(prompt).toContain("CORRECTIONS ARE WELCOME");
    });

    it("requires source attribution for all response types", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("FLEET DATA");
      expect(prompt).toContain("TRAINING KNOWLEDGE");
      expect(prompt).toContain("INFERENCE");
      expect(prompt).toContain("UNKNOWN");
    });

    it("flags game meta as potentially outdated", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("live game");
      expect(prompt).toContain("outdated");
    });

    it("does NOT contain restrictive anti-patterns", () => {
      const prompt = buildSystemPrompt("Name,Class\nKirk,Command");
      // These are the phrases that broke Majel v1.
      // "not limited to" is fine — it's the ABSENCE of "not" that's the problem.
      expect(prompt).not.toContain("use ONLY");
      expect(prompt).not.toMatch(/(?<!not )limited to the/i);
      expect(prompt).not.toContain("unable to process");
      expect(prompt).not.toContain("cannot discuss");
      expect(prompt).not.toMatch(/access is limited/i);
      expect(prompt).not.toMatch(/I am unable/i);
    });

    it("does NOT contain overconfidence anti-patterns", () => {
      const prompt = buildSystemPrompt(null);
      // These phrases encourage confabulation by telling the model
      // to never show uncertainty.
      expect(prompt).not.toContain("utterly competent");
      expect(prompt).not.toContain("don't hedge");
    });
  });

  describe("with roster data", () => {
    const csv = "Name,Class,Level\nKirk,Command,15\nSpock,Science,12";

    it("includes the CSV data", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("Kirk,Command,15");
      expect(prompt).toContain("Spock,Science,12");
    });

    it("wraps CSV in begin/end markers", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("--- BEGIN ROSTER DATA ---");
      expect(prompt).toContain("--- END ROSTER DATA ---");
    });

    it("instructs to cite exact stats", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("Cite exact stats");
    });

    it("instructs to combine roster with training knowledge", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("Combine roster data WITH your training knowledge");
    });

    it("instructs to handle missing officers gracefully with attribution", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("NOT in the roster");
      expect(prompt).toContain("training knowledge");
    });
  });

  describe("without roster data", () => {
    it("handles null gracefully", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).not.toContain("BEGIN ROSTER DATA");
      expect(prompt).toContain("No fleet data is currently connected");
    });

    it('handles "No roster data" prefix string', () => {
      const prompt = buildSystemPrompt("No roster data loaded yet.");
      expect(prompt).not.toContain("BEGIN ROSTER DATA");
      expect(prompt).toContain("No fleet data is currently connected");
    });

    it("handles empty string", () => {
      const prompt = buildSystemPrompt("");
      expect(prompt).not.toContain("BEGIN ROSTER DATA");
    });

    it("still has capabilities declared", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("CAPABILITIES:");
      expect(prompt).toContain("training knowledge");
    });

    it("suggests connecting fleet data via UI", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("connect");
    });
  });

  describe("model name interpolation", () => {
    it("includes the model name in the prompt", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("gemini-2.5-flash-lite");
    });
  });

  describe("with FleetData (structured)", () => {
    const officerSection = buildSection("officers", "Officers", "Officers", [
      ["Name", "Level", "Rank"],
      ["Kirk", "50", "Captain"],
      ["Spock", "45", "Commander"],
    ]);
    const shipSection = buildSection("ships", "Ships", "Ships", [
      ["Ship", "Tier", "Class"],
      ["Enterprise", "5", "Explorer"],
    ]);
    const customSection = buildSection("custom", "Notes", "Notes", [
      ["Note", "Priority"],
      ["Focus on PvP", "High"],
    ]);

    it("includes officer section with markers", () => {
      const data = buildFleetData("sheet-1", [officerSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("--- BEGIN OFFICERS: OFFICERS");
      expect(prompt).toContain("--- END OFFICERS: OFFICERS ---");
      expect(prompt).toContain("Kirk,50,Captain");
    });

    it("includes ship section with markers", () => {
      const data = buildFleetData("sheet-1", [shipSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("--- BEGIN SHIPS: SHIPS");
      expect(prompt).toContain("--- END SHIPS: SHIPS ---");
      expect(prompt).toContain("Enterprise,5,Explorer");
    });

    it("includes custom section with markers", () => {
      const data = buildFleetData("sheet-1", [customSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("--- BEGIN NOTES");
      expect(prompt).toContain("--- END NOTES ---");
      expect(prompt).toContain("Focus on PvP");
    });

    it("includes all sections when multiple types present", () => {
      const data = buildFleetData("sheet-1", [officerSection, shipSection, customSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("OFFICERS:");
      expect(prompt).toContain("SHIPS:");
      expect(prompt).toContain("NOTES");
    });

    it("shows row counts in section markers", () => {
      const data = buildFleetData("sheet-1", [officerSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("2 officers");
    });

    it("instructs cross-referencing between sections", () => {
      const data = buildFleetData("sheet-1", [officerSection, shipSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("Cross-reference between sections");
    });

    it("still declares capabilities and identity", () => {
      const data = buildFleetData("sheet-1", [officerSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("CAPABILITIES:");
      expect(prompt).toContain("training knowledge");
      expect(prompt).toContain("You are Majel");
    });

    it("handles empty FleetData (no sections)", () => {
      const emptyData = buildFleetData("sheet-1", []);
      const prompt = buildSystemPrompt(emptyData);
      expect(prompt).toContain("No fleet data is currently connected");
      expect(prompt).not.toContain("BEGIN OFFICERS");
    });
  });

  describe("with fleet config", () => {
    const config = { opsLevel: 29, drydockCount: 4, shipHangarSlots: 43 };

    it("includes ops level in prompt", () => {
      const prompt = buildSystemPrompt(null, config);
      expect(prompt).toContain("Operations Level: 29");
    });

    it("includes drydock count in prompt", () => {
      const prompt = buildSystemPrompt(null, config);
      expect(prompt).toContain("Active Drydocks: 4");
    });

    it("includes hangar slots in prompt", () => {
      const prompt = buildSystemPrompt(null, config);
      expect(prompt).toContain("Ship Hangar Slots: 43");
    });

    it("interpolates ops level in guidance text", () => {
      const prompt = buildSystemPrompt(null, config);
      expect(prompt).toContain("At Ops 29");
    });

    it("interpolates drydock count in guidance text", () => {
      const prompt = buildSystemPrompt(null, config);
      expect(prompt).toContain("With 4 drydocks");
    });

    it("works alongside fleet data", () => {
      const data = buildFleetData("sheet-1", [
        buildSection("officers", "Officers", "Officers", [
          ["Name", "Level"], ["Kirk", "50"],
        ]),
      ]);
      const prompt = buildSystemPrompt(data, config);
      expect(prompt).toContain("Operations Level: 29");
      expect(prompt).toContain("Kirk,50");
    });

    it("omits fleet config section when null", () => {
      const prompt = buildSystemPrompt(null, null);
      expect(prompt).not.toContain("FLEET CONFIGURATION");
    });

    it("omits fleet config section when undefined", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).not.toContain("FLEET CONFIGURATION");
    });
  });

  describe("with dock briefing", () => {
    const briefing = "DRYDOCK STATUS\n- Dock 1: USS Enterprise (Battleship) — Warp drive upgrade [active]\n\nCREW PRESETS\n- \"Alpha Crew\" for USS Enterprise: Kirk (Captain), Spock (Science)\n\nINSIGHTS\n- 1 dock active of 2 total";

    it("includes dock briefing in prompt", () => {
      const prompt = buildSystemPrompt(null, null, briefing);
      expect(prompt).toContain("DRYDOCK LOADOUT INTELLIGENCE");
      expect(prompt).toContain("DRYDOCK STATUS");
      expect(prompt).toContain("USS Enterprise");
    });

    it("includes crew preset data", () => {
      const prompt = buildSystemPrompt(null, null, briefing);
      expect(prompt).toContain("Alpha Crew");
      expect(prompt).toContain("Kirk (Captain)");
    });

    it("includes insights section", () => {
      const prompt = buildSystemPrompt(null, null, briefing);
      expect(prompt).toContain("INSIGHTS");
      expect(prompt).toContain("1 dock active of 2 total");
    });

    it("omits dock briefing section when null", () => {
      const prompt = buildSystemPrompt(null, null, null);
      expect(prompt).not.toContain("DRYDOCK LOADOUT INTELLIGENCE");
    });

    it("omits dock briefing section when undefined", () => {
      const prompt = buildSystemPrompt(null, null);
      expect(prompt).not.toContain("DRYDOCK LOADOUT INTELLIGENCE");
    });

    it("works alongside fleet config and fleet data", () => {
      const data = buildFleetData("sheet-1", [
        buildSection("officers", "Officers", "Officers", [
          ["Name", "Level"], ["Kirk", "50"],
        ]),
      ]);
      const config = { opsLevel: 29, drydockCount: 4, shipHangarSlots: 43 };
      const prompt = buildSystemPrompt(data, config, briefing);
      expect(prompt).toContain("Operations Level: 29");
      expect(prompt).toContain("Kirk,50");
      expect(prompt).toContain("DRYDOCK LOADOUT INTELLIGENCE");
      expect(prompt).toContain("USS Enterprise");
    });
  });
});

// ─── createGeminiEngine ─────────────────────────────────────────

describe("createGeminiEngine", () => {
  // We mock the Gemini SDK to avoid real API calls
  vi.mock("@google/generative-ai", () => {
    const mockSendMessage = vi.fn().mockResolvedValue({
      response: { text: () => "Aye, Admiral." },
    });

    const mockStartChat = vi.fn().mockReturnValue({
      sendMessage: mockSendMessage,
    });

    const mockGetGenerativeModel = vi.fn().mockReturnValue({
      startChat: mockStartChat,
    });

    class MockGoogleGenerativeAI {
      constructor(_apiKey: string) {}
      getGenerativeModel = mockGetGenerativeModel;
    }

    return {
      GoogleGenerativeAI: MockGoogleGenerativeAI,
      HarmCategory: {
        HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
        HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
        HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
      },
      HarmBlockThreshold: {
        BLOCK_NONE: "BLOCK_NONE",
      },
    };
  });

  it("creates an engine with chat, getHistory, getSessionCount, closeSession methods", () => {
    const engine = createGeminiEngine("fake-key", "some,csv,data");
    expect(engine).toHaveProperty("chat");
    expect(engine).toHaveProperty("getHistory");
    expect(engine).toHaveProperty("getSessionCount");
    expect(engine).toHaveProperty("closeSession");
    expect(typeof engine.chat).toBe("function");
    expect(typeof engine.getHistory).toBe("function");
    expect(typeof engine.getSessionCount).toBe("function");
    expect(typeof engine.closeSession).toBe("function");
  });

  it("returns an empty history initially", () => {
    const engine = createGeminiEngine("fake-key", "some,csv,data");
    expect(engine.getHistory()).toEqual([]);
  });

  it("chat returns model response and updates history", async () => {
    const engine = createGeminiEngine("fake-key", "csv");
    const response = await engine.chat("Hello");

    expect(response).toBe("Aye, Admiral.");

    const history = engine.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", text: "Hello" });
    expect(history[1]).toEqual({ role: "model", text: "Aye, Admiral." });
  });

  it("accumulates history across multiple turns", async () => {
    const engine = createGeminiEngine("fake-key", "csv");
    await engine.chat("First message");
    await engine.chat("Second message");

    const history = engine.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0].text).toBe("First message");
    expect(history[2].text).toBe("Second message");
  });

  it("returns a copy of history (not a reference)", () => {
    const engine = createGeminiEngine("fake-key", "csv");
    const h1 = engine.getHistory();
    const h2 = engine.getHistory();
    expect(h1).not.toBe(h2);
  });

  it("starts with zero active sessions", () => {
    const engine = createGeminiEngine("fake-key", "csv");
    expect(engine.getSessionCount()).toBe(0);
  });

  it("creates separate sessions for different sessionIds", async () => {
    const engine = createGeminiEngine("fake-key", "csv");
    await engine.chat("Alpha", "session-a");
    await engine.chat("Beta", "session-b");

    expect(engine.getSessionCount()).toBe(2);
    expect(engine.getHistory("session-a")).toHaveLength(2);
    expect(engine.getHistory("session-b")).toHaveLength(2);
    expect(engine.getHistory("session-a")[0].text).toBe("Alpha");
    expect(engine.getHistory("session-b")[0].text).toBe("Beta");
  });

  it("isolates history between sessions", async () => {
    const engine = createGeminiEngine("fake-key", "csv");
    await engine.chat("Hello", "s1");
    await engine.chat("World", "s2");

    const h1 = engine.getHistory("s1");
    const h2 = engine.getHistory("s2");
    expect(h1.some((m) => m.text === "World")).toBe(false);
    expect(h2.some((m) => m.text === "Hello")).toBe(false);
  });

  it("closeSession removes the session", async () => {
    const engine = createGeminiEngine("fake-key", "csv");
    await engine.chat("Test", "temp-session");
    expect(engine.getSessionCount()).toBe(1);

    engine.closeSession("temp-session");
    expect(engine.getSessionCount()).toBe(0);
    expect(engine.getHistory("temp-session")).toEqual([]);
  });

  it("getHistory returns empty array for unknown sessionId", () => {
    const engine = createGeminiEngine("fake-key", "csv");
    expect(engine.getHistory("nonexistent")).toEqual([]);
  });
});
