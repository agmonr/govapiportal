/**
 * IndexedDB-backed store of every completed trip - "previous rides" the
 * visitor can come back to, view, re-export as PDF, or delete. Separate
 * from STORAGE_LAST_COMPLETE (a single-slot localStorage entry
 * trip-report.js already kept for "show the trip I just finished even
 * after a reload"): that one entry is fine for the most recent trip, but a
 * real history needs many, and a single 8-hour trip's own point array can
 * already approach localStorage's ~5-10MB quota on its own - a history of
 * several trips would blow past it fast. IndexedDB has no such practical
 * ceiling for this size of data.
 */

const DB_NAME = 'tripReportHistory';
const STORE = 'trips';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'tripId' }).createIndex('startTime', 'startTime');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTripToHistory(trip) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(trip);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Newest first - that's the order anyone browsing "previous rides" wants. */
export async function listTripHistory() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startTime - a.startTime));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTripFromHistory(tripId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(tripId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
