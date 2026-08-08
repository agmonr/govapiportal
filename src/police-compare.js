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
import { renderHBarChart, renderMultiSeriesChart, citySwatchCell } from './charts.js';
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

// Every STATISTIC_GROUPS name starts with "עבירות " (one exception: "שאר
// עבירות" carries it as a trailing word instead) - redundant once it's one
// option/row among many that's already understood to be about offenses
// (compare section body, category picker). Section captions/headings keep
// the full word; this is body rows and picker options only.
const stripOffensesWord = (name) => name.replace(/^עבירות\s+/, '').replace(/\s+עבירות$/, '');

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

/* ---------- category order (shared by the "דירוג לפי סוג עבירה" picker
   below and renderCategoryBreakdown's own charts in the compare section, so
   both list offense categories in the same reading order) ---------- */

// Display order for the category-breakdown charts (a reading-order
// preference, not a data concern) - BUCKET_IDS itself stays whatever
// tools/police_build.py generated it as (regulatory/violent/nonviolent/
// security), since that array's order is also what indexes into every
// entity's own parallel `buckets` totals - reordering it here instead of
// there avoids a full data regenerate (a network fetch against data.gov.il)
// for what's purely a chart-order preference.
const CATEGORY_DISPLAY_ORDER = ['security', 'violent', 'nonviolent', 'regulatory'];

// Same reading-order-only reordering as CATEGORY_DISPLAY_ORDER above, one
// level down: which of a bucket's own member groups comes first. Falls
// back to BUCKET_GROUPS[bid]'s own (generated) order for any bucket with
// no override here - only 'violent' has one so far.
const GROUP_DISPLAY_ORDER = {
  violent: ['עבירות נגד אדם', 'עבירות מין', 'עבירות נגד גוף'],
};

// "דירוג לפי סוג עבירה" picker's own category list: same bucket/group
// reading order as renderCategoryBreakdown above, "עבירות נגד אדם" moved to
// the front (also the default active category, since that's just
// CATEGORY_BOARD_GROUPS[0] - user request), not touching
// CATEGORY_DISPLAY_ORDER/GROUP_DISPLAY_ORDER itself since those also drive
// the compare section's own bucket order, unrelated to this picker's
// default. "שאר עבירות" (a real, non-negligible catch-all - unlike
// "סעיפי הגדרה"/"שגיאת הזנה", dropped entirely as definition-bookkeeping
// and data-entry-error rows, not real offense categories) is no longer
// offered here either (user request).
const CATEGORY_BOARD_GROUPS = (() => {
  const all = CATEGORY_DISPLAY_ORDER.flatMap((bid) => GROUP_DISPLAY_ORDER[bid] || BUCKET_GROUPS[bid]);
  return ['עבירות נגד אדם', ...all.filter((g) => g !== 'עבירות נגד אדם')];
})();

// renderBoard's own "שכונות ב<city>" group (shown only when singlePickedCity()
// is truthy) - a small metric picker scoped to that one board, letting it
// rank the city's own neighborhoods by a violent-offense category or their
// combined total, not just METRIC_ORDER[0]'s fixed "כל סוגי התיקים" total
// (user request, replacing the page's old separate per-neighborhood
// violent-category chart with an interactive single-metric ranking
// instead). 'total' (the previous fixed behavior) stays the default so
// nothing regresses for anyone not using the new picker.
const NB_METRIC_IDS = ['total', 'violentTotal', ...(GROUP_DISPLAY_ORDER.violent || BUCKET_GROUPS.violent)];

/* ---------- state + URL ---------- */

const VALID_LEVELS = ['city', 'neighborhood'];

const DEFAULT_CITY_PICKS = ['ירושלים', 'תל אביב יפו', 'חיפה', 'באר שבע'];

const state = {
  level: 'city', picks: [...DEFAULT_CITY_PICKS], cityFilter: null, boardOrder: 'best', activeCategory: CATEGORY_BOARD_GROUPS[0],
  nbMetric: NB_METRIC_IDS[0],
};

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (VALID_LEVELS.includes(p.get('level'))) state.level = p.get('level');
  const maxPicks = LEVELS[state.level]?.maxPicks || 0;
  state.picks = p.has('p') ? p.getAll('p').filter(Boolean).slice(0, maxPicks)
    : (state.level === 'city' ? DEFAULT_CITY_PICKS.slice(0, maxPicks) : []);
  if (p.get('city')) state.cityFilter = p.get('city');
  if (p.get('order') === 'worst') state.boardOrder = 'worst';
  if (CATEGORY_BOARD_GROUPS.includes(p.get('cat'))) state.activeCategory = p.get('cat');
  if (NB_METRIC_IDS.includes(p.get('nbm'))) state.nbMetric = p.get('nbm');
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v) => { if (v) p.append('p', v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  if (state.boardOrder === 'worst') p.set('order', 'worst');
  if (state.activeCategory !== CATEGORY_BOARD_GROUPS[0]) p.set('cat', state.activeCategory);
  if (state.nbMetric !== NB_METRIC_IDS[0]) p.set('nbm', state.nbMetric);
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
      <td dir="auto">${top ? `${esc(stripOffensesWord(top.name))} (${num(top.value)})` : '—'}</td>
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
  // A single bar filling its own chart end-to-end (nothing to compare it
  // against) says nothing a plain number doesn't already say better - and
  // the per-1000 rate would just be a second, unrelated-looking stat with
  // the same problem, so only the raw total prints here as text instead
  // (user request: no graph, and no per-1000 figure, for a single pick).
  if (entries.length === 1) {
    const total = valueFor(entries[0], 'total');
    container.innerHTML = `<p class="acc-hint" dir="auto">${esc(METRICS.total.label)}: ${total != null ? `<strong>${num(total)}</strong> ${esc(METRICS.total.unit)}` : 'אין נתון'}</p>`;
    return;
  }
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

/* ---------- category breakdown - one hbar chart PER OFFENSE-FAMILY BUCKET
   (regulatory/violent/nonviolent/security - see BUCKET_IDS/BUCKET_GROUPS/
   BUCKET_LABELS in police-meta.js, a product decision made with the user,
   not derived from the source), combining every picked entity into that
   SAME chart rather than each entity getting its own copy (previously one
   full set of bucket charts per entity - same "separate chart per entity"
   issue renderYearTrend had, fixed the same way: one shared chart, entity
   identity carried by pickColorFor color instead of a wholly separate
   chart). Unlike renderYearTrend's grouped-vertical-bar chart though, this
   stays the existing renderHBarChart leaderboard style entirely unchanged,
   using its `groupHeader` row (a label-only divider, no bar) to split the
   list into a named sub-section per offense-group (BUCKET_GROUPS order),
   that group's cities as ordinary rows right under it, in PICK order (not
   value order) so a city sits in the same relative position under every
   group's header rather than reshuffling group to group - same-category
   bars from different cities sit together under one heading, and each
   row's own label is just the city name (color is what ties a row back to
   a city, same as every other combined chart on this page - the group
   name itself only needs to appear once, in the header, not repeated on
   every row under it).
   Each bar is a member StatisticGroup's own average-per-year row count, or
   (see `normalize` below) that count per 1000 residents when every picked
   entity has a population figure - only true at city level.
   The 3 EXCLUDED_GROUPS (שאר עבירות/שגיאת הזנה/סעיפי הגדרה) appear in
   neither this section nor any bucket - not real offense categories or too
   small to matter (see police-meta.js's own comment). ------- */

const STATISTIC_GROUP_INDEX = new Map(STATISTIC_GROUPS.map((g, i) => [g, i]));

// A single offense sub-category's own per-1000-residents rate is often a
// small fraction (unlike the ~20-35 range of the page's one overall
// perCapita figure) - num()'s 0-decimal rounding would flatten most rows
// to a meaningless "0". Same 'he-IL' locale formatting, just 2 decimals.
const numRate = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL', { maximumFractionDigits: 2 }));

// Display-only clarification for one specific StatisticGroup name, whose
// plain name alone ("offenses against a person") reads as broader than
// what it actually covers. A UI-layer relabel, not touching the group name
// itself - that's generated data (STATISTIC_GROUPS/BUCKET_GROUPS in
// police-meta.js) used as a real lookup key elsewhere, not just display
// text, so it can't just be edited to add a parenthetical there.
const GROUP_LABEL_OVERRIDES = { 'עבירות נגד אדם': 'נגד אדם (רצח, הריגה)' };
const groupLabel = (groupName) => GROUP_LABEL_OVERRIDES[groupName] || stripOffensesWord(groupName);

function renderCategoryBreakdown(entries) {
  const container = el('pcCategoryBreakdown');
  // At neighborhood level, only the violent bucket is shown - the other 3
  // offense-family buckets are far sparser per neighborhood (smaller area,
  // privacy suppression) and add noise rather than signal at that
  // granularity (user request).
  const bucketOrder = state.level === 'neighborhood' ? ['violent'] : CATEGORY_DISPLAY_ORDER;
  container.innerHTML = bucketOrder.map((_, oi) =>
    `<figure id="pc-cat-${oi}" class="acc-chart acc-chart-wide" role="img"></figure>`).join('');
  const multi = entries.length > 1;
  // Per-1000 needs every picked entity's own population - only available at
  // city level (see populationFor's own comment). Falls back to raw average
  // -per-year counts at neighborhood level rather than hiding the charts.
  const normalize = entries.every((e) => populationFor(e) != null);
  const rateFor = (e, idx) => {
    const raw = (categoriesFor(e) || [])[idx] || 0;
    return normalize ? (raw / populationFor(e)) * 1000 : raw;
  };
  const unit = normalize ? 'לאלף תושבים' : 'שורות/שנה';
  const formatValue = normalize ? numRate : num;

  bucketOrder.forEach((bid, oi) => {
    const bi = BUCKET_IDS.indexOf(bid);
    const bars = (GROUP_DISPLAY_ORDER[bid] || BUCKET_GROUPS[bid]).flatMap((groupName) => {
      const idx = STATISTIC_GROUP_INDEX.get(groupName);
      // Pick order, not value order - so a city sits in the same relative
      // position under every group's header instead of jumping around
      // group to group depending on which offense happens to be bigger for
      // which city that time.
      const rows = entries
        .map((e, ei) => ({ e, ei, value: rateFor(e, idx) }))
        .filter(({ value }) => value > 0);
      if (!rows.length) return [];
      // Single entity: only one row per group anyway (nothing to compare
      // it against WITHIN the group), so the bars stay real numbers -
      // renderHBarChart's own single shared peak across the whole bucket
      // then shows each category's true relative size for this one city
      // (e.g. נגד גוף really is ~60x נגד אדם's rate - user request: "the
      // graph should represent the number").
      if (!multi) return rows.map(({ value }) => ({ label: groupLabel(groupName), value }));
      // Comparing multiple entities: renderHBarChart scales every bar in
      // the whole figure against ONE shared peak - fine within a group,
      // but a bucket combines groups of very different natural scale (e.g.
      // violent's own נגד גוף routinely 50-100x נגד אדם's rate), so under a
      // single shared peak the smaller groups' bars all but disappear.
      // Pre-normalized to 0-100 = "% of this GROUP's own highest bar"
      // instead (peak always reaches exactly 100, same effect as
      // renderHBarChart's own peak-relative scaling, just scoped per
      // group) - the printed/tooltip number still shows the real rate via
      // displayValue, only the bar's fill is renormalized (user request:
      // "the graph with the most, fill the line, others relative to it" -
      // per category, not per bucket).
      const groupPeak = Math.max(...rows.map((r) => r.value));
      const scaled = rows.map((r) => ({ ...r, displayValue: r.value, value: (r.value / groupPeak) * 100 }));
      return [
        { groupHeader: groupLabel(groupName) },
        ...scaled.map(({ e, ei, value, displayValue }) => ({ label: e.label, value, displayValue, color: pickColorFor(ei) })),
      ];
    });
    const bucketLabel = normalize ? `${BUCKET_LABELS[bid]} לאלף תושבים` : BUCKET_LABELS[bid];
    const bucketRawTotal = (bucketsFor(entries[0]) || [])[bi] || 0;
    const bucketTotal = normalize ? (bucketRawTotal / populationFor(entries[0])) * 1000 : bucketRawTotal;
    const caption = multi
      ? `${bucketLabel} — השוואה`
      : `${entries[0].label} — ${bucketLabel} (ממוצע שנתי: ${formatValue(bucketTotal)})`;
    renderHBarChart(`pc-cat-${oi}`, caption, bars, unit, { formatValue });
  });
}

/* ---------- year trend - two combined charts (raw count, then per-1000-
   residents), all picked entities as distinctly-colored bars per year in
   each (previously a fully separate raw-count-only chart per entity, each
   on its own y-axis scale - not actually comparable at a glance). Same
   per-entity color (pickColorFor) as everywhere else on this page. A year
   with fewer than 4 quarters observed (see YEAR_QUARTERS) is marked
   `active`, which renderMultiSeriesChart surfaces as an asterisk on that
   year's label rather than a bar tint, since color here means "which
   entity".
   The per-1000 chart divides each YEAR's own raw count by the city's
   POLICE_CITIES population - not the same number as METRICS.perCapita
   (that's a 5-year AVERAGE rate, this is the rate for that specific year).
   Neighborhoods have no population figure at all (see METRICS.perCapita's
   own comment) so this second chart is simply omitted when none of the
   picked entities have one, same as that metric already disappears at
   neighborhood level elsewhere on this page. ---- */

function populationFor(e) {
  return e.level === 'city' ? POLICE_CITIES[e.name]?.population : null;
}

function renderYearTrend(entries) {
  const suffix = entries.length > 1 ? ' — השוואה' : '';

  const totalSeries = entries.map((e, i) => ({
    name: e.label,
    color: pickColorFor(i),
    points: YEARS.map((y, yi) => ({ year: Number(y), value: (yearsFor(e) || [])[yi] || 0, active: YEAR_QUARTERS[y] < 4 })),
  }));

  const perCapitaSeries = entries.map((e, i) => {
    const pop = populationFor(e);
    if (!pop) return null;
    return {
      name: e.label,
      color: pickColorFor(i),
      points: YEARS.map((y, yi) => ({
        year: Number(y),
        value: ((yearsFor(e) || [])[yi] || 0) / pop * 1000,
        active: YEAR_QUARTERS[y] < 4,
      })),
    };
  }).filter(Boolean);

  // Same side-by-side-on-desktop/stack-on-mobile flex row every other
  // "two year charts" pair on the site already uses (accidents.html's own
  // #accChartKilled/#accChartTotal) - flex-basis:20rem + wrap needs no
  // media query, it naturally stacks once the row's too narrow for both
  // (user request, desktop only - which this already is, since a narrow
  // viewport doesn't have room for two 20rem+ columns).
  const container = el('pcYearTrend');
  container.innerHTML = `
    <div class="acc-charts">
      <figure id="pc-year-combined" class="acc-chart" role="img"></figure>
      ${perCapitaSeries.length ? '<figure id="pc-year-combined-percap" class="acc-chart" role="img"></figure>' : ''}
    </div>`;

  renderMultiSeriesChart('pc-year-combined', `תיקים לפי שנה${suffix}`, totalSeries, 'תיקים');
  if (perCapitaSeries.length) {
    renderMultiSeriesChart('pc-year-combined-percap', `תיקים לאלף תושבים לפי שנה${suffix}`, perCapitaSeries, 'לאלף תושבים');
  }
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
  renderNbBoard();
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
  el('pcBoardLevel').textContent = 'דירוג ארצי';

  // ערים - the page's own biggest leaderboard (every city, ~250 rows) -
  // capped to ~15 visible rows (scrollable) instead of the general 32rem
  // cap, same idiom as the "דירוג לפי סוג עבירה" board's own
  // tc-board-scroll-15 (user request). Left off "שכונות" (state.level ===
  // 'neighborhood', ~2,000 rows) since that wasn't asked for. The single
  // picked city's own neighborhoods (previously a second board here) now
  // live in the compare section instead - see renderNbBoard().
  const mainIsCities = state.level === 'city';

  // Expanded by default (user request) - previously collapsed so the page
  // didn't open already showing a multi-hundred-row leaderboard, but that's
  // exactly what a visitor scrolling this far down is looking for.
  const container = el('pcBoardCharts');
  container.innerHTML = `
    <details class="notice info" open>
      <summary><strong dir="auto">${esc(lvl.boardTitle)}</strong></summary>
      <figure id="pc-board-main" class="acc-chart acc-chart-wide tc-board-scroll${mainIsCities ? ' tc-board-scroll-15' : ''}" role="img"></figure>
    </details>`;

  // One ranking, not one per METRIC_ORDER entry - a "ערים"/"שכונות" board
  // followed immediately by a second board with the exact same caption
  // prefix read as a duplicate, not two different metrics (user request).
  // METRIC_ORDER[0] ('total') over perCapita since it's the page's own
  // primary metric (listed first everywhere else too, e.g.
  // renderCompareTable's own column order).
  renderMetricBoard('pc-board-main', METRIC_ORDER[0], entries, { labelPlural: lvl.boardTitle, capAll: mainIsCities });
}

/* ---------- single picked city's own neighborhoods, ranked by a
   switchable metric - lives in the compare section, right before
   renderYearTrend's own chart (user request: "put שכונות ב<city> before
   תיקים לפי שנה" - this used to be a second board under "דירוג ארצי"
   alongside the national one, moved here instead since it's about ONE
   city, not a national ranking). Shown only when singlePickedCity() is
   truthy. ---------- */

// nbMetric's own label/value - 'total' is METRICS.total verbatim (every
// case, every offense type, same as this board always ranked by before);
// 'violentTotal' sums the 3 violent-bucket categories; anything else is a
// single StatisticGroup's own raw average-per-year count (see
// NB_METRIC_IDS's own comment above).
function nbMetricLabel(id) {
  if (id === 'total') return 'סה״כ תיקים';
  if (id === 'violentTotal') return 'סה״כ עבירות אלימות';
  return groupLabel(id);
}
function nbMetricValue(e, id) {
  if (id === 'total') return valueFor(e, 'total');
  const violentGroups = GROUP_DISPLAY_ORDER.violent || BUCKET_GROUPS.violent;
  if (id === 'violentTotal') {
    return violentGroups.reduce((sum, g) => sum + ((categoriesFor(e) || [])[STATISTIC_GROUP_INDEX.get(g)] || 0), 0);
  }
  return (categoriesFor(e) || [])[STATISTIC_GROUP_INDEX.get(id)] || 0;
}

function renderNbMetricPicker() {
  const box = el('pcNbMetricPick');
  if (!box) return;
  box.innerHTML = NB_METRIC_IDS.map((id) => `<button type="button" data-nbm="${esc(id)}" class="tc-level-btn${id === state.nbMetric ? ' active' : ''}">${esc(nbMetricLabel(id))}</button>`).join('');
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.nbMetric === btn.dataset.nbm) return;
      state.nbMetric = btn.dataset.nbm;
      syncUrl();
      renderNbBoard();
    });
  });
}

function renderNbBoard() {
  const container = el('pcNbBoard');
  const cityForNb = singlePickedCity();
  if (!cityForNb) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="cm-filters" id="pcNbMetricPick" role="group" aria-label="מדד"></div>
    <figure id="pc-nb-board" class="acc-chart acc-chart-wide tc-board-scroll" role="img"></figure>`;
  renderNbMetricPicker();

  const entries = levelEntries('neighborhood').filter((e) => e.city === cityForNb);
  const id = state.nbMetric;
  const withVals = entries
    .map((e) => ({ label: e.label, value: nbMetricValue(e, id) }))
    .filter((r) => r.value != null)
    .sort((a, b) => b.value - a.value);
  const peak = Math.max(0, ...withVals.map((r) => r.value));
  const rowsHtml = withVals.map((r) => `
    <div class="acc-hbar" title="${esc(r.label)}: ${num(r.value)}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (r.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(r.value)}</span>
    </div>`);
  renderBoardChartChunked('pc-nb-board', `${num(withVals.length)} שכונות ב${cityForNb}, מהגבוה לנמוך לפי ${nbMetricLabel(id)}`, rowsHtml);
}

/* ---------- category leaderboard - pick one StatisticGroup, rank every
   entity at the current level by it. Ports mortality-compare.js's
   renderCityMetricPicker/cityEntriesFor shape (there: pick one health
   metric; here: pick one offense category) - the answer to "compare table
   column per StatisticGroup" made interactive instead of a static 12/15-
   column table. ---------- */

function renderCategoryPicker() {
  const box = el('pcCategoryPick');
  box.innerHTML = CATEGORY_BOARD_GROUPS.map((g) => `<button type="button" data-cat="${esc(g)}" class="tc-level-btn${g === state.activeCategory ? ' active' : ''}">${esc(groupLabel(g))}</button>`).join('');
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
  el('pcCategoryHint').textContent = `${num(entries.length)} מתוך ${num(levelEntries(state.level).length)} ${lvl.labelPlural} עם תיקים מסוג "${groupLabel(state.activeCategory)}" (ממוצע שנתי)`;
  const peak = Math.max(0, ...capped.map((r) => r.value));
  const rowsHtml = capped.map((r) => `
    <div class="acc-hbar" title="${esc(r.label)}: ${num(r.value)}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (r.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(r.value)}</span>
    </div>`);
  renderBoardChartChunked('pcCategoryBoardChart', `${num(capped.length)} ${lvl.labelPlural}, מהגבוה לנמוך לפי "${groupLabel(state.activeCategory)}" (ממוצע שנתי)${capNote}`, rowsHtml);
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
