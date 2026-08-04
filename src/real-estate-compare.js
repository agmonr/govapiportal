/**
 * Entry point for real-estate-compare.html - מידע איזורי על מחירי נדל״ן.
 * Mirrors canopy-heat-compare.js's architecture (up-to-4 compare, national
 * leaderboard, CSV/WhatsApp export, city-scoped in-city rank) but for a
 * single new source (real-estate-cities.js/real-estate-neighborhoods.js -
 * see tools/real_estate_build.py) with two metrics instead of three, and no
 * street level (no street-buffer geometry built for this dataset).
 *
 * Unlike canopy/heat, neither metric here has an inherent "better/worse"
 * direction - an expensive city isn't a worse one, a quiet market isn't a
 * bad one - so the board's order toggle is framed as a neutral high->low /
 * low->high, not best/worst, and both metrics always sort the same
 * direction for a given toggle position (no per-metric HIGHER_IS_BETTER).
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, renderBarChart, citySwatchCell } from './charts.js';
import { CITY_REAL_ESTATE } from './real-estate-cities.js';
import { NEIGHBORHOOD_REAL_ESTATE } from './real-estate-neighborhoods.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'real-estate-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- metrics ---------- */

const METRICS = {
  price: {
    label: 'מחיר למ״ר', unit: '₪',
    valueForCity: (name) => CITY_REAL_ESTATE[name]?.medianPricePerSqm,
    valueForNb: (key) => NEIGHBORHOOD_REAL_ESTATE[key]?.medianPricePerSqm,
  },
  volume: {
    label: 'כמות עסקאות', unit: '',
    valueForCity: (name) => CITY_REAL_ESTATE[name]?.n,
    valueForNb: (key) => NEIGHBORHOOD_REAL_ESTATE[key]?.n,
  },
};
const METRIC_ORDER = ['price', 'volume'];

function valueForLevel(metric, level, key) {
  return level === 'city' ? metric.valueForCity(key) : metric.valueForNb(key);
}
function valueFor(entity, metricId) {
  return valueForLevel(METRICS[metricId], entity.level, entity.key);
}

/* ---------- levels ---------- */

function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}

const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:', boardTitle: 'ערים',
    entries: () => Object.keys(CITY_REAL_ESTATE).map((name) => ({ key: name, label: name, name, city: name, level: 'city' })),
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:', boardTitle: 'שכונות',
    entries: () => Object.keys(NEIGHBORHOOD_REAL_ESTATE).map((key) => {
      const [city, name] = key.split('::');
      return { key, label: neighborhoodLabel(city, name), name, city, level: 'neighborhood' };
    }),
  },
};

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
const VOLUME_PICK_COLORS = [
  'var(--danger)',
  'color-mix(in srgb, var(--danger) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--danger) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--danger) 22%, var(--bg) 78%)',
];
const METRIC_PICK_COLORS = { price: PICK_COLORS, volume: VOLUME_PICK_COLORS };

const MAX_PICKS = 4;

/* ---------- state + URL ---------- */

const state = {
  level: 'city', picks: [null, null, null, null], cityFilter: null, boardOrder: 'best',
};

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (LEVELS[p.get('level')]) state.level = p.get('level');
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
  if (p.get('city')) state.cityFilter = p.get('city');
  if (p.get('order') === 'worst') state.boardOrder = 'worst';
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  if (state.boardOrder === 'worst') p.set('order', 'worst');
  history.replaceState(null, '', `?${p}`);
}

/* ---------- roster ---------- */

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

function updateCityRoster(query) {
  const q = query.trim().toLowerCase();
  const names = levelEntries('city').map((e) => e.name);
  const hits = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  el('recCityRoster').innerHTML = hits.slice(0, 40).map((n) => `<option value="${esc(n)}">`).join('');
}

function updateRosterOptions(query) {
  const top = candidateEntries(query).slice(0, 40);
  el('recRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = candidateEntries('');
  if (state.cityFilter) {
    const scoped = all.filter((e) => e.city === state.cityFilter).length;
    el('recRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(all.length)}) — <button type="button" id="recClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('recClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('recRosterHint').textContent = `${num(all.length)} ${lvl.labelPlural} סה״כ`;
  }
}

/* ---------- comparison (up to 4 picks) ---------- */

function renderCompareTable(entries) {
  const rows = entries.map((e, i) => {
    const price = valueFor(e, 'price');
    const vol = valueFor(e, 'volume');
    return `
    <tr>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${price != null ? `${num(price)} ₪` : '—'}</td>
      <td>${vol != null ? num(vol) : '—'}</td>
    </tr>`;
  }).join('');
  el('recTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">${esc(METRICS.price.label)}</th>
          <th scope="col">${esc(METRICS.volume.label)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderCompareCharts(entries) {
  const container = el('recCompareCharts');
  container.innerHTML = METRIC_ORDER.map((_, i) => `<figure id="rec-compare-${i}" class="acc-chart acc-chart-wide" role="img"></figure>`).join('');
  METRIC_ORDER.forEach((metricId, i) => {
    const figId = `rec-compare-${i}`;
    const m = METRICS[metricId];
    const colors = METRIC_PICK_COLORS[metricId];
    const chartEntries = entries
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => valueFor(e, metricId) != null)
      .map(({ e, idx }) => ({ label: e.label, value: valueFor(e, metricId), color: colors[idx] }));
    renderHBarChart(figId, `${m.label}${m.unit ? ` (${m.unit})` : ''}${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, m.unit);
  });
}

// Where a neighborhood ranks among every other neighborhood IN ITS OWN CITY,
// per metric - "5th of 40 neighborhoods in Hod HaSharon by price/m²" rather
// than a national rank. Both metrics rank highest-first always (rank 1 =
// most expensive / most active) - a fixed fact about the entity, not a
// "best" judgment, unlike canopy-heat-compare's own HIGHER_IS_BETTER.
function rankInCity(entity) {
  if (entity.level === 'city' || !entity.city) return null;
  const siblings = levelEntries(entity.level).filter((e) => e.city === entity.city);
  const ranks = {};
  for (const id of METRIC_ORDER) {
    const withVals = siblings
      .map((e) => ({ key: e.key, value: valueFor(e, id) }))
      .filter((r) => r.value != null)
      .sort((a, b) => b.value - a.value);
    const idx = withVals.findIndex((r) => r.key === entity.key);
    if (idx !== -1) ranks[id] = { rank: idx + 1, total: withVals.length, value: withVals[idx].value };
  }
  return Object.keys(ranks).length ? ranks : null;
}

function renderRanks(entries) {
  const box = el('recRanks');
  const lines = entries.map((e) => {
    const ranks = rankInCity(e);
    if (!ranks) return null;
    const parts = METRIC_ORDER.filter((id) => ranks[id]).map((id) => {
      const r = ranks[id];
      const unit = id === 'price' ? `${num(r.value)} ₪` : num(r.value);
      return `מקום ${r.rank} מתוך ${num(r.total)} ב${METRICS[id].label} (${unit})`;
    });
    return parts.length ? `<p dir="auto"><strong>${esc(e.label)}</strong> בתוך ${esc(e.city)}: ${parts.join(' · ')}</p>` : null;
  }).filter(Boolean);
  box.innerHTML = lines.join('');
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('recWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('recCompareSection');
  const dealsSection = el('recDealsSection');
  if (!entries.length) {
    section.hidden = true;
    dealsSection.hidden = true;
    return;
  }
  section.hidden = false;
  dealsSection.hidden = false;

  renderCompareCharts(entries);
  renderCompareTable(entries);
  renderRanks(entries);
  renderDealsSections(entries);
}

/* ---------- individual deals - lazily fetched per city (one plain JSON
   array per city under assets/deals/<city>.json, written by
   tools/real_estate_build.py - same lazy-per-city-asset idiom canopy-
   map.html's own heat/canopy blob PNGs already use), filtered to just the
   picked neighborhood client-side when that's the level in play. Shows the
   deal as actually reported (nominal ₪), not CPI-adjusted - the median
   above is the number to compare across years, this list is "what actually
   sold, real numbers." ---------- */

const cityDealsCache = new Map(); // cityName -> Promise<record[]>
function fetchCityDeals(cityName) {
  if (!cityDealsCache.has(cityName)) {
    cityDealsCache.set(cityName, fetch(`./assets/deals/${cityName}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []));
  }
  return cityDealsCache.get(cityName);
}

function dealsForEntry(entry, cityDeals) {
  return entry.level === 'neighborhood' ? cityDeals.filter((d) => d.nb === entry.name) : cityDeals;
}

function dealYearCounts(deals) {
  const counts = {};
  for (const d of deals) {
    const y = d.dt.slice(0, 4);
    counts[y] = (counts[y] || 0) + 1;
  }
  return Object.keys(counts).sort().map((year) => ({ label: year, value: counts[year] }));
}

const DEALS_ROW_CAP = 300; // hard ceiling on how many (already sorted/filtered) rows ever reach the DOM
const DEALS_INITIAL_ROWS = 10; // visible before "הצג עוד" - the rest sits in a second, hidden tbody

const DEAL_COLUMNS = [
  { key: 'dt', label: 'תאריך', type: 'text', get: (d) => d.dt || '' },
  { key: 'addr', label: 'כתובת', type: 'text', get: (d) => [d.st, d.hn].filter((v) => v != null && v !== '').join(' ') },
  { key: 'area', label: 'שטח (מ״ר)', type: 'num', get: (d) => d.area },
  { key: 'amt', label: 'מחיר', type: 'num', get: (d) => d.amt },
  { key: 'perSqm', label: 'מחיר למ״ר', type: 'num', get: (d) => (d.area ? d.amt / d.area : null) },
];
const DEAL_COLUMN_BY_KEY = Object.fromEntries(DEAL_COLUMNS.map((c) => [c.key, c]));

// Per-entity sort/search state, keyed by entity key so switching between
// picks (or a level/order change elsewhere) doesn't reset a sort/search the
// visitor already set up. Default sort is מחיר למ״ר desc - the page's own
// overall theme.
const dealsUiState = {};
function dealsStateFor(key) {
  if (!dealsUiState[key]) dealsUiState[key] = { col: 'amt', dir: 'desc', q: '' };
  return dealsUiState[key];
}

function matchesSearch(d, q) {
  if (!q) return true;
  const hay = `${d.dt || ''} ${d.st || ''} ${d.hn ?? ''} ${d.nb || ''}`.toLowerCase();
  return hay.includes(q);
}

async function renderDealsBlock(entry, index) {
  const blockId = `recDealsBlock${index}`;
  const block = el(blockId);
  if (!block) return;
  block.innerHTML = '<p class="acc-hint" dir="auto">טוען עסקאות…</p>';

  const cityName = entry.level === 'city' ? entry.name : entry.city;
  const cityDeals = await fetchCityDeals(cityName);
  if (!el(blockId)) return; // re-rendered away (picks changed) while the fetch was in flight

  const deals = dealsForEntry(entry, cityDeals);
  const state = dealsStateFor(entry.key);
  const yearFigId = `${blockId}Year`;
  const searchId = `${blockId}Search`;
  const tableId = `${blockId}Table`;

  // Collapsed by default (no `open` attribute) - a visitor who picked 4
  // entities to compare doesn't want 4 long deal tables blocking the page;
  // opening one is a deliberate choice, same idiom as the site's other
  // <details class="notice ..."> explainer blocks.
  block.innerHTML = `
    <details class="notice info">
      <summary><strong dir="auto">${esc(entry.label)} - עסקאות בודדות</strong></summary>
      <figure id="${yearFigId}" class="acc-chart" role="img"></figure>
      <div class="acc-year-pick">
        <label for="${searchId}">חיפוש (רחוב, תאריך, שכונה):</label>
        <input id="${searchId}" type="text" autocomplete="off" spellcheck="false" placeholder="למשל: הרצל, 2024, רמת אשכול…">
      </div>
      <div id="${tableId}"></div>
    </details>`;

  const rerender = () => renderDealsTableSorted(tableId, deals, state);

  el(searchId).addEventListener('input', debounce((ev) => {
    state.q = ev.target.value.trim().toLowerCase();
    rerender();
  }, 150));

  renderBarChart(yearFigId, 'עסקאות לפי שנה', dealYearCounts(deals));
  rerender();
}

function renderDealsTableSorted(containerId, deals, state) {
  const col = DEAL_COLUMN_BY_KEY[state.col] || DEAL_COLUMN_BY_KEY.perSqm;
  const filtered = state.q ? deals.filter((d) => matchesSearch(d, state.q)) : deals;
  const sorted = [...filtered].sort((a, b) => {
    const va = col.get(a); const vb = col.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // missing values sink to the bottom regardless of direction
    if (vb == null) return -1;
    return col.type === 'text' ? String(va).localeCompare(String(vb), 'he') : va - vb;
  });
  if (state.dir === 'desc') sorted.reverse();
  const shown = sorted.slice(0, DEALS_ROW_CAP);
  const firstRows = shown.slice(0, DEALS_INITIAL_ROWS);
  const restRows = shown.slice(DEALS_INITIAL_ROWS);

  const rowHtml = (d) => {
    const perSqm = d.area ? Math.round(d.amt / d.area) : null;
    const addr = [d.st, d.hn].filter((v) => v != null && v !== '').join(' ');
    return `
    <tr>
      <td dir="ltr">${esc(d.dt)}</td>
      <td dir="auto">${esc(addr || '—')}</td>
      <td>${d.area != null ? num(d.area) : '—'}</td>
      <td>${num(d.amt)} ₪</td>
      <td>${perSqm != null ? `${num(perSqm)} ₪` : '—'}</td>
    </tr>`;
  };

  // Same th.sortable/data-sort-key/data-sort-dir/s-mark convention as
  // plan-render.js's own sortTh() - the next click's direction is baked
  // into data-sort-dir at render time, so the click handler just reads it
  // back rather than re-deriving a toggle.
  const headCell = (c) => {
    const active = state.col === c.key;
    const nextDir = active && state.dir === 'asc' ? 'desc' : 'asc';
    return `<th class="sortable${active ? ' sorted' : ''}" data-sort-key="${c.key}" data-sort-dir="${nextDir}"
                tabindex="0" role="button"
                aria-sort="${active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      ${esc(c.label)}<span class="s-mark">${active ? (state.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>`;
  };

  const capNote = deals.length > shown.length
    ? ` (מוצגות ${num(shown.length)} מתוך ${num(state.q ? filtered.length : deals.length)}${state.q ? ` שנמצאו מתוך ${num(deals.length)}` : ''})`
    : (state.q ? ` (${num(filtered.length)} מתוך ${num(deals.length)} תואמות לחיפוש)` : '');

  const restId = `${containerId}Rest`;
  const moreBtnId = `${containerId}More`;

  el(containerId).innerHTML = `
    <div class="matrix-wrap scroll">
      <table class="matrix preview">
        <thead><tr>${DEAL_COLUMNS.map(headCell).join('')}</tr></thead>
        <tbody>${firstRows.map(rowHtml).join('')}</tbody>
        <tbody id="${restId}" hidden>${restRows.map(rowHtml).join('')}</tbody>
      </table>
    </div>
    <p class="acc-hint" dir="auto">${num(shown.length)} עסקאות מוצגות${capNote}</p>
    ${restRows.length ? `<button type="button" id="${moreBtnId}" class="drill-dl">הצג עוד ${num(restRows.length)} עסקאות ▾</button>` : ''}`;

  el(containerId).querySelectorAll('th.sortable').forEach((th) => {
    const apply = () => {
      state.col = th.dataset.sortKey;
      state.dir = th.dataset.sortDir;
      renderDealsTableSorted(containerId, deals, state);
    };
    th.addEventListener('click', apply);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });
  });

  if (restRows.length) {
    el(moreBtnId).addEventListener('click', () => {
      const rest = el(restId);
      const btn = el(moreBtnId);
      rest.hidden = !rest.hidden;
      btn.textContent = rest.hidden ? `הצג עוד ${num(restRows.length)} עסקאות ▾` : 'הצג פחות ▴';
    });
  }
}

let dealsRenderGen = 0;
function renderDealsSections(entries) {
  const myGen = (dealsRenderGen += 1);
  const container = el('recDealsSections');
  container.innerHTML = entries.map((_, i) => `<div id="recDealsBlock${i}" class="rec-deals-block"></div>`).join('');
  entries.forEach((entry, i) => {
    renderDealsBlock(entry, i).then(() => {
      if (myGen !== dealsRenderGen) return; // superseded by a newer pick change - nothing to reconcile, the container itself was already replaced
    });
  });
}

/* ---------- national leaderboard - every entity at the current level,
   unscoped by picks, chunked across animation frames (see canopy-heat-
   compare.js's own comment - identical reasoning: neighborhood level has
   ~980 rows, cities 142, both fine unchunked really, but kept for
   consistency and future-proofing if the dataset grows). ---------- */

const BOARD_CHUNK = 300;
const BOARD_CAP = 100;
let boardRenderGen = 0;

function renderBoardChartChunked(figId, caption, rowsHtml) {
  const myGen = (boardRenderGen += 1);
  const fig = el(figId);
  if (!rowsHtml.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars"></div>`;
  const body = fig.querySelector('.acc-hbars');
  let i = 0;
  function appendChunk() {
    if (myGen !== boardRenderGen) return;
    const end = Math.min(i + BOARD_CHUNK, rowsHtml.length);
    const wrap = document.createElement('div');
    wrap.innerHTML = rowsHtml.slice(i, end).join('');
    const frag = document.createDocumentFragment();
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    body.appendChild(frag);
    i = end;
    if (i < rowsHtml.length) requestAnimationFrame(appendChunk);
  }
  appendChunk();
}

// Renders one metric's ranked bars into figId - shared by the main level
// board and the single-picked-city neighborhoods pre-section below, which
// differ only in which entries/cap/caption they use.
function renderMetricBoard(figId, metricId, entries, { labelPlural, capAll = false }) {
  const m = METRICS[metricId];
  const desc = state.boardOrder === 'best';
  const withVals = entries
    .map((e) => ({ label: e.label, value: valueFor(e, metricId) }))
    .filter((r) => r.value != null)
    .sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
  const capped = capAll ? withVals : withVals.slice(0, BOARD_CAP);
  const capNote = capped.length < withVals.length ? ` (${num(BOARD_CAP)} מתוך ${num(withVals.length)})` : '';
  const peak = Math.max(0, ...capped.map((r) => r.value));
  const orderWord = desc ? 'מהגבוה לנמוך' : 'מהנמוך לגבוה';
  const rowsHtml = capped.map((r) => `
    <div class="acc-hbar" title="${esc(r.label)}: ${num(r.value)}${m.unit ? ` ${esc(m.unit)}` : ''}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (r.value / peak) * 100 : 0}%;background:${metricId === 'volume' ? 'var(--danger)' : 'var(--accent)'}"></div></div>
      <span class="acc-hbar-v">${num(r.value)}</span>
    </div>`);
  renderBoardChartChunked(figId, `${num(capped.length)} ${labelPlural}, ${orderWord} לפי ${m.label}${capNote}`, rowsHtml);
}

// When exactly one city is picked at city level (whether from a map deep
// link's own p1 param or typed into the pick field by hand), that city's
// own neighborhoods are shown FIRST, ahead of the national city list - a
// natural "what does this one city look like inside" drill-down, without
// having to switch level and retype the city into the neighborhood filter.
function singlePickedCity() {
  if (state.level !== 'city') return null;
  const picked = state.picks.filter(Boolean);
  return picked.length === 1 && CITY_REAL_ESTATE[picked[0]] ? picked[0] : null;
}

function renderBoard() {
  const lvl = LEVELS[state.level];
  let entries = levelEntries(state.level);
  const scopeNote = [];
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    scopeNote.push(`מוצג בתוך ${state.cityFilter} בלבד`);
  }
  el('recBoardHint').textContent = scopeNote.join(' · ');

  const cityForNb = singlePickedCity();
  el('recBoardLevel').textContent = 'דירוג ארצי';

  // Each group is its own collapsed-by-default <details> - a visitor who
  // picked one city to drill into its neighborhoods doesn't also want the
  // full national city ranking splashed open below it uninvited; opening
  // either one is a deliberate click, same idiom as the deals blocks above.
  const groups = [];
  if (cityForNb) {
    groups.push({
      id: 'nb',
      title: `שכונות ב${cityForNb}`,
      entries: levelEntries('neighborhood').filter((e) => e.city === cityForNb),
      capAll: false,
    });
  }
  groups.push({ id: 'main', title: lvl.boardTitle, entries, capAll: state.level === 'city' });

  const container = el('recBoardCharts');
  container.innerHTML = groups.map((g) => `
    <details class="notice info">
      <summary><strong dir="auto">${esc(g.title)}</strong></summary>
      ${METRIC_ORDER.map((_, i) => `<figure id="rec-board-${g.id}-${i}" class="acc-chart acc-chart-wide tc-board-scroll" role="img"></figure>`).join('')}
    </details>`).join('');

  groups.forEach((g) => {
    METRIC_ORDER.forEach((metricId, i) => {
      renderMetricBoard(`rec-board-${g.id}-${i}`, metricId, g.entries, { labelPlural: g.title, capAll: g.capAll });
    });
  });
}

/* ---------- CSV ---------- */

el('recCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const fields = [lvl.label, 'עיר', 'מחיר_למר', 'כמות_עסקאות'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label,
    עיר: e.city || '',
    מחיר_למר: valueFor(e, 'price') ?? '',
    כמות_עסקאות: valueFor(e, 'volume') ?? '',
  }));
  const name = `מחירי_נדלן_${lvl.labelPlural}`.replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('recShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => {
    const price = valueFor(e, 'price');
    const vol = valueFor(e, 'volume');
    const priceText = price != null ? `${num(price)} ₪ למ״ר` : 'אין נתון מחיר';
    const volText = vol != null ? `${num(vol)} עסקאות` : 'אין נתון עסקאות';
    return `${e.label}: ${priceText}, ${volText}`;
  });
  const text = `מידע איזורי על מחירי נדל״ן 🏘️💰\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`recPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of el('recLevelPick').querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`recPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
    input.value = state.picks[i] || '';
  });
  el('recCityFilterRow').hidden = state.level === 'city';
  el('recCityFilter').value = state.cityFilter || '';
  updateCityRoster('');
  for (const btn of el('recBoardOrderPick').querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.order === state.boardOrder);
  }
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
  renderBoard();
}

el('recLevelPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.picks = [null, null, null, null];
    state.cityFilter = null;
    syncUrl();
    renderAll();
  });
});

el('recCityFilter').addEventListener('input', debounce(() => updateCityRoster(el('recCityFilter').value), 120));
el('recCityFilter').addEventListener('change', () => {
  const v = el('recCityFilter').value.trim();
  state.cityFilter = v && levelEntries('city').some((e) => e.name === v) ? v : null;
  syncUrl();
  renderAll();
});

el('recBoardOrderPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.boardOrder === btn.dataset.order) return;
    state.boardOrder = btn.dataset.order;
    syncUrl();
    renderAll();
  });
});

const pickConfirmTimers = [];
function showPickConfirm(i, ok) {
  const confirmEl = el(`recPickConfirm${i}`);
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
