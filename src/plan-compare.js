/**
 * Entry point for plan-compare.html - up to 4 cities, compared on how long a
 * building plan takes from submission to approval. Same 4-pick UI idiom as
 * tree-canopy.js (compare up to 4 entities via one shared <datalist>), just
 * for a single level (city) and a duration metric instead of canopy %. See
 * src/plan-data.js for where the underlying numbers come from.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchPlans, groupByCity, avgStageDurations, APPROVED_WHERE } from './plan-data.js';

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

const state = { picks: [null, null, null, null] };

let cityMap = new Map(); // city name -> groupByCity() bucket

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
}

function syncUrl() {
  const p = new URLSearchParams();
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
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
    el('pcStageSection').hidden = true;
    return;
  }
  section.hidden = false;

  const chartEntries = entries.map((e, i) => ({
    label: e.city, value: e.medianDays ?? 0, color: PICK_COLORS[i],
  }));
  renderHBarChart('pcChart', `חציון ימים, הגשה→אישור${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, 'ימים');
  renderCompareTable(entries);
  renderStageTable(entries);
}

/* ---------- CSV ---------- */

el('pcCsv').addEventListener('click', () => {
  const entries = state.picks.map((city) => (city ? cityMap.get(city) : null)).filter(Boolean);
  const fields = ['עיר', 'תכניות', 'עם_משך_זמן', 'חציון_ימים', 'ממוצע_ימים', 'מינימום_ימים', 'מקסימום_ימים'];
  const records = entries.map((e) => ({
    עיר: e.city, תכניות: e.count, עם_משך_זמן: e.withTimeline,
    חציון_ימים: e.medianDays ?? '', ממוצע_ימים: e.avgDays ?? '',
    מינימום_ימים: e.minDays ?? '', מקסימום_ימים: e.maxDays ?? '',
  }));
  const name = `plan_compare_${entries.map((e) => e.city).join('_')}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
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
    state.picks[i] = input.value.trim() || null;
    syncUrl();
    renderCompare();
    showPickConfirm(i, Boolean(state.picks[i] && cityMap.has(state.picks[i])));
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
});

/* ---------- load ---------- */

(async function init() {
  let plans;
  try {
    plans = await fetchPlans(APPROVED_WHERE, (n) => {
      el('pcLoading').textContent = `טוען תכניות מאושרות… ${num(n)} עד כה`;
    });
  } catch (err) {
    el('pcLoading').textContent = 'שגיאה בטעינת הנתונים מ-Xplan. נסו לרענן את הדף.';
    console.error(err);
    return;
  }
  el('pcLoading').textContent = `נטענו ${num(plans.length)} תכניות מאושרות.`;
  cityMap = new Map(groupByCity(plans).map((c) => [c.city, c]));

  readStateFromUrl();
  pickInputs.forEach((input, i) => { input.value = state.picks[i] || ''; });
  updateRoster('');
  renderCompare();
}());
