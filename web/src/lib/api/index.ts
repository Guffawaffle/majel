/**
 * API barrel — re-exports every domain API module.
 *
 * Usage:
 *   import { sendChat, fetchSessions } from "$lib/api";
 *
 * The core fetch wrapper and ApiError are also re-exported here
 * so callers don't need to import from api/fetch directly.
 */

export { ApiError, apiFetch, apiDelete, apiPatch, apiPost, apiPut, qs, pathEncode } from "./fetch.js";
export { getMe, postLogout } from "./auth.js";
export { checkHealth } from "./health.js";
export { sendChat, loadHistory, searchRecall } from "./chat.js";
export { fetchSessions, restoreSession, deleteSession } from "./sessions.js";
export { saveFleetSetting, loadFleetSettings, loadSetting } from "./settings.js";
export { fetchModels, selectModel } from "./models.js";
export {
  fetchCatalogOfficers,
  fetchCatalogShips,
  fetchCatalogCounts,
  setOfficerOverlay,
  setShipOverlay,
  bulkSetOfficerOverlay,
  bulkSetShipOverlay,
} from "./catalog.js";
export {
  // Bridge cores
  fetchBridgeCores,
  fetchBridgeCore,
  createBridgeCore,
  updateBridgeCore,
  deleteBridgeCore,
  setBridgeCoreMembers,
  // Below deck policies
  fetchBelowDeckPolicies,
  fetchBelowDeckPolicy,
  createBelowDeckPolicy,
  updateBelowDeckPolicy,
  deleteBelowDeckPolicy,
  // Crew loadouts
  fetchCrewLoadouts,
  fetchCrewLoadout,
  createCrewLoadout,
  updateCrewLoadout,
  deleteCrewLoadout,
  // Loadout variants
  fetchVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  resolveVariant,
  // Docks
  fetchCrewDocks,
  fetchCrewDock,
  upsertCrewDock,
  deleteCrewDock,
  // Fleet presets
  fetchFleetPresets,
  fetchFleetPreset,
  createFleetPreset,
  updateFleetPreset,
  deleteFleetPreset,
  setFleetPresetSlots,
  activateFleetPreset,
  // Plan items
  fetchCrewPlanItems,
  fetchCrewPlanItem,
  createCrewPlanItem,
  updateCrewPlanItem,
  deleteCrewPlanItem,
  // Officer reservations
  fetchReservations,
  setReservation,
  deleteReservation,
  // Effective state
  fetchEffectiveState,
} from "./crews.js";
export {
  adminListUsers,
  adminSetRole,
  adminSetLock,
  adminDeleteUser,
  adminListInvites,
  adminCreateInvite,
  adminRevokeInvite,
  adminListSessions,
  adminDeleteSession,
  adminDeleteAllSessions,
} from "./admiral.js";
export { fetchReceipts, fetchReceipt, undoReceipt, resolveReceiptItems } from "./receipts.js";
