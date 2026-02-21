import { apiPost } from "./fetch.js";
import { runLockedMutation } from "./mutation.js";
import type {
  CompositionBelowDeckPolicySuggestion,
  CompositionBridgeCoreSuggestion,
  CompositionLoadoutSuggestion,
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
  return runLockedMutation({
    label: "Commit import rows",
    lockKey: "import-commit",
    mutationKey: "import-commit",
    mutate: () => apiPost<{
      receipt: { id: number };
      summary: { added: number; updated: number; unchanged: number; unresolved: number };
      requiresApproval: boolean;
    }>("/api/import/commit", input),
  });
}

export async function commitCompositionInference(input: {
  sourceReceiptId: number;
  sourceMeta?: Record<string, unknown>;
  bridgeCores: CompositionBridgeCoreSuggestion[];
  belowDeckPolicies: CompositionBelowDeckPolicySuggestion[];
  loadouts: CompositionLoadoutSuggestion[];
}): Promise<{
  receipt: { id: number };
  summary: { bridgeCores: number; belowDeckPolicies: number; loadouts: number };
}> {
  const acceptedBridgeCores = input.bridgeCores
    .filter((entry) => entry.accepted)
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      notes: entry.notes,
      members: entry.members.map((member) => ({ officerId: member.officerId, slot: member.slot })),
    }));

  const acceptedPolicies = input.belowDeckPolicies
    .filter((entry) => entry.accepted)
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      mode: entry.mode,
      spec: entry.spec,
      notes: entry.notes,
    }));

  const acceptedLoadouts = input.loadouts
    .filter((entry) => entry.accepted)
    .map((entry) => ({
      name: entry.name,
      shipId: entry.shipId,
      bridgeCoreKey: entry.bridgeCoreKey,
      belowDeckPolicyKey: entry.belowDeckPolicyKey,
      intentKeys: entry.intentKeys,
      tags: entry.tags,
      notes: entry.notes,
    }));

  return runLockedMutation({
    label: "Commit composition inference",
    lockKey: `composition-inference:${input.sourceReceiptId}`,
    mutationKey: "import-commit",
    mutate: () => apiPost<{
      receipt: { id: number };
      summary: { bridgeCores: number; belowDeckPolicies: number; loadouts: number };
    }>("/api/import/composition/commit", {
      sourceReceiptId: input.sourceReceiptId,
      sourceMeta: input.sourceMeta,
      bridgeCores: acceptedBridgeCores,
      belowDeckPolicies: acceptedPolicies,
      loadouts: acceptedLoadouts,
    }),
  });
}
