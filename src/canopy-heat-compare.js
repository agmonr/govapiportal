/**
 * Entry point for canopy-heat-compare.html - מידע איזורי על עצים וחום.
 *
 * No new data source: reuses tree-canopy.html's own three canopy-%
 * tables (CITY_CANOPY/NEIGHBORHOOD_CANOPY/STREET_CANOPY) and heat-
 * islands.html's own three heat-delta tables (CITY_HEAT/NEIGHBORHOOD_HEAT/
 * STREET_HEAT) as-is - see those pages' own src/ files (and
 * tools/canopy_build.py/tools/heat_build.py) for how each is actually
 * computed. This page's only job is showing both together, up to 4
 * entities at a time, the same "pick up to 4, compare" UX tree-canopy.js
 * already established (state shape, URL round-trip via level/p1..p4/city,
 * roster/datalist search) - copied here rather than imported, matching
 * how canopy-split.js already duplicates that same skeleton rather than
 * sharing a module for it.
 *
 * Each level's entries() UNIONS canopy and heat by key rather than
 * intersecting them - an entity present in one table but not the other
 * (a data gap in either underlying source) still shows up here, with the
 * missing metric's own chart/table cell simply showing no bar/a dash,
 * instead of the entity silently disappearing from the pick list entirely.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { CITY_CANOPY } from './tree-canopy-cities.js';
import { NEIGHBORHOOD_CANOPY } from './tree-canopy-neighborhoods.js';
import { STREET_CANOPY } from './tree-canopy-streets.js';
import { CITY_HEAT } from './heat-cities.js';
import { NEIGHBORHOOD_HEAT } from './heat-neighborhoods.js';
import { STREET_HEAT } from './heat-streets.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'canopy-heat-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- levels: one shape, two merged sources ----------
   Key format and label conventions match tree-canopy.js's/heat-islands.js's
   own exactly (city name for city level, "city::name" for neighborhood/
   street), which is what makes a plain key union safe - both sides already
   agree on what a given entity's key/label look like. */

function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}
function streetLabel(city, name, nb) {
  return `${name}, ${city}${nb ? ` (${nb})` : ''}`;
}

const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:',
    entries: () => {
      const keys = new Set([...Object.keys(CITY_CANOPY), ...Object.keys(CITY_HEAT)]);
      return [...keys].map((name) => ({
        key: name, label: name, name, city: name,
        canopyPct: CITY_CANOPY[name]?.pct ?? null,
        heatMaxC: CITY_HEAT[name]?.maxC ?? null,
      }));
    },
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:',
    entries: () => {
      const keys = new Set([...Object.keys(NEIGHBORHOOD_CANOPY), ...Object.keys(NEIGHBORHOOD_HEAT)]);
      return [...keys].map((key) => {
        const [city, name] = key.split('::');
        return {
          key, label: neighborhoodLabel(city, name), name, city,
          canopyPct: NEIGHBORHOOD_CANOPY[key]?.pct ?? null,
          heatMaxC: NEIGHBORHOOD_HEAT[key]?.maxC ?? null,
        };
      });
    },
  },
  street: {
    label: 'רחוב', labelPlural: 'רחובות', pickLabel: 'רחוב:',
    entries: () => {
      const keys = new Set([...Object.keys(STREET_CANOPY), ...Object.keys(STREET_HEAT)]);
      return [...keys].map((key) => {
        const [city, name] = key.split('::');
        const nb = STREET_CANOPY[key]?.nb || STREET_HEAT[key]?.nb;
        return {
          key, label: streetLabel(city, name, nb), name, city,
          canopyPct: STREET_CANOPY[key]?.pct ?? null,
          heatMaxC: STREET_HEAT[key]?.maxC ?? null,
        };
      });
    },
  },
};

// Built once per level on first use - same lazy-cache idiom as tree-
// canopy.js's own entriesCache/labelMapCache, for the same reason (a
// street level's ~36k rows are cheap to hold, not cheap to re-derive from
// two source objects on every keystroke).
const entriesCache = {};
const labelMapCache = {};
function levelEntries(level) {
  if (!entriesCache[level]) entriesCache[level] = LEVELS[level].entries();
  return entriesCache[level];
}
function labelMap(level) {
  if (!labelMapCache[level]) {
    const map = new Map();
    for (const e of levelEntries(level)) map.set(e.label, e);
    labelMapCache[level] = map;
  }
  return labelMapCache[level];
}

const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];
const MAX_PICKS = 4;

/* ---------- state + URL ---------- */

const state = { level: 'city', picks: [null, null, null, null], cityFilter: null };

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (LEVELS[p.get('level')]) state.level = p.get('level');
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
  if (p.get('city')) state.cityFilter = p.get('city');
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  history.replaceState(null, '', `?${p}`);
}

/* ---------- roster (datalist), filtered live rather than holding thousands of <option>s ---------- */

function candidateEntries(query) {
  // Kept if EITHER metric has a value - unlike tree-canopy.js's own
  // isCredible() (which needs a treeCount check to tell a real canopy
  // zero from a data gap), this page would rather show an entity with one
  // missing metric than risk hiding it entirely over the other metric's
  // own zero-vs-gap nuance, which is already covered in full on that
  // metric's own dedicated page.
  let candidates = levelEntries(state.level).filter((e) => e.canopyPct != null || e.heatMaxC != null);
  if (state.cityFilter) candidates = candidates.filter((e) => e.city === state.cityFilter);
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  const nameHits = [];
  const otherHits = [];
  for (const e of candidates) {
    if (e.name.toLowerCase().includes(q)) nameHits.push(e);
    else if (e.label.toLowerCase().includes(q)) otherHits.push(e);
  }
  return [...nameHits, ...otherHits];
}

function updateRosterOptions(query) {
  const top = candidateEntries(query).slice(0, 40);
  el('chcRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = candidateEntries('');
  if (state.cityFilter) {
    const scoped = all.filter((e) => e.city === state.cityFilter).length;
    el('chcRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(all.length)}) — <button type="button" id="chcClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('chcClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('chcRosterHint').textContent = `${num(all.length)} ${lvl.labelPlural} סה״כ`;
  }
}

/* ---------- comparison ---------- */

function renderCompareTable(entries) {
  const rows = entries.map((e, i) => `
    <tr>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${e.canopyPct != null ? `${e.canopyPct.toFixed(2)}%` : '—'}</td>
      <td>${e.heatMaxC != null ? `${e.heatMaxC > 0 ? '+' : ''}${e.heatMaxC.toFixed(2)}°C` : '—'}</td>
    </tr>`).join('');
  el('chcTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">כיסוי חופות עצים</th>
          <th scope="col">דלתת חום מרבית</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('chcWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('chcCompareSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;

  // Each metric's own chart only gets entries that actually have a value
  // for it - same filtering canopy-map.js's renderDetailMetric() already
  // does for its own combined-metric charts, so a pick missing one metric
  // just shows fewer bars in that one figure instead of a null/NaN bar.
  const canopyEntries = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.canopyPct != null)
    .map(({ e, i }) => ({ label: e.label, value: Number(e.canopyPct.toFixed(2)), color: PICK_COLORS[i] }));
  const heatEntries = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.heatMaxC != null)
    .map(({ e, i }) => ({ label: e.label, value: Number(e.heatMaxC.toFixed(2)), color: PICK_COLORS[i] }));
  renderHBarChart('chcChartCanopy', `כיסוי חופות עצים (%)${entries.length > 1 ? ' — השוואה' : ''}`, canopyEntries, '%');
  renderHBarChart('chcChartHeat', `דלתת חום מרבית (°C)${entries.length > 1 ? ' — השוואה' : ''}`, heatEntries, '°C');
  renderCompareTable(entries);
}

/* ---------- CSV (the up-to-4 picks only, not the whole level's roster -
   this page is a focused compare view, not a leaderboard/export page the
   way tree-canopy.html's own CSV button is) ---------- */

el('chcCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const fields = [lvl.label, 'עיר', 'כיסוי_חופות_אחוז', 'דלתא_חום_מרבית'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label, עיר: e.city || '', כיסוי_חופות_אחוז: e.canopyPct ?? '', דלתא_חום_מרבית: e.heatMaxC ?? '',
  }));
  const name = `עצים_וחום_${lvl.labelPlural}`.replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('chcShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => {
    const canopy = e.canopyPct != null ? `${e.canopyPct.toFixed(1)}% חופות` : 'אין נתוני חופות';
    const heat = e.heatMaxC != null ? `${e.heatMaxC > 0 ? '+' : ''}${e.heatMaxC.toFixed(1)}°C` : 'אין נתוני חום';
    return `${e.label}: ${canopy}, ${heat}`;
  });
  const text = `מידע איזורי על עצים וחום 🌳🌡️\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`chcPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of document.querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`chcPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
    input.value = state.picks[i] || '';
  });
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
}

document.querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.picks = [null, null, null, null];
    state.cityFilter = null;
    syncUrl();
    renderAll();
  });
});

// Mobile-only brief "✓ נטען" confirmation next to whichever field was just
// picked - same idiom (and same reasoning) as tree-canopy.js's own
// showPickConfirm.
const pickConfirmTimers = [];
function showPickConfirm(i, ok) {
  const confirmEl = el(`chcPickConfirm${i}`);
  clearTimeout(pickConfirmTimers[i]);
  confirmEl.classList.remove('tc-pick-confirm-show');
  if (!ok) return;
  confirmEl.textContent = '✓ נטען';
  void confirmEl.offsetWidth;
  confirmEl.classList.add('tc-pick-confirm-show');
  pickConfirmTimers[i] = setTimeout(() => confirmEl.classList.remove('tc-pick-confirm-show'), 1500);
}

pickInputs.forEach((input, i) => {
  input.addEventListener('input', debounce(() => updateRosterOptions(input.value), 120));
  const commit = () => {
    state.picks[i] = input.value.trim() || null;
    syncUrl();
    renderCompare();
    showPickConfirm(i, Boolean(state.picks[i] && labelMap(state.level).has(state.picks[i])));
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
});

readStateFromUrl();
renderAll();
