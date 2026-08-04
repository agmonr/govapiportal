/**
 * Entry point for heat-islands.html - כמה חם כאן.
 *
 * Same idea as tree-canopy.js (its own docstring explains the underlying
 * pattern in full - three levels, one shared UI): the source (the Ministry
 * of Environmental Protection's national climate-risk map, with Tomorrow.io
 * + the Israel Meteorological Service) has no bulk-download or normal query
 * API at all - see tools/heat_build.py, which fetches and decodes the raw
 * LERC tiles once, then computes max/mean temperature delta against the
 * exact same city (GovMap), neighborhood and street (OSM, 7.5m buffer)
 * boundaries tree-canopy.js already uses. Only those three small computed
 * tables ship here; the ~850-tile raster mosaic stays local and gitignored.
 *
 * "Delta" throughout means: August 21:00 air temperature at that pixel,
 * compared to the open land surrounding the same settlement - a heat-island
 * proxy, not an absolute temperature or true ground surface reading.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { CITY_HEAT } from './heat-cities.js';
import { NEIGHBORHOOD_HEAT } from './heat-neighborhoods.js';
import { STREET_HEAT } from './heat-streets.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'heat-islands')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- levels: one shape, three sources ---------- */

const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:',
    boardTitle: 'ערים חמות', rankedWord: 'מדורגות',
    entries: () => Object.entries(CITY_HEAT).map(([name, v]) => ({
      key: name, label: name, name, city: name, maxC: v.maxC, meanC: v.meanC, pixelCount: v.pixelCount,
    })),
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:',
    boardTitle: 'שכונות חמות', rankedWord: 'מדורגות',
    entries: () => Object.entries(NEIGHBORHOOD_HEAT).map(([key, v]) => {
      const [city, name] = key.split('::');
      return {
        key, label: `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`, name, city,
        maxC: v.maxC, meanC: v.meanC, pixelCount: v.pixelCount, approx: v.approx,
      };
    }),
  },
  street: {
    label: 'רחוב', labelPlural: 'רחובות', pickLabel: 'רחוב:',
    boardTitle: 'רחובות חמים', rankedWord: 'מדורגים',
    entries: () => Object.entries(STREET_HEAT).map(([key, v]) => {
      const [city, name] = key.split('::');
      return {
        key, label: `${name}, ${city}${v.nb ? ` (${v.nb})` : ''}`, name, city,
        maxC: v.maxC, meanC: v.meanC, pixelCount: v.pixelCount, lengthM: v.lengthM,
      };
    }),
  },
};

// Built once per level on first use - a street's ~32k rows are cheap to hold
// as an array/Map, just not cheap to re-derive from the source object on
// every keystroke.
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

// A gradient of one color, warmed toward red rather than the site's usual
// green - same identity-color idiom as tree-canopy.js's own PICK_COLORS
// (solid accent for pick #1, fainter tints for #2-4), just in a hue that
// reads as "heat" rather than this site's default "growth/canopy" green.
const PICK_COLORS = [
  'var(--danger)',
  'color-mix(in srgb, var(--danger) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--danger) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--danger) 22%, var(--bg) 78%)',
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

/* ---------- roster (datalist), filtered live rather than holding ~32k <option>s ---------- */

/** Same "own name first, city-name-substring second" ordering as
 *  tree-canopy.js's candidateEntries() - see there for why. */
function candidateEntries(query) {
  let candidates = levelEntries(state.level);
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
  el('hiRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = levelEntries(state.level);
  if (state.cityFilter) {
    const scoped = all.filter((e) => e.city === state.cityFilter).length;
    el('hiRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(all.length)}) — <button type="button" id="hiClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('hiClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('hiRosterHint').textContent = `${num(all.length)} ${lvl.labelPlural} סה״כ`;
  }
}

/* ---------- comparison ---------- */

// Only the headline max delta shows by default; mean/pixel-count sit in an
// expandable row per entity, same idiom as tree-canopy.js's own compare
// table (there: area/canopy-area/tree-count; here: everything besides the
// number this page is about).
function renderCompareTable(entries) {
  const rows = entries.map((e, i) => `
    <tr class="has-files" data-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${e.maxC > 0 ? '+' : ''}${e.maxC.toFixed(2)}°C</td>
    </tr>
    <tr class="files-row" data-files="${i}" hidden>
      <td colspan="3">
        <dl class="ck-facts" dir="auto">
          <dt>ממוצע (°C)</dt><dd>${e.meanC > 0 ? '+' : ''}${e.meanC.toFixed(2)}</dd>
          <dt>פיקסלים (~43 מ' כל אחד)</dt><dd>${num(e.pixelCount)}</dd>
          ${e.approx ? '<dt>גבול</dt><dd>משוער (ללא פוליגון אמיתי)</dd>' : ''}
        </dl>
      </td>
    </tr>`).join('');
  el('hiTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">דלתא חום מרבית</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  el('hiTable').querySelectorAll('tr.has-files').forEach((tr) => {
    const toggle = () => {
      const target = el('hiTable').querySelector(`tr[data-files="${tr.dataset.row}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

// Every selected city (not just the first) gets its own drill-in pair - see
// tree-canopy.js's own renderDrill for the same reasoning.
function renderDrill(entries) {
  const section = el('hiDrillSection');
  if (state.level !== 'city' || !entries.length) { section.hidden = true; return; }
  section.hidden = false;
  el('hiDrillBtns').innerHTML = entries.map((e, i) => `
    <span class="tc-drill-group">
      <span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>
      <button type="button" data-idx="${i}" data-drill="neighborhood">שכונות של <span dir="auto">${esc(e.label)}</span> ←</button>
      <button type="button" data-idx="${i}" data-drill="street">רחובות של <span dir="auto">${esc(e.label)}</span> ←</button>
    </span>`).join('');
  el('hiDrillBtns').querySelectorAll('button[data-drill]').forEach((btn) => {
    const e = entries[Number(btn.dataset.idx)];
    btn.addEventListener('click', () => drillInto(btn.dataset.drill, e.label));
  });
}

function drillInto(level, cityName) {
  state.level = level;
  state.cityFilter = cityName;
  const top = levelEntries(level).filter((e) => e.city === cityName).sort((x, y) => y.maxC - x.maxC);
  state.picks = [top[0]?.label || null, top[1]?.label || null, null, null];
  syncUrl();
  renderAll();
}

// A single city gets a quick answer to "which of ITS OWN neighborhoods/
// streets run hottest" without leaving the city level - same reasoning as
// tree-canopy.js's renderTopWithinCity.
const TOP_NEIGHBORHOODS_N = 20;
const TOP_STREETS_N = 25;

function renderTopWithinCity(entries, level, n, sectionId, citySpanId, chartId, noun) {
  const section = el(sectionId);
  if (state.level !== 'city' || entries.length !== 1) { section.hidden = true; return; }
  const cityName = entries[0].label;
  const items = levelEntries(level).filter((e) => e.city === cityName);
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  el(citySpanId).textContent = cityName;
  const top = [...items].sort((a, b) => b.maxC - a.maxC).slice(0, n);
  const chartEntries = top.map((e) => ({ label: e.name, value: Number(e.maxC.toFixed(2)) }));
  renderHBarChart(chartId, `${num(top.length)} ${noun} בדלתת חום${top.length < items.length ? ` (מתוך ${num(items.length)})` : ''}`, chartEntries, '°C');
}

function renderTopNeighborhoods(entries) {
  renderTopWithinCity(entries, 'neighborhood', TOP_NEIGHBORHOODS_N, 'hiTopNeighborhoodsSection', 'hiTopNeighborhoodsCity', 'hiTopNeighborhoodsChart', 'שכונות חמות');
}

function renderTopStreets(entries) {
  renderTopWithinCity(entries, 'street', TOP_STREETS_N, 'hiTopStreetsSection', 'hiTopStreetsCity', 'hiTopStreetsChart', 'רחובות חמים');
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('hiWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('hiCompareSection');
  if (!entries.length) {
    section.hidden = true;
    renderDrill([]);
    el('hiTopNeighborhoodsSection').hidden = true;
    el('hiTopStreetsSection').hidden = true;
    return;
  }
  section.hidden = false;

  const chartEntries = entries.map((e, i) => ({ label: e.label, value: Number(e.maxC.toFixed(2)), color: PICK_COLORS[i] }));
  renderHBarChart('hiChart', `דלתת חום מרבית (°C)${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, '°C');
  renderCompareTable(entries);
  renderDrill(entries);
  renderTopNeighborhoods(entries);
  renderTopStreets(entries);
}

/* ---------- leaderboard - same chunked-render idiom as tree-canopy.js's
   own renderBoardChart, for the same street-level row-count reason ---------- */

const BOARD_CHUNK = 300;
let boardRenderGen = 0;

function renderBoardChart(figId, caption, entries, unit) {
  const myGen = (boardRenderGen += 1);
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }

  const peak = Math.max(...entries.map((e) => e.value));
  const rowHtml = (e) => `
    <div class="acc-hbar" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
      <span class="acc-hbar-y" dir="auto">${esc(e.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (e.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(e.value)}</span>
    </div>`;

  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars"></div>`;
  const body = fig.querySelector('.acc-hbars');
  let i = 0;
  function appendChunk() {
    if (myGen !== boardRenderGen) return;
    const end = Math.min(i + BOARD_CHUNK, entries.length);
    const wrap = document.createElement('div');
    wrap.innerHTML = entries.slice(i, end).map(rowHtml).join('');
    const frag = document.createDocumentFragment();
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    body.appendChild(frag);
    i = end;
    if (i < entries.length) requestAnimationFrame(appendChunk);
  }
  appendChunk();
}

function renderBoard() {
  const lvl = LEVELS[state.level];
  el('hiBoardLevel').textContent = lvl.boardTitle;
  let entries = levelEntries(state.level);
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    el('hiBoardHint').textContent = `מוצג בתוך ${state.cityFilter} בלבד`;
  } else {
    el('hiBoardHint').textContent = '';
  }

  // Same cap as tree-canopy.js's own leaderboard, same reasoning: cities
  // (only 186) show every one, neighborhoods/streets cap at 100.
  const BOARD_CAP = 100;
  const sorted = [...entries].sort((x, y) => y.maxC - x.maxC);
  const capped = state.level === 'city' ? sorted : sorted.slice(0, BOARD_CAP);
  const ranked = capped.map((e) => ({ label: e.label, value: Number(e.maxC.toFixed(2)) }));
  const capNote = capped.length < sorted.length ? ` (${num(BOARD_CAP)} מתוך ${num(sorted.length)})` : '';
  renderBoardChart('hiBoardChart', `${num(ranked.length)} ${lvl.labelPlural} ${lvl.rankedWord} לפי דלתת חום מרבית${capNote}`, ranked, '°C');
}

/* ---------- CSV ---------- */

el('hiCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  let entries = levelEntries(state.level);
  if (state.cityFilter) entries = entries.filter((e) => e.city === state.cityFilter);
  const fields = [lvl.label, 'עיר', 'דלתא_חום_מרבית', 'דלתא_חום_ממוצעת', 'פיקסלים'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label, עיר: e.city || '', דלתא_חום_מרבית: e.maxC, דלתא_חום_ממוצעת: e.meanC, פיקסלים: e.pixelCount,
  }));
  const name = `איי_חום_${lvl.labelPlural}${state.cityFilter ? `_${state.cityFilter}` : ''}`
    .replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('hiShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => `${e.label}: ${e.maxC > 0 ? '+' : ''}${e.maxC.toFixed(1)}°C`);
  const text = `כמה חם כאן 🌡️\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`hiPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of document.querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`hiPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
    input.value = state.picks[i] || '';
  });
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
  renderBoard();
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

const pickConfirmTimers = [];
function showPickConfirm(i, ok) {
  const confirmEl = el(`hiPickConfirm${i}`);
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
