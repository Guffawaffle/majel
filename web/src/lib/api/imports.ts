import { apiPost } from "./fetch.js";
import { invalidateForMutation } from "../cache/cached-fetch.js";
import type {
  ImportAnalysis,
  MappedImportRow,
  ParsedImportData,
  ResolvedImportRow,
  UnresolvedImportItem,
} from "../types.js";

export async function analyzeImportFile(input: {
  fileName: string;
  contentBase64: string;
  format: "csv" | "xlsx";
}): Promise<ImportAnalysis> {
  const data = await apiPost<{ analysis: ImportAnalysis }>("/api/import/analyze", input);
  return data.analysis;
}

export async function parseImportFile(input: {
  fileName: string;
  contentBase64: string;
  format: "csv" | "xlsx";
}): Promise<ParsedImportData> {
  const data = await apiPost<{ parsed: ParsedImportData }>("/api/import/parse", input);
  return data.parsed;
}

export async function mapImportRows(input: {
  headers: string[];
  rows: string[][];
  mapping: Record<string, string | null | undefined>;
}): Promise<{ mappedRows: MappedImportRow[]; summary: { rowCount: number } }> {
  return apiPost<{ mappedRows: MappedImportRow[]; summary: { rowCount: number } }>("/api/import/map", input);
}

export async function resolveImportRows(input: {
  mappedRows: MappedImportRow[];
}): Promise<{
  resolvedRows: ResolvedImportRow[];
  unresolved: UnresolvedImportItem[];
  summary: { rows: number; unresolved: number };
}> {
  return apiPost<{
    resolvedRows: ResolvedImportRow[];
    unresolved: UnresolvedImportItem[];
    summary: { rows: number; unresolved: number };
  }>("/api/import/resolve", input);
}

export async function commitImportRows(input: {
  fileName?: string;
  sourceMeta?: Record<string, unknown>;
  mapping: Record<string, string | null | undefined>;
  resolvedRows: ResolvedImportRow[];
  unresolved: UnresolvedImportItem[];
  allowOverwrite?: boolean;
}): Promise<{
  receipt: { id: number };
  summary: { added: number; updated: number; unchanged: number; unresolved: number };
  requiresApproval: boolean;
}> {
  const result = await apiPost<{
    receipt: { id: number };
    summary: { added: number; updated: number; unchanged: number; unresolved: number };
    requiresApproval: boolean;
  }>("/api/import/commit", input);
  await invalidateForMutation("import-commit");
  return result;
}
