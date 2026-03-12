/**
 * scan.ts — Structured image extraction service (ADR-008 Phase B)
 *
 * Stateless Gemini calls that parse STFC screenshots into structured JSON.
 * Cross-references extracted data against the reference catalog to detect
 * existing entities and field changes.
 */

import { GoogleGenAI, type Part } from "@google/genai";
import type { ReferenceStore } from "../stores/reference-store.js";
import type { OverlayStore } from "../stores/overlay-store.js";
import { log } from "../logger.js";
import { SAFETY_SETTINGS } from "./gemini/system-prompt.js";

// ─── Types ────────────────────────────────────────────────────

export type ScanType = "officer" | "ship" | "event" | "auto";

export interface ScanRequest {
  image: { data: string; mimeType: string };
  scanType: ScanType;
}

export interface ExtractedOfficer {
  name: string;
  rarity?: string;
  level?: number;
  rank?: number;
  group?: string;
  abilities?: string[];
  faction?: string;
}

export interface ExtractedShip {
  name: string;
  shipClass?: string;
  tier?: number;
  level?: number;
  rarity?: string;
  faction?: string;
  warpRange?: number;
}

export interface ExtractedEvent {
  name: string;
  type?: string;
  description?: string;
  scoring?: string;
  startDate?: string;
  endDate?: string;
}

export interface ScanExtraction {
  scanType: ScanType;
  officers?: ExtractedOfficer[];
  ships?: ExtractedShip[];
  events?: ExtractedEvent[];
  confidence: number;
  rawText?: string;
  note?: string;
}

export interface MatchedChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

export interface MatchedEntity {
  entityType: "officer" | "ship";
  refId: string;
  name: string;
  changes: MatchedChange[];
}

export interface ScanResult {
  scanType: ScanType;
  extracted: ScanExtraction;
  matched: MatchedEntity[];
}

// ─── Prompts ──────────────────────────────────────────────────

const OFFICER_PROMPT = `Analyze this STFC (Star Trek Fleet Command) screenshot and extract officer data.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "scanType": "officer",
  "officers": [
    {
      "name": "Full officer name exactly as displayed",
      "rarity": "common|uncommon|rare|epic|legendary",
      "level": 0,
      "rank": 0,
      "group": "command|science|engineering",
      "abilities": ["captain maneuver description", "officer ability description"],
      "faction": "federation|klingon|romulan|augment|other|neutral"
    }
  ],
  "confidence": 0.0,
  "rawText": "all visible text from the image"
}

Rules:
- Extract ALL officers visible in the screenshot
- confidence is 0.0-1.0 reflecting how clearly you can read the data
- If text is blurry or partially obscured, set confidence below 0.5 and add a "note" field
- Use exact names as they appear in game (e.g. "James T. Kirk" not "Kirk")
- level and rank are integers; omit if not visible
- Include a "note" field if anything is uncertain`;

const SHIP_PROMPT = `Analyze this STFC (Star Trek Fleet Command) screenshot and extract ship data.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "scanType": "ship",
  "ships": [
    {
      "name": "Full ship name as displayed",
      "shipClass": "explorer|interceptor|battleship|survey",
      "tier": 0,
      "level": 0,
      "rarity": "common|uncommon|rare|epic|legendary",
      "faction": "federation|klingon|romulan|independent|neutral",
      "warpRange": 0
    }
  ],
  "confidence": 0.0,
  "rawText": "all visible text from the image"
}

Rules:
- Extract ALL ships visible in the screenshot
- confidence is 0.0-1.0 reflecting how clearly you can read the data
- If text is blurry or partially obscured, set confidence below 0.5 and add a "note" field
- tier and level are integers; omit if not visible
- warpRange is an integer; omit if not visible
- Include a "note" field if anything is uncertain`;

const EVENT_PROMPT = `Analyze this STFC (Star Trek Fleet Command) screenshot and extract event data.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "scanType": "event",
  "events": [
    {
      "name": "Event name",
      "type": "solo|alliance|faction_hunt|mining|combat|generic",
      "description": "brief event description if visible",
      "scoring": "scoring criteria if visible",
      "startDate": "ISO date if visible or null",
      "endDate": "ISO date if visible or null"
    }
  ],
  "confidence": 0.0,
  "rawText": "all visible text from the image"
}

Rules:
- Extract ALL events visible in the screenshot
- confidence is 0.0-1.0 reflecting how clearly you can read the data
- If text is blurry or partially obscured, set confidence below 0.5 and add a "note" field
- Dates should be ISO 8601 format if parseable, null otherwise
- Include a "note" field if anything is uncertain`;

const AUTO_PROMPT = `Analyze this STFC (Star Trek Fleet Command) screenshot. Determine what type of content it shows (officer card, ship stats, event notification, or other) and extract the relevant structured data.

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "scanType": "officer" | "ship" | "event",
  "officers": [...],
  "ships": [...],
  "events": [...],
  "confidence": 0.0,
  "rawText": "all visible text from the image",
  "note": "optional explanation"
}

Include only the array field(s) relevant to the detected content type.

Rules:
- Detect the screenshot type first, then extract accordingly
- confidence is 0.0-1.0 reflecting how clearly you can read the data
- If text is blurry or partially obscured, set confidence below 0.5
- Follow the same extraction rules as type-specific scans
- Include a "note" field explaining what you detected`;

const PROMPTS: Record<ScanType, string> = {
  officer: OFFICER_PROMPT,
  ship: SHIP_PROMPT,
  event: EVENT_PROMPT,
  auto: AUTO_PROMPT,
};

// ─── Extraction ───────────────────────────────────────────────

/**
 * Call Gemini with the image + extraction prompt and parse the JSON response.
 * Uses a stateless generateContent call — no session history needed.
 */
export async function extractFromImage(
  apiKey: string,
  modelId: string,
  image: { data: string; mimeType: string },
  scanType: ScanType,
): Promise<ScanExtraction> {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = PROMPTS[scanType];

  const parts: Part[] = [
    { inlineData: { data: image.data, mimeType: image.mimeType } },
    { text: prompt },
  ];

  const result = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: "user", parts }],
    config: {
      safetySettings: SAFETY_SETTINGS,
    },
  });

  const text = result.text ?? "";
  log.gemini.debug({ scanType, responseLen: text.length }, "scan:extraction");

  return parseExtractionResponse(text, scanType);
}

/**
 * Parse the model's JSON response, handling common formatting issues
 * (markdown fences, trailing commas, etc.).
 */
export function parseExtractionResponse(text: string, fallbackScanType: ScanType): ScanExtraction {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Validate and normalize
    const scanType = (parsed.scanType as ScanType) || fallbackScanType;
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    return {
      scanType,
      officers: Array.isArray(parsed.officers) ? parsed.officers : undefined,
      ships: Array.isArray(parsed.ships) ? parsed.ships : undefined,
      events: Array.isArray(parsed.events) ? parsed.events : undefined,
      confidence,
      rawText: typeof parsed.rawText === "string" ? parsed.rawText : undefined,
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  } catch {
    log.gemini.warn({ responseLen: text.length }, "scan:json_parse_failed");
    return {
      scanType: fallbackScanType,
      confidence: 0,
      note: "Failed to parse extraction response as JSON",
      rawText: text.slice(0, 2000),
    };
  }
}

// ─── Cross-Reference ──────────────────────────────────────────

/**
 * Match extracted entities against the reference catalog and overlay data.
 * Returns matched entities with detected field changes.
 */
export async function crossReference(
  extraction: ScanExtraction,
  referenceStore: ReferenceStore,
  overlayStore?: OverlayStore | null,
): Promise<MatchedEntity[]> {
  const matched: MatchedEntity[] = [];

  if (extraction.officers) {
    for (const officer of extraction.officers) {
      if (!officer.name) continue;
      const ref = await referenceStore.findOfficerByName(officer.name)
        ?? (await referenceStore.searchOfficers(officer.name))[0]
        ?? null;

      if (!ref) continue;

      const changes: MatchedChange[] = [];

      // Check overlay for progression changes
      if (overlayStore && officer.level != null) {
        const overlay = await overlayStore.getOfficerOverlay(ref.id);
        if (overlay?.level != null && overlay.level !== officer.level) {
          changes.push({ field: "level", from: overlay.level, to: officer.level });
        }
        if (overlay?.rank != null && officer.rank != null && String(overlay.rank) !== String(officer.rank)) {
          changes.push({ field: "rank", from: overlay.rank, to: officer.rank });
        }
      }

      matched.push({
        entityType: "officer",
        refId: ref.id,
        name: ref.name,
        changes,
      });
    }
  }

  if (extraction.ships) {
    for (const ship of extraction.ships) {
      if (!ship.name) continue;
      const ref = await referenceStore.findShipByName(ship.name)
        ?? (await referenceStore.searchShips(ship.name))[0]
        ?? null;

      if (!ref) continue;

      const changes: MatchedChange[] = [];

      if (overlayStore && ship.tier != null) {
        const overlay = await overlayStore.getShipOverlay(ref.id);
        if (overlay?.tier != null && overlay.tier !== ship.tier) {
          changes.push({ field: "tier", from: overlay.tier, to: ship.tier });
        }
        if (overlay?.level != null && ship.level != null && overlay.level !== ship.level) {
          changes.push({ field: "level", from: overlay.level, to: ship.level });
        }
      }

      matched.push({
        entityType: "ship",
        refId: ref.id,
        name: ref.name,
        changes,
      });
    }
  }

  return matched;
}
