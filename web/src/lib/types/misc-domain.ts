import type { Role, OwnershipState } from "./shared-core.js";
import type { BridgeSlot, BelowDeckMode } from "./crew-domain.js";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  emailVerified: boolean;
  lockedAt: string | null;
  createdAt: string;
}

export interface AdminInvite {
  code: string;
  label: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface AdminSession {
  id: string;
  inviteCode: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface DiagnosticHealth {
  system: {
    version: string;
    uptime: string;
    uptimeSeconds: number;
    nodeVersion?: string;
    timestamp: string;
    startupComplete: boolean;
  };
  gemini: { status: string; model?: string; activeSessions?: number };
  memory: { status: string; frameCount?: number; dbPath?: string };
  settings: { status: string; userOverrides?: number };
  sessions: { status: string; count?: number };
  crewStore: { status: string; [key: string]: unknown };
  referenceStore: { status: string; [key: string]: unknown };
  overlayStore: { status: string; [key: string]: unknown };
}

export interface DiagnosticSummary {
  reference: {
    officers: { total: number; byRarity: { rarity: string | null; count: number }[] };
    ships: { total: number; byClass: { ship_class: string | null; count: number }[]; byFaction: { faction: string | null; count: number }[] };
  };
  overlay: {
    officers: { total: number; byOwnership: { ownership_state: string; count: number }[] };
    ships: { total: number; byOwnership: { ownership_state: string; count: number }[] };
  };
  samples: {
    officers: Record<string, unknown>[];
    ships: Record<string, unknown>[];
  };
}

export interface DiagnosticSchemaTable {
  table: string;
  rowCount: number;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    defaultValue: string | null;
    primaryKey: boolean;
  }[];
  indexes: { name: string; unique: boolean }[];
}

export interface DiagnosticSchema {
  database: string;
  tables: DiagnosticSchemaTable[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  totalBeforeLimit: number;
  truncated: boolean;
  limit: number;
  durationMs: number;
  sql: string;
}

export type TimerState = "running" | "paused" | "stopped" | "completed";

export interface Timer {
  id: string;
  label: string;
  durationMs: number;
  remainingMs: number;
  state: TimerState;
  repeating: boolean;
  soundId: number;
  createdAt: number;
  completedCount: number;
}

export interface ViewDef {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  gate?: "admiral";
}

export interface ImportMappingSuggestion {
  sourceColumn: string;
  suggestedField: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ImportAnalysis {
  fileName: string;
  format: "csv" | "tsv" | "xlsx";
  rowCount: number;
  headers: string[];
  sampleRows: string[][];
  candidateFields: string[];
  suggestions: ImportMappingSuggestion[];
}

export interface ParsedImportData {
  fileName: string;
  format: "csv" | "tsv" | "xlsx";
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

export interface ImportReceipt {
  id: number;
  sourceType: string;
  sourceMeta: Record<string, unknown>;
  mapping: Record<string, unknown> | null;
  layer: string;
  changeset: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  inverse: { added?: unknown[]; updated?: unknown[]; removed?: unknown[] };
  unresolved: unknown[] | null;
  createdAt: string;
}

export interface CompositionBridgeCoreSuggestion {
  key: string;
  name: string;
  accepted: boolean;
  members: Array<{ officerId: string; officerName: string; slot: BridgeSlot }>;
  notes?: string;
}

export interface CompositionBelowDeckPolicySuggestion {
  key: string;
  name: string;
  accepted: boolean;
  mode: BelowDeckMode;
  spec: { pinned?: string[]; prefer_modifiers?: string[]; avoid_reserved?: boolean; max_slots?: number };
  notes?: string;
}

export interface CompositionLoadoutSuggestion {
  key: string;
  name: string;
  accepted: boolean;
  shipId: string;
  shipName: string;
  bridgeCoreKey?: string;
  belowDeckPolicyKey?: string;
  intentKeys: string[];
  tags: string[];
  notes?: string;
}

export interface UndoReceiptResult {
  success: boolean;
  message: string;
  inverse?: ImportReceipt["inverse"];
}

export interface LexHistoryEntry {
  id: string;
  timestamp: string;
  summary: string;
}

export interface HistoryResponse {
  session?: { role: string; text: string }[];
  lex?: LexHistoryEntry[];
}

export interface RecallEntry {
  id: string;
  timestamp: string;
  summary: string;
  reference: string;
  keywords: string[];
}

export interface RecallResponse {
  query: string;
  results: RecallEntry[];
}

export interface OfficerOverlayResponse {
  ownershipState: OwnershipState;
  target: boolean;
  userLevel: number | null;
  userRank: string | null;
  userPower: number | null;
  targetNote: string | null;
  targetPriority: number | null;
}

export interface ShipOverlayResponse {
  ownershipState: OwnershipState;
  target: boolean;
  userTier: number | null;
  userLevel: number | null;
  userPower: number | null;
  targetNote: string | null;
  targetPriority: number | null;
}

export interface BulkOverlayResponse {
  updated: number;
  refIds: number;
  receiptId?: number | null;
}
