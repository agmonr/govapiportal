/**
 * Entry point for canopy-heat-compare.html - מידע איזורי על עצים וחום.
 *
 * No new data source: reuses tree-canopy.html's own street-level canopy
 * table (STREET_CANOPY - a street IS the public strip by definition, so
 * it doubles as "public canopy" at that level), canopy-split.html's own
 * city/neighborhood public/private breakdown (CITY_CANOPY_SPLIT/
 * NEIGHBORHOOD_CANOPY_SPLIT), and heat-islands.html's own three heat-
 * delta tables (CITY_HEAT/NEIGHBORHOOD_HEAT/STREET_HEAT) as-is - see
 * those pages' own src/ files (and tools/canopy_build.py/
 * tools/canopy_split_build.py/tools/heat_build.py) for how each is
 * actually computed.
 *
 * Three selectable metrics (state.activeMetrics, 1-3 active at once, same
 * "toggle membership, never zero" multi-pick idiom canopy-map.js's own
 * state.cityLayers already uses): public trees (green), private trees
 * (green, a lighter tint), heat (red). Public+private specifically get
 * COMBINED into one two-segment bar when both are active together
 * (renderStackedBarChart) rather than two separate charts, since
 * public+private is exactly total canopy split into its two components -
 * showing them stacked answers "how green, and how much of that is
 * street trees vs. private yards" in one bar instead of two disconnected
 * ones.
 *
 * Compare (up to 4 picks) and the national leaderboard board (every
 * entity at the current level, unscoped by picks - visible even before
 * any pick is made, same as tree-canopy.html's/canopy-split.html's own
 * always-on board) both follow the same active-metric selection.
 *
 * Each level's entries() UNIONS every metric's own source table by key
 * rather than intersecting them - an entity present in one table but not
 * another (a data gap in one underlying source) still shows up here, with
 * the missing metric's own bar/table cell simply absent instead of the
 * entity silently disappearing from the pick list entirely.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { STREET_CANOPY } from './tree-canopy-streets.js';
import { CITY_CANOPY_SPLIT } from './canopy-split-cities.js';
import { NEIGHBORHOOD_CANOPY_SPLIT } from './canopy-split-neighborhoods.js';
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

/* ---------- metrics ---------- */

const METRICS = {
  street: {
    label: 'עצי רחוב (ציבורי)', unit: '%',
    valueForCity: (name) => CITY_CANOPY_SPLIT[name]?.publicPct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY_SPLIT[key]?.publicPct,
    // A street IS the public/road portion by definition (see canopy-
    // split.js's own reasoning for why it has no street level at all) -
    // its own plain canopy % already means "public" at this level.
    valueForStreet: (key) => STREET_CANOPY[key]?.pct,
  },
  private: {
    label: 'עצים פרטיים', unit: '%',
    valueForCity: (name) => CITY_CANOPY_SPLIT[name]?.privatePct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY_SPLIT[key]?.privatePct,
    // No meaningful "private yard" concept for a street buffer.
    valueForStreet: () => null,
  },
  heat: {
    label: 'דלתת חום מרבית', unit: '°C',
    valueForCity: (name) => CITY_HEAT[name]?.maxC,
    valueForNb: (key) => NEIGHBORHOOD_HEAT[key]?.maxC,
    valueForStreet: (key) => STREET_HEAT[key]?.maxC,
  },
};
const METRIC_ORDER = ['street', 'private', 'heat'];
// Trees: higher % is better. Heat: lower delta is better (cooler than the
// city's own open-land baseline). Drives both the board's best/worst toggle
// and rankInCity() below, so "5th greenest" and "5th hottest" always agree
// with what "best"/"worst" mean for that metric.
const HIGHER_IS_BETTER = { street: true, private: true, heat: false };

function valueForLevel(metric, level, key) {
  if (level === 'city') return metric.valueForCity(key);
  if (level === 'neighborhood') return metric.valueForNb(key);
  return metric.valueForStreet(key);
}
function valueFor(entity, metricId) {
  return valueForLevel(METRICS[metricId], entity.level, entity.key);
}

/* ---------- levels: one shape, every metric's own source unioned by key ----------
   Key format and label conventions match tree-canopy.js's/heat-islands.js's/
   canopy-split.js's own exactly (city name for city level, "city::name"
   for neighborhood/street), which is what makes a plain key union safe -
   every source already agrees on what a given entity's key/label look like. */

function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}
function streetLabel(city, name, nb) {
  return `${name}, ${city}${nb ? ` (${nb})` : ''}`;
}

// Per-level best/worse wording, gendered to agree with labelPlural
// (ערים/שכונות are feminine, רחובות is masculine) - "worse" is phrased as
// "less good" (הפחות טובות/טובים) rather than "the worst" (הכי גרועות), a
// softer framing for a place that's simply behind its peers on this one
// metric, not objectively bad.
const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:', boardTitle: 'ערים מובילות',
    orderWord: { best: 'הכי טובות', worst: 'הפחות טובות' },
    entries: () => {
      const keys = new Set([...Object.keys(CITY_CANOPY_SPLIT), ...Object.keys(CITY_HEAT)]);
      return [...keys].map((name) => ({ key: name, label: name, name, city: name, level: 'city' }));
    },
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:', boardTitle: 'שכונות מובילות',
    orderWord: { best: 'הכי טובות', worst: 'הפחות טובות' },
    entries: () => {
      const keys = new Set([...Object.keys(NEIGHBORHOOD_CANOPY_SPLIT), ...Object.keys(NEIGHBORHOOD_HEAT)]);
      return [...keys].map((key) => {
        const [city, name] = key.split('::');
        return { key, label: neighborhoodLabel(city, name), name, city, level: 'neighborhood' };
      });
    },
  },
  street: {
    label: 'רחוב', labelPlural: 'רחובות', pickLabel: 'רחוב:', boardTitle: 'רחובות מובילים',
    orderWord: { best: 'הכי טובים', worst: 'הפחות טובים' },
    entries: () => {
      const keys = new Set([...Object.keys(STREET_CANOPY), ...Object.keys(STREET_HEAT)]);
      return [...keys].map((key) => {
        const [city, name] = key.split('::');
        const nb = STREET_CANOPY[key]?.nb || STREET_HEAT[key]?.nb;
        return { key, label: streetLabel(city, name, nb), name, city, level: 'street' };
      });
    },
  },
};

// Built once per level on first use - same lazy-cache idiom as tree-
// canopy.js's own entriesCache/labelMapCache, for the same reason (a
// street level's ~36k rows are cheap to hold, not cheap to re-derive from
// several source objects on every keystroke).
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

// Per-entity pick color (table swatch, and any single-metric compare
// chart) is always this green-based 4-step fade regardless of which
// metric it's for - GREEN_PICK/RED_PICK below are for telling metrics
// apart on a chart with only one metric active, not entities apart within
// that metric's own chart, which stays whichever is a smaller ask.
const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];
// Trees green, heat red (as requested) - each metric's own single-chart
// bars use this fixed per-entity fade instead of PICK_COLORS, so a chart
// showing only heat reads unambiguously red and one showing only trees
// reads unambiguously green, regardless of pick order.
const METRIC_PICK_COLORS = {
  street: PICK_COLORS,
  private: [
    'color-mix(in srgb, var(--accent) 55%, var(--bg) 45%)',
    'color-mix(in srgb, var(--accent) 40%, var(--bg) 60%)',
    'color-mix(in srgb, var(--accent) 28%, var(--bg) 72%)',
    'color-mix(in srgb, var(--accent) 16%, var(--bg) 84%)',
  ],
  heat: [
    'var(--danger)',
    'color-mix(in srgb, var(--danger) 70%, var(--bg) 30%)',
    'color-mix(in srgb, var(--danger) 45%, var(--bg) 55%)',
    'color-mix(in srgb, var(--danger) 22%, var(--bg) 78%)',
  ],
};
// Fixed (not per-entity) - the stacked chart tells entities apart by row
// label already, and needs its two colors to mean the same thing (public
// vs. private) in every row instead of doubling as an entity-color code.
const STACKED_COLOR_STREET = 'var(--accent)';
const STACKED_COLOR_PRIVATE = 'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)';

const MAX_PICKS = 4;

/* ---------- state + URL ---------- */

const state = {
  level: 'city', picks: [null, null, null, null], cityFilter: null, activeMetrics: ['street', 'private', 'heat'],
  boardOrder: 'best',
};

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (LEVELS[p.get('level')]) state.level = p.get('level');
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
  if (p.get('city')) state.cityFilter = p.get('city');
  const metrics = (p.get('metrics') || '').split(',').filter((id) => METRICS[id]);
  if (metrics.length) state.activeMetrics = [...new Set(metrics)];
  if (p.get('order') === 'worst') state.boardOrder = 'worst';
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  p.set('metrics', state.activeMetrics.join(','));
  if (state.boardOrder === 'worst') p.set('order', 'worst');
  history.replaceState(null, '', `?${p}`);
}

/* ---------- roster (datalist), filtered live rather than holding thousands of <option>s ---------- */

function candidateEntries(query) {
  // Kept if ANY metric has a value - unlike tree-canopy.js's own
  // isCredible() (which needs a treeCount check to tell a real canopy
  // zero from a data gap), this page would rather show an entity with
  // some missing metrics than risk hiding it entirely over one metric's
  // own zero-vs-gap nuance, which is already covered in full on that
  // metric's own dedicated page.
  let candidates = levelEntries(state.level).filter((e) => METRIC_ORDER.some((id) => valueFor(e, id) != null));
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

// City-filter input at neighborhood/street level - lets a visitor scope the
// board (and the pick roster) to one city's own streets/neighborhoods
// instead of the national list, same idea as canopy-map.html's own
// cmCityPick at its neighborhood level.
function updateCityRoster(query) {
  const q = query.trim().toLowerCase();
  const names = levelEntries('city').map((e) => e.name);
  const hits = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  el('chcCityRoster').innerHTML = hits.slice(0, 40).map((n) => `<option value="${esc(n)}">`).join('');
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

/* ---------- chart groups: turn state.activeMetrics into an ordered list
   of {type:'stacked', metrics:['street','private']} | {type:'single',
   metric} - street+private collapse into one combined group whenever
   BOTH are active, every other active metric stays its own group. Shared
   by the compare section and the national board below, so both respond
   to the same picker identically. ---------- */

function chartGroups() {
  const active = state.activeMetrics;
  const groups = [];
  if (active.includes('street') && active.includes('private')) {
    groups.push({ type: 'stacked', metrics: ['street', 'private'] });
  } else {
    if (active.includes('street')) groups.push({ type: 'single', metric: 'street' });
    if (active.includes('private')) groups.push({ type: 'single', metric: 'private' });
  }
  if (active.includes('heat')) groups.push({ type: 'single', metric: 'heat' });
  return groups;
}

/* ---------- comparison (up to 4 picks) ---------- */

function renderCompareTable(entries) {
  const rows = entries.map((e, i) => {
    const street = valueFor(e, 'street');
    const priv = valueFor(e, 'private');
    const heat = valueFor(e, 'heat');
    return `
    <tr>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${street != null ? `${street.toFixed(2)}%` : '—'}</td>
      <td>${priv != null ? `${priv.toFixed(2)}%` : '—'}</td>
      <td>${heat != null ? `${heat > 0 ? '+' : ''}${heat.toFixed(2)}°C` : '—'}</td>
    </tr>`;
  }).join('');
  el('chcTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">${esc(METRICS.street.label)}</th>
          <th scope="col">${esc(METRICS.private.label)}</th>
          <th scope="col">${esc(METRICS.heat.label)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// One <figure> per chart group, built fresh into the container each render
// (the number/kind of figures varies with the picker) - figIds are
// synthesized (`chc-compare-0`, `chc-compare-1`, ...) rather than fixed,
// since how many there are depends on state.activeMetrics.
function renderCompareCharts(entries) {
  const groups = chartGroups();
  const container = el('chcCompareCharts');
  container.innerHTML = groups.map((_, i) => `<figure id="chc-compare-${i}" class="acc-chart acc-chart-wide" role="img"></figure>`).join('');
  groups.forEach((group, i) => {
    const figId = `chc-compare-${i}`;
    if (group.type === 'stacked') {
      const rows = entries.map((e) => ({
        label: e.label, streetVal: valueFor(e, 'street'), privateVal: valueFor(e, 'private'),
      })).filter((r) => r.streetVal != null || r.privateVal != null);
      renderStackedBarChart(figId, `כיסוי חופות עצים: ציבורי + פרטי (%)${entries.length > 1 ? ' — השוואה' : ''}`, rows);
    } else {
      const m = METRICS[group.metric];
      const colors = METRIC_PICK_COLORS[group.metric];
      const chartEntries = entries
        .map((e, idx) => ({ e, idx }))
        .filter(({ e }) => valueFor(e, group.metric) != null)
        .map(({ e, idx }) => ({ label: e.label, value: Number(valueFor(e, group.metric).toFixed(2)), color: colors[idx] }));
      renderHBarChart(figId, `${m.label} (${m.unit})${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, m.unit);
    }
  });
}

// Where a neighborhood/street ranks among every other entity of the same
// level IN ITS OWN CITY, per metric - "5th of 40 streets in Hod HaSharon by
// street trees" rather than a national rank, since a national street rank
// mostly just reflects city size. Rank 1 always means "best" per
// HIGHER_IS_BETTER (so heat ranks coolest-first regardless of the board's
// own best/worst toggle - a street's rank is a fixed fact, not a view). Not
// meaningful for city-level entities (no enclosing city to rank within).
function rankInCity(entity) {
  if (entity.level === 'city' || !entity.city) return null;
  const siblings = levelEntries(entity.level).filter((e) => e.city === entity.city);
  const ranks = {};
  for (const id of METRIC_ORDER) {
    const withVals = siblings
      .map((e) => ({ key: e.key, value: valueFor(e, id) }))
      .filter((r) => r.value != null)
      .sort((a, b) => (HIGHER_IS_BETTER[id] ? b.value - a.value : a.value - b.value));
    const idx = withVals.findIndex((r) => r.key === entity.key);
    if (idx !== -1) ranks[id] = { rank: idx + 1, total: withVals.length, value: withVals[idx].value };
  }
  return Object.keys(ranks).length ? ranks : null;
}

function ordinalHe(n) {
  return `מקום ${n}`;
}

function renderRanks(entries) {
  const box = el('chcRanks');
  const lines = entries.map((e) => {
    const ranks = rankInCity(e);
    if (!ranks) return null;
    const parts = METRIC_ORDER.filter((id) => ranks[id]).map((id) => {
      const r = ranks[id];
      const unit = id === 'heat' ? `${r.value > 0 ? '+' : ''}${r.value.toFixed(1)}°C` : `${r.value.toFixed(1)}%`;
      return `${ordinalHe(r.rank)} מתוך ${num(r.total)} ב${METRICS[id].label} (${unit})`;
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

  const warn = el('chcWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('chcCompareSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;

  renderCompareCharts(entries);
  renderCompareTable(entries);
  renderRanks(entries);
}

/* ---------- stacked (public+private combined) bar chart - not part of
   charts.js's own renderHBarChart (single value per row), so a small
   dedicated renderer: two <div class="acc-hbar-fill"> segments per row,
   inside a `.acc-hbar-track-stacked` (display:flex) track instead of one -
   see style.css's own comment on that class for why the segments
   themselves are square (the track's rounding+overflow:hidden already
   rounds the outer ends). Ranked/scaled by the COMBINED total, so the
   bar's own full length still means "how much canopy total," matching
   what a single un-split canopy chart would have shown. ---------- */

function renderStackedBarChart(figId, caption, rows) {
  const fig = el(figId);
  if (!rows.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const totals = rows.map((r) => (r.streetVal ?? 0) + (r.privateVal ?? 0));
  const peak = Math.max(...totals);
  const body = rows.map((r, i) => {
    const total = totals[i];
    const streetPct = peak ? ((r.streetVal ?? 0) / peak) * 100 : 0;
    const privatePct = peak ? ((r.privateVal ?? 0) / peak) * 100 : 0;
    const title = `${r.label}: ${esc(METRICS.street.label)} ${r.streetVal != null ? r.streetVal.toFixed(1) : '—'}%, `
      + `${esc(METRICS.private.label)} ${r.privateVal != null ? r.privateVal.toFixed(1) : '—'}%`;
    return `
    <div class="acc-hbar" title="${esc(title)}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track acc-hbar-track-stacked">
        <div class="acc-hbar-fill" style="inline-size:${streetPct}%;background:${STACKED_COLOR_STREET}"></div>
        <div class="acc-hbar-fill" style="inline-size:${privatePct}%;background:${STACKED_COLOR_PRIVATE}"></div>
      </div>
      <span class="acc-hbar-v">${num(Number(total.toFixed(1)))}%</span>
    </div>`;
  }).join('');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars">${body}</div>
    <p class="acc-hint" dir="auto">
      <span class="acc-legend-swatch" style="background:${STACKED_COLOR_STREET}"></span> ${esc(METRICS.street.label)}
      · <span class="acc-legend-swatch" style="background:${STACKED_COLOR_PRIVATE}"></span> ${esc(METRICS.private.label)}
    </p>`;
}

/* ---------- national leaderboard board - every entity at the current
   level, unscoped by picks, visible even before any pick is made (same
   "always-on board" tree-canopy.html's/canopy-split.html's own pages
   already have) - follows the same chartGroups()/activeMetrics picker as
   the compare section above. Chunked across animation frames for the
   street level's ~36k rows, same reasoning/idiom as tree-canopy.js's own
   renderBoardChart (a single synchronous innerHTML write that size
   measured a multi-second visible freeze). ---------- */

const BOARD_CHUNK = 300;
const BOARD_CAP = 100; // neighborhoods/streets cap here - cities (only 186) always show every one
let boardRenderGen = 0;

function renderBoardChartChunked(figId, caption, rowsHtml) {
  const myGen = (boardRenderGen += 1);
  const fig = el(figId);
  if (!rowsHtml.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars"></div>`;
  const body = fig.querySelector('.acc-hbars');
  let i = 0;
  function appendChunk() {
    if (myGen !== boardRenderGen) return; // a newer render superseded this one
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

// true if the board should list highest-value first for a metric where
// `higherIsBetter` describes what "best" means for it - so e.g. heat's
// board defaults to coolest-first (state.boardOrder 'best'), and flipping
// the toggle to 'worst' shows hottest-first instead.
function wantDescending(higherIsBetter) {
  return (state.boardOrder === 'best') === higherIsBetter;
}

function renderBoard() {
  const lvl = LEVELS[state.level];
  el('chcBoardLevel').textContent = lvl.boardTitle;
  let entries = levelEntries(state.level);
  const scopeNote = [];
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    scopeNote.push(`מוצג בתוך ${state.cityFilter} בלבד`);
  }
  el('chcBoardHint').textContent = scopeNote.join(' · ');

  const groups = chartGroups();
  const container = el('chcBoardCharts');
  container.innerHTML = groups.map((_, i) => `<figure id="chc-board-${i}" class="acc-chart acc-chart-wide tc-board-scroll" role="img"></figure>`).join('');

  groups.forEach((group, i) => {
    const figId = `chc-board-${i}`;
    if (group.type === 'stacked') {
      const withVals = entries
        .map((e) => ({ label: e.label, streetVal: valueFor(e, 'street'), privateVal: valueFor(e, 'private') }))
        .filter((r) => r.streetVal != null || r.privateVal != null)
        .map((r) => ({ ...r, total: (r.streetVal ?? 0) + (r.privateVal ?? 0) }))
        .sort((a, b) => (wantDescending(true) ? b.total - a.total : a.total - b.total));
      const capped = state.level === 'city' ? withVals : withVals.slice(0, BOARD_CAP);
      const capNote = capped.length < withVals.length ? ` (${num(BOARD_CAP)} מתוך ${num(withVals.length)})` : '';
      const peak = Math.max(0, ...capped.map((r) => r.total));
      const rowsHtml = capped.map((r) => {
        const streetPct = peak ? ((r.streetVal ?? 0) / peak) * 100 : 0;
        const privatePct = peak ? ((r.privateVal ?? 0) / peak) * 100 : 0;
        return `
        <div class="acc-hbar" title="${esc(r.label)}: ${esc(METRICS.street.label)} ${r.streetVal != null ? r.streetVal.toFixed(1) : '—'}%, ${esc(METRICS.private.label)} ${r.privateVal != null ? r.privateVal.toFixed(1) : '—'}%">
          <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
          <div class="acc-hbar-track acc-hbar-track-stacked">
            <div class="acc-hbar-fill" style="inline-size:${streetPct}%;background:${STACKED_COLOR_STREET}"></div>
            <div class="acc-hbar-fill" style="inline-size:${privatePct}%;background:${STACKED_COLOR_PRIVATE}"></div>
          </div>
          <span class="acc-hbar-v">${num(Number(r.total.toFixed(1)))}%</span>
        </div>`;
      });
      renderBoardChartChunked(figId, `${num(capped.length)} ${lvl.labelPlural} ${lvl.orderWord[state.boardOrder]} לפי כיסוי חופות עצים (ציבורי+פרטי)${capNote}`, rowsHtml);
    } else {
      const m = METRICS[group.metric];
      const desc = wantDescending(HIGHER_IS_BETTER[group.metric]);
      const withVals = entries
        .map((e) => ({ label: e.label, value: valueFor(e, group.metric) }))
        .filter((r) => r.value != null)
        .sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
      const capped = state.level === 'city' ? withVals : withVals.slice(0, BOARD_CAP);
      const capNote = capped.length < withVals.length ? ` (${num(BOARD_CAP)} מתוך ${num(withVals.length)})` : '';
      const peak = Math.max(0, ...capped.map((r) => Math.abs(r.value)));
      const rowsHtml = capped.map((r) => `
        <div class="acc-hbar" title="${esc(r.label)}: ${num(r.value)} ${esc(m.unit)}">
          <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
          <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (Math.abs(r.value) / peak) * 100 : 0}%;background:${group.metric === 'heat' ? 'var(--danger)' : 'var(--accent)'}"></div></div>
          <span class="acc-hbar-v">${num(Number(r.value.toFixed(1)))}</span>
        </div>`);
      renderBoardChartChunked(figId, `${num(capped.length)} ${lvl.labelPlural} ${lvl.orderWord[state.boardOrder]} לפי ${m.label}${capNote}`, rowsHtml);
    }
  });
}

/* ---------- CSV (the up-to-4 picks only, not the whole level's roster -
   this page is a focused compare view, not a leaderboard/export page the
   way tree-canopy.html's own CSV button is) ---------- */

el('chcCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const fields = [lvl.label, 'עיר', 'עצי_רחוב_ציבורי_אחוז', 'עצים_פרטיים_אחוז', 'דלתא_חום_מרבית'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label,
    עיר: e.city || '',
    עצי_רחוב_ציבורי_אחוז: valueFor(e, 'street') ?? '',
    עצים_פרטיים_אחוז: valueFor(e, 'private') ?? '',
    דלתא_חום_מרבית: valueFor(e, 'heat') ?? '',
  }));
  const name = `עצים_וחום_${lvl.labelPlural}`.replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('chcShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => {
    const street = valueFor(e, 'street');
    const priv = valueFor(e, 'private');
    const heat = valueFor(e, 'heat');
    const trees = street != null || priv != null
      ? `עצים: ${street != null ? `${street.toFixed(1)}% ציבורי` : 'אין נתון'}, ${priv != null ? `${priv.toFixed(1)}% פרטי` : 'אין נתון'}`
      : 'אין נתוני עצים';
    const heatText = heat != null ? `${heat > 0 ? '+' : ''}${heat.toFixed(1)}°C` : 'אין נתוני חום';
    return `${e.label}: ${trees}, ${heatText}`;
  });
  const text = `מידע איזורי על עצים וחום 🌳🌡️\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`chcPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of el('chcLevelPick').querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  for (const btn of document.querySelectorAll('.chc-metric-btn')) {
    btn.classList.toggle('active', state.activeMetrics.includes(btn.dataset.metric));
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`chcPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
    input.value = state.picks[i] || '';
  });
  el('chcCityFilterRow').hidden = state.level === 'city';
  el('chcCityFilter').value = state.cityFilter || '';
  updateCityRoster('');
  for (const btn of el('chcBoardOrderPick').querySelectorAll('.tc-level-btn')) {
    btn.textContent = lvl.orderWord[btn.dataset.order];
    btn.classList.toggle('active', btn.dataset.order === state.boardOrder);
  }
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
  renderBoard();
}

// Scoped to #chcLevelPick specifically - .tc-level-btn is reused for
// styling on the metric picker buttons below too (a different container,
// #chcMetricPick), and a global querySelectorAll('.tc-level-btn') here
// would also wire ITS clicks to this same handler, setting
// state.level = undefined (no data-level on a metric button) the moment
// someone toggled a metric instead of a level - a real bug, caught before
// shipping via a real click-through test, not by inspection.
el('chcLevelPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.picks = [null, null, null, null];
    state.cityFilter = null;
    syncUrl();
    renderAll();
  });
});

el('chcCityFilter').addEventListener('input', debounce(() => updateCityRoster(el('chcCityFilter').value), 120));
el('chcCityFilter').addEventListener('change', () => {
  const v = el('chcCityFilter').value.trim();
  state.cityFilter = v && levelEntries('city').some((e) => e.name === v) ? v : null;
  syncUrl();
  renderAll();
});

el('chcBoardOrderPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.boardOrder === btn.dataset.order) return;
    state.boardOrder = btn.dataset.order;
    syncUrl();
    renderAll();
  });
});

// Same toggle-membership idiom as canopy-map.html's own state.cityLayers
// (city-level multi-metric picker) - up to 3 active, never zero.
document.querySelectorAll('.chc-metric-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.metric;
    const i = state.activeMetrics.indexOf(id);
    if (i !== -1) {
      if (state.activeMetrics.length === 1) return; // never zero active metrics
      state.activeMetrics.splice(i, 1);
    } else {
      state.activeMetrics.push(id);
    }
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
