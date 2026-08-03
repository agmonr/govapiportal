/**
 * A tiny async key-value cache backed by IndexedDB - used where a cached
 * value needs to survive page reloads and new tabs, not just the current
 * one. sessionStorage is per-tab (gone the moment it closes) and neither it
 * nor localStorage has the headroom for what this actually caches: the
 * plan-timeline/plan-compare Xplan datasets run ~15-20MB of JSON each, well
 * past the ~5-10MB-per-origin cap both of those typically hit (Safari lower
 * still). IndexedDB's quota is a different order of magnitude, tied to
 * available disk space rather than a fixed per-origin number.
 *
 * Entries expire after `maxAgeMs` (checked against a stored timestamp on
 * read, not on write) - the underlying government data changes daily, so an
 * indefinitely-stale cache would eventually serve data nobody asked for. A
 * get() past that age behaves as a plain cache miss, not as an error.
 */

const DB_NAME = 'govapiportal-cache';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** `undefined` for a miss, an expired entry, or any IndexedDB failure
 *  (disabled, private-mode quirks, etc.) - callers already treat "no cached
 *  value" as the trigger to fetch, so a failure degrades to that instead of
 *  throwing. */
export async function idbGet(key, maxAgeMs) {
  try {
    const db = await openDb();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!entry) return undefined;
    if (maxAgeMs != null && Date.now() - entry.storedAt > maxAgeMs) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

/** Silently no-ops on failure (quota exceeded, private mode, etc.) - same
 *  tolerance the old sessionStorage try/catch had; a cache write is a
 *  best-effort optimization, never something a caller should have to
 *  handle failing. */
export async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ value, storedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* not cached - the caller still has the value it just computed */
  }
}
