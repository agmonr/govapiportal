/**
 * Entry point for tree-canopy.html - כמה ירוקה העיר שלי.
 *
 * Unlike every other page here, the source data (a 358MB national tree-
 * canopy shapefile) has no API at all - see tools/canopy_build.py, which
 * computes canopy coverage locally, once, against city boundaries (GovMap),
 * OSM-mapped neighborhoods and OSM streets (7.5m buffer, matching the source
 * dataset's own stated methodology). Only those three small computed tables
 * ship here; the raw shapefile stays local and gitignored.
 *
 * All three levels share one UI: pick two entities of the same level (city,
 * neighborhood or street), compare their canopy %, and see a leaderboard.
 * Because a street/neighborhood name repeats across many cities (there is a
 * "הרצל" in nearly every city), every level other than "city" is searched as
 * "name (city)" and keyed the same way in the underlying data.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { CITY_CANOPY } from './tree-canopy-cities.js';
import { NEIGHBORHOOD_CANOPY } from './tree-canopy-neighborhoods.js';
import { STREET_CANOPY } from './tree-canopy-streets.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'tree-canopy')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- levels: one shape, three sources ---------- */

// boardTitle/rankedWord: "ערים"/"שכונות" are grammatically feminine
// (מובילות/מדורגות agrees), but "רחובות" is masculine (needs מובילים/
// מדורגים) - both leaderboard strings below (the h2 and renderBoard's own
// chart caption) read off these per-level rather than one fixed adjective
// for all three, so the streets leaderboard doesn't read as a grammar error.
const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:',
    boardTitle: 'ערים מובילות', rankedWord: 'מדורגות',
    entries: () => Object.entries(CITY_CANOPY).map(([name, v]) => ({
      key: name, label: name, name, city: name, pct: v.pct, areaM2: v.cityAreaM2,
      canopyAreaM2: v.canopyAreaM2, treeCount: v.treeCount,
    })),
  },
  // "city" and "name" are not stored per-row - both live only in the key
  // ("city::name"), which halves the file size for these two (a street or
  // neighborhood name repeats across many cities, so storing it twice per
  // row - once in the key, once in the value - was pure duplication).
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:',
    boardTitle: 'שכונות מובילות', rankedWord: 'מדורגות',
    // Some neighborhoods have no real OSM boundary, only a named point -
    // their "area" is a Voronoi cell built around that point and clipped to
    // the city (see tools/canopy_build.py), not a verified shape. That
    // distinction used to be spelled out per-name ("(עיר, משוער)"), which
    // repeated on every such neighborhood across the roster, chart and
    // table alike - covered once, in full, in the "מה יש כאן" methodology
    // notice instead now.
    entries: () => Object.entries(NEIGHBORHOOD_CANOPY).map(([key, v]) => {
      const [city, name] = key.split('::');
      return {
        key, label: `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`, name, city, pct: v.pct,
        areaM2: v.areaM2, canopyAreaM2: v.canopyAreaM2, treeCount: v.treeCount,
      };
    }),
  },
  street: {
    label: 'רחוב', labelPlural: 'רחובות', pickLabel: 'רחוב:',
    boardTitle: 'רחובות מובילים', rankedWord: 'מדורגים',
    entries: () => Object.entries(STREET_CANOPY).map(([key, v]) => {
      const [city, name] = key.split('::');
      // `nb` (the neighborhood the street's centroid falls in) is display-
      // only - it comes from tools/canopy_build.py's own neighborhood
      // geometries (real polygons + Voronoi cells), not from any canopy
      // computation, and is absent for a street outside every known
      // neighborhood rather than guessed at.
      return {
        key, label: `${name}, ${city}${v.nb ? ` (${v.nb})` : ''}`, name, city, pct: v.pct,
        areaM2: v.bufferAreaM2, canopyAreaM2: v.canopyAreaM2, treeCount: v.treeCount,
      };
    }),
  },
};

// Built once per level on first use - a street's 36k rows are cheap to hold
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

/**
 * A zero is usually a data gap (see canopy_area_within's docstring) - but
 * for a NEIGHBORHOOD specifically, a zero stops being ambiguous once its own
 * city clearly has canopy somewhere: the survey demonstrably reached that
 * city, so a sub-area of it reading zero is a real "no canopy detected
 * here" (an industrial zone, a brand-new development with no mature trees
 * yet), not evidence the survey missed it. Cities and streets keep the
 * blanket exclusion - a city is never "inside" something bigger to check
 * against, and a street's buffer is narrow enough that "the city has
 * canopy" says nothing about that one strip of it.
 */
function isCredible(level, e) {
  if (e.treeCount > 0) return true;
  return level === 'neighborhood' && Boolean(CITY_CANOPY[e.city]?.treeCount > 0);
}

// A gradient of one color rather than four unrelated hues - same identity-
// color idiom as CITY_COLOR_MAIN/COMPARE elsewhere on the site (solid accent
// for the "main" entity, a fainter tint for "compare"), just carried out to
// four steps instead of two.
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

/* ---------- roster (datalist), filtered live rather than holding 36k <option>s ---------- */

/**
 * Matches on the entity's own name rank before matches that only hit
 * because the CITY name happens to contain the query - without this,
 * typing "הרצל" (a street name common to dozens of cities) got swamped by
 * every street in "הרצליה", whose city name contains "הרצל" as a
 * substring. Both kinds of match stay available (typing a city name is a
 * legitimate way to browse its streets/neighborhoods), just ordered so the
 * likely intent wins the visible slice.
 */
function candidateEntries(query) {
  // A zero is left off the pick list unless isCredible() says it's a real
  // zero, not a data gap - see its docstring for when that's the case.
  let candidates = levelEntries(state.level).filter((e) => isCredible(state.level, e));
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
  el('tcRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = levelEntries(state.level);
  const withTrees = all.filter((e) => isCredible(state.level, e));
  const excludedNote = all.length > withTrees.length
    ? ` (${num(all.length - withTrees.length)} ללא חופה שזוהתה כלל אינן ברשימה)` : '';
  if (state.cityFilter) {
    const scoped = withTrees.filter((e) => e.city === state.cityFilter).length;
    el('tcRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(withTrees.length)})${esc(excludedNote)} — <button type="button" id="tcClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('tcClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('tcRosterHint').textContent = `${num(withTrees.length)} ${lvl.labelPlural} סה״כ${excludedNote}`;
  }
}

/* ---------- comparison ---------- */

// Only the % - the number this whole page is about - shows by default;
// area/canopy-area/tree-count sit in an expandable row per entity, same
// "expandable" table idiom already used by portal.js/moag-explorer.js for
// their own per-row detail (there: a dataset's files; here: everything
// besides the headline %).
function renderCompareTable(entries) {
  const rows = entries.map((e, i) => `
    <tr class="has-files" data-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${e.pct.toFixed(2)}%</td>
    </tr>
    <tr class="files-row" data-files="${i}" hidden>
      <td colspan="3">
        <dl class="ck-facts" dir="auto">
          <dt>שטח (דונם)</dt><dd>${num(Math.round(e.areaM2 / 1000))}</dd>
          <dt>שטח חופה (מ״ר)</dt><dd>${num(Math.round(e.canopyAreaM2))}</dd>
          <dt>חופות שזוהו</dt><dd>${num(e.treeCount)}</dd>
        </dl>
      </td>
    </tr>`).join('');
  el('tcTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">כיסוי (%)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  el('tcTable').querySelectorAll('tr.has-files').forEach((tr) => {
    const toggle = () => {
      const target = el('tcTable').querySelector(`tr[data-files="${tr.dataset.row}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

// Every selected city (not just the first) gets its own drill-in pair, so
// comparing 4 cities lets you jump into any one of them, not only pick #1.
function renderDrill(entries) {
  const section = el('tcDrillSection');
  if (state.level !== 'city' || !entries.length) { section.hidden = true; return; }
  section.hidden = false;
  el('tcDrillBtns').innerHTML = entries.map((e, i) => `
    <span class="tc-drill-group">
      <span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>
      <button type="button" data-idx="${i}" data-drill="neighborhood">שכונות של <span dir="auto">${esc(e.label)}</span> ←</button>
      <button type="button" data-idx="${i}" data-drill="street">רחובות של <span dir="auto">${esc(e.label)}</span> ←</button>
    </span>`).join('');
  el('tcDrillBtns').querySelectorAll('button[data-drill]').forEach((btn) => {
    const e = entries[Number(btn.dataset.idx)];
    btn.addEventListener('click', () => drillInto(btn.dataset.drill, e.label));
  });
}

function drillInto(level, cityName) {
  state.level = level;
  state.cityFilter = cityName;
  const top = levelEntries(level).filter((e) => e.city === cityName).sort((x, y) => y.pct - x.pct);
  state.picks = [top[0]?.label || null, top[1]?.label || null, null, null];
  syncUrl();
  renderAll();
}

// A single city (not a multi-city comparison, and not already at the
// street/neighborhood level - drilling in there via "צלילה פנימה" already
// gets its own full leaderboard below) gets a quick answer to the obvious
// next question - which of ITS OWN streets are greenest - without leaving
// the city level or waiting for the page-wide (national) leaderboard
// further down, which ranks every city's streets against each other, not
// one city's against itself.
const TOP_STREETS_N = 10;
function renderTopStreets(entries) {
  const section = el('tcTopStreetsSection');
  if (state.level !== 'city' || entries.length !== 1) { section.hidden = true; return; }
  const cityName = entries[0].label;
  const streets = levelEntries('street').filter((e) => e.city === cityName && isCredible('street', e));
  if (!streets.length) { section.hidden = true; return; }
  section.hidden = false;
  el('tcTopStreetsCity').textContent = cityName;
  const top = [...streets].sort((a, b) => b.pct - a.pct).slice(0, TOP_STREETS_N);
  // e.name (just the street) rather than e.label (which repeats the city
  // and neighborhood already named in this section's own heading).
  const chartEntries = top.map((e) => ({ label: e.name, value: Number(e.pct.toFixed(1)) }));
  renderHBarChart('tcTopStreetsChart', `${num(top.length)} רחובות מובילים בכיסוי חופות עצים${top.length < streets.length ? ` (מתוך ${num(streets.length)})` : ''}`, chartEntries, '%');
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('tcWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('tcCompareSection');
  if (!entries.length) {
    section.hidden = true;
    renderDrill([]);
    el('tcTopStreetsSection').hidden = true;
    return;
  }
  section.hidden = false;

  const chartEntries = entries.map((e, i) => ({ label: e.label, value: Number(e.pct.toFixed(1)), color: PICK_COLORS[i] }));
  renderHBarChart('tcChart', `אחוז כיסוי חופות עצים${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, '%');
  renderCompareTable(entries);
  renderDrill(entries);
  renderTopStreets(entries);
}

/* ---------- leaderboard (own renderer - see why below) ---------- */

// The shared renderHBarChart (charts.js) builds one HTML string and writes
// it in a single innerHTML - fine for the handful of rows every other
// caller ever passes, but the street level here can rank ~27,700 entries
// with any detected canopy at all: one synchronous write of that many rows
// measured a ~3.3s visible freeze on click. This appends in chunks across
// animation frames instead - the first chunk is on screen almost instantly,
// the rest fills in shortly after without blocking input. Cities/
// neighborhoods (hundreds of rows) finish in their first chunk regardless,
// so this is a strict improvement for them too, not a special case.
const BOARD_CHUNK = 300;
let boardRenderGen = 0; // guards against a stale chunked render still
// appending rows after the level/city-filter changed and reset the figure

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
    if (myGen !== boardRenderGen) return; // a newer render superseded this one
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
  el('tcBoardLevel').textContent = lvl.boardTitle;
  let entries = levelEntries(state.level);
  const scopeNote = [];
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    scopeNote.push(`מוצג בתוך ${state.cityFilter} בלבד`);
  }
  // Same isCredible() rule as the pick list - a neighborhood's zero is kept
  // (and can legitimately rank last) once its own city is known to have
  // canopy somewhere; a city or street's zero stays excluded as a data gap.
  const withTrees = entries.filter((e) => isCredible(state.level, e));
  scopeNote.push(`${num(entries.length - withTrees.length)} מתוך ${num(entries.length)} ללא חופה שזוהתה כלל - לא נכללות`);
  el('tcBoardHint').textContent = scopeNote.join(' · ');

  // Cities (only 186) show every one of them - the box already scrolls.
  // Neighborhoods (1,283) and streets (~27,700 with any detected canopy)
  // cap at 100: rendering all of either is real, felt work for a
  // leaderboard nobody reads past the first screenful of anyway.
  const BOARD_CAP = 100;
  const sorted = [...withTrees].sort((x, y) => y.pct - x.pct);
  const capped = state.level === 'city' ? sorted : sorted.slice(0, BOARD_CAP);
  const ranked = capped.map((e) => ({ label: e.label, value: Number(e.pct.toFixed(1)) }));
  const capNote = capped.length < sorted.length ? ` (${num(BOARD_CAP)} מתוך ${num(sorted.length)})` : '';
  renderBoardChart('tcBoardChart', `${num(ranked.length)} ${lvl.labelPlural} ${lvl.rankedWord} לפי אחוז כיסוי חופות עצים${capNote}`, ranked, '%');
}

/* ---------- CSV ---------- */

el('tcCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  let entries = levelEntries(state.level);
  if (state.cityFilter) entries = entries.filter((e) => e.city === state.cityFilter);
  const fields = [lvl.label, 'עיר', 'כיסוי_אחוז', 'שטח_דונם', 'שטח_חופה_מר', 'חופות'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label, עיר: e.city || '', כיסוי_אחוז: e.pct,
    שטח_דונם: Math.round(e.areaM2 / 1000), שטח_חופה_מר: Math.round(e.canopyAreaM2), חופות: e.treeCount,
  }));
  const name = `כיסוי_חופות_${lvl.labelPlural}${state.cityFilter ? `_${state.cityFilter}` : ''}`
    .replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

// The comparison itself is already shareable as a link - every pick lives in
// the URL via syncUrl() - so this only has to build readable WhatsApp text
// around location.href, not any state of its own. Same wa.me pattern
// area-cleanup.js already uses for its own WhatsApp share, minus the
// image/navigator.share complexity that page needs and this one does not
// (there is no canvas/PDF here, just a link).
el('tcShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => `${e.label}: ${e.pct.toFixed(1)}% כיסוי חופות`);
  const text = `כמה ירוקה העיר שלי? 🌳\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`tcPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of document.querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`tcPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
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

pickInputs.forEach((input, i) => {
  input.addEventListener('input', debounce(() => updateRosterOptions(input.value), 120));
  const commit = () => { state.picks[i] = input.value.trim() || null; syncUrl(); renderCompare(); };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
});

readStateFromUrl();
renderAll();
