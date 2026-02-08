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

  describe("capabilities layer (never restricted)", () => {
    it("declares full training knowledge access", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("FULL ACCESS");
      expect(prompt).toContain("training knowledge");
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

    it("instructs model not to pretend it lacks capabilities", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("Do not pretend to lack capabilities");
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

    it("instructs to combine roster with game knowledge", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("Combine roster data WITH your game knowledge");
    });

    it("instructs to handle missing officers gracefully", () => {
      const prompt = buildSystemPrompt(csv);
      expect(prompt).toContain("NOT in the roster");
      expect(prompt).toContain("game knowledge");
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

    it("still has full capabilities declared", () => {
      const prompt = buildSystemPrompt(null);
      expect(prompt).toContain("CAPABILITIES:");
      expect(prompt).toContain("FULL ACCESS");
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

    it("still declares full capabilities", () => {
      const data = buildFleetData("sheet-1", [officerSection]);
      const prompt = buildSystemPrompt(data);
      expect(prompt).toContain("CAPABILITIES:");
      expect(prompt).toContain("FULL ACCESS");
      expect(prompt).toContain("You are Majel");
    });

    it("handles empty FleetData (no sections)", () => {
      const emptyData = buildFleetData("sheet-1", []);
      const prompt = buildSystemPrompt(emptyData);
      expect(prompt).toContain("No fleet data is currently connected");
      expect(prompt).not.toContain("BEGIN OFFICERS");
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

  it("creates an engine with chat and getHistory methods", () => {
    const engine = createGeminiEngine("fake-key", "some,csv,data");
    expect(engine).toHaveProperty("chat");
    expect(engine).toHaveProperty("getHistory");
    expect(typeof engine.chat).toBe("function");
    expect(typeof engine.getHistory).toBe("function");
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
});
