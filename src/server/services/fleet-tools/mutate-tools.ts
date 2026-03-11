/**
 * fleet-tools/mutate-tools.ts — Barrel re-export
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Domain mutation handlers split into focused modules (#193).
 * This barrel preserves the single import path used by tool-registry.ts.
 */

// ── Crew composition ────────────────────────────────────────
export {
  createBridgeCoreTool,
  createLoadoutTool,
  activatePresetTool,
  setReservationTool,
  createVariantTool,
  getEffectiveStateTool,
} from "./mutate-tools-crew.js";

// ── Target tracking ─────────────────────────────────────────
export {
  createTargetTool,
  updateTargetTool,
  completeTargetTool,
  recordTargetDeltaTool,
  recordReminderFeedbackTool,
  recordGoalRestatementTool,
} from "./mutate-tools-targets.js";

// ── Bulk import sync ────────────────────────────────────────
export {
  syncOverlayTool,
  syncResearchTool,
} from "./mutate-tools-sync.js";

// ── Overlay & inventory setters ─────────────────────────────
export {
  setShipOverlayTool,
  setOfficerOverlayTool,
  updateInventoryTool,
} from "./mutate-tools-overlay.js";

// ── Dock assignment ─────────────────────────────────────────
export {
  assignDockTool,
  updateDockTool,
  removeDockAssignmentTool,
} from "./mutate-tools-dock.js";
