/**
 * Entry point for plan-timeline.html - how long a building plan (תוכנית)
 * takes from submission (הגשה) to approval (אישור), grouped by city, with a
 * drill-down into every plan's own step-by-step milestone timeline and a
 * detailed Excel export. See src/plan-data.js for the data model and why
 * this is computable from a single live Xplan query.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, saveXls } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchPlans, groupByCity, planTimeline, PLAN_STEPS, median } from './plan-data.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'plan-timeline')).catch(() => {});

/* ---------- state ---------- */

const state = {
  status: 'approved', // 'approved' | 'progress' | 'all'
  cityFilter: null,
  sortKey: 'medianDays',
  sortDir: 'desc',
  expandedCity: null,
  expandedPlan: null,
};

let allPlans = [];

/* ---------- helpers ---------- */

const fmtDate = (d) => (d ? d.toLocaleDateString('he-IL') : '—');

/** current-status badge for one plan: {cls, text} - `cls` matches the
 *  site-wide .badge.ok/warn/bad/limited/unknown vocabulary (see style.css). */
function statusBadge(plan, totalDays) {
  if (plan.station_desc === 'אישור') {
    return totalDays != null
      ? { cls: 'ok', text: `אושרה — ${num(totalDays)} ימים` }
      : { cls: 'limited', text: 'אושרה (חסרים תאריכים)' };
  }
  const rejecting = plan.station_desc === 'התכנית נדחתה' || plan.internet_short_status === 'התכנית נדחתה';
  if (rejecting) return { cls: 'bad', text: 'נדחתה' };
  return { cls: 'warn', text: plan.internet_short_status || plan.station_desc || 'לא ידוע' };
}

function filteredPlans() {
  let plans = allPlans;
  if (state.status === 'approved') plans = plans.filter((p) => p.station_desc === 'אישור');
  else if (state.status === 'progress') plans = plans.filter((p) => p.station_desc !== 'אישור');
  if (state.cityFilter) plans = plans.filter((p) => p.plan_county_name === state.cityFilter);
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

/* ---------- per-plan timeline (deepest drill-down) ---------- */

function renderPlanTimelineHtml(plan) {
  const { steps } = planTimeline(plan);
  if (!steps.length) return '<p class="acc-hint">אין אף תאריך ציר-זמן רשום לתכנית זו.</p>';
  const rows = steps.map((s) => `
    <tr>
      <td>${esc(s.label)}</td>
      <td>${fmtDate(s.date)}</td>
      <td>${s.daysSincePrev == null ? '—' : `${s.daysSincePrev >= 0 ? '+' : ''}${num(s.daysSincePrev)}`}</td>
    </tr>`).join('');
  return `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">שלב</th>
          <th scope="col">תאריך</th>
          <th scope="col">ימים מהשלב הקודם</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ---------- per-city plan list (middle drill-down) ---------- */

const PLANS_PER_CITY_CAP = 300;

function renderCityPlansHtml(cityBucket) {
  const withTotals = cityBucket.plans.map((p) => ({ plan: p, totalDays: planTimeline(p).totalDays }));
  withTotals.sort((a, b) => {
    if (a.totalDays == null && b.totalDays == null) return 0;
    if (a.totalDays == null) return 1;
    if (b.totalDays == null) return -1;
    return b.totalDays - a.totalDays;
  });
  const capped = withTotals.slice(0, PLANS_PER_CITY_CAP);
  const capNote = withTotals.length > capped.length
    ? `<p class="acc-hint">מוצגות ${num(capped.length)} מתוך ${num(withTotals.length)} - השתמשו בהורדת ה-Excel לקבלת הכול.</p>` : '';

  const rows = capped.map(({ plan, totalDays }, i) => {
    const badge = statusBadge(plan, totalDays);
    return `
    <tr class="has-detail" data-plan-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      <td dir="auto">${esc(plan.pl_name || plan.pl_number)}</td>
      <td dir="ltr">${esc(plan.pl_number || '')}</td>
      <td><span class="badge ${badge.cls}">${esc(badge.text)}</span></td>
      <td>${totalDays == null ? '—' : num(totalDays)}</td>
    </tr>
    <tr class="detail-row" data-detail="${i}" hidden>
      <td colspan="5">
        ${renderPlanTimelineHtml(plan)}
        ${plan.pl_url ? `<p class="acc-hint"><a href="${esc(plan.pl_url)}" target="_blank" rel="noopener">מסמכי התכנית במבא"ת ↗</a></p>` : ''}
      </td>
    </tr>`;
  }).join('');

  return `
    ${capNote}
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          <th scope="col">שם תכנית</th>
          <th scope="col">מספר תכנית</th>
          <th scope="col">סטטוס</th>
          <th scope="col">ימים (הגשה→אישור)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function bindExpandableRows(container, rowSelector, detailAttr, rowAttr) {
  container.querySelectorAll(rowSelector).forEach((tr) => {
    const toggle = () => {
      const target = container.querySelector(`[${detailAttr}="${tr.dataset[rowAttr]}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
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
      <td colspan="8">${expanded ? renderCityPlansHtml(c) : ''}</td>
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
    if (detailRow) bindExpandableRows(detailRow, 'tr.has-detail', 'data-detail', 'planRow');
  }
}

/* ---------- render-all ---------- */

function renderAll() {
  document.querySelectorAll('#ptStatusPick .tc-level-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === state.status);
  });
  const plans = filteredPlans();
  renderStats(plans);
  currentCities = groupByCity(plans);
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
      row[step.label] = date ? fmtDate(date) : '';
    }
    return row;
  });
  const name = `plan_timeline_${state.status}${state.cityFilter ? `_${state.cityFilter}` : ''}`.replace(/[\\/:*?"<>|]/g, '_');
  saveXls('תכניות', headers, records, `${name}.xls`);
});

el('ptCsvCities').addEventListener('click', () => {
  const fields = ['יישוב', 'תכניות', 'עם_משך_זמן', 'חציון_ימים', 'ממוצע_ימים', 'מינימום_ימים', 'מקסימום_ימים'];
  const records = sortCities(currentCities).map((c) => ({
    יישוב: c.city, תכניות: c.count, עם_משך_זמן: c.withTimeline,
    חציון_ימים: c.medianDays ?? '', ממוצע_ימים: c.avgDays ?? '',
    מינימום_ימים: c.minDays ?? '', מקסימום_ימים: c.maxDays ?? '',
  }));
  saveCsv(buildCsv(fields, records), `plan_timeline_by_city_${state.status}.csv`);
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

const cityFilterInput = el('ptCityFilter');
const commitCityFilter = debounce(() => {
  state.cityFilter = cityFilterInput.value.trim() || null;
  state.expandedCity = null;
  renderAll();
}, 200);
cityFilterInput.addEventListener('input', commitCityFilter);

/* ---------- load ---------- */

(async function init() {
  try {
    allPlans = await fetchPlans('1=1', (n) => {
      el('ptLoading').textContent = `טוען תכניות… ${num(n)} עד כה`;
    });
  } catch (err) {
    el('ptLoading').textContent = 'שגיאה בטעינת הנתונים מ-Xplan. נסו לרענן את הדף.';
    console.error(err);
    return;
  }
  el('ptLoading').textContent = `נטענו ${num(allPlans.length)} תכניות.`;
  updateCityRoster();
  renderAll();
}());
