/**
 * idb-cache.ts — IndexedDB cache engine for Majel.
 *
 * Provides a thin, typed key-value store backed by IndexedDB with:
 * - Per-user database isolation (majel-cache-{userId})
 * - TTL-based freshness tracking
 * - Pattern-based invalidation (prefix matching)
 * - Graceful fallback (all operations are safe to call if IDB unavailable)
 *
 * ADR-032: Local-First Data Cache
 */

// ─── Types ──────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  key: string;
  data: T;
  fetchedAt: number;
  maxAge: number;
}

interface CacheRecord {
  key: string;
  data: string;       // JSON-serialized
  fetchedAt: number;
  maxAge: number;
}

// ─── Constants ──────────────────────────────────────────────

const STORE_NAME = "cache";
const DB_VERSION = 1;

// ─── State ──────────────────────────────────────────────────

let db: IDBDatabase | null = null;
let dbName: string | null = null;

// ─── Lifecycle ──────────────────────────────────────────────

/**
 * Open (or create) the per-user cache database.
 * Call once after authentication resolves.
 */
export async function openCache(userId: string): Promise<void> {
  if (db && dbName === `majel-cache-${userId}`) return; // already open for this user
  closeCache();
  dbName = `majel-cache-${userId}`;
  try {
    db = await openDB(dbName);
  } catch {
    // IDB unavailable (private browsing, quota, etc.) — degrade gracefully
    db = null;
  }
}

/** Close the cache database. Call on logout. */
export function closeCache(): void {
  if (db) {
    db.close();
    db = null;
  }
  dbName = null;
}

/** Delete the entire cache database for the current user. */
export async function destroyCache(): Promise<void> {
  const name = dbName;
  closeCache();
  if (name) {
    try {
      await deleteDB(name);
    } catch {
      // Best-effort cleanup
    }
  }
}

// ─── Core Operations ────────────────────────────────────────

/**
 * Retrieve a cached entry by key.
 * Returns null if not found or IDB unavailable.
 */
export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | null> {
  if (!db) return null;
  try {
    const record = await txGet<CacheRecord>(db, STORE_NAME, key);
    if (!record) return null;
    return {
      key: record.key,
      data: JSON.parse(record.data) as T,
      fetchedAt: record.fetchedAt,
      maxAge: record.maxAge,
    };
  } catch {
    return null;
  }
}

/**
 * Store a value in the cache with a TTL (maxAge in ms).
 */
export async function cacheSet<T>(key: string, data: T, maxAge: number): Promise<void> {
  if (!db) return;
  const record: CacheRecord = {
    key,
    data: JSON.stringify(data),
    fetchedAt: Date.now(),
    maxAge,
  };
  try {
    await txPut(db, STORE_NAME, record);
  } catch {
    // Quota exceeded or other IDB error — silently ignore
  }
}

/**
 * Delete a single cache entry by exact key.
 */
export async function cacheDelete(key: string): Promise<void> {
  if (!db) return;
  try {
    await txDelete(db, STORE_NAME, key);
  } catch {
    // Best-effort
  }
}

/**
 * Invalidate all cache entries whose key starts with the given prefix.
 * If prefix ends with `*`, the `*` is stripped and used as a prefix match.
 * An exact key (no `*`) deletes only that one entry.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  if (!db) return;
  const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;
  if (!prefix) {
    await cacheDelete(pattern);
    return;
  }
  try {
    const keys = await txGetAllKeys(db, STORE_NAME);
    const toDelete = keys.filter((k) => typeof k === "string" && k.startsWith(prefix));
    if (toDelete.length > 0) {
      await txDeleteMulti(db, STORE_NAME, toDelete as string[]);
    }
  } catch {
    // Best-effort
  }
}

/**
 * Purge all entries older than maxAgeMs from the cache.
 * Call periodically (e.g., on app startup) for hygiene.
 */
export async function cachePurge(maxAgeMs: number): Promise<void> {
  if (!db) return;
  const cutoff = Date.now() - maxAgeMs;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        const record = cursor.value as CacheRecord;
        if (record.fetchedAt < cutoff) {
          cursor.delete();
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
      tx.oncomplete = () => resolve();
    });
  } catch {
    // Best-effort
  }
}

/**
 * Clear all entries from the cache (but keep the database).
 */
export async function cacheClear(): Promise<void> {
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await txComplete(tx);
  } catch {
    // Best-effort
  }
}

/** Check whether a CacheEntry is still fresh (within its maxAge). */
export function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < entry.maxAge;
}

/** Check whether the cache is currently connected. */
export function isCacheOpen(): boolean {
  return db !== null;
}

// ─── IndexedDB Helpers ──────────────────────────────────────

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function txGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function txPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txDeleteMulti(db: IDBDatabase, store: string, keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txGetAllKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
