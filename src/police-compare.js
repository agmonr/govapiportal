/**
 * Entry point for police-compare.html - נתוני פשיעה, ערים ושכונות.
 *
 * Architecture follows canopy-heat-compare.js, not real-estate-compare.js:
 * both are "compare up to N + always-on national leaderboard + CSV/
 * WhatsApp", entirely batch-precomputed (tools/police_build.py ->
 * src/police-{cities,neighborhoods,meta}.js) - but unlike real-estate-
 * compare.js there is NO per-city lazy-fetched drill-down here (no
 * assets/police/<city>.json the way real estate has assets/deals/<city>.json)
 * - raw incident rows aren't meaningfully browsable one-by-one the way
 * individual property deals are, so a picked entity's own category/year
 * breakdown is rendered straight from the already-loaded aggregate instead
 * (renderCategoryBreakdown/renderYearTrend below).
 *
 * Two levels only (city, neighborhood - StatisticArea) - no third "street"
 * level, there is no street-equivalent in crime data.
 *
 * The pick UI is real-estate-compare.js's chip+datalist idiom (commitPick/
 * removePick/renderPickChips), not canopy-heat-compare.js's older fixed-
 * slot inputs - the newer idiom this repo has since standardized on.
 *
 * A THIRD section beyond compare+board: a category leaderboard (pick one
 * StatisticGroup, rank every entity at the current level by it), ported
 * from mortality-compare.js's renderCityMetricPicker/cityEntriesFor shape -
 * the answer to "how do these compare per offense type" without a 12-
 * segment stacked chart (no shared primitive in charts.js supports that).
 *
 * Every count-like number sourced from POLICE_CITIES/POLICE_NEIGHBORHOODS
 * (total, perCapita, categories, buckets, unattributed) is a PER-YEAR
 * AVERAGE (5-year sum / 5), decided with the user so the page reads as "a
 * typical year" rather than a 5-year cumulative pile - only `years` itself
 * stays per-year (it already was). renderCategoryBreakdown() below splits
 * the per-entity offense breakdown into 4 offense-family charts
 * (regulatory/violent/nonviolent/security - BUCKET_IDS in police-meta.js,
 * a product decision, not derived from the source) instead of one top-8
 * chart, per the same conversation.
 *
 * Board framing is deliberately NEUTRAL ("מהגבוה לנמוך"/"מהנמוך לגבוה", real-
 * estate-compare.js's own wording), NOT canopy-heat-compare.js's best/worst
 * framing - a crime count is confounded by privacy-suppressed small areas,
 * revisable case records, and "investigated not convicted", so asserting a
 * city is objectively "worse" isn't defensible the way "more canopy is
 * better" is. rankInCity() below states a rank as a fact ("5th of 40 by
 * total cases"), never as a judgment.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, renderBarChart, citySwatchCell } from './charts.js';
import { POLICE_CITIES } from './police-cities.js';
import { POLICE_NEIGHBORHOODS } from './police-neighborhoods.js';
import { STATISTIC_GROUPS, YEARS, YEAR_QUARTERS, NATIONAL_UNRESOLVED, BUCKET_IDS, BUCKET_LABELS, BUCKET_GROUPS } from './police-meta.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'police-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- on-page disclaimer numbers, computed from the loaded data
   itself rather than hand-typed, so they can never drift from what
   POLICE_CITIES/NATIONAL_UNRESOLVED actually say. ---------- */

function computeYearNote() {
  const partial = YEARS.filter((y) => YEAR_QUARTERS[y] < 4);
  el('pcYearNote').textContent = partial.length
    ? `לתשומת לב: נתוני ${partial.map((y) => `${y} (${YEAR_QUARTERS[y]} מתוך 4 רבעונים)`).join(', ')} חלקיים נכון למועד המשיכה מהמאגר, וכמו כל נתוני התיקים עשויים עוד להתעדכן.`
    : `כל ${YEARS.length} השנים (${YEARS[0]}–${YEARS[YEARS.length - 1]}) כוללות 4 רבעונים מלאים נכון למועד המשיכה מהמאגר.`;
}

function computeNationalNotes() {
  // total/unattributed here are already per-year averages (POLICE_CITIES'
  // own fields) - the RATIO is identical to the underlying 5-year sums'
  // ratio, but the absolute numbers are per-year, so the wording says so
  // explicitly. NATIONAL_UNRESOLVED, by contrast, is a deliberate 5-YEAR
  // raw total (a data-coverage fact about the whole pull, not a rate) -
  // worded separately so the two numbers are never read as the same kind
  // of figure.
  let total = 0;
  let unattributed = 0;
  for (const c of Object.values(POLICE_CITIES)) { total += c.total; unattributed += c.unattributed; }
  const pct = total ? Math.round((unattributed / total) * 1000) / 10 : 0;
  el('pcUnattributedNote').innerHTML = `בממוצע שנתי: ${num(unattributed)} תיקים (${pct}%) מתוך התיקים המשויכים לעיר <strong>אינם משויכים</strong> `
    + `לאף שכונה/אזור סטטיסטי - מופיעים בסה״כ של העיר בלבד. בנוסף, לאורך כל 5 השנים (2021–2025) יחד `
    + `${num(NATIONAL_UNRESOLVED.cases)} תיקים (${NATIONAL_UNRESOLVED.pct}%) אינם משויכים לאף עיר כלל, ולכן אינם מופיעים בדף זה בשום רמה.`;
}

computeYearNote();
computeNationalNotes();

/* ---------- metrics ---------- */

// Every count-like field in POLICE_CITIES/POLICE_NEIGHBORHOODS (total,
// perCapita, categories, buckets, unattributed) is a PER-YEAR AVERAGE
// (5-year sum / 5), not a 5-year total - see tools/police_build.py's own
// header comment on POLICE_CITIES. Only `years` itself stays per-year (it
// already was). Every label below says "ממוצע שנתי" for this reason.
const METRICS = {
  total: {
    label: 'ממוצע תיקים לשנה', unit: 'תיקים',
    valueForCity: (name) => POLICE_CITIES[name]?.total,
    valueForNb: (key) => POLICE_NEIGHBORHOODS[key]?.total,
  },
  perCapita: {
    label: 'תיקים לאלף תושבים (ממוצע שנתי)', unit: 'לאלף תושבים',
    valueForCity: (name) => POLICE_CITIES[name]?.perCapita,
    // No CBS population figure exists at StatisticArea granularity - same
    // "metric doesn't exist at this level" idiom as canopy-heat-compare.js's
    // own METRICS.private.valueForStreet.
    valueForNb: () => null,
  },
};
const METRIC_ORDER = ['total', 'perCapita'];

function valueForLevel(metric, level, key) {
  return level === 'city' ? metric.valueForCity(key) : metric.valueForNb(key);
}
function valueFor(entity, metricId) {
  return valueForLevel(METRICS[metricId], entity.level, entity.key);
}
function categoriesFor(entity) {
  return entity.level === 'city' ? POLICE_CITIES[entity.name]?.categories : POLICE_NEIGHBORHOODS[entity.key]?.categories;
}
function bucketsFor(entity) {
  return entity.level === 'city' ? POLICE_CITIES[entity.name]?.buckets : POLICE_NEIGHBORHOODS[entity.key]?.buckets;
}
function yearsFor(entity) {
  return entity.level === 'city' ? POLICE_CITIES[entity.name]?.years : POLICE_NEIGHBORHOODS[entity.key]?.years;
}
function entryUnattributed(entity) {
  return entity.level === 'city' ? (POLICE_CITIES[entity.name]?.unattributed ?? 0) : null;
}
function topCategory(entity) {
  const cats = categoriesFor(entity);
  if (!cats) return null;
  let bestIdx = -1;
  let bestVal = 0;
  cats.forEach((v, i) => { if (v > bestVal) { bestVal = v; bestIdx = i; } });
  return bestIdx === -1 ? null : { name: STATISTIC_GROUPS[bestIdx], value: bestVal };
}

/* ---------- levels ---------- */

function neighborhoodLabel(city, name) {
  return `${name} (${city})`;
}

const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:', boardTitle: 'ערים', maxPicks: 6,
    entries: () => Object.keys(POLICE_CITIES).map((name) => ({ key: name, label: name, name, city: name, level: 'city' })),
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:', boardTitle: 'שכונות', maxPicks: 6,
    entries: () => Object.keys(POLICE_NEIGHBORHOODS).map((key) => {
      const i = key.indexOf('::');
      const city = key.slice(0, i);
      const name = key.slice(i + 2);
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

// Same fixed-fade idiom as real-estate-compare.js's own PICK_PCTS, sized to
// this page's own maxPicks (6, not 10).
const PICK_PCTS = [100, 70, 45, 22, 15, 11];
function pickColor(i, base) {
  const pct = PICK_PCTS[i] ?? 11;
  return pct >= 100 ? base : `color-mix(in srgb, ${base} ${pct}%, var(--bg) ${100 - pct}%)`;
}
const pickColorFor = (i) => pickColor(i, 'var(--accent)');
const perCapitaColorFor = (i) => pickColor(i, 'var(--danger)');
const METRIC_COLOR_FOR = { total: pickColorFor, perCapita: perCapitaColorFor };

/* ---------- state + URL ---------- */

const VALID_LEVELS = ['city', 'neighborhood'];

const state = {
  level: 'city', picks: [], cityFilter: null, boardOrder: 'best', activeCategory: STATISTIC_GROUPS[0],
};

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (VALID_LEVELS.includes(p.get('level'))) state.level = p.get('level');
  const maxPicks = LEVELS[state.level]?.maxPicks || 0;
  state.picks = p.getAll('p').filter(Boolean).slice(0, maxPicks);
  if (p.get('city')) state.cityFilter = p.get('city');
  if (p.get('order') === 'worst') state.boardOrder = 'worst';
  if (STATISTIC_GROUPS.includes(p.get('cat'))) state.activeCategory = p.get('cat');
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v) => { if (v) p.append('p', v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  if (state.boardOrder === 'worst') p.set('order', 'worst');
  if (state.activeCategory !== STATISTIC_GROUPS[0]) p.set('cat', state.activeCategory);
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
  el('pcCityRoster').innerHTML = hits.slice(0, 40).map((n) => `<option value="${esc(n)}">`).join('');
}

function updateRosterOptions(query) {
  const top = candidateEntries(query).filter((e) => !state.picks.includes(e.label)).slice(0, 40);
  el('pcRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = candidateEntries('');
  if (state.cityFilter) {
    const scoped = all.filter((e) => e.city === state.cityFilter).length;
    el('pcRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(all.length)}) — <button type="button" id="pcClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('pcClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('pcRosterHint').textContent = `${num(all.length)} ${lvl.labelPlural} סה״כ`;
  }
}

/* ---------- comparison (up to LEVELS[level].maxPicks picks) ---------- */

function renderCompareTable(entries) {
  const isCity = state.level === 'city';
  const rows = entries.map((e, i) => {
    const total = valueFor(e, 'total');
    const perCap = valueFor(e, 'perCapita');
    const top = topCategory(e);
    return `
    <tr>
      ${citySwatchCell(e.label, pickColorFor(i))}
      <td>${total != null ? num(total) : '—'}</td>
      <td>${perCap != null ? num(perCap) : '—'}</td>
      <td dir="auto">${top ? `${esc(top.name)} (${num(top.value)})` : '—'}</td>
      ${isCity ? `<td>${num(entryUnattributed(e) ?? 0)}</td>` : ''}
    </tr>`;
  }).join('');
  el('pcTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">${esc(METRICS.total.label)}</th>
          <th scope="col">${esc(METRICS.perCapita.label)}</th>
          <th scope="col">סוג עבירה מוביל (שורות/שנה בממוצע)</th>
          ${isCity ? '<th scope="col">לא משויך לשכונה (ממוצע שנתי)</th>' : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderCompareCharts(entries) {
  const container = el('pcCompareCharts');
  container.innerHTML = METRIC_ORDER.map((_, i) => `<figure id="pc-compare-${i}" class="acc-chart acc-chart-wide" role="img"></figure>`).join('');
  METRIC_ORDER.forEach((metricId, i) => {
    const figId = `pc-compare-${i}`;
    const m = METRICS[metricId];
    const colorFor = METRIC_COLOR_FOR[metricId];
    const chartEntries = entries
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => valueFor(e, metricId) != null)
      .map(({ e, idx }) => ({ label: e.label, value: valueFor(e, metricId), color: colorFor(idx) }));
    renderHBarChart(figId, `${m.label}${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, m.unit);
  });
}

// Where an entity ranks among every other entity of the same level IN ITS
// OWN CITY, per metric - "5th of 40 neighborhoods in Netanya by total
// cases" rather than a national rank. States a fixed fact (rank 1 = most
// cases), not a "best"/"worst" judgment - see this file's own top docstring
// for why that framing is deliberately avoided here.
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
  const box = el('pcRanks');
  const lines = entries.map((e) => {
    const ranks = rankInCity(e);
    if (!ranks) return null;
    const parts = METRIC_ORDER.filter((id) => ranks[id]).map((id) => {
      const r = ranks[id];
      return `מקום ${r.rank} מתוך ${num(r.total)} ב${METRICS[id].label} (${num(r.value)})`;
    });
    return parts.length ? `<p dir="auto"><strong>${esc(e.label)}</strong> בתוך ${esc(e.city)}: ${parts.join(' · ')}</p>` : null;
  }).filter(Boolean);
  box.innerHTML = lines.join('');
}

/* ---------- category breakdown - per picked entity, one hbar chart PER
   OFFENSE-FAMILY BUCKET (regulatory/violent/nonviolent/security - see
   BUCKET_IDS/BUCKET_GROUPS/BUCKET_LABELS in police-meta.js, a product
   decision made with the user, not derived from the source), each bar a
   member StatisticGroup's own average-per-year row count. Replaces the
   single top-8-plus-"אחר" chart this section used to render - with only
   3-5 members per bucket there's no need to truncate, every member group
   gets its own bar. The 3 EXCLUDED_GROUPS (שאר עבירות/שגיאת הזנה/סעיפי
   הגדרה) appear in neither this section nor any bucket - not real offense
   categories or too small to matter (see police-meta.js's own comment).
   Replaces real-estate-compare.js's lazy per-city deals section - this is
   synchronous, no fetch, the data is already in the loaded module. ------- */

const STATISTIC_GROUP_INDEX = new Map(STATISTIC_GROUPS.map((g, i) => [g, i]));

function renderCategoryBreakdown(entries) {
  const container = el('pcCategoryBreakdown');
  container.innerHTML = entries.flatMap((_, ei) => BUCKET_IDS.map((bid, bi) =>
    `<figure id="pc-cat-${ei}-${bi}" class="acc-chart acc-chart-wide" role="img"></figure>`)).join('');
  entries.forEach((e, ei) => {
    const cats = categoriesFor(e) || [];
    const bucketTotals = bucketsFor(e) || [];
    BUCKET_IDS.forEach((bid, bi) => {
      const bars = BUCKET_GROUPS[bid]
        .map((groupName) => ({ label: groupName, value: cats[STATISTIC_GROUP_INDEX.get(groupName)] || 0 }))
        .filter((p) => p.value > 0)
        .sort((a, b) => b.value - a.value);
      renderHBarChart(`pc-cat-${ei}-${bi}`,
        `${e.label} — ${BUCKET_LABELS[bid]} (ממוצע שנתי: ${num(bucketTotals[bi] || 0)})`, bars, 'שורות/שנה');
    });
  });
}

/* ---------- year trend - one bar chart per picked entity, distinct-case
   counts per year. A year with fewer than 4 quarters observed (see
   YEAR_QUARTERS) is marked `active` so renderBarChart highlights it. ---- */

function renderYearTrend(entries) {
  const container = el('pcYearTrend');
  container.innerHTML = entries.map((_, i) => `<figure id="pc-year-${i}" class="acc-chart" role="img"></figure>`).join('');
  entries.forEach((e, i) => {
    const yearsVec = yearsFor(e) || [];
    const chartEntries = YEARS.map((y, yi) => ({ label: y, value: yearsVec[yi] || 0, active: YEAR_QUARTERS[y] < 4 }));
    renderBarChart(`pc-year-${i}`, `${e.label} — תיקים לפי שנה`, chartEntries, 'תיקים');
  });
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('pcWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('pcCompareSection');
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;

  renderCompareCharts(entries);
  renderCompareTable(entries);
  renderRanks(entries);
  renderCategoryBreakdown(entries);
  renderYearTrend(entries);
}

/* ---------- national leaderboard - every entity at the current level,
   unscoped by picks, chunked across animation frames (same reasoning/idiom
   as real-estate-compare.js's own renderBoardChartChunked). ---------- */

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
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (r.value / peak) * 100 : 0}%;background:${metricId === 'perCapita' ? 'var(--danger)' : 'var(--accent)'}"></div></div>
      <span class="acc-hbar-v">${num(r.value)}</span>
    </div>`);
  renderBoardChartChunked(figId, `${num(capped.length)} ${labelPlural}, ${orderWord} לפי ${m.label}${capNote}`, rowsHtml);
}

// When exactly one city is picked at city level, its own neighborhoods are
// shown first, ahead of the national city list - same idiom as real-
// estate-compare.js's own singlePickedCity().
function singlePickedCity() {
  if (state.level !== 'city') return null;
  const picked = state.picks.filter(Boolean);
  return picked.length === 1 && POLICE_CITIES[picked[0]] ? picked[0] : null;
}

function renderBoard() {
  const lvl = LEVELS[state.level];
  let entries = levelEntries(state.level);
  const scopeNote = [];
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    scopeNote.push(`מוצג בתוך ${state.cityFilter} בלבד`);
  }
  el('pcBoardHint').textContent = scopeNote.join(' · ');

  const cityForNb = singlePickedCity();
  el('pcBoardLevel').textContent = 'דירוג ארצי';

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

  const container = el('pcBoardCharts');
  container.innerHTML = groups.map((g) => `
    <details class="notice info">
      <summary><strong dir="auto">${esc(g.title)}</strong></summary>
      ${METRIC_ORDER.map((_, i) => `<figure id="pc-board-${g.id}-${i}" class="acc-chart acc-chart-wide tc-board-scroll" role="img"></figure>`).join('')}
    </details>`).join('');

  groups.forEach((g) => {
    METRIC_ORDER.forEach((metricId, i) => {
      renderMetricBoard(`pc-board-${g.id}-${i}`, metricId, g.entries, { labelPlural: g.title, capAll: g.capAll });
    });
  });
}

/* ---------- category leaderboard - pick one StatisticGroup, rank every
   entity at the current level by it. Ports mortality-compare.js's
   renderCityMetricPicker/cityEntriesFor shape (there: pick one health
   metric; here: pick one offense category) - the answer to "compare table
   column per StatisticGroup" made interactive instead of a static 12/15-
   column table. ---------- */

function renderCategoryPicker() {
  const box = el('pcCategoryPick');
  box.innerHTML = STATISTIC_GROUPS.map((g) => `<button type="button" data-cat="${esc(g)}" class="tc-level-btn${g === state.activeCategory ? ' active' : ''}">${esc(g)}</button>`).join('');
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.activeCategory === btn.dataset.cat) return;
      state.activeCategory = btn.dataset.cat;
      syncUrl();
      renderCategoryBoard();
    });
  });
}

function categoryEntriesFor(level, categoryName) {
  const gi = STATISTIC_GROUPS.indexOf(categoryName);
  if (gi === -1) return [];
  return levelEntries(level)
    .map((e) => {
      const cats = categoriesFor(e);
      return cats ? { label: e.label, value: cats[gi] || 0 } : null;
    })
    .filter((r) => r && r.value > 0);
}

function renderCategoryBoard() {
  renderCategoryPicker();
  const lvl = LEVELS[state.level];
  const entries = categoryEntriesFor(state.level, state.activeCategory).sort((a, b) => b.value - a.value);
  const capped = state.level === 'city' ? entries : entries.slice(0, BOARD_CAP);
  const capNote = capped.length < entries.length ? ` (${num(BOARD_CAP)} מתוך ${num(entries.length)})` : '';
  el('pcCategoryHint').textContent = `${num(entries.length)} מתוך ${num(levelEntries(state.level).length)} ${lvl.labelPlural} עם תיקים מסוג "${state.activeCategory}" (ממוצע שנתי)`;
  const peak = Math.max(0, ...capped.map((r) => r.value));
  const rowsHtml = capped.map((r) => `
    <div class="acc-hbar" title="${esc(r.label)}: ${num(r.value)}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (r.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(r.value)}</span>
    </div>`);
  renderBoardChartChunked('pcCategoryBoardChart', `${num(capped.length)} ${lvl.labelPlural}, מהגבוה לנמוך לפי "${state.activeCategory}" (ממוצע שנתי)${capNote}`, rowsHtml);
}

/* ---------- CSV ---------- */

// All numeric columns here are per-year averages, not 5-year totals (see
// METRICS' own header comment above) - field names say so explicitly so a
// spreadsheet-literate visitor doesn't mistake them for raw totals.
const BUCKET_FIELD_NAMES = BUCKET_IDS.map((bid) => `ממוצע_שנתי_${bid}`);

el('pcCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const fields = [lvl.label, 'עיר', 'ממוצע_תיקים_לשנה', 'תיקים_לאלף_תושבים_ממוצע_שנתי',
    ...BUCKET_FIELD_NAMES, ...STATISTIC_GROUPS, 'לא_משויך_לשכונה_ממוצע_שנתי'];
  const records = entries.map((e) => {
    const cats = categoriesFor(e) || [];
    const buckets = bucketsFor(e) || [];
    const rec = {
      [lvl.label]: e.label,
      עיר: e.city || '',
      ממוצע_תיקים_לשנה: valueFor(e, 'total') ?? '',
      תיקים_לאלף_תושבים_ממוצע_שנתי: valueFor(e, 'perCapita') ?? '',
      לא_משויך_לשכונה_ממוצע_שנתי: entryUnattributed(e) ?? '',
    };
    BUCKET_IDS.forEach((bid, i) => { rec[BUCKET_FIELD_NAMES[i]] = buckets[i] ?? 0; });
    STATISTIC_GROUPS.forEach((g, i) => { rec[g] = cats[i] ?? 0; });
    return rec;
  });
  const name = `נתוני_פשיעה_${lvl.labelPlural}`.replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('pcShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => {
    const total = valueFor(e, 'total');
    const perCap = valueFor(e, 'perCapita');
    const totalText = total != null ? `${num(total)} תיקים לשנה בממוצע` : 'אין נתון';
    const perCapText = perCap != null ? `${num(perCap)} לאלף תושבים` : 'אין נתון לנפש';
    return `${e.label}: ${totalText} (${perCapText})`;
  });
  const text = `נתוני פשיעה 🚔\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring - picks: one persistent "add" input + roster datalist +
   removable chips, same idiom as real-estate-compare.js's own recPick. --- */

function showPickConfirm(ok) {
  const confirmEl = el('pcPickConfirm');
  if (!confirmEl) return;
  clearTimeout(confirmEl._timer);
  confirmEl.classList.remove('tc-pick-confirm-show');
  if (!ok) return;
  confirmEl.textContent = '✓ נוסף';
  void confirmEl.offsetWidth;
  confirmEl.classList.add('tc-pick-confirm-show');
  confirmEl._timer = setTimeout(() => confirmEl.classList.remove('tc-pick-confirm-show'), 1500);
}

function renderPickChips() {
  const chips = el('pcPickChips');
  if (!state.picks.length) { chips.hidden = true; chips.innerHTML = ''; return; }
  chips.hidden = false;
  chips.innerHTML = state.picks.map((label, i) => `
    <span class="cm-chip" style="border-color:${pickColorFor(i)}">
      <span class="acc-legend-swatch" style="background:${pickColorFor(i)}"></span>
      <span dir="auto">${esc(label)}</span>
      <button type="button" class="cm-chip-remove" data-idx="${i}" aria-label="הסרה">✕</button>
    </span>`).join('');
  chips.querySelectorAll('.cm-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => removePick(Number(btn.dataset.idx)));
  });
}

function removePick(i) {
  state.picks.splice(i, 1);
  syncUrl();
  renderPickChips();
  updateRosterOptions(el('pcPick').value);
  renderCompare();
}

function commitPick() {
  const input = el('pcPick');
  const lvl = LEVELS[state.level];
  const label = input.value.trim();
  const known = label && labelMap(state.level).has(label);
  if (known && state.picks.length < lvl.maxPicks && !state.picks.includes(label)) {
    state.picks.push(label);
    syncUrl();
    renderPickChips();
    renderCompare();
  }
  input.value = '';
  el('pcRoster').innerHTML = '';
  showPickConfirm(known);
  updateRosterOptions('');
}

function renderAll() {
  for (const btn of el('pcLevelPick').querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }

  const lvl = LEVELS[state.level];
  el('pcPickLabel').textContent = lvl.pickLabel;
  el('pcPickHint').textContent = `הקלידו ${lvl.label} והקישו Enter (או בחרו מהרשימה) כדי להוסיף להשוואה - עד ${lvl.maxPicks} בבת אחת.`;
  el('pcPick').value = '';
  el('pcRoster').innerHTML = '';
  renderPickChips();
  el('pcCityFilterRow').hidden = state.level === 'city';
  el('pcCityFilter').value = state.cityFilter || '';
  updateCityRoster('');
  for (const btn of el('pcBoardOrderPick').querySelectorAll('.tc-level-btn')) {
    btn.classList.toggle('active', btn.dataset.order === state.boardOrder);
  }
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
  renderBoard();
  renderCategoryBoard();
}

el('pcLevelPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.picks = [];
    state.cityFilter = null;
    syncUrl();
    renderAll();
  });
});

el('pcCityFilter').addEventListener('input', debounce(() => updateCityRoster(el('pcCityFilter').value), 120));
el('pcCityFilter').addEventListener('change', () => {
  const v = el('pcCityFilter').value.trim();
  state.cityFilter = v && levelEntries('city').some((e) => e.name === v) ? v : null;
  syncUrl();
  renderAll();
});

el('pcPick').addEventListener('input', debounce((ev) => updateRosterOptions(ev.target.value), 120));
el('pcPick').addEventListener('change', commitPick);
el('pcPick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitPick(); } });

el('pcBoardOrderPick').querySelectorAll('.tc-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.boardOrder === btn.dataset.order) return;
    state.boardOrder = btn.dataset.order;
    syncUrl();
    renderAll();
  });
});

readStateFromUrl();
renderAll();
