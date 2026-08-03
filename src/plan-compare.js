/**
 * Entry point for plan-compare.html - up to 4 cities, compared on how long a
 * building plan takes from submission to approval. Same 4-pick UI idiom as
 * tree-canopy.js (compare up to 4 entities via one shared <datalist>), just
 * for a single level (city) and a duration metric instead of canopy %. See
 * src/plan-data.js for where the underlying numbers come from.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, bindExpandableRows } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderBarChart, renderHBarChart, citySwatchCell } from './charts.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchPlans, groupByCity, groupByYear, avgStageDurations, receivingYear, availableYears } from './plan-data.js';
import { renderPlanListHtml, planAreaColorScale } from './plan-render.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'plan-compare')).catch(() => {});

// Same gradient-of-one-color idiom as tree-canopy.js's PICK_COLORS - solid
// accent for pick #1, fainter tints for #2-4, rather than four unrelated hues.
const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];
const MAX_PICKS = 4;

const state = { picks: [null, null, null, null], year: null };

let allPlans = []; // every fetched plan, any status, unfiltered
let cityMap = new Map(); // city name -> groupByCity() bucket of APPROVED plans only, for the current state.year
let pendingCountByCity = new Map(); // city name -> count of not-yet-approved plans, for the current state.year

/** Recomputes cityMap/pendingCountByCity for the current state.year - called
 *  on load and whenever the year filter changes, never a refetch (allPlans
 *  already has everything; only the aggregation changes). cityMap stays
 *  approved-only (station_desc='אישור') so every existing duration figure
 *  on this page (median/avg days, stage breakdown, year breakdown) is
 *  unaffected by broadening the fetch to include pending plans too -
 *  pendingCountByCity is the only thing actually built from the rest. */
function rebuildCityMap() {
  const plans = state.year ? allPlans.filter((p) => receivingYear(p) === state.year) : allPlans;
  const approved = plans.filter((p) => p.station_desc === 'אישור');
  cityMap = new Map(groupByCity(approved).map((c) => [c.city, c]));

  pendingCountByCity = new Map();
  for (const p of plans) {
    if (p.station_desc === 'אישור') continue;
    const city = p.plan_county_name || 'לא ידוע';
    pendingCountByCity.set(city, (pendingCountByCity.get(city) || 0) + 1);
  }
}

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
  const y = Number(p.get('year'));
  if (y) state.year = y;
}

function syncUrl() {
  const p = new URLSearchParams();
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
  if (state.year) p.set('year', String(state.year));
  history.replaceState(null, '', `?${p}`);
}

function updateRoster(query) {
  const q = query.trim().toLowerCase();
  const all = [...cityMap.values()].filter((c) => c.withTimeline > 0);
  const matches = q ? all.filter((c) => c.city.toLowerCase().includes(q)) : all;
  const top = matches.sort((a, b) => b.withTimeline - a.withTimeline).slice(0, 40);
  el('pcRoster').innerHTML = top.map((c) => `<option value="${esc(c.city)}">`).join('');
  const withData = all.length;
  const total = cityMap.size;
  el('pcRosterHint').textContent = `${num(withData)} ישובים עם תכניות מאושרות ומשך זמן מחושב, מתוך ${num(total)} סה"כ`;
}

function renderCompareTable(entries) {
  const rows = entries.map((e, i) => `
    <tr>
      ${citySwatchCell(e.city, PICK_COLORS[i])}
      <td>${num(e.count)}</td>
      <td><span class="badge warn">${num(pendingCountByCity.get(e.city) || 0)}</span></td>
      <td>${num(e.withTimeline)}</td>
      <td>${e.medianDays == null ? '—' : num(e.medianDays)}</td>
      <td>${e.avgDays == null ? '—' : num(e.avgDays)}</td>
      <td>${e.minDays == null ? '—' : num(e.minDays)}</td>
      <td>${e.maxDays == null ? '—' : num(e.maxDays)}</td>
    </tr>`).join('');
  el('pcTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr>
          <th scope="col">עיר</th>
          <th scope="col">תכניות מאושרות</th>
          <th scope="col">תוכניות בתהליך</th>
          <th scope="col">עם משך זמן</th>
          <th scope="col">חציון ימים</th>
          <th scope="col">ממוצע ימים</th>
          <th scope="col">מינימום</th>
          <th scope="col">מקסימום</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Cross-city, one row per שנת הגשה (not per plan) - each picked city's FULL
// history via allPlans, ignoring the global "שנת הגשה" filter above for the
// same reason renderYearBreakdown does (a by-year breakdown needs more than
// one year to say anything). Only already-approved plans contribute a
// number for a given year (same as everywhere else on this page) - a year
// that's mostly still-open plans just shows "—" rather than a number that
// would otherwise mix finished and in-progress durations together.
// Table sort state for pcYearStatsTable - independent of the chart (a time
// series reads left-to-right chronologically regardless of how the table
// underneath happens to be sorted). Defaults to newest-first, per request.
let yearStatsSortDir = 'desc';

function renderYearStatsChart(entries, years, byYear) {
  // Always chronological (oldest -> newest), regardless of yearStatsSortDir -
  // a trend chart read right-to-left-reversed would be confusing even though
  // the table next to it is sorted the other way by default.
  const chronological = [...years].sort((a, b) => a - b);
  const peak = Math.max(1, ...chronological.flatMap((year) => byYear.map((m) => m.get(year)?.medianDays ?? 0)));
  const PLOT_PX = 150;
  const groups = chronological.map((year) => `
    <div class="fin-chart-group">
      <div class="fin-chart-bars-wrap" style="block-size:${PLOT_PX}px">
        <div class="fin-chart-bars">
          ${entries.map((e, i) => {
            const val = byYear[i].get(year)?.medianDays ?? 0;
            const h = Math.round((val / peak) * PLOT_PX);
            return `<div class="fin-chart-bar" style="block-size:${h}px;background:${PICK_COLORS[i]}" title="${esc(e.city)}, ${year}: ${val ? `${num(val)} ימים` : 'אין נתונים'}"></div>`;
          }).join('')}
        </div>
      </div>
      <span class="fin-chart-y">${year}</span>
    </div>`).join('');
  el('pcYearStatsChart').innerHTML = `
    <figcaption>חציון ימים, הגשה→אישור, לפי שנה</figcaption>
    <div class="acc-legend">
      ${entries.map((e, i) => `<span class="acc-legend-item"><span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>${esc(e.city)}</span>`).join('')}
    </div>
    <div class="fin-chart-body"><div class="fin-chart-plot">${groups}</div></div>`;
}

function renderYearStatsTable(entries, years, byYear) {
  const dir = yearStatsSortDir === 'asc' ? 1 : -1;
  const sortedYears = [...years].sort((a, b) => dir * (a - b));
  const rows = sortedYears.map((year) => `
    <tr>
      <td>${year}</td>
      ${entries.map((e, ci) => {
        const y = byYear[ci].get(year);
        return `<td>${y && y.medianDays != null ? `${num(y.medianDays)} <span class="acc-hint">(ממוצע ${num(y.avgDays)}, n=${num(y.withTimeline)})</span>` : '—'}</td>`;
      }).join('')}
    </tr>`).join('');
  const nextDir = yearStatsSortDir === 'asc' ? 'desc' : 'asc';
  el('pcYearStatsTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr>
          <th class="sortable sorted" data-sort-dir="${nextDir}" tabindex="0" role="button"
              aria-sort="${yearStatsSortDir === 'asc' ? 'ascending' : 'descending'}">
            שנת הגשה<span class="s-mark">${yearStatsSortDir === 'asc' ? '▲' : '▼'}</span>
          </th>
          ${entries.map((e, i) => `<th scope="col"><span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>${esc(e.city)}</th>`).join('')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const th = el('pcYearStatsTable').querySelector('th.sortable');
  const apply = () => {
    yearStatsSortDir = th.dataset.sortDir;
    renderYearStatsTable(entries, years, byYear);
  };
  th.addEventListener('click', apply);
  th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });
}

function renderYearStats(entries) {
  const section = el('pcYearStatsSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;
  const perCity = entries.map((e) => groupByYear(allPlans.filter((p) => p.plan_county_name === e.city)));
  const years = [...new Set(perCity.flatMap((rows) => rows.map((r) => r.year)))];
  const byYear = perCity.map((rows) => new Map(rows.map((r) => [r.year, r])));
  renderYearStatsChart(entries, years, byYear);
  renderYearStatsTable(entries, years, byYear);
}

function renderStageTable(entries) {
  const section = el('pcStageSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;
  const perCity = entries.map((e) => avgStageDurations(e.plans));
  const segments = perCity[0].map((seg, i) => ({ from: seg.from, to: seg.to, i }));
  const rows = segments.map((seg) => `
    <tr>
      <td dir="auto">${esc(seg.from)} ← ${esc(seg.to)}</td>
      ${entries.map((e, ci) => {
        const d = perCity[ci][seg.i];
        return `<td>${d.avgDays == null ? '—' : `${num(d.avgDays)} <span class="acc-hint">(n=${num(d.n)})</span>`}</td>`;
      }).join('')}
    </tr>`).join('');
  el('pcStageTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr>
          <th scope="col">קטע</th>
          ${entries.map((e, i) => `<th scope="col"><span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>${esc(e.city)}</th>`).join('')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Only meaningful for a single picked city (comparing several cities' own
// year-trends at once would be four overlapping timelines, not a compare
// table) - uses that city's FULL history from allPlans, ignoring the global
// "שנת הגשה" filter above (which would otherwise collapse this to one row),
// so the point of this section - a trend across years - still has years to
// show.
function renderYearBreakdown(entries) {
  const section = el('pcYearBreakdownSection');
  if (entries.length !== 1) { section.hidden = true; return; }
  const { city } = entries[0];
  const cityPlans = allPlans.filter((p) => p.plan_county_name === city);
  const byYear = groupByYear(cityPlans);
  if (!byYear.length) { section.hidden = true; return; }
  section.hidden = false;
  el('pcYearBreakdownCity').textContent = city;

  const chartEntries = byYear.map((y) => ({ label: String(y.year), value: y.medianDays ?? 0 }));
  renderBarChart('pcYearBreakdownChart', `חציון ימים לפי שנת הגשה — ${city}`, chartEntries, 'ימים');

  const rows = byYear.map((y) => `
    <tr>
      <td>${y.year}</td>
      <td>${num(y.count)}</td>
      <td>${num(y.withTimeline)}</td>
      <td>${y.medianDays == null ? '—' : num(y.medianDays)}</td>
      <td>${y.avgDays == null ? '—' : num(y.avgDays)}</td>
      <td>${y.minDays == null ? '—' : num(y.minDays)}</td>
      <td>${y.maxDays == null ? '—' : num(y.maxDays)}</td>
    </tr>`).join('');
  el('pcYearBreakdownTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr>
          <th scope="col">שנת הגשה</th>
          <th scope="col">תכניות</th>
          <th scope="col">עם משך זמן</th>
          <th scope="col">חציון ימים</th>
          <th scope="col">ממוצע ימים</th>
          <th scope="col">מינימום</th>
          <th scope="col">מקסימום</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Every picked city's own plans, sorted longest-duration-first (same order
// as plan-timeline.html's per-city list) - one sub-list per city, each
// independently expandable into its plan's step timeline. The area column's
// color scale is built from the POOL of all picked cities' plans together
// (planAreaColorScale), not per-city, so a big plan reads as big relative to
// everything currently on screen, not just its own city's other plans.
function renderPlansByCity(entries) {
  const section = el('pcPlansSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;
  const areaColor = planAreaColorScale(entries.flatMap((e) => e.plans));
  el('pcPlansByCity').innerHTML = entries.map((e, i) => `
    <h3 dir="auto"><span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span> ${esc(e.city)}</h3>
    <div class="pc-city-plans" data-city-idx="${i}">
      ${renderPlanListHtml(e.plans, { areaColor })}
    </div>`).join('');
  el('pcPlansByCity').querySelectorAll('.pc-city-plans').forEach((div) => {
    bindExpandableRows(div, 'tr.has-detail', 'data-detail', 'planRow');
  });
}

function renderCompare() {
  const resolved = state.picks.map((city) => (city ? cityMap.get(city) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('pcWarn');
  const missing = state.picks.filter((city, i) => city && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')}.`;

  const section = el('pcCompareSection');
  if (!entries.length) {
    section.hidden = true;
    el('pcYearStatsSection').hidden = true;
    el('pcStageSection').hidden = true;
    el('pcPlansSection').hidden = true;
    el('pcYearBreakdownSection').hidden = true;
    return;
  }
  section.hidden = false;

  const chartEntries = entries.map((e, i) => ({
    label: e.city, value: e.medianDays ?? 0, color: PICK_COLORS[i],
  }));
  renderHBarChart('pcChart', `חציון ימים, הגשה→אישור${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, 'ימים');
  renderCompareTable(entries);
  renderYearStats(entries);
  renderStageTable(entries);
  renderPlansByCity(entries);
  renderYearBreakdown(entries);
}

/* ---------- CSV ---------- */

el('pcCsv').addEventListener('click', () => {
  const entries = state.picks.map((city) => (city ? cityMap.get(city) : null)).filter(Boolean);
  const fields = ['עיר', 'תכניות_מאושרות', 'תוכניות_בתהליך', 'עם_משך_זמן', 'חציון_ימים', 'ממוצע_ימים', 'מינימום_ימים', 'מקסימום_ימים'];
  const records = entries.map((e) => ({
    עיר: e.city, תכניות_מאושרות: e.count, תוכניות_בתהליך: pendingCountByCity.get(e.city) || 0,
    עם_משך_זמן: e.withTimeline, חציון_ימים: e.medianDays ?? '', ממוצע_ימים: e.avgDays ?? '',
    מינימום_ימים: e.minDays ?? '', מקסימום_ימים: e.maxDays ?? '',
  }));
  const name = `plan_compare_${entries.map((e) => e.city).join('_')}${state.year ? `_${state.year}` : ''}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  saveCsv(buildCsv(fields, records), `${name || 'plan_compare'}.csv`);
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`pcPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

const pickConfirmTimers = [];
function showPickConfirm(i, ok) {
  const confirmEl = el(`pcPickConfirm${i}`);
  clearTimeout(pickConfirmTimers[i]);
  confirmEl.classList.remove('tc-pick-confirm-show');
  if (!ok) return;
  confirmEl.textContent = '✓ נטען';
  void confirmEl.offsetWidth;
  confirmEl.classList.add('tc-pick-confirm-show');
  pickConfirmTimers[i] = setTimeout(() => confirmEl.classList.remove('tc-pick-confirm-show'), 1500);
}

pickInputs.forEach((input, i) => {
  el(`pcPickLabel${i}`).textContent = i === 0 ? 'עיר:' : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
  input.addEventListener('input', debounce(() => updateRoster(input.value), 120));
  const commit = () => {
    const next = input.value.trim() || null;
    // A 'change' event also fires on plain blur with no edit - e.g. clicking
    // into an expanded plan row below re-renders that same section right
    // back to collapsed, since renderCompare() rebuilds it from scratch.
    // Skipping a no-op commit keeps focus loss from clobbering state the
    // user never actually asked to change.
    if (next === state.picks[i]) return;
    state.picks[i] = next;
    syncUrl();
    renderCompare();
    showPickConfirm(i, Boolean(state.picks[i] && cityMap.has(state.picks[i])));
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
});

el('pcYearFilter').addEventListener('change', (e) => {
  state.year = e.target.value ? Number(e.target.value) : null;
  syncUrl();
  rebuildCityMap();
  updateRoster('');
  renderCompare();
});

/* ---------- load ---------- */

(async function init() {
  try {
    // Every plan regardless of status - needed for the "תוכניות בתהליך"
    // (not yet approved) count per city; cityMap itself stays approved-only
    // (see rebuildCityMap()), so every duration figure is unaffected. Same
    // '1=1' query plan-timeline.html already uses, so the IndexedDB cache
    // (see src/idb-cache.js) is shared between the two pages, and persists
    // across reloads/tabs, not just within one.
    allPlans = await fetchPlans('1=1', (n) => {
      el('pcLoading').textContent = `טוען תכניות… ${num(n)} עד כה`;
    });
  } catch (err) {
    el('pcLoading').textContent = 'שגיאה בטעינת הנתונים מ-Xplan. נסו לרענן את הדף.';
    console.error(err);
    return;
  }
  el('pcLoading').textContent = `נטענו ${num(allPlans.length)} תכניות.`;

  readStateFromUrl();
  const years = availableYears(allPlans);
  el('pcYearFilter').innerHTML = '<option value="">כל השנים</option>'
    + years.map((y) => `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`).join('');
  rebuildCityMap();

  pickInputs.forEach((input, i) => { input.value = state.picks[i] || ''; });
  updateRoster('');
  renderCompare();
}());
