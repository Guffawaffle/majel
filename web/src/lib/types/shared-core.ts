export type Role = "ensign" | "lieutenant" | "captain" | "admiral";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

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

export interface ChatImage {
  data: string;
  mimeType: string;
}

export interface ChatProposal {
  id: string;
  batchItems: Array<{ tool: string; preview: string }>;
  expiresAt: string;
}

export interface ChatResponse {
  answer: string;
  proposals?: ChatProposal[];
  [key: string]: unknown;
}

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

export interface SettingEntry {
  key: string;
  value: string;
  category: string;
}

export type OwnershipState = "unknown" | "owned" | "unowned";

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
  ownershipState: OwnershipState;
  target: boolean;
  userLevel: number | null;
  userRank: string | null;
  userPower: number | null;
  targetNote: string | null;
  targetPriority: number | null;
}

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
