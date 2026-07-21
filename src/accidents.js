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
import { CITY_ROWS, CITY_YEARS } from './city-stats.js';

initThemePicker(el('themePick'));

// When this page itself was built/published, distinct from "מחושב" (when the
// data was computed). document.lastModified is the file's Last-Modified - the
// GitHub Pages deploy time when served, the file's mtime when opened offline.
const built = new Date(document.lastModified);
if (!Number.isNaN(built.getTime())) {
  el('created').textContent = `נוצר: ${probedAt(document.lastModified)}`;
  el('created').title = built.toISOString();
}

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
 * CITY_ROWS (src/city-stats.js) packs each settlement flat to stay small;
 * unpack it here into the {fatal,severe,light,total} shape the tiles and the
 * table read, and sum the all-years figures once. Same dated snapshot as
 * YEAR_STATS - its per-city sums validate against the national totals above -
 * so it is dated by the very same apps[].computed_at, not a second live query.
 * SEMEL_YISHUV code -> { name, all-years total, per-year totals }.
 */
const CITY_STATS = {};
for (const [code, row] of Object.entries(CITY_ROWS)) {
  const years = {};
  const all = { fatal: 0, severe: 0, light: 0, total: 0 };
  CITY_YEARS.forEach((y, i) => {
    const fatal = row[1 + i * 3], severe = row[2 + i * 3], light = row[3 + i * 3];
    years[y] = { fatal, severe, light, total: fatal + severe + light };
    all.fatal += fatal; all.severe += severe; all.light += light;
    all.total += years[y].total;
  });
  CITY_STATS[code] = { name: row[0], all, years };
}

// Typed city name -> its code, for the autocomplete lookup. Settlement names
// are unique in the source list; a later duplicate would just win, harmlessly.
const CITY_BY_NAME = new Map(
  Object.entries(CITY_STATS).map(([code, c]) => [c.name, code]));

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
  const city = CITY_STATS[code];
  renderCityStats(city.all);
  renderCityTable(city);
}

// The panel before any city is chosen (and whenever the text isn't yet a whole
// city name): a prompt, not stale numbers from a previous pick.
function showCityPrompt() {
  el('cityStats').innerHTML = '';
  el('cityTable').innerHTML =
    '<p class="acc-hint">התחילו להקליד שם ישוב כדי לראות את הפירוט לפי שנה.</p>';
}

// A hand-rolled suggestion dropdown, not a native <datalist>: the latter's
// popup is drawn by the OS/browser itself and ignores the page's dir="rtl" -
// on Linux/GTK builds of Chrome it shows up left-anchored and LTR regardless
// of the surrounding page, which isn't fixable from CSS. Rendering our own
// <ul> keeps every pixel of it under our styling, RTL included.
const cityInput = el('cityInput');
const cityMenu = el('cityMenu');
// Most-accidents-first (Object insertion order = CITY_ROWS order), same order
// the datalist used to offer suggestions in.
const CITY_LIST = Object.entries(CITY_STATS).map(([code, c]) => ({ code, name: c.name }));
const CITY_MENU_MAX = 8;

let cityMatches = [];
let cityActive = -1;

function closeCityMenu() {
  cityMenu.hidden = true;
  cityMenu.innerHTML = '';
  cityMatches = [];
  cityActive = -1;
  cityInput.setAttribute('aria-expanded', 'false');
  cityInput.removeAttribute('aria-activedescendant');
}

function renderCityMenu() {
  cityMenu.innerHTML = cityMatches.map((c, i) => `
    <li role="option" id="cityopt-${i}" data-code="${c.code}"
        class="${i === cityActive ? 'active' : ''}">${esc(c.name)}</li>`).join('');
  cityMenu.hidden = false;
  cityInput.setAttribute('aria-expanded', 'true');
  if (cityActive >= 0) cityInput.setAttribute('aria-activedescendant', `cityopt-${cityActive}`);
  else cityInput.removeAttribute('aria-activedescendant');
}

function selectCity(code, name) {
  cityInput.value = name;
  renderCity(code);
  closeCityMenu();
}

// Empty by default; only an exact match to a known name resolves - a partial
// string shows the prompt rather than guessing a city.
function onCityInput() {
  const q = cityInput.value.trim();
  const code = CITY_BY_NAME.get(q);
  if (code) renderCity(code);
  else showCityPrompt();

  if (!q) { closeCityMenu(); return; }
  cityMatches = CITY_LIST.filter((c) => c.name.includes(q)).slice(0, CITY_MENU_MAX);
  cityActive = -1;
  if (cityMatches.length) renderCityMenu();
  else closeCityMenu();
}
showCityPrompt();
cityInput.addEventListener('input', onCityInput);

cityInput.addEventListener('keydown', (e) => {
  if (cityMenu.hidden) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cityActive = Math.min(cityActive + 1, cityMatches.length - 1);
    renderCityMenu();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cityActive = Math.max(cityActive - 1, 0);
    renderCityMenu();
  } else if (e.key === 'Enter' && cityActive >= 0) {
    e.preventDefault();
    const m = cityMatches[cityActive];
    selectCity(m.code, m.name);
  } else if (e.key === 'Escape') {
    closeCityMenu();
  }
});

// mousedown, not click: it fires before the input's blur, and preventDefault
// here stops that blur from happening at all, so the menu is still there for
// this same handler to read from when the tap/click lands.
cityMenu.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  selectCity(li.dataset.code, li.textContent);
});

cityInput.addEventListener('blur', closeCityMenu);

// Years oldest→newest in the DOM; on this RTL page the flow lays them out
// right→left, so time reads the same direction as the Hebrew around it -
// oldest (2020) on the right, newest (2024) on the left.
const CHART_YEARS = ['2020', '2021', '2022', '2023', '2024'];
const CHART_MAX_H = 150; // px height of the tallest bar; the rest scale to it

// Two single-series bar charts side by side, each its own hue (fatalities in
// the danger red of the "killed" tile, all accidents in the neutral accent) -
// one series apiece, so no legend, the caption names it. Bars share a zero
// baseline and are labelled directly, so each plot carries its own numbers.
// A picked year lights its bar in both and recedes the rest, echoing the
// dropdown; the two charts stay on the same y-scale is NOT wanted - each is
// keyed to its own peak, since killed and total counts differ by two orders.
function renderChart(figId, caption, unit, valueOf, year) {
  const peak = Math.max(...CHART_YEARS.map(valueOf));
  const bars = CHART_YEARS.map((y) => {
    const n = valueOf(y);
    const h = Math.round((n / peak) * CHART_MAX_H);
    const active = year !== 'all' && year === y ? ' active' : '';
    return `
      <div class="acc-bar${active}" title="${y}: ${num(n)} ${unit}">
        <div class="acc-bar-track">
          <span class="acc-bar-v">${num(n)}</span>
          <div class="acc-bar-fill" style="block-size:${h}px"></div>
        </div>
        <span class="acc-bar-y">${y}</span>
      </div>`;
  }).join('');
  const fig = el(figId);
  fig.setAttribute('aria-label',
    `${caption}, ${CHART_YEARS[0]}–${CHART_YEARS[CHART_YEARS.length - 1]}`);
  fig.innerHTML = `
    <figcaption>${caption}</figcaption>
    <div class="acc-bars">${bars}</div>`;
}

function renderCharts(year) {
  renderChart('accChartKilled', 'הרוגים לפי שנה', 'הרוגים',
    (y) => YEAR_STATS[y].fatal, year);
  renderChart('accChartTotal', 'מספר התאונות לפי שנה', 'תאונות',
    (y) => YEAR_STATS[y].total, year);
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

renderCharts('all');
renderStats('all');
el('accYear').addEventListener('change', (e) => {
  renderCharts(e.target.value);
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
