/**
 * api/index.js — Barrel Re-export (Migration Shim)
 *
 * @module  api/index
 * @layer   api-client
 * @domain  core
 * @depends api/*
 *
 * ⚠️  MIGRATION ONLY — Do not add new imports from this barrel.
 * Views should import directly from domain modules:
 *   import { fetchBridgeCores } from './api/crews.js';
 * NOT:
 *   import { fetchDocks } from './api/index.js';
 *
 * This barrel exists solely so the old `import * as api from './api.js'`
 * pattern continues to work during the migration window.
 * It will be deleted once all consumers use direct imports (Phase 1 complete).
 *
 * No-bundler note: each re-export is a separate HTTP request in development.
 * This fan-out cost is acceptable during migration but is the reason
 * barrels are banned in production code (ADR-023 §Barrel Convention).
 */

export { _fetch, apiFetch, ApiError } from './_fetch.js';
export { getMe } from './auth.js';
export { checkHealth } from './health.js';
export { sendChat, loadHistory, searchRecall } from './chat.js';
export { fetchSessions, getCachedSessions, restoreSession, deleteSession } from './sessions.js';
export { saveFleetSetting, loadFleetSettings } from './settings.js';
export {
    fetchCatalogOfficers, fetchCatalogShips,
    fetchCatalogCounts, setOfficerOverlay, setShipOverlay,
    bulkSetOfficerOverlay, bulkSetShipOverlay,
    fetchShips, fetchOfficers,
} from './catalog.js';
export {
    adminListUsers, adminSetRole, adminSetLock, adminDeleteUser,
    adminListInvites, adminCreateInvite, adminRevokeInvite,
    adminListSessions, adminDeleteSession, adminDeleteAllSessions,
} from './admiral.js';
