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

// Years oldest→newest in the DOM; on this RTL page the flow lays them out
// right→left, so time reads the same direction as the Hebrew around it -
// oldest (2020) on the right, newest (2024) on the left.
const CHART_YEARS = ['2020', '2021', '2022', '2023', '2024'];
const CHART_MAX_H = 150; // px height of the tallest bar; the rest scale to it

// Single series (fatalities per year), so no legend - the caption names it -
// and one hue: the same danger red as the "killed" stat tile. Bars share a
// zero baseline and are labelled directly, so the plot carries its own numbers.
function renderChart(year) {
  const peak = Math.max(...CHART_YEARS.map((y) => YEAR_STATS[y].fatal));
  const bars = CHART_YEARS.map((y) => {
    const n = YEAR_STATS[y].fatal;
    const h = Math.round((n / peak) * CHART_MAX_H);
    const active = year !== 'all' && year === y ? ' active' : '';
    return `
      <div class="acc-bar${active}" title="${y}: ${num(n)} הרוגים">
        <div class="acc-bar-track">
          <span class="acc-bar-v">${num(n)}</span>
          <div class="acc-bar-fill" style="block-size:${h}px"></div>
        </div>
        <span class="acc-bar-y">${y}</span>
      </div>`;
  }).join('');
  const fig = el('accChart');
  fig.setAttribute('aria-label',
    'הרוגים בתאונות דרכים לפי שנה, ' + CHART_YEARS[0] + '–' +
    CHART_YEARS[CHART_YEARS.length - 1]);
  fig.innerHTML = `
    <figcaption>הרוגים לפי שנה</figcaption>
    <div class="acc-bars">${bars}</div>`;
}

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

renderChart('all');
renderStats('all');
el('accYear').addEventListener('change', (e) => {
  renderChart(e.target.value);
  renderStats(e.target.value);
});

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
