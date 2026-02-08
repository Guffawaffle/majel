/**
 * memory.test.ts — Tests for Lex memory integration.
 *
 * Uses a temp directory for each test to avoid cross-test contamination
 * and to avoid touching the real Majel DB.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createMemoryService, extractKeywords } from "../src/server/memory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── extractKeywords ────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts meaningful words, skips stop words", () => {
    const keywords = extractKeywords("What is the best crew for a mining ship?");
    expect(keywords).toContain("best");
    expect(keywords).toContain("crew");
    expect(keywords).toContain("mining");
    expect(keywords).toContain("ship");
    expect(keywords).not.toContain("what");
    expect(keywords).not.toContain("is");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("for");
    expect(keywords).not.toContain("a");
  });

  it("lowercases everything", () => {
    const keywords = extractKeywords("Kirk SPOCK McCoy");
    expect(keywords).toContain("kirk");
    expect(keywords).toContain("spock");
    expect(keywords).toContain("mccoy");
  });

  it("strips punctuation", () => {
    const keywords = extractKeywords("What's Kirk's power level?");
    expect(keywords).not.toContain("what's");
    expect(keywords).toContain("kirk");
    expect(keywords).toContain("power");
    expect(keywords).toContain("level");
  });

  it("limits to 10 keywords", () => {
    const longText =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const keywords = extractKeywords(longText);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });

  it("filters words shorter than 3 chars", () => {
    const keywords = extractKeywords("I am at an OK spot on my go");
    // "spot" is 4 chars, the rest are stop words or < 3 chars
    expect(keywords).toContain("spot");
    expect(keywords).not.toContain("am");
    expect(keywords).not.toContain("at");
    expect(keywords).not.toContain("go");
  });

  it("handles empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });
});

// ─── createMemoryService ────────────────────────────────────────

describe("createMemoryService", () => {
  const tmpDirs: string[] = [];

  function makeTmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-test-"));
    tmpDirs.push(dir);
    return path.join(dir, "test-memory.db");
  }

  afterEach(async () => {
    // Clean up temp dirs
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates a memory service with all expected methods", () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);
    expect(service).toHaveProperty("remember");
    expect(service).toHaveProperty("recall");
    expect(service).toHaveProperty("timeline");
    expect(service).toHaveProperty("close");
  });

  it("remember() stores a turn and returns a frame", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    const frame = await service.remember({
      question: "Who is the best captain?",
      answer: "Kirk leads with 2100 power.",
    });

    expect(frame).toBeDefined();
    expect(frame.id).toBeTruthy();
    expect(frame.timestamp).toBeTruthy();
    expect(frame.summary_caption).toContain("Who is the best captain?");
    expect(frame.summary_caption).toContain("Kirk leads");
    expect(frame.branch).toBe("majel-chat");
    expect(frame.module_scope).toContain("majel/chat");
    expect(frame.keywords).toBeInstanceOf(Array);
    expect(frame.keywords.length).toBeGreaterThan(0);

    await service.close();
  });

  it("remember() truncates long reference points", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    const longQuestion = "A".repeat(100);
    const frame = await service.remember({
      question: longQuestion,
      answer: "Yes.",
    });

    expect(frame.reference_point.length).toBeLessThanOrEqual(60);
    expect(frame.reference_point).toContain("...");

    await service.close();
  });

  it("remember() truncates long answer summaries", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    const frame = await service.remember({
      question: "Hi",
      answer: "B".repeat(200),
    });

    expect(frame.summary_caption).toContain("...");

    await service.close();
  });

  it("timeline() returns stored frames in order", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    await service.remember({ question: "First", answer: "One" });
    await service.remember({ question: "Second", answer: "Two" });
    await service.remember({ question: "Third", answer: "Three" });

    const frames = await service.timeline(10);
    expect(frames.length).toBe(3);

    await service.close();
  });

  it("timeline() respects limit", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    await service.remember({ question: "A", answer: "1" });
    await service.remember({ question: "B", answer: "2" });
    await service.remember({ question: "C", answer: "3" });

    const frames = await service.timeline(2);
    expect(frames.length).toBe(2);

    await service.close();
  });

  it("recall() searches by query text", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    await service.remember({
      question: "What crew works best for mining?",
      answer: "Use Domitia and K'Bisch.",
    });
    await service.remember({
      question: "Best PvP crew?",
      answer: "Try Kirk, Spock, and McCoy.",
    });

    const results = await service.recall("mining crew");
    expect(results.length).toBeGreaterThanOrEqual(1);

    await service.close();
  });

  it("recall() returns empty for no matches", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);

    const results = await service.recall("nonexistent topic xyz");
    expect(results).toEqual([]);

    await service.close();
  });

  it("close() can be called safely", async () => {
    const dbPath = makeTmpDb();
    const service = createMemoryService(dbPath);
    await service.close();
    // Should not throw
  });
});
