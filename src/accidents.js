/**
 * Entry point for accidents.html.
 *
 * This app has its own page rather than a slot in the map's portal grid: it
 * isn't a government API in itself (the underlying API is data.gov.il's, and
 * is catalogued under that portal on the map) - it's a thing built on top of
 * one. openPortal() is reused as-is from portal.js in standalone mode, so
 * the live table, search-by-city and CSV download are exactly the same code
 * already exercised on the map, just given a page of its own.
 */

import { el, esc, num, probedAt } from './ui.js';
import { openPortal } from './portal.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

/**
 * Severity counts by year, computed once against the live DataStore (all
 * 49,941 records across the five per-year resources, paginated past the
 * API's 10,000-row page cap) rather than recalculated in-browser on every
 * visit - the same "snapshot fact, dated" pattern as the about/notes text
 * elsewhere in apis.json. See apps[].computed_at for when.
 */
const YEAR_STATS = {
  all:  { fatal: 1684, severe: 11253, light: 37004, total: 49941 },
  2024: { fatal: 405, severe: 2452, light: 5458, total: 8315 },
  2023: { fatal: 338, severe: 2374, light: 6120, total: 8832 },
  2022: { fatal: 319, severe: 2320, light: 7765, total: 10404 },
  2021: { fatal: 336, severe: 2208, light: 9010, total: 11554 },
  2020: { fatal: 286, severe: 1899, light: 8651, total: 10836 },
};

function renderStats(year) {
  const s = YEAR_STATS[year] || YEAR_STATS.all;
  el('accStats').innerHTML = `
    <div class="stat bad">
      <span class="stat-n">${num(s.fatal)}</span>
      <span class="stat-l">הרוגים (תאונות קטלניות)</span>
    </div>
    <div class="stat warn">
      <span class="stat-n">${num(s.severe)}</span>
      <span class="stat-l">פצועים קשה</span>
    </div>
    <div class="stat ok">
      <span class="stat-n">${num(s.light)}</span>
      <span class="stat-l">פצועים קל</span>
    </div>
    <div class="stat">
      <span class="stat-n">${num(s.total)}</span>
      <span class="stat-l">סה"כ תאונות עם נפגעים</span>
    </div>`;
}

renderStats('all');
el('accYear').addEventListener('change', (e) => renderStats(e.target.value));

async function load() {
  const mount = el('accidents');
  try {
    const data = globalThis.__API_DATA__ || await (async () => {
      const res = await fetch(new URL('../apis.json', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })();
    const app = data.apps.find((a) => a.id === 'accidents');
    if (!app) throw new Error('accidents app entry not found in apis.json');
    if (app.computed_at) {
      el('computed').textContent = `מחושב: ${probedAt(app.computed_at)}`;
      el('computed').title = app.computed_at;
    }
    await openPortal(mount, app, { standalone: true });
  } catch (err) {
    mount.innerHTML = `<div class="notice error">טעינת הנתונים נכשלה: ${esc(err.message)}</div>`;
  }
}

load();
