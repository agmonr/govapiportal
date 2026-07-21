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

/**
 * The same severity counts broken down by settlement, for the twelve cities
 * with the most accidents over 2020-2024. Computed from the identical snapshot
 * as YEAR_STATS (its per-city sums validate against the national totals above),
 * so it is dated by the very same apps[].computed_at - not a second live query.
 * SEMEL_YISHUV code -> { name, all-years total, per-year totals }.
 */
const CITY_STATS = {
  '5000': {
    name: 'תל אביב - יפו',
    all: { fatal: 82, severe: 960, light: 3905, total: 4947 },
    years: {
      2020: { fatal: 13, severe: 168, light: 1092, total: 1273 },
      2021: { fatal: 20, severe: 200, light: 1124, total: 1344 },
      2022: { fatal: 20, severe: 231, light: 852, total: 1103 },
      2023: { fatal: 16, severe: 176, light: 453, total: 645 },
      2024: { fatal: 13, severe: 185, light: 384, total: 582 },
    },
  },
  '3000': {
    name: 'ירושלים',
    all: { fatal: 71, severe: 880, light: 2854, total: 3805 },
    years: {
      2020: { fatal: 15, severe: 151, light: 669, total: 835 },
      2021: { fatal: 16, severe: 153, light: 640, total: 809 },
      2022: { fatal: 8, severe: 186, light: 597, total: 791 },
      2023: { fatal: 11, severe: 176, light: 578, total: 765 },
      2024: { fatal: 21, severe: 214, light: 370, total: 605 },
    },
  },
  '4000': {
    name: 'חיפה',
    all: { fatal: 37, severe: 366, light: 1738, total: 2141 },
    years: {
      2020: { fatal: 7, severe: 63, light: 306, total: 376 },
      2021: { fatal: 9, severe: 60, light: 355, total: 424 },
      2022: { fatal: 4, severe: 75, light: 406, total: 485 },
      2023: { fatal: 10, severe: 98, light: 323, total: 431 },
      2024: { fatal: 7, severe: 70, light: 348, total: 425 },
    },
  },
  '7900': {
    name: 'פתח תקווה',
    all: { fatal: 29, severe: 230, light: 1291, total: 1550 },
    years: {
      2020: { fatal: 3, severe: 43, light: 276, total: 322 },
      2021: { fatal: 4, severe: 48, light: 249, total: 301 },
      2022: { fatal: 8, severe: 41, light: 261, total: 310 },
      2023: { fatal: 5, severe: 45, light: 235, total: 285 },
      2024: { fatal: 9, severe: 53, light: 270, total: 332 },
    },
  },
  '7400': {
    name: 'נתניה',
    all: { fatal: 23, severe: 178, light: 1002, total: 1203 },
    years: {
      2020: { fatal: 9, severe: 32, light: 171, total: 212 },
      2021: { fatal: 4, severe: 44, light: 208, total: 256 },
      2022: { fatal: 2, severe: 30, light: 218, total: 250 },
      2023: { fatal: 6, severe: 37, light: 217, total: 260 },
      2024: { fatal: 2, severe: 35, light: 188, total: 225 },
    },
  },
  '6600': {
    name: 'חולון',
    all: { fatal: 19, severe: 194, light: 984, total: 1197 },
    years: {
      2020: { fatal: 4, severe: 35, light: 274, total: 313 },
      2021: { fatal: 5, severe: 28, light: 296, total: 329 },
      2022: { fatal: 4, severe: 46, light: 206, total: 256 },
      2023: { fatal: 3, severe: 44, light: 104, total: 151 },
      2024: { fatal: 3, severe: 41, light: 104, total: 148 },
    },
  },
  '70': {
    name: 'אשדוד',
    all: { fatal: 25, severe: 224, light: 809, total: 1058 },
    years: {
      2020: { fatal: 1, severe: 31, light: 177, total: 209 },
      2021: { fatal: 6, severe: 39, light: 173, total: 218 },
      2022: { fatal: 8, severe: 45, light: 157, total: 210 },
      2023: { fatal: 8, severe: 51, light: 145, total: 204 },
      2024: { fatal: 2, severe: 58, light: 157, total: 217 },
    },
  },
  '8600': {
    name: 'רמת גן',
    all: { fatal: 8, severe: 222, light: 813, total: 1043 },
    years: {
      2020: { fatal: 3, severe: 45, light: 249, total: 297 },
      2021: { fatal: 1, severe: 31, light: 231, total: 263 },
      2022: { fatal: 2, severe: 43, light: 173, total: 218 },
      2023: { fatal: 1, severe: 51, light: 91, total: 143 },
      2024: { fatal: 1, severe: 52, light: 69, total: 122 },
    },
  },
  '9000': {
    name: 'באר שבע',
    all: { fatal: 30, severe: 227, light: 765, total: 1022 },
    years: {
      2020: { fatal: 7, severe: 40, light: 170, total: 217 },
      2021: { fatal: 8, severe: 45, light: 187, total: 240 },
      2022: { fatal: 3, severe: 46, light: 122, total: 171 },
      2023: { fatal: 8, severe: 55, light: 124, total: 187 },
      2024: { fatal: 4, severe: 41, light: 162, total: 207 },
    },
  },
  '6200': {
    name: 'בת ים',
    all: { fatal: 16, severe: 135, light: 782, total: 933 },
    years: {
      2020: { fatal: 2, severe: 20, light: 215, total: 237 },
      2021: { fatal: 4, severe: 28, light: 202, total: 234 },
      2022: { fatal: 0, severe: 26, light: 168, total: 194 },
      2023: { fatal: 8, severe: 40, light: 101, total: 149 },
      2024: { fatal: 2, severe: 21, light: 96, total: 119 },
    },
  },
  '8300': {
    name: 'ראשון לציון',
    all: { fatal: 27, severe: 236, light: 504, total: 767 },
    years: {
      2020: { fatal: 7, severe: 37, light: 158, total: 202 },
      2021: { fatal: 2, severe: 51, light: 109, total: 162 },
      2022: { fatal: 9, severe: 52, light: 94, total: 155 },
      2023: { fatal: 5, severe: 45, light: 63, total: 113 },
      2024: { fatal: 4, severe: 51, light: 80, total: 135 },
    },
  },
  '6100': {
    name: 'בני ברק',
    all: { fatal: 12, severe: 147, light: 576, total: 735 },
    years: {
      2020: { fatal: 3, severe: 26, light: 163, total: 192 },
      2021: { fatal: 3, severe: 29, light: 171, total: 203 },
      2022: { fatal: 0, severe: 28, light: 133, total: 161 },
      2023: { fatal: 3, severe: 32, light: 70, total: 105 },
      2024: { fatal: 3, severe: 32, light: 39, total: 74 },
    },
  },
};

// Cities listed most-accidents-first, the order the dropdown shows them in.
const CITY_ORDER = ['5000', '3000', '4000', '7900', '7400', '6600',
  '70', '8600', '9000', '6200', '8300', '6100'];

// Newest year first: a table is read top-down, so the most recent row leads.
const CITY_TABLE_YEARS = ['2024', '2023', '2022', '2021', '2020'];

// A city's all-years totals as the same four tiles the national section uses,
// so "the total for this city" reads in the exact visual vocabulary above it.
function renderCityStats(s) {
  el('cityStats').innerHTML = `
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

// The per-year breakdown for one city, under its total tiles.
function renderCityTable(city) {
  const rows = CITY_TABLE_YEARS.map((y) => {
    const v = city.years[y];
    return `
      <tr>
        <th scope="row">${y}</th>
        <td>${num(v.fatal)}</td>
        <td>${num(v.severe)}</td>
        <td>${num(v.light)}</td>
        <td>${num(v.total)}</td>
      </tr>`;
  }).join('');
  el('cityTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            <th scope="col">הרוגים</th>
            <th scope="col">פצועים קשה</th>
            <th scope="col">פצועים קל</th>
            <th scope="col">סה"כ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderCity(code) {
  const city = CITY_STATS[code] || CITY_STATS[CITY_ORDER[0]];
  renderCityStats(city.all);
  renderCityTable(city);
}

// Fill the dropdown from the ranked list, then show the busiest city first.
const cityPick = el('cityPick');
cityPick.innerHTML = CITY_ORDER
  .map((c) => `<option value="${c}">${esc(CITY_STATS[c].name)}</option>`).join('');
renderCity(CITY_ORDER[0]);
cityPick.addEventListener('change', (e) => renderCity(e.target.value));

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
