/**
 * Shared types for the Majel web client.
 *
 * These mirror server-side shapes from src/server/ — reduced to
 * the fields actually returned by client-facing endpoints.
 */

// ─── Auth ───────────────────────────────────────────────────

export type Role = "ensign" | "lieutenant" | "captain" | "admiral";

/** User returned by GET /api/auth/me (subset of server UserPublic) */
export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

// ─── Health ─────────────────────────────────────────────────

export interface HealthResponse {
  status: "online" | "initializing";
  retryAfterMs?: number;
  gemini: "connected" | "not configured";
  memory: "active" | "not configured";
  sessions: "active" | "not configured";
  crewStore: StoreStatus;
  referenceStore: StoreStatus;
  overlayStore: StoreStatus;
}

export type StoreStatus =
  | { active: false }
  | { active: true; error?: string; [key: string]: unknown };

// ─── Sessions ───────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "model" | "system" | "error";
  text: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

// ─── Chat ───────────────────────────────────────────────────

export interface ChatImage {
  data: string;
  mimeType: string;
}

export interface ChatResponse {
  answer: string;
  [key: string]: unknown;
}

// ─── Models ─────────────────────────────────────────────────

export type ModelTier = "budget" | "balanced" | "thinking" | "premium" | "frontier";
export type ModelSpeed = "fastest" | "fast" | "moderate" | "slow";

export interface ModelDef {
  id: string;
  name: string;
  tier: ModelTier;
  description: string;
  thinking: boolean;
  contextWindow: number;
  costRelative: number;
  speed: ModelSpeed;
}

export interface ModelsResponse {
  current: string;
  defaultModel: string;
  currentDef: ModelDef | null;
  models: (ModelDef & { active: boolean })[];
}

export interface ModelSelectResponse {
  previousModel: string;
  currentModel: string;
  modelDef: ModelDef;
  sessionsCleared: number;
  hints: string[];
}

// ─── Settings ───────────────────────────────────────────────

export interface SettingEntry {
  key: string;
  value: string;
  category: string;
}

// ─── Catalog / Fleet ────────────────────────────────────────

export type OwnershipState = "unknown" | "owned" | "unowned";

/** Merged officer — reference data + overlay fields from /api/catalog/officers/merged */
export interface CatalogOfficer {
  id: string;
  name: string;
  rarity: string | null;
  groupName: string | null;
  captainManeuver: string | null;
  officerAbility: string | null;
  belowDeckAbility: string | null;
  abilities: Record<string, unknown> | null;
  tags: Record<string, unknown> | null;
  officerGameId: number | null;
  officerClass: number | null;
  faction: { id?: number; name?: string } | null;
  synergyId: number | null;
  maxRank: number | null;
  traitConfig: Record<string, unknown> | null;
  source: string;
  // Overlay fields
  ownershipState: OwnershipState;
  target: boolean;
  userLevel: number | null;
  userRank: string | null;
  userPower: number | null;
  targetNote: string | null;
  targetPriority: number | null;
}

/** Merged ship — reference data + overlay fields from /api/catalog/ships/merged */
export interface CatalogShip {
  id: string;
  name: string;
  shipClass: string | null;
  grade: number | null;
  rarity: string | null;
  faction: string | null;
  tier: number | null;
  hullType: number | null;
  buildTimeInSeconds: number | null;
  maxTier: number | null;
  maxLevel: number | null;
  blueprintsRequired: number | null;
  gameId: number | null;
  ability: Record<string, unknown> | null;
  officerBonus: { attack?: number; defense?: number; health?: number } | null;
  source: string;
  // Overlay fields
  ownershipState: OwnershipState;
  target: boolean;
  userTier: number | null;
  userLevel: number | null;
  userPower: number | null;
  targetNote: string | null;
  targetPriority: number | null;
}

export interface CatalogCounts {
  reference: { officers: number; ships: number };
  overlay: {
    officers: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
    ships: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
  };
}

export interface OfficerOverlayPatch {
  ownershipState?: OwnershipState;
  target?: boolean;
  level?: number | null;
  rank?: string | null;
  power?: number | null;
  targetNote?: string | null;
  targetPriority?: number | null;
}

export interface ShipOverlayPatch {
  ownershipState?: OwnershipState;
  target?: boolean;
  tier?: number | null;
  level?: number | null;
  power?: number | null;
  targetNote?: string | null;
  targetPriority?: number | null;
}

// ─── Crews / Fleet Cross-Refs ───────────────────────────────

export type BridgeSlot = "captain" | "bridge_1" | "bridge_2";
export type BelowDeckMode = "stats_then_bda" | "pinned_only" | "stat_fill_only";
export type PlanSource = "manual" | "preset";
export type IntentCategory = "mining" | "combat" | "utility" | "custom";

export interface OfficerReservation {
  officerId: string;
  reservedFor: string;
  locked: boolean;
  notes: string | null;
  createdAt: string;
}

export interface OfficerConflict {
  officerId: string;
  locations: Array<{
    type: "bridge" | "plan_item" | "preset_slot";
    entityId: number;
    entityName: string;
    slot?: string;
  }>;
}

export interface BridgeCoreWithMembers {
  id: number;
  name: string;
  notes: string | null;
  members: Array<{
    id: number;
    bridgeCoreId: number;
    officerId: string;
    slot: "captain" | "bridge_1" | "bridge_2";
  }>;
}

export interface Loadout {
  id: number;
  shipId: string;
  bridgeCoreId: number | null;
  belowDeckPolicyId: number | null;
  name: string;
  priority: number;
  isActive: boolean;
  intentKeys: string[];
  tags: string[];
  notes: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BelowDeckPolicy {
  id: number;
  name: string;
  mode: BelowDeckMode;
  spec: { pinned?: string[]; prefer_modifiers?: string[]; avoid_reserved?: boolean; max_slots?: number };
  notes: string | null;
}

export interface Dock {
  dockNumber: number;
  label: string | null;
  unlocked: boolean;
  notes: string | null;
}

export interface VariantPatch {
  bridge?: Partial<Record<BridgeSlot, string>>;
  below_deck_policy_id?: number;
  below_deck_patch?: { pinned_add?: string[]; pinned_remove?: string[] };
  intent_keys?: string[];
}

export interface LoadoutVariant {
  id: number;
  baseLoadoutId: number;
  name: string;
  patch: VariantPatch;
  notes: string | null;
  createdAt: string;
}

export interface ResolvedLoadout {
  loadoutId: number;
  shipId: string;
  name: string;
  bridge: Record<BridgeSlot, string | null>;
  belowDeckPolicy: BelowDeckPolicy | null;
  intentKeys: string[];
  tags: string[];
  notes: string | null;
}

export interface EffectiveAwayTeam {
  label: string | null;
  officers: string[];
  source: PlanSource;
}

export interface EffectiveDockEntry {
  dockNumber: number;
  loadout: ResolvedLoadout | null;
  variantPatch: VariantPatch | null;
  intentKeys: string[];
  source: PlanSource;
}

export interface EffectiveDockState {
  docks: EffectiveDockEntry[];
  awayTeams: EffectiveAwayTeam[];
  conflicts: OfficerConflict[];
}

// ─── Fleet Presets ──────────────────────────────────────────

export interface FleetPreset {
  id: number;
  name: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetPresetSlot {
  id: number;
  presetId: number;
  dockNumber: number | null;
  loadoutId: number | null;
  variantId: number | null;
  awayOfficers: string[] | null;
  label: string | null;
  priority: number;
  notes: string | null;
}

export interface FleetPresetWithSlots extends FleetPreset {
  slots: FleetPresetSlot[];
}

// ─── Plan Items ─────────────────────────────────────────────

export interface PlanItem {
  id: number;
  intentKey: string | null;
  label: string | null;
  loadoutId: number | null;
  variantId: number | null;
  dockNumber: number | null;
  awayOfficers: string[] | null;
  priority: number;
  isActive: boolean;
  source: PlanSource;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Intent Catalog ─────────────────────────────────────────

export interface IntentDef {
  key: string;
  label: string;
  icon: string;
  category: IntentCategory;
}

// ─── Admiral Console ────────────────────────────────────────

/** Extended user for the admin user-management table */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  emailVerified: boolean;
  lockedAt: string | null;
  createdAt: string;
}

/** Invite code returned by the admin invites API */
export interface AdminInvite {
  code: string;
  label: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Active session returned by the admin sessions API */
export interface AdminSession {
  id: string;
  inviteCode: string | null;
  createdAt: string;
  lastSeenAt: string;
}

// ─── Diagnostics ────────────────────────────────────────────

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

// ─── Timers ─────────────────────────────────────────────────

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

// ─── Router ─────────────────────────────────────────────────

/** View definition for the router */
export interface ViewDef {
  /** Route identifier — matches hash fragment (e.g. "chat" → #/chat) */
  name: string;
  /** Display title */
  title: string;
  /** Subtitle shown in the title bar */
  subtitle: string;
  /** Emoji icon */
  icon: string;
  /** Role required to access (undefined = no gate) */
  gate?: "admiral";
}

// ─── Import Analysis ───────────────────────────────────────

export interface ImportMappingSuggestion {
  sourceColumn: string;
  suggestedField: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ImportAnalysis {
  fileName: string;
  format: "csv" | "xlsx";
  rowCount: number;
  headers: string[];
  sampleRows: string[][];
  candidateFields: string[];
  suggestions: ImportMappingSuggestion[];
}

export interface ParsedImportData {
  fileName: string;
  format: "csv" | "xlsx";
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

// ─── Import Receipts ────────────────────────────────────────

/** Server-side import receipt shape. */
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

/** Response from the undo-receipt endpoint. */
export interface UndoReceiptResult {
  success: boolean;
  message: string;
  inverse?: ImportReceipt["inverse"];
}

// ─── Chat History / Recall ──────────────────────────────────

/** A single Lex history entry. */
export interface LexHistoryEntry {
  id: string;
  timestamp: string;
  summary: string;
}

/** Response from the history endpoint. */
export interface HistoryResponse {
  session?: { role: string; text: string }[];
  lex?: LexHistoryEntry[];
}

/** A single Lex recall result. */
export interface RecallEntry {
  id: string;
  timestamp: string;
  summary: string;
  reference: string;
  keywords: string[];
}

/** Response from the recall search endpoint. */
export interface RecallResponse {
  query: string;
  results: RecallEntry[];
}

// ─── Catalog Overlay Responses ──────────────────────────────

/** Response from single overlay PATCH. Server echoes the merged overlay. */
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

/** Response from bulk overlay endpoints. */
export interface BulkOverlayResponse {
  updated: number;
  refIds: number;
  receiptId?: number | null;
}
