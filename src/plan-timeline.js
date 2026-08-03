/**
 * Entry point for plan-timeline.html - how long a building plan (תוכנית)
 * takes from submission (הגשה) to approval (אישור), grouped by city, with a
 * drill-down into every plan's own step-by-step milestone timeline and a
 * detailed Excel export. See src/plan-data.js for the data model and why
 * this is computable from a single live Xplan query.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, saveXls, bindExpandableRows } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchPlans, groupByCity, planTimeline, PLAN_STEPS, median, receivingYear, availableYears } from './plan-data.js';
import { renderPlanListHtml, planAreaColorScale } from './plan-render.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'plan-timeline')).catch(() => {});

/* ---------- state ---------- */

const state = {
  status: 'approved', // 'approved' | 'progress' | 'all'
  cityFilter: null,
  nameFilter: null, // free-text, matched as a substring against pl_name
  yearFilter: null, // year the plan was first submitted (receiving_date) - null = every year
  minPlans: 50, // hide cities with fewer plans than this - the ~1,000-city list is mostly small localities with 1-2 plans, whose duration numbers are single-digit-sample noise; a large city is the interesting comparison on first load, not the tail
  sortKey: 'medianDays',
  sortDir: 'desc',
  expandedCity: null,
  expandedPlan: null,
  planListSortKey: 'days', // sort within an expanded city's own plan list (ימים by default) - see renderPlanListHtml
  planListSortDir: 'desc',
};

let allPlans = [];

/* ---------- URL linkability (city only - see plan-compare.js's per-city
   links, which point here via ?city=) ---------- */

function readCityFromUrl() {
  const city = new URLSearchParams(location.search).get('city');
  if (city) state.cityFilter = city;
}

function syncCityUrl() {
  const p = new URLSearchParams(location.search);
  if (state.cityFilter) p.set('city', state.cityFilter);
  else p.delete('city');
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/* ---------- helpers ---------- */

const fmtExportDate = (d) => (d ? d.toLocaleDateString('he-IL') : '—');

function filteredPlans() {
  let plans = allPlans;
  if (state.status === 'approved') plans = plans.filter((p) => p.station_desc === 'אישור');
  else if (state.status === 'progress') plans = plans.filter((p) => p.station_desc !== 'אישור');
  if (state.cityFilter) plans = plans.filter((p) => p.plan_county_name === state.cityFilter);
  if (state.yearFilter) plans = plans.filter((p) => receivingYear(p) === state.yearFilter);
  if (state.nameFilter) plans = plans.filter((p) => (p.pl_name || '').toLowerCase().includes(state.nameFilter));
  return plans;
}

/* ---------- summary stats ---------- */

function renderStats(plans) {
  const days = plans.map((p) => planTimeline(p).totalDays).filter((d) => d != null && d >= 0).sort((a, b) => a - b);
  el('ptStats').innerHTML = `
    <div class="stat">
      <span class="stat-n">${num(plans.length)}</span>
      <span class="stat-l">תכניות בתצוגה הנוכחית</span>
    </div>
    <div class="stat">
      <span class="stat-n">${plans.length ? Math.round((days.length / plans.length) * 100) : 0}%</span>
      <span class="stat-l">עם משך זמן מלא (הגשה+אישור)</span>
    </div>
    <div class="stat">
      <span class="stat-n">${days.length ? num(Math.round(median(days))) : '—'}</span>
      <span class="stat-l">חציון ימים, הגשה→אישור</span>
    </div>`;
}

/* ---------- city roster (datalist) ---------- */

function updateCityRoster() {
  const cities = [...new Set(allPlans.map((p) => p.plan_county_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  el('ptCityRoster').innerHTML = cities.map((c) => `<option value="${esc(c)}">`).join('');
}

function populateYearFilter() {
  const years = availableYears(allPlans);
  el('ptYearFilter').innerHTML = '<option value="">כל השנים</option>'
    + years.map((y) => `<option value="${y}">${y}</option>`).join('');
}

/* ---------- city aggregate table (top level) ---------- */

const SORT_COLUMNS = [
  { key: 'city', label: 'יישוב' },
  { key: 'count', label: 'תכניות' },
  { key: 'withTimeline', label: 'עם משך זמן' },
  { key: 'medianDays', label: 'חציון ימים' },
  { key: 'avgDays', label: 'ממוצע ימים' },
  { key: 'minDays', label: 'מינימום' },
  { key: 'maxDays', label: 'מקסימום' },
];

function sortCities(cities) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...cities].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls always last, regardless of direction
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv, 'he');
    return dir * (av - bv);
  });
}

let currentCities = [];

function renderCityTable() {
  const sorted = sortCities(currentCities);
  const head = SORT_COLUMNS.map((col) => {
    const active = state.sortKey === col.key;
    const nextDir = active && state.sortDir === 'asc' ? 'desc' : 'asc';
    return `<th class="sortable${active ? ' sorted' : ''}" data-sort-key="${col.key}" data-sort-dir="${nextDir}"
                tabindex="0" role="button"
                aria-sort="${active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      ${esc(col.label)}<span class="s-mark">${active ? (state.sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>`;
  }).join('');

  const rows = sorted.map((c) => {
    const expanded = state.expandedCity === c.city;
    return `
    <tr class="has-files" data-city="${esc(c.city)}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">${expanded ? '▴' : '▾'}</span></td>
      <td dir="auto">${esc(c.city)}</td>
      <td>${num(c.count)}</td>
      <td>${num(c.withTimeline)}</td>
      <td>${c.medianDays == null ? '—' : num(c.medianDays)}</td>
      <td>${c.avgDays == null ? '—' : num(c.avgDays)}</td>
      <td>${c.minDays == null ? '—' : num(c.minDays)}</td>
      <td>${c.maxDays == null ? '—' : num(c.maxDays)}</td>
    </tr>
    <tr class="files-row" data-city-detail="${esc(c.city)}" ${expanded ? '' : 'hidden'}>
      <td colspan="8">${expanded ? renderPlanListHtml(c.plans, { areaColor: planAreaColorScale(c.plans), sortKey: state.planListSortKey, sortDir: state.planListSortDir }) : ''}</td>
    </tr>`;
  }).join('');

  el('ptCityTable').innerHTML = !sorted.length ? '<p class="acc-hint">אין תכניות התואמות לסינון הנוכחי.</p>' : `
    <div class="matrix-wrap scroll">
      <table class="matrix">
        <thead><tr><th class="c-x"></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const table = el('ptCityTable');
  table.querySelectorAll('th.sortable').forEach((th) => {
    const apply = () => {
      state.sortKey = th.dataset.sortKey;
      state.sortDir = th.dataset.sortDir;
      renderCityTable();
    };
    th.addEventListener('click', apply);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });
  });

  table.querySelectorAll('tr.has-files').forEach((tr) => {
    tr.addEventListener('click', () => {
      const { city } = tr.dataset;
      state.expandedCity = state.expandedCity === city ? null : city;
      renderCityTable();
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      tr.click();
    });
  });

  if (state.expandedCity) {
    const detailRow = table.querySelector(`[data-city-detail="${state.expandedCity}"]`);
    if (detailRow) {
      bindExpandableRows(detailRow, 'tr.has-detail', 'data-detail', 'planRow');
      detailRow.querySelectorAll('th.sortable').forEach((th) => {
        const apply = () => {
          state.planListSortKey = th.dataset.sortKey;
          state.planListSortDir = th.dataset.sortDir;
          renderCityTable();
        };
        th.addEventListener('click', apply);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });
      });
    }
  }
}

/* ---------- render-all ---------- */

function renderAll() {
  document.querySelectorAll('#ptStatusPick .tc-level-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === state.status);
  });
  const plans = filteredPlans();
  renderStats(plans);
  const allCities = groupByCity(plans);
  currentCities = allCities.filter((c) => c.count >= state.minPlans);
  const hint = el('ptMinPlansHint');
  hint.textContent = allCities.length > currentCities.length
    ? `מוצגים ${num(currentCities.length)} יישובים עם ${num(state.minPlans)} תכניות ומעלה (מתוך ${num(allCities.length)} סה"כ).`
    : '';
  renderCityTable();
}

/* ---------- exports ---------- */

el('ptXlsAll').addEventListener('click', () => {
  const plans = filteredPlans();
  const headers = [
    'מספר תכנית', 'שם תכנית', 'יישוב', 'ועדה', 'מרחב תכנון', 'שטח (דונם)',
    'סטטוס נוכחי (station_desc)', 'סטטוס מפורט (internet_short_status)',
    ...PLAN_STEPS.map((s) => s.label),
    'משך זמן כולל (ימים, הגשה→אישור)', 'קישור לתכנית',
  ];
  const records = plans.map((p) => {
    const { steps, totalDays } = planTimeline(p);
    const byField = new Map(steps.map((s) => [s.field, s.date]));
    const row = {
      'מספר תכנית': p.pl_number || '',
      'שם תכנית': p.pl_name || '',
      יישוב: p.plan_county_name || '',
      ועדה: p.ja_concat || '',
      'מרחב תכנון': p.plan_area_name || '',
      'שטח (דונם)': p.pl_area_dunam ?? '',
      'סטטוס נוכחי (station_desc)': p.station_desc || '',
      'סטטוס מפורט (internet_short_status)': p.internet_short_status || '',
      'משך זמן כולל (ימים, הגשה→אישור)': totalDays ?? '',
      'קישור לתכנית': p.pl_url ? { href: p.pl_url, text: 'פתח תכנית' } : '',
    };
    for (const step of PLAN_STEPS) {
      const date = byField.get(step.field);
      row[step.label] = date ? fmtExportDate(date) : '';
    }
    return row;
  });
  const name = `plan_timeline_${state.status}${state.cityFilter ? `_${state.cityFilter}` : ''}${state.yearFilter ? `_${state.yearFilter}` : ''}`.replace(/[\\/:*?"<>|]/g, '_');
  saveXls('תכניות', headers, records, `${name}.xls`);
});

el('ptCsvCities').addEventListener('click', () => {
  const fields = ['יישוב', 'תכניות', 'עם_משך_זמן', 'חציון_ימים', 'ממוצע_ימים', 'מינימום_ימים', 'מקסימום_ימים'];
  const records = sortCities(currentCities).map((c) => ({
    יישוב: c.city, תכניות: c.count, עם_משך_זמן: c.withTimeline,
    חציון_ימים: c.medianDays ?? '', ממוצע_ימים: c.avgDays ?? '',
    מינימום_ימים: c.minDays ?? '', מקסימום_ימים: c.maxDays ?? '',
  }));
  saveCsv(buildCsv(fields, records), `plan_timeline_by_city_${state.status}${state.yearFilter ? `_${state.yearFilter}` : ''}.csv`);
});

/* ---------- wiring ---------- */

document.querySelectorAll('#ptStatusPick .tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.status === btn.dataset.status) return;
    state.status = btn.dataset.status;
    state.expandedCity = null;
    renderAll();
  });
});

const nameFilterInput = el('ptNameFilter');
const commitNameFilter = debounce(() => {
  state.nameFilter = nameFilterInput.value.trim().toLowerCase() || null;
  state.expandedCity = null;
  renderAll();
}, 250);
nameFilterInput.addEventListener('input', commitNameFilter);

const cityFilterInput = el('ptCityFilter');
const commitCityFilter = debounce(() => {
  state.cityFilter = cityFilterInput.value.trim() || null;
  state.expandedCity = null;
  syncCityUrl();
  renderAll();
}, 200);
cityFilterInput.addEventListener('input', commitCityFilter);

el('ptYearFilter').addEventListener('change', (e) => {
  state.yearFilter = e.target.value ? Number(e.target.value) : null;
  state.expandedCity = null;
  renderAll();
});

const minPlansInput = el('ptMinPlans');
const commitMinPlans = debounce(() => {
  state.minPlans = Math.max(0, Number(minPlansInput.value) || 0);
  state.expandedCity = null;
  renderAll();
}, 300);
minPlansInput.addEventListener('input', commitMinPlans);

/* ---------- load ---------- */

(async function init() {
  try {
    allPlans = await fetchPlans('1=1', (n) => {
      el('ptLoading').textContent = `טוען תכניות… ${num(n)} עד כה`;
    });
  } catch (err) {
    el('ptLoading').classList.replace('plan-loading', 'notice');
    el('ptLoading').classList.add('error');
    el('ptLoading').textContent = 'שגיאה בטעינת הנתונים מ-Xplan. נסו לרענן את הדף.';
    console.error(err);
    return;
  }
  el('ptLoading').classList.replace('plan-loading', 'acc-hint');
  el('ptLoading').textContent = `נטענו ${num(allPlans.length)} תכניות.`;
  updateCityRoster();
  populateYearFilter();
  readCityFromUrl();
  cityFilterInput.value = state.cityFilter || '';
  renderAll();
}());
