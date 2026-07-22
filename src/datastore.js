/**
 * Shared data.gov.il DataStore query wrapper, used by companies.js,
 * local-finance.js and welfare.js - each had its own near-identical copy
 * (companies.js took raw params; local-finance.js/welfare.js took a
 * `filters` object and JSON.stringified it themselves). `dsQuery` covers the
 * general case, `dsFilter` is the common-case convenience the latter two
 * actually used at every call site.
 *
 * Adds a 25s timeout (ckan.js's datagov.html explorer already had one; none
 * of the three copies here did) - without it, a hung request left "טוען…"
 * on screen indefinitely instead of eventually failing into showError().
 */

const DATASTORE = 'https://data.gov.il/api/3/action/datastore_search';

export async function dsQuery(resourceId, params = {}) {
  const p = new URLSearchParams({ resource_id: resourceId, ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(`${DATASTORE}?${p}`, { signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('הבקשה ל-data.gov.il ארכה זמן רב מדי (מעל 25 שניות).'), { kind: 'network' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'network' });
  const j = await res.json();
  if (!j.success) throw new Error(j.error?.message || j.error?.__type || 'שגיאת שרת');
  return j.result;
}

/** `filters` is a plain object (e.g. `{ שם_רשות: 'רעננה' }`, values may be
 *  arrays for CKAN's OR-match) - JSON-stringified here so every caller
 *  doesn't repeat that. */
export async function dsFilter(resourceId, filters, limit = 10000) {
  const params = { limit: String(limit) };
  if (filters) params.filters = JSON.stringify(filters);
  return dsQuery(resourceId, params);
}
