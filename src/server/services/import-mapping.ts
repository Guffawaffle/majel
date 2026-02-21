import type { GeminiEngine } from "./gemini/index.js";
import { read, utils } from "xlsx";

export type ImportFormat = "csv" | "tsv" | "xlsx";

export interface ImportAnalyzeInput {
  fileName: string;
  contentBase64: string;
  format: ImportFormat;
}

export interface ImportSuggestion {
  sourceColumn: string;
  suggestedField: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ImportAnalyzeResult {
  fileName: string;
  format: ImportFormat;
  rowCount: number;
  headers: string[];
  sampleRows: string[][];
  candidateFields: string[];
  suggestions: ImportSuggestion[];
}

export interface ParsedImportData {
  fileName: string;
  format: ImportFormat;
  headers: string[];
  rows: string[][];
  sampleRows: string[][];
  rowCount: number;
}

export interface MappedImportRow {
  rowIndex: number;
  officerId?: string;
  officerName?: string;
  officerLevel?: number | null;
  officerRank?: string | null;
  officerPower?: number | null;
  officerOwned?: boolean | null;
  shipId?: string;
  shipName?: string;
  shipLevel?: number | null;
  shipTier?: number | null;
  shipPower?: number | null;
  shipOwned?: boolean | null;
}

export interface ResolveCandidate {
  id: string;
  name: string;
  score: number;
}

export interface UnresolvedImportItem {
  rowIndex: number;
  entityType: "officer" | "ship";
  rawValue: string;
  candidates: ResolveCandidate[];
}

export interface ResolvedImportRow extends MappedImportRow {
  officerRefId?: string | null;
  shipRefId?: string | null;
}

const OWNERSHIP_FIELDS = [
  "officer.id",
  "officer.name",
  "officer.level",
  "officer.rank",
  "officer.power",
  "officer.owned",
  "ship.id",
  "ship.name",
  "ship.level",
  "ship.tier",
  "ship.power",
  "ship.owned",
] as const;

const FIELD_ALIASES: Record<string, string[]> = {
  "officer.id": ["officerid", "officer_id", "officer id", "id"],
  "officer.name": ["officer", "officername", "officer_name", "officer name", "name"],
  "officer.level": ["officerlevel", "officer_level", "officer lvl", "level", "lvl"],
  "officer.rank": ["officerrank", "officer_rank", "rank"],
  "officer.power": ["officerpower", "officer_power", "power", "strength"],
  "officer.owned": ["owned", "isowned", "officer_owned", "officer owned", "have officer"],
  "ship.id": ["shipid", "ship_id", "ship id"],
  "ship.name": ["ship", "shipname", "ship_name", "ship name"],
  "ship.level": ["shiplevel", "ship_level", "ship lvl"],
  "ship.tier": ["tier", "shiptier", "ship_tier", "ship tier"],
  "ship.power": ["shippower", "ship_power", "ship strength"],
  "ship.owned": ["shipowned", "ship_owned", "ship owned", "have ship"],
};

const KNOWN_SCHEMA_M86_MAP: Record<string, string> = {
  officer: "officer.name",
  "officer name": "officer.name",
  level: "officer.level",
  "officer level": "officer.level",
  rank: "officer.rank",
  "officer rank": "officer.rank",
  power: "officer.power",
  "officer power": "officer.power",
  owned: "officer.owned",
  "officer owned": "officer.owned",
  ship: "ship.name",
  "ship name": "ship.name",
  "ship level": "ship.level",
  tier: "ship.tier",
  "ship tier": "ship.tier",
  "ship power": "ship.power",
  "ship owned": "ship.owned",
};

const KNOWN_SCHEMA_M86_REQUIRED_HEADERS = ["officer", "level", "owned"];

export async function analyzeImport(
  input: ImportAnalyzeInput,
  geminiEngine: GeminiEngine | null,
): Promise<ImportAnalyzeResult> {
  const rows = parseRows(input);
  if (rows.length === 0) {
    return {
      fileName: input.fileName,
      format: input.format,
      rowCount: 0,
      headers: [],
      sampleRows: [],
      candidateFields: [...OWNERSHIP_FIELDS],
      suggestions: [],
    };
  }

  const normalizedRows = rows.filter((r) => r.some((c) => c.trim().length > 0));
  const headers = normalizedRows[0]?.map((c) => c.trim()) ?? [];
  const dataRows = normalizedRows.slice(1);
  const sampleRows = dataRows.slice(0, 3).map((row) => normalizeRowLength(row, headers.length));
  const knownSchemaSuggestions = detectKnownSchemaSuggestions(headers);
  const heuristicSuggestions = buildHeuristicSuggestions(headers, sampleRows);

  const aiSuggestions = knownSchemaSuggestions || !geminiEngine
    ? null
    : await suggestWithAi(headers, sampleRows, geminiEngine);

  const suggestions = knownSchemaSuggestions ?? mergeSuggestions(heuristicSuggestions, aiSuggestions);

  return {
    fileName: input.fileName,
    format: input.format,
    rowCount: dataRows.length,
    headers,
    sampleRows,
    candidateFields: [...OWNERSHIP_FIELDS],
    suggestions,
  };
}

export function parseImportData(input: ImportAnalyzeInput): ParsedImportData {
  const rows = parseRows(input).filter((r) => r.some((cell) => cell.trim().length > 0));
  const headers = rows[0]?.map((cell) => cell.trim()) ?? [];
  const dataRows = rows.slice(1).map((row) => normalizeRowLength(row, headers.length));
  const sampleRows = dataRows.slice(0, 3);

  return {
    fileName: input.fileName,
    format: input.format,
    headers,
    rows: dataRows,
    sampleRows,
    rowCount: dataRows.length,
  };
}

export function mapParsedRows(
  parsed: Pick<ParsedImportData, "headers" | "rows">,
  mapping: Record<string, string | null | undefined>,
): MappedImportRow[] {
  const fieldByIndex = parsed.headers.map((header) => mapping[header] ?? null);

  return parsed.rows.map((row, rowIndex) => {
    const mapped: MappedImportRow = { rowIndex };

    for (let index = 0; index < row.length; index += 1) {
      const targetField = fieldByIndex[index];
      if (!targetField) continue;
      const raw = row[index] ?? "";
      applyMappedValue(mapped, targetField, raw);
    }

    return mapped;
  });
}

export function resolveMappedRows(
  mappedRows: MappedImportRow[],
  officers: Array<{ id: string; name: string }>,
  ships: Array<{ id: string; name: string }>,
): { resolvedRows: ResolvedImportRow[]; unresolved: UnresolvedImportItem[] } {
  const unresolved: UnresolvedImportItem[] = [];

  const resolvedRows = mappedRows.map((row) => {
    const resolved: ResolvedImportRow = { ...row, officerRefId: null, shipRefId: null };

    if (row.officerId || row.officerName) {
      const rawOfficer = row.officerId?.trim() || row.officerName?.trim() || "";
      const officerHit = resolveReference(rawOfficer, officers);
      if (officerHit) {
        resolved.officerRefId = officerHit.id;
      } else if (rawOfficer) {
        unresolved.push({
          rowIndex: row.rowIndex,
          entityType: "officer",
          rawValue: rawOfficer,
          candidates: topCandidates(rawOfficer, officers),
        });
      }
    }

    if (row.shipId || row.shipName) {
      const rawShip = row.shipId?.trim() || row.shipName?.trim() || "";
      const shipHit = resolveReference(rawShip, ships);
      if (shipHit) {
        resolved.shipRefId = shipHit.id;
      } else if (rawShip) {
        unresolved.push({
          rowIndex: row.rowIndex,
          entityType: "ship",
          rawValue: rawShip,
          candidates: topCandidates(rawShip, ships),
        });
      }
    }

    return resolved;
  });

  return { resolvedRows, unresolved };
}

function parseRows(input: ImportAnalyzeInput): string[][] {
  const buffer = Buffer.from(input.contentBase64, "base64");

  if (input.format === "xlsx") {
    return parseXlsxFirstSheet(buffer);
  }

  if (input.format === "tsv") {
    return parseDelimited(buffer.toString("utf8"), "\t");
  }

  return parseDelimited(buffer.toString("utf8"), ",");
}

function applyMappedValue(target: MappedImportRow, field: string, raw: string): void {
  const value = raw.trim();
  switch (field) {
    case "officer.id":
      target.officerId = value || undefined;
      break;
    case "officer.name":
      target.officerName = value || undefined;
      break;
    case "officer.level":
      target.officerLevel = parseNullableInteger(value);
      break;
    case "officer.rank":
      target.officerRank = value || null;
      break;
    case "officer.power":
      target.officerPower = parseNullableInteger(value);
      break;
    case "officer.owned":
      target.officerOwned = parseNullableBoolean(value);
      break;
    case "ship.id":
      target.shipId = value || undefined;
      break;
    case "ship.name":
      target.shipName = value || undefined;
      break;
    case "ship.level":
      target.shipLevel = parseNullableInteger(value);
      break;
    case "ship.tier":
      target.shipTier = parseNullableInteger(value);
      break;
    case "ship.power":
      target.shipPower = parseNullableInteger(value);
      break;
    case "ship.owned":
      target.shipOwned = parseNullableBoolean(value);
      break;
    default:
      break;
  }
}

function parseNullableInteger(value: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/[^0-9-]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseNullableBoolean(value: string): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "owned"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "unowned"].includes(normalized)) return false;
  return null;
}

function resolveReference(
  raw: string,
  refs: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const norm = normalizeLookup(raw);
  if (!norm) return null;

  for (const ref of refs) {
    if (normalizeLookup(ref.id) === norm) return ref;
  }

  for (const ref of refs) {
    if (normalizeLookup(ref.name) === norm) return ref;
  }

  return null;
}

function topCandidates(
  raw: string,
  refs: Array<{ id: string; name: string }>,
): ResolveCandidate[] {
  const normRaw = normalizeLookup(raw);
  const scored = refs
    .map((ref) => ({
      id: ref.id,
      name: ref.name,
      score: similarity(normRaw, normalizeLookup(ref.name)),
    }))
    .filter((item) => item.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((item) => ({ ...item, score: Number(item.score.toFixed(3)) }));
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.length === 0) return 0;
  const overlap = aTokens.filter((token) => bTokens.has(token)).length;
  return overlap / Math.max(aTokens.length, bTokens.size || 1);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function parseXlsxFirstSheet(buffer: Buffer): string[][] {
  const workbook = read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  if (!worksheet) return [];

  const rows = utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });

  return rows.map((row) => row.map((cell) => String(cell ?? "")));
}

function detectKnownSchemaSuggestions(headers: string[]): ImportSuggestion[] | null {
  if (headers.length === 0) return null;

  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const requiredMatched = KNOWN_SCHEMA_M86_REQUIRED_HEADERS.every((required) => normalizedHeaders.includes(required));

  const mappedCount = normalizedHeaders.filter((header) => !!KNOWN_SCHEMA_M86_MAP[header]).length;
  const coverage = mappedCount / headers.length;
  const isM86 = requiredMatched && mappedCount >= 3 && coverage >= 0.5;

  if (!isM86) return null;

  return headers.map((header, columnIndex) => {
    const mappedField = KNOWN_SCHEMA_M86_MAP[normalizedHeaders[columnIndex]] ?? null;
    if (!mappedField) {
      return {
        sourceColumn: header,
        suggestedField: null,
        confidence: "low",
        reason: "Known schema: M86 (no direct field match)",
      };
    }

    return {
      sourceColumn: header,
      suggestedField: mappedField,
      confidence: "high",
      reason: "Known schema: M86",
    };
  });
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeRowLength(row: string[], len: number): string[] {
  if (row.length === len) return row;
  if (row.length > len) return row.slice(0, len);
  return [...row, ...new Array(len - row.length).fill("")];
}

function buildHeuristicSuggestions(headers: string[], sampleRows: string[][]): ImportSuggestion[] {
  return headers.map((header, columnIndex) => {
    const normalized = normalizeHeader(header);
    let bestField: string | null = null;
    let bestScore = 0;

    for (const field of OWNERSHIP_FIELDS) {
      const aliases = FIELD_ALIASES[field] ?? [];
      let score = 0;
      for (const alias of aliases) {
        const normalizedAlias = normalizeHeader(alias);
        if (!normalizedAlias) continue;
        if (normalized === normalizedAlias) score = Math.max(score, 1);
        else if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) {
          score = Math.max(score, 0.7);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestField = field;
      }
    }

    const sampleValues = sampleRows
      .map((row) => row[columnIndex] ?? "")
      .filter((value) => value.trim().length > 0)
      .slice(0, 3);

    if (!bestField) {
      return {
        sourceColumn: header,
        suggestedField: null,
        confidence: "low",
        reason: "No strong header match",
      };
    }

    const confidence = bestScore >= 1 ? "high" : bestScore >= 0.7 ? "medium" : "low";
    return {
      sourceColumn: header,
      suggestedField: bestField,
      confidence,
      reason: `Header similarity + sample values (${sampleValues.join(" | ") || "none"})`,
    };
  });
}

async function suggestWithAi(
  headers: string[],
  sampleRows: string[][],
  geminiEngine: GeminiEngine,
): Promise<ImportSuggestion[] | null> {
  const prompt = [
    "You are mapping spreadsheet columns to known fleet ownership fields.",
    "Return ONLY strict JSON as an object: {\"suggestions\":[{\"sourceColumn\":string,\"suggestedField\":string|null,\"confidence\":\"high\"|\"medium\"|\"low\",\"reason\":string}]}",
    `Allowed target fields: ${OWNERSHIP_FIELDS.join(", ")}`,
    `Headers: ${JSON.stringify(headers)}`,
    `Sample rows (first up to 3): ${JSON.stringify(sampleRows)}`,
  ].join("\n");

  try {
    const raw = await geminiEngine.chat(prompt, "import-mapping");
    const parsed = parseJsonObject(raw) as { suggestions?: ImportSuggestion[] } | null;
    const suggestions = parsed?.suggestions;
    if (!Array.isArray(suggestions)) return null;
    return suggestions
      .filter((entry) => headers.includes(entry.sourceColumn))
      .map((entry) => ({
        sourceColumn: entry.sourceColumn,
        suggestedField: isAllowedField(entry.suggestedField) ? entry.suggestedField : null,
        confidence: toConfidence(entry.confidence),
        reason: String(entry.reason ?? "AI suggestion"),
      }));
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("No JSON object in AI response");
  }
}

function isAllowedField(value: string | null): value is string {
  return !!value && OWNERSHIP_FIELDS.includes(value as (typeof OWNERSHIP_FIELDS)[number]);
}

function toConfidence(value: string): "high" | "medium" | "low" {
  if (value === "high" || value === "medium") return value;
  return "low";
}

function mergeSuggestions(
  heuristics: ImportSuggestion[],
  ai: ImportSuggestion[] | null,
): ImportSuggestion[] {
  if (!ai || ai.length === 0) return heuristics;
  const aiByColumn = new Map(ai.map((entry) => [entry.sourceColumn, entry]));
  return heuristics.map((base) => {
    const suggested = aiByColumn.get(base.sourceColumn);
    return suggested ?? base;
  });
}
