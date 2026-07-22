/**
 * Entry point for local-finance.html - דוחות כספיים מבוקרים של רשויות מקומיות
 * (משרד הפנים).
 *
 * Everything here is a LIVE browser fetch against data.gov.il's DataStore API
 * (the same CKAN engine every other data.gov.il-sourced page on this site
 * already uses) - no offline precompute, no snapshot. Verified feasible
 * before building: the national summary query below returns ~3,300 rows for
 * all ~259 authorities combined, comfortably inside a single request, so
 * there was no need for the accidents.html-style "dated snapshot" pattern
 * here - real time filtering does the job.
 *
 * See the notice at the top of local-finance.html for what this deliberately
 * does NOT attempt: computed national KPIs for years before 2023 (line-item
 * labels aren't stable across years - confirmed by direct probing, not
 * assumed), 2014-2015 (split into multiple files per year), and the separate
 * "transferred payments" dataset (different shape entirely, not merged in).
 */

import { el, esc, num, debounce, buildCsv, saveCsv, showError, showLoading } from './ui.js';
import { initThemePicker } from './theme.js';
import { YEAR_RESOURCES, YEARS_DESC, ROSTER_YEAR, ROSTER_FILTERS, SUMMARY_SHEET, SUMMARY_ROWS, SUMMARY_COLUMN, form2RowsFor, BALANCE_COLUMN, balanceRowsFor, CBS_POPULATION_RESOURCE_ID, CBS_POPULATION_FIELD, CBS_POPULATION_YEAR, AREA_SHEET, AREA_CATEGORIES, areaColumnFor, JURISDICTION_SHEET, JURISDICTION_ROW, JURISDICTION_YEAR } from './finance-data.js';

initThemePicker(el('themePick'));

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

const DATASTORE = 'https://data.gov.il/api/3/action/datastore_search';

async function dsQuery(resourceId, filters, limit = 10000) {
  const p = new URLSearchParams({ resource_id: resourceId, limit: String(limit) });
  if (filters) p.set('filters', JSON.stringify(filters));
  const res = await fetch(`${DATASTORE}?${p}`);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'network' });
  const j = await res.json();
  if (!j.success) throw new Error(j.error?.__type || 'שגיאת שרת');
  return j.result;
}

/* ---------- state ---------- */

// הוד השרון is the default landing authority (not because it's special
// statistically - it just needs to be *something* real rather than a blank
// prompt on first load) and doubles as the one this whole data pipeline was
// hand-verified against earlier, so it's also the safest default to show.
const DEFAULT_AUTHORITY = 'הוד השרון';

const state = {
  authority: DEFAULT_AUTHORITY,
  compareAuthority: null, // chart-only backdrop - never touches the table/statement/CSV
  year: YEARS_DESC[0],
  summaryCache: new Map(), // year -> { totals, byAuthority[] } | 'unsupported'
};

/* ---------- URL state: makes the current authority+year copyable/shareable
   as a link, and a shared link reproduces the same view on open. Read once
   on load (before the first render), written back with replaceState (not
   pushState) on every change - a link should reflect the latest view, not
   grow a back-button history entry per keystroke. */
function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const authority = p.get('authority')?.trim();
  const compare = p.get('compare')?.trim();
  const year = Number(p.get('year'));
  if (authority) state.authority = authority;
  if (compare) state.compareAuthority = compare;
  if (YEAR_RESOURCES[year]) state.year = year;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.authority) p.set('authority', state.authority);
  if (state.compareAuthority) p.set('compare', state.compareAuthority);
  p.set('year', String(state.year));
  history.replaceState(null, '', `?${p}`);
}

/* ---------- authority roster (one cheap query, cached) ---------- */

const authorityInput = el('finAuthority');
let rosterNames = [];

async function loadRoster() {
  try {
    const cfg = YEAR_RESOURCES[ROSTER_YEAR];
    const { records } = await dsQuery(cfg.resourceId, {
      [cfg.sheetField]: ROSTER_FILTERS.גליון, שורה: ROSTER_FILTERS.שורה, עמודה: ROSTER_FILTERS.עמודה,
    });
    rosterNames = [...new Set(records.map((r) => r['שם_רשות']))].sort((a, b) => a.localeCompare(b, 'he'));
    el('finAuthorityList').innerHTML = rosterNames.map((n) => `<option value="${esc(n)}"></option>`).join('');
  } catch (err) {
    console.error('roster load failed', err);
  }
}

/* ---------- year select ---------- */

// Unverified years (see discoverNewYears below) get a visible marker in the
// dropdown itself - the least intrusive place to flag "this one wasn't
// hand-checked yet" without a separate banner most visitors would never
// look for.
function populateYearSelect() {
  el('finYear').innerHTML = YEARS_DESC
    .map((y) => `<option value="${y}">${y}${YEAR_RESOURCES[y].unverified ? ' (חדש - טרם אומת)' : ''}</option>`)
    .join('');
  el('finYear').value = String(state.year);
}
populateYearSelect();

const FINANCE_PACKAGES = ['local-authorities', 'local-council-1'];

/** Looks for a financial-report resource for a year newer than every year
 *  already in YEAR_RESOURCES - e.g. the ministry publishing next year's
 *  reports sometime after this file was last hand-updated. Resource names
 *  in both source packages embed the year directly and were checked
 *  directly, not assumed: the reliable convention is "... לשנת 2024"
 *  (singular "year") - a combined multi-year resource like "...לשנים שבין
 *  2017-2018" (plural "years") never matches that phrase, confirmed against
 *  that exact resource, so it's correctly skipped rather than misread as a
 *  new single year. A resource whose name carries the phrase but ALSO a
 *  second unrelated 20xx number (an update date, e.g. "עדכון אפריל 2020")
 *  is still read correctly, since the phrase match anchors on the specific
 *  number that follows "לשנת", not on "some 4-digit number in the string".
 *
 *  A newly discovered year is registered using the SAME conventions
 *  2023/2024 use (current era: no gershayim, has the "דוח לתושב" summary
 *  sheet, no in-file yearFilter needed) - the best available guess, since
 *  every era boundary in this dataset so far has kept or extended that
 *  convention rather than reverting to an older one. It is marked
 *  `unverified: true` and flagged in the UI (year <select>, statement
 *  coverage line) rather than silently trusted - a wrong guess here would
 *  show real-looking numbers, not an error, and every other year in this
 *  file needed hand probing before being trusted too. */
async function discoverNewYears() {
  const currentMax = Math.max(...YEARS_DESC);
  const found = [];
  for (const pkg of FINANCE_PACKAGES) {
    try {
      const res = await fetch(`https://data.gov.il/api/3/action/package_show?id=${pkg}`);
      if (!res.ok) continue;
      const j = await res.json();
      if (!j.success) continue;
      for (const r of j.result.resources) {
        if (!r.datastore_active || !r.name) continue;
        const named = r.name.match(/לשנת\s+(20\d{2})/);
        if (!named) continue; // "לשנים" (plural, multi-year ranges) never matches - deliberately not handled here
        const year = Number(named[1]);
        if (year <= currentMax || YEAR_RESOURCES[year]) continue;
        YEAR_RESOURCES[year] = {
          source: pkg, resourceId: r.id, sheetField: 'גליון', hasSummary: true,
          coverage: 'כלל סוגי הרשויות (שנה חדשה שהתגלתה אוטומטית - טרם אומתה ידנית)',
          unverified: true,
        };
        found.push(year);
      }
    } catch { /* discovery is best-effort - a failure here shouldn't block the rest of the page */ }
  }
  if (found.length) {
    for (const y of found) if (!YEARS_DESC.includes(y)) YEARS_DESC.push(y);
    YEARS_DESC.sort((a, b) => b - a);
  }
  return found;
}

/* ---------- national summary (KPIs + charts) - only for hasSummary years ---------- */

async function fetchSummary(year) {
  if (state.summaryCache.has(year)) return state.summaryCache.get(year);
  const cfg = YEAR_RESOURCES[year];
  if (!cfg?.hasSummary) { state.summaryCache.set(year, 'unsupported'); return 'unsupported'; }

  const { records } = await dsQuery(cfg.resourceId, {
    [cfg.sheetField]: SUMMARY_SHEET,
    שורה: Object.values(SUMMARY_ROWS),
    עמודה: SUMMARY_COLUMN,
  });

  const byAuthority = new Map(); // name -> { revenue, expense, surplus, ownRevenue, grants }
  for (const rec of records) {
    const name = rec['שם_רשות'];
    const row = byAuthority.get(name) || { name };
    const key = Object.entries(SUMMARY_ROWS).find(([, label]) => label === rec['שורה'])?.[0];
    if (key) row[key] = Number(rec['ערך']) || 0;
    byAuthority.set(name, row);
  }
  const rows = [...byAuthority.values()];
  const totals = rows.reduce((acc, r) => ({
    revenue: acc.revenue + (r.revenue || 0),
    expense: acc.expense + (r.expense || 0),
    surplus: acc.surplus + (r.surplus || 0),
  }), { revenue: 0, expense: 0, surplus: 0 });
  const deficitCount = rows.filter((r) => (r.surplus || 0) < 0).length;

  const summary = { totals, rows, authorityCount: rows.length, deficitCount };
  state.summaryCache.set(year, summary);
  return summary;
}

/* ---------- KPI tiles - same visual vocabulary as accidents.html's .stat-row ---------- */

async function renderKpis() {
  const { year } = state;
  el('kpiYearLabel').textContent = year;
  const box = el('finKpis');

  const cfg = YEAR_RESOURCES[year];
  if (!cfg?.hasSummary) {
    box.innerHTML = `<p class="acc-hint">אין גיליון סיכום ארצי מוכן לשנת ${year} — ראו ההסבר למעלה. הדוח המפורט של הרשות שנבחרה עדיין זמין למטה.</p>`;
    el('finChartYoY').innerHTML = '';
    el('finChartTop').innerHTML = '';
    return;
  }

  showLoading(box, 'טוען מדדים ארציים…');
  try {
    const summary = await fetchSummary(year);
    const balancedPct = summary.authorityCount
      ? Math.round(((summary.authorityCount - summary.deficitCount) / summary.authorityCount) * 100)
      : 0;
    box.innerHTML = `
      <div class="stat">
        <span class="stat-n">${num(summary.totals.revenue)}</span>
        <span class="stat-l">סה"כ הכנסות (אלפי ש"ח, ${summary.authorityCount} רשויות)</span>
      </div>
      <div class="stat warn">
        <span class="stat-n">${num(summary.totals.expense)}</span>
        <span class="stat-l">סה"כ הוצאות (אלפי ש"ח)</span>
      </div>
      <div class="stat ${summary.totals.surplus >= 0 ? 'ok' : 'bad'}">
        <span class="stat-n">${num(summary.totals.surplus)}</span>
        <span class="stat-l">עודף (גרעון) ארצי מצטבר</span>
      </div>
      <div class="stat ${balancedPct >= 50 ? 'ok' : 'warn'}">
        <span class="stat-n">${balancedPct}%</span>
        <span class="stat-l">רשויות מאוזנות (${summary.authorityCount - summary.deficitCount}/${summary.authorityCount})</span>
      </div>`;
    await renderCharts(summary);
  } catch (err) {
    showError(box, err);
  }
}

/* ---------- charts - reuses accidents.html's .acc-chart/.acc-bars bar look ---------- */

// Single-series bar chart - only the national YoY chart uses this now (the
// per-authority ארנונה chart that used to share it, and its own compare-
// backdrop support, was removed).
function renderBarChart(figId, caption, entries, unit, colorClass) {
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...entries.map((e) => Math.abs(e.value)));
  const bars = entries.map((e) => {
    const h = peak ? Math.round((Math.abs(e.value) / peak) * 150) : 0;
    return `
      <div class="acc-bar" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
        <div class="acc-bar-track">
          <span class="acc-bar-v">${num(e.value)}</span>
          <div class="acc-bar-fill" style="block-size:${h}px"></div>
        </div>
        <span class="acc-bar-y">${esc(e.label)}</span>
      </div>`;
  }).join('');
  fig.className = `acc-chart${colorClass ? ` ${colorClass}` : ''}`;
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-bars">${bars}</div>`;
}

/** A ranked leaderboard (top-N by value) reads far better as rows stacked
 *  top-to-bottom than as N vertical bars squeezed into one fixed-height row -
 *  a different mark from renderBarChart, not that same one rotated.
 *  An entry may set `compare: true` to render in the same grayed-out accent
 *  used for a compare authority everywhere else on this page - lets two
 *  cities sit as adjacent rows per category, distinguished by that same
 *  color code rather than a legend the reader has to look up. */
function renderHBarChart(figId, caption, entries, unit) {
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...entries.map((e) => e.value));
  const rows = entries.map((e) => `
    <div class="acc-hbar${e.compare ? ' acc-hbar-compare' : ''}" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
      <span class="acc-hbar-y" dir="auto">${esc(e.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (e.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(e.value)}</span>
    </div>`).join('');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars">${rows}</div>`;
}

async function renderCharts(summary) {
  // YoY: the only other year that also has a national summary (2023<->2024
  // today) - not a general multi-year trend, since no other year has one.
  const otherYear = YEARS_DESC.find((y) => YEAR_RESOURCES[y].hasSummary && y !== state.year);
  const otherSummary = otherYear ? await fetchSummary(otherYear) : null;
  const yoyEntries = [
    { label: String(state.year), value: summary.totals.surplus },
    ...(otherSummary && otherSummary !== 'unsupported'
      ? [{ label: String(otherYear), value: otherSummary.totals.surplus }] : []),
  ].sort((a, b) => a.label.localeCompare(b.label));
  renderBarChart('finChartYoY', 'עודף (גרעון) ארצי מצטבר, לפי שנה', yoyEntries, 'אלפי ש"ח',
    summary.totals.surplus >= 0 ? 'ok-chart' : 'total');

  const top = [...summary.rows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 20)
    .map((r) => ({ label: r.name, value: r.revenue || 0 }));
  renderHBarChart('finChartTop', `20 הרשויות עם ההכנסות הגבוהות ביותר, ${state.year}`, top, 'אלפי ש"ח');
}

/* ---------- one authority's own revenue/expense/surplus, across every year
   it has data for - unlike the national KPIs above, this needs no
   cross-authority summing, so both label eras (see form2RowsFor) are usable
   and all 9 years can appear, not just 2023-2024. Years the authority has no
   row in (e.g. a city in 2020/2021, a councils-only year) are skipped, not
   shown as zero - a real gap should look like a gap, not a false zero. ---------- */

/** Revenue/expense (Form 2), balance sheet (Form 1) and land-use areas
 *  (נספח א) in ONE query per year, not three - all three sheets live in the
 *  same per-year resource, so one request with a wider גיליון/שורה/עמודה
 *  filter (each an array - CKAN OR-matches within a field, ANDs across
 *  fields) returns exactly the rows all three needed, split back out
 *  client-side by row label. Row-label vocabulary never overlaps between
 *  these three sheets (checked directly - "מגורים"/"סה\"כ מאזן..."/"סה\"כ
 *  תקבולים..." share no text), and each row's own real עמודה value only
 *  ever matches the ONE filter value meant for its own sheet, so widening
 *  the array doesn't pull in a wrong row.
 *
 *  This exists because fetching the three separately (27 concurrent
 *  requests per authority, 9 years x 3 sheets - 54 with a compare
 *  authority) was the actual bottleneck behind a slow "טוען": each
 *  individual request answers in well under a second in isolation
 *  (confirmed directly), but firing dozens of them from one browser at
 *  once queues up against the browser's/server's own concurrent-connection
 *  limit rather than truly running in parallel. Cutting the request count
 *  3x (to 9, 18 with compare) was the fix - the per-year Promise.all
 *  concurrency (see the comment that used to be here) helps only once the
 *  count itself isn't the bottleneck.
 *
 *  Years fetch concurrently, same reasoning as before: no reason to wait
 *  for 2024 to answer before asking 2023. A year failing (or the authority
 *  not being covered that year) resolves to `null` rather than rejecting,
 *  so one bad year can't hide the rest. */
async function fetchAuthorityBundle(authority) {
  const points = await Promise.all(YEARS_DESC.map(async (year) => {
    const cfg = YEAR_RESOURCES[year];
    const form2 = form2RowsFor(year);
    const balRows = balanceRowsFor(year);
    const areaCol = areaColumnFor(year);
    const filters = {
      שם_רשות: authority,
      [cfg.sheetField]: ['טופס 2', 'טופס 1 אקטיב', 'טופס 1 פאסיב', AREA_SHEET],
      שורה: [form2.revenue, form2.expense, balRows.assets, balRows.liabilities, balRows.currentLiabilities, ...AREA_CATEGORIES],
      עמודה: [form2.column, BALANCE_COLUMN, areaCol],
    };
    if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
    try {
      const { records } = await dsQuery(cfg.resourceId, filters);
      if (!records.length) return null; // authority not covered this year - a real gap, not an error
      const val = (row) => Number(records.find((r) => r['שורה'] === row)?.['ערך']) || 0;
      const areas = {};
      for (const cat of AREA_CATEGORIES) {
        const rec = records.find((r) => r['שורה'] === cat);
        const v = rec ? Number(rec['ערך']) : null;
        areas[cat] = Number.isFinite(v) ? v : null;
      }
      return {
        year,
        revenue: val(form2.revenue), expense: val(form2.expense),
        assets: val(balRows.assets), liabilities: val(balRows.liabilities), currentLiabilities: val(balRows.currentLiabilities),
        areas,
      };
    } catch { return null; /* one year failing shouldn't hide the rest */ }
  }));
  return points.filter(Boolean).sort((a, b) => a.year - b.year); // oldest first - a trend reads left-to-right in time
}

/** Revenue (front, narrower, green) layered over expense (back, full-width,
 *  accent) sharing one baseline per year - the back bar's edges show on both
 *  sides of the front one regardless of how close the two values are, so
 *  neither series depends on a height gap to stay visible. Peak is taken
 *  across BOTH series together, not per-series, so a year where expense
 *  exceeds revenue (a deficit year) doesn't get its back bar clipped taller
 *  than the chart while the front bar looks artificially short. */
/** `compare` (optional): another authority's own revenue, per year - shown as
 *  a third, gray, widest-of-the-three backdrop bar purely for scale (per the
 *  request: chart-only context, never touching the table/statement/CSV,
 *  which stay scoped to the main authority alone). Keyed by year, not
 *  assumed to line up positionally with `points` - the compare authority can
 *  easily have data for a different subset of the 9 years (a city vs. a
 *  council-only year, for instance). */
const FIN_PLOT_PX = 200; // shared by bar heights, gridline spacing and axis labels - must stay one constant so all three line up

/** Rounds a peak value up to a "nice" axis maximum (1/2/2.5/5 x 10^n steps),
 *  the standard chart-axis algorithm - a gridline at 683,417 would tell a
 *  reader nothing an unlabeled bar didn't already; a gridline at 700,000
 *  does. `targetSteps` is a target, not a guarantee - the actual count is
 *  whatever full steps fit under the rounded max. */
function niceAxisStep(max, targetSteps = 5) {
  if (!max || max <= 0) return { step: 1, steps: 1, axisMax: 1 };
  const roughStep = max / targetSteps;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  const step = niceResidual * magnitude;
  const steps = Math.ceil(max / step);
  return { step, steps, axisMax: step * steps };
}

/** Splits the main authority's own year coverage into real years and gap
 *  runs (e.g. 2020-2021, missing because Hod Hasharon isn't in those two
 *  years' councils-only source) - a gap INSIDE the covered span (between
 *  the earliest and latest year with data) gets its own dashed slot on the
 *  chart; years outside that span (a city not covered before/after) are
 *  simply not shown at all, same as before - there's no "gap" to mark at
 *  the edge of what the chart covers in the first place. */
function buildYearSlots(points) {
  const years = points.map((p) => p.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const present = new Set(years);
  const slots = [];
  let gapFrom = null;
  for (let y = minYear; y <= maxYear; y++) {
    if (present.has(y)) {
      if (gapFrom != null) { slots.push({ type: 'gap', from: gapFrom, to: y - 1 }); gapFrom = null; }
      slots.push({ type: 'year', year: y });
    } else if (gapFrom == null) {
      gapFrom = y;
    }
  }
  return slots;
}

/** Grouped (not overlapping) bar chart with a gridlined y-axis, replacing
 *  the earlier layered/telescoping-bar version - a reader can now read an
 *  exact-ish value straight off a single bar instead of needing the table
 *  underneath. `compare` (optional): { name, points: [{year, revenue,
 *  expense}] } - the compare authority's own two series, drawn as a second,
 *  distinctly-colored bar group right next to the main authority's for the
 *  same year.
 *
 *  Color encodes CITY, not series: the main authority is always --accent,
 *  the compare authority always --fin-compare, identical across all three
 *  finance charts on this page (revenue/expense, per-resident, liabilities)
 *  - a color's meaning here doesn't need re-checking chart to chart. Which
 *  of the two series a bar is (`labels.front` vs `labels.back`) is carried
 *  by POSITION (front's bar always comes first in its city's pair) and a
 *  lighter tint of that same city's color, not a second hue - see the
 *  legend this renders, which states the position rule once per chart.
 *
 *  When `compare` is set, each year gets a small "X% מ-<city>" label above
 *  its bars - the main authority's total (front+back) as a percentage of
 *  the compare authority's same total - so the comparison answers "closer
 *  to or further from the other city than last year", not just "which
 *  city is bigger" from two overlapping bars of very different height. */
function renderGroupedChart(figId, caption, points, unit, labels = { front: 'הכנסות', back: 'הוצאות' }, compare = null) {
  const fig = el(figId);
  if (!points.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const peak = Math.max(
    ...points.flatMap((p) => [p.revenue, p.expense]),
    ...[...compareByYear.values()].flatMap((p) => [p.revenue, p.expense]),
  );
  const { steps, axisMax } = niceAxisStep(peak);
  const byYear = new Map(points.map((p) => [p.year, p]));
  const slots = buildYearSlots(points);

  const barH = (v) => (axisMax ? Math.round((v / axisMax) * FIN_PLOT_PX) : 0);
  const cityBars = (p, mainCity) => `
    <div class="fin-chart-bars">
      <div class="fin-chart-bar${mainCity ? '' : ' fin-chart-bar-compare'}" style="block-size:${barH(p.revenue)}px"></div>
      <div class="fin-chart-bar fin-chart-bar-light${mainCity ? '' : ' fin-chart-bar-compare'}" style="block-size:${barH(p.expense)}px"></div>
    </div>`;

  // Every group stacks in normal flow - an optional pct label, then a
  // bars-wrap fixed at EXACTLY FIN_PLOT_PX (never a percentage/flex-fill
  // height, which under this site's global box-sizing:border-box would
  // silently shrink by whatever padding sits on an ancestor, throwing off
  // every height computed against FIN_PLOT_PX elsewhere), then the year
  // label - so the pct label always sits directly above whatever that
  // year's tallest bar happens to be, with no separate pixel math to keep
  // in sync, and every bars-wrap's own 0-line lines up with every other
  // group's without relying on shared ancestor height tricks.
  const groups = slots.map((slot) => {
    if (slot.type === 'gap') {
      const label = slot.from === slot.to ? String(slot.from) : `${slot.from}-${slot.to}`;
      return `
        <div class="fin-chart-group" title="אין נתונים לשנים ${esc(label)}">
          <div class="fin-chart-gap-box" style="block-size:${FIN_PLOT_PX}px"></div>
          <span class="fin-chart-y fin-chart-gap-label">${esc(label)}<br>אין נתונים</span>
        </div>`;
    }
    const p = byYear.get(slot.year);
    const cmp = compareByYear.get(slot.year);
    const mainTotal = p.revenue + p.expense;
    const cmpTotal = cmp ? cmp.revenue + cmp.expense : null;
    const pct = cmp && cmpTotal ? Math.round((mainTotal / cmpTotal) * 100) : null;
    const title = `${slot.year} — ${esc(state.authority)}: ${esc(labels.front)} ${num(p.revenue)}, ${esc(labels.back)} ${num(p.expense)} ${esc(unit)}`
      + (cmp ? `; ${esc(compare.name)}: ${esc(labels.front)} ${num(cmp.revenue)}, ${esc(labels.back)} ${num(cmp.expense)} ${esc(unit)}` : '');
    return `
      <div class="fin-chart-group" title="${title}">
        <span class="fin-chart-pct">${pct != null ? `${pct}% מ-${esc(compare.name)}` : ''}</span>
        <div class="fin-chart-bars-wrap" style="block-size:${FIN_PLOT_PX}px; background-size:100% ${FIN_PLOT_PX / steps}px">
          ${cityBars(p, true)}
          ${cmp ? cityBars(cmp, false) : ''}
        </div>
        <span class="fin-chart-y">${slot.year}</span>
      </div>`;
  }).join('');

  const axisLabels = Array.from({ length: steps + 1 }, (_, i) => axisMax - i * (axisMax / steps))
    .map((v) => `<span>${num(Math.round(v))}</span>`).join('');

  fig.className = 'acc-chart';
  fig.innerHTML = `
    <figcaption>${esc(caption)}</figcaption>
    <div class="acc-legend">
      <span class="acc-legend-item"><span class="acc-legend-swatch" style="background:var(--accent)"></span>${esc(state.authority)} - ${esc(labels.front)} (מלא, ראשון) / ${esc(labels.back)} (בהיר, שני)</span>
      ${compare ? `<span class="acc-legend-item"><span class="acc-legend-swatch" style="background:var(--fin-compare)"></span>${esc(compare.name)} - אותו סדר</span>` : ''}
    </div>
    <div class="fin-chart-body">
      <div class="fin-chart-axis">
        <span class="fin-chart-pct">&nbsp;</span>
        <div class="fin-chart-axis-scale" style="block-size:${FIN_PLOT_PX}px">${axisLabels}</div>
      </div>
      <div class="fin-chart-plot">${groups}</div>
    </div>
    <p class="acc-hint">${esc(unit)}${compare ? ' - האחוז מעל כל שנה: הסה"כ של ' + esc(state.authority) + ' כאחוז מהסה"כ של ' + esc(compare.name) + ' אותה שנה' : ''}</p>`;
}

// The chart's own values only show on hover (the title attribute) - a plain
// table underneath makes every year's figures visible at once, newest year
// first (a table is read top-down, so the most recent row leads). `compare`
// (optional) adds the second authority's own revenue/expense/surplus as
// three more columns, keyed by year - not assumed to line up positionally,
// since the two authorities can have data for different years.
// Identity color for a city row - solid accent for the main authority,
// the same grayed-out accent used for its bars elsewhere on this page for
// the compare authority - so a reader who's already learned "gray = the
// other city" from the charts above doesn't have to learn a second code.
const CITY_COLOR_MAIN = 'var(--accent)';
const CITY_COLOR_COMPARE = 'color-mix(in srgb, var(--accent) 55%, var(--bg) 45%)';
const citySwatchCell = (name, color) => `<td><span class="acc-legend-swatch" style="background:${color}"></span>${esc(name)}</td>`;

/** `population`/`comparePopulation` (optional): each authority's own
 *  resident count from CBS's 2022 census (see fetchPopulation) - one fixed
 *  number reused for every year's per-resident column, since no per-year
 *  population series exists. `compare` (optional): each year with a
 *  matching compare-authority point gets a second row directly beneath the
 *  main authority's row for that year (same year cell, via rowspan) rather
 *  than more columns beside it - a year with no compare data for the year
 *  keeps its single row, since that's a real gap, not a zero. */
function renderAuthorityTable(points, compare = null, population = null, comparePopulation = null) {
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const surplus = p.revenue - p.expense;
    // A subtle text-color flag, not a full row/cell fill - visible on a
    // glance down the column without turning a deficit year into an alarm.
    const color = surplus >= 0 ? 'var(--fin-ok)' : 'var(--fin-bad)';
    // Revenue/expense are in אלפי ש"ח (thousands) - ×1000 before dividing by
    // a head count gives a plain ₪-per-resident figure, not a figure already
    // divided by 1000 twice over.
    const perResRevenue = population ? Math.round((p.revenue * 1000) / population) : null;
    const perResExpense = population ? Math.round((p.expense * 1000) / population) : null;
    const cmp = compareByYear.get(p.year);
    const mainRow = `
      <tr>
        <th scope="row"${cmp ? ' rowspan="2"' : ''}>${p.year}</th>
        ${compare ? citySwatchCell(state.authority, CITY_COLOR_MAIN) : ''}
        <td>${num(p.revenue)}</td>
        <td>${num(p.expense)}</td>
        <td dir="ltr" style="color:${color}; font-weight:600">${surplus >= 0 ? '+' : ''}${num(surplus)}</td>
        ${population ? `
          <td>${num(perResRevenue)}</td>
          <td>${num(perResExpense)}</td>` : ''}
      </tr>`;
    if (!cmp) return mainRow;
    const cmpSurplus = cmp.revenue - cmp.expense;
    const cmpColor = cmpSurplus >= 0 ? 'var(--fin-ok)' : 'var(--fin-bad)';
    const cmpPerResRevenue = comparePopulation ? Math.round((cmp.revenue * 1000) / comparePopulation) : null;
    const cmpPerResExpense = comparePopulation ? Math.round((cmp.expense * 1000) / comparePopulation) : null;
    const cmpRow = `
      <tr class="fin-row-compare">
        ${citySwatchCell(compare.name, CITY_COLOR_COMPARE)}
        <td>${num(cmp.revenue)}</td>
        <td>${num(cmp.expense)}</td>
        <td dir="ltr" style="color:${cmpColor}; font-weight:600">${cmpSurplus >= 0 ? '+' : ''}${num(cmpSurplus)}</td>
        ${population ? `
          <td>${cmpPerResRevenue != null ? num(cmpPerResRevenue) : '—'}</td>
          <td>${cmpPerResExpense != null ? num(cmpPerResExpense) : '—'}</td>` : ''}
      </tr>`;
    return mainRow + cmpRow;
  }).join('');
  const popNote = el('finPopNote');
  if (population) {
    popNote.hidden = false;
    const compareNote = compare
      ? (comparePopulation ? ` אוכלוסיית ${compare.name}: ${num(comparePopulation)} תושבים.` : ` הנתון אינו זמין עבור ${compare.name}.`)
      : '';
    popNote.textContent = `הכנסות/הוצאות לתושב מחושבות לפי אוכלוסיית ${state.authority} במפקד ${CBS_POPULATION_YEAR} של הלשכה המרכזית לסטטיסטיקה (${num(population)} תושבים) - אותו מספר תושבים משמש לכל השנים בטבלה, ולא אומדן שנתי מתעדכן.${compareNote}`;
  } else {
    popNote.hidden = true;
  }
  el('finAuthTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            ${compare ? '<th scope="col">רשות</th>' : ''}
            <th scope="col">הכנסות (אלפי ש"ח)</th>
            <th scope="col">הוצאות (אלפי ש"ח)</th>
            <th scope="col">עודף (גרעון)</th>
            ${population ? `
              <th scope="col">הכנסות לתושב (ש"ח)</th>
              <th scope="col">הוצאות לתושב (ש"ח)</th>` : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Same plain-values-underneath-the-chart pattern as renderAuthorityTable
// above, for the liabilities combo chart - and the same city-per-row
// stacking, rather than more columns beside the main authority's. `compare`
// (optional) carries the compare authority's own balance points directly
// ({year, liabilities, currentLiabilities}) - not the single flattened
// backdrop value the chart itself uses, since a table has room to show both
// real figures plainly.
function renderLiabilityTable(points, compare = null) {
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const cmp = compareByYear.get(p.year);
    const mainRow = `
      <tr>
        <th scope="row"${cmp ? ' rowspan="2"' : ''}>${p.year}</th>
        ${compare ? citySwatchCell(state.authority, CITY_COLOR_MAIN) : ''}
        <td>${num(p.liabilities)}</td>
        <td>${num(p.currentLiabilities)}</td>
      </tr>`;
    if (!cmp) return mainRow;
    const cmpRow = `
      <tr class="fin-row-compare">
        ${citySwatchCell(compare.name, CITY_COLOR_COMPARE)}
        <td>${num(cmp.liabilities)}</td>
        <td>${num(cmp.currentLiabilities)}</td>
      </tr>`;
    return mainRow + cmpRow;
  }).join('');
  el('finLiabTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            ${compare ? '<th scope="col">רשות</th>' : ''}
            <th scope="col">סה"כ התחייבויות (אלפי ש"ח)</th>
            <th scope="col">התחייבויות שוטפות (אלפי ש"ח)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// A stat tile per city (reusing the same .stat/.stat-row look as the
// national KPIs at the top of the page), right under the section heading -
// the population figures feed the per-resident chart/columns further down,
// but a reader shouldn't have to find those to learn the headcount itself.
function renderPopulationStats(population, compareName, comparePopulation) {
  const box = el('finPopStats');
  const tiles = [];
  if (population != null) {
    tiles.push(`
      <div class="stat" style="border-inline-start-color:${CITY_COLOR_MAIN}">
        <span class="stat-n">${num(population)}</span>
        <span class="stat-l">תושבים — ${esc(state.authority)} (מפקד ${CBS_POPULATION_YEAR})</span>
      </div>`);
  }
  if (compareName) {
    tiles.push(comparePopulation != null ? `
      <div class="stat" style="border-inline-start-color:${CITY_COLOR_COMPARE}">
        <span class="stat-n">${num(comparePopulation)}</span>
        <span class="stat-l">תושבים — ${esc(compareName)} (מפקד ${CBS_POPULATION_YEAR})</span>
      </div>` : `
      <div class="stat unknown">
        <span class="stat-n">—</span>
        <span class="stat-l">תושבים — ${esc(compareName)}: הנתון לא נמצא</span>
      </div>`);
  }
  box.innerHTML = tiles.join('');
}

async function renderAuthorityCharts() {
  const wrap = el('finAuthCharts');
  if (!state.authority) {
    wrap.hidden = true;
    el('finAreas').hidden = true;
    return;
  }
  wrap.hidden = false;
  el('finChartAuthRevenue').innerHTML = '<p class="acc-hint">טוען…</p>';
  el('finChartAuthPerCapita').innerHTML = '<p class="acc-hint">טוען…</p>';
  el('finChartAuthLiab').innerHTML = '<p class="acc-hint">טוען…</p>';

  const hasCompare = !!state.compareAuthority;
  // Only 4 outer fetches now (2 with no compare authority set): the bundle
  // (revenue+balance+areas together, see fetchAuthorityBundle), population
  // and jurisdiction area, each x2 when comparing. Racing them still pins
  // the wait to the slowest one instead of their sum, and a failure in any
  // one can't take down the others - but the REAL fix for a slow "טוען" was
  // cutting how many requests get fired in the first place (27 down to 9
  // per authority), not just how they're scheduled; see fetchAuthorityBundle.
  const [
    bundle, compareBundle, population, comparePopulation, jurisdictionArea, compareJurisdictionArea,
  ] = await Promise.all([
    fetchAuthorityBundle(state.authority),
    hasCompare ? fetchAuthorityBundle(state.compareAuthority) : Promise.resolve(null),
    fetchPopulation(state.authority),
    hasCompare ? fetchPopulation(state.compareAuthority) : Promise.resolve(null),
    fetchJurisdictionArea(state.authority),
    hasCompare ? fetchJurisdictionArea(state.compareAuthority) : Promise.resolve(null),
  ]);

  renderPopulationStats(population, hasCompare ? state.compareAuthority : null, comparePopulation);

  // Every chart/table below still wants its own narrow shape - deriving
  // these as plain projections of the one bundled fetch (rather than
  // reshaping every downstream consumer) keeps this the only place that
  // needs to know the fetch was merged.
  const points = bundle.map(({ year, revenue, expense }) => ({ year, revenue, expense }));
  const comparePoints = compareBundle?.map(({ year, revenue, expense }) => ({ year, revenue, expense })) ?? null;
  const balancePoints = bundle.map(({ year, assets, liabilities, currentLiabilities }) => ({ year, assets, liabilities, currentLiabilities }));
  const compareBalancePoints = compareBundle?.map(({ year, assets, liabilities, currentLiabilities }) => ({ year, assets, liabilities, currentLiabilities })) ?? null;
  const areaPoints = bundle.map(({ year, areas }) => ({ year, areas }));
  const compareAreaPoints = compareBundle?.map(({ year, areas }) => ({ year, areas })) ?? null;

  if (!points.length) {
    el('finChartAuthRevenue').innerHTML = `<p class="acc-hint">לא נמצאו נתוני הכנסות/הוצאות עבור "${esc(state.authority)}" באף שנה זמינה.</p>`;
    el('finChartAuthPerCapita').innerHTML = '';
    el('finAuthTable').innerHTML = '';
    el('finPopNote').hidden = true;
  } else {
    const compare = hasCompare && comparePoints?.length
      ? { name: state.compareAuthority, points: comparePoints } : null;
    renderGroupedChart('finChartAuthRevenue', `הכנסות והוצאות לפי שנה — ${state.authority}`, points, 'אלפי ש"ח',
      undefined, compare);
    renderAuthorityTable(points, compare, population, comparePopulation);
    // A typed compare-authority that matched nothing needs to say so - silently
    // leaving the chart without a backdrop bar and no explanation looks
    // identical to the feature simply not having run.
    const compareWarn = el('finCompareWarn');
    compareWarn.hidden = !(hasCompare && !compare);
    if (!compare && hasCompare) {
      compareWarn.textContent = `לא נמצאו נתונים עבור "${state.compareAuthority}" לצורך השוואה.`;
    }

    // Same revenue/expense points as the chart above, divided by the CBS
    // 2022 population (see fetchPopulation) - a second chart rather than a
    // toggle on the first, since the two use genuinely different units
    // (אלפי ש"ח vs. plain ש"ח) and switching between them mid-figure would
    // make the y-axis lie about what's being compared.
    if (population) {
      const perCapitaPoints = points.map((p) => ({
        year: p.year, revenue: Math.round((p.revenue * 1000) / population), expense: Math.round((p.expense * 1000) / population),
      }));
      const comparePerCapita = compare && comparePopulation
        ? {
          name: compare.name,
          points: compare.points.map((p) => ({
            year: p.year, revenue: Math.round((p.revenue * 1000) / comparePopulation), expense: Math.round((p.expense * 1000) / comparePopulation),
          })),
        } : null;
      renderGroupedChart('finChartAuthPerCapita', `הכנסות והוצאות לתושב, לפי שנה — ${state.authority}`, perCapitaPoints, 'ש"ח',
        undefined, comparePerCapita);
    } else {
      el('finChartAuthPerCapita').innerHTML = `<p class="acc-hint">לא נמצא נתון אוכלוסייה עבור "${esc(state.authority)}" במפקד ${CBS_POPULATION_YEAR}.</p>`;
    }
  }

  // Balance sheet: only the total-vs-current liabilities combo chart - the
  // total-size-alone chart was removed (assets == liabilities exactly, so it
  // just duplicated this chart's own "back" bar with no new information).
  // The compare authority's own TOTAL liabilities is what's shown as the
  // backdrop here - its current-liabilities figure isn't part of this
  // particular chart's two series, so there's nothing else meaningful of
  // its to layer in a third time.
  if (!balancePoints.length) {
    el('finChartAuthLiab').innerHTML = `<p class="acc-hint">לא נמצאו נתוני מאזן עבור "${esc(state.authority)}" באף שנה זמינה.</p>`;
    el('finLiabTable').innerHTML = '';
  } else {
    const compareBalance = hasCompare && compareBalancePoints?.length
      ? { name: state.compareAuthority, points: compareBalancePoints.map((p) => ({ year: p.year, revenue: p.currentLiabilities, expense: p.liabilities })) }
      : null;
    renderGroupedChart('finChartAuthLiab', `התחייבויות: סה"כ מול שוטפות — ${state.authority}`,
      balancePoints.map((p) => ({ year: p.year, revenue: p.currentLiabilities, expense: p.liabilities })),
      'אלפי ש"ח', { front: 'שוטפות', back: 'סה"כ' }, compareBalance);
    // The table's own compare columns use the compare authority's real
    // current-liabilities figure (not the flattened single backdrop value
    // the chart above uses) - a table has room for both numbers plainly.
    const compareBalanceTable = hasCompare && compareBalancePoints?.length
      ? { name: state.compareAuthority, points: compareBalancePoints } : null;
    renderLiabilityTable(balancePoints, compareBalanceTable);
  }

  // שטחים לפי ייעוד: a separate section (own <section>, own hidden flag),
  // not folded into the charts above - land use, not fiscal performance,
  // even though it comes from the same report.
  const areasWrap = el('finAreas');
  if (!areaPoints.length) {
    areasWrap.hidden = true;
  } else {
    areasWrap.hidden = false;
    const compareAreas = hasCompare && compareAreaPoints?.length
      ? { name: state.compareAuthority, points: compareAreaPoints } : null;
    const latest = areaPoints[areaPoints.length - 1];
    // The compare authority's own latest year can differ from the main
    // authority's (different coverage gaps) - matched by year value, not
    // assumed to be the same array index.
    const compareLatest = compareAreas?.points.find((p) => p.year === latest.year)
      || compareAreas?.points[compareAreas.points.length - 1] || null;
    const areaEntries = AREA_CATEGORIES.filter((cat) => latest.areas[cat] != null).flatMap((cat) => [
      { label: cat, value: latest.areas[cat] },
      ...(compareAreas && compareLatest?.areas[cat] != null
        ? [{ label: `${cat} — ${compareAreas.name}`, value: compareLatest.areas[cat], compare: true }] : []),
    ]);
    renderHBarChart('finChartAreas', `שטחים לפי ייעוד, ${latest.year} — ${state.authority}${compareAreas ? ` / ${compareAreas.name}` : ''}`,
      areaEntries, 'אלפי מ"ר');
    renderAreasTable(areaPoints, compareAreas);
    const jurNote = el('finJurisdictionNote');
    const jurParts = [];
    if (jurisdictionArea != null) jurParts.push(`${state.authority}: ${num(jurisdictionArea)} דונם`);
    if (hasCompare && compareJurisdictionArea != null) jurParts.push(`${state.compareAuthority}: ${num(compareJurisdictionArea)} דונם`);
    if (jurParts.length) {
      jurNote.hidden = false;
      jurNote.textContent = `שטח שיפוט - ${jurParts.join(', ')} (נתוני ${JURISDICTION_YEAR} - נתון חד-פעמי, אינו מפורסם בשנים אחרות).`;
    } else {
      jurNote.hidden = true;
    }
  }
}

/** A single population figure for one authority, from CBS's 2022 census (see
 *  finance-data.js) - not per-year, so every year's per-resident figure in
 *  the table below reuses this same number; a real limitation, stated on the
 *  page next to the numbers it affects, not hidden in a tooltip. */
async function fetchPopulation(authority) {
  try {
    const { records } = await dsQuery(CBS_POPULATION_RESOURCE_ID, { [CBS_POPULATION_FIELD]: authority });
    if (!records.length) return null;
    const n = Number(String(records[0]['Total_Population']).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Jurisdiction area (דונם) - a single figure, 2024 only (see
 *  finance-data.js) - not a per-year loop like everything else here. */
async function fetchJurisdictionArea(authority) {
  const cfg = YEAR_RESOURCES[JURISDICTION_YEAR];
  try {
    const { records } = await dsQuery(cfg.resourceId, { שם_רשות: authority, [cfg.sheetField]: JURISDICTION_SHEET, שורה: JURISDICTION_ROW });
    if (!records.length) return null;
    const n = Number(records[0]['ערך']);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// Plain values-underneath-the-chart table, same pattern as the other
// authority tables on this page - one column per land-use category, and the
// same city-per-row stacking as renderAuthorityTable/renderLiabilityTable
// when a compare authority is set, rather than doubling every column.
function renderAreasTable(points, compare = null) {
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const cmp = compareByYear.get(p.year);
    const mainRow = `
      <tr>
        <th scope="row"${cmp ? ' rowspan="2"' : ''}>${p.year}</th>
        ${compare ? citySwatchCell(state.authority, CITY_COLOR_MAIN) : ''}
        ${AREA_CATEGORIES.map((cat) => `<td>${p.areas[cat] != null ? num(p.areas[cat]) : '—'}</td>`).join('')}
      </tr>`;
    if (!cmp) return mainRow;
    const cmpRow = `
      <tr class="fin-row-compare">
        ${citySwatchCell(compare.name, CITY_COLOR_COMPARE)}
        ${AREA_CATEGORIES.map((cat) => `<td>${cmp.areas[cat] != null ? num(cmp.areas[cat]) : '—'}</td>`).join('')}
      </tr>`;
    return mainRow + cmpRow;
  }).join('');
  el('finAreasTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            ${compare ? '<th scope="col">רשות</th>' : ''}
            ${AREA_CATEGORIES.map((cat) => `<th scope="col">${esc(cat)} (אלפי מ"ר)</th>`).join('')}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ---------- detailed per-authority statement - fully live, any year ---------- */

// The analyst-persona/instructions half of the suggested prompt - fixed
// text, not generated per authority/year (see ai_promt.txt in the repo
// root, which this is copied from verbatim; edit that file for reference
// and mirror the change here, since the page has no runtime file-loading
// mechanism to read it live).
const AI_PROMPT_INSTRUCTIONS = `אתה מומחה בהסברת נתונים מורכבים לאנשים פשוטים, נתח את הדוחות הכספיים, מצא אנומליות, מגמות בעיתיות, הצג גרפים וכל כלי אחר על מנת לאפשר להדיוט את המשמעויות הכלכליות, הנסתרות והחשובות בדוחות הכספיים. אם אינך יכול לייצר גרפים, ייצר טבלאות.

התייחס לנושאים כמו הוצאות על חינוך, פיתוח, היקף השטחים המניבים לעירייה, התחיבויות עתידיות וכל פרמטר אחר אשר משפיע על איכות החיים של התושבים. אם אינך יכול לבצע חלק מהבקשות, בצע את מה שאתה יכול`;

/** A ready-to-paste prompt for an AI chat, framed around the CSV file the
 *  buttons further down this page produce - NOT a live URL for the
 *  assistant to fetch on its own. data.gov.il's DataStore API only answers
 *  requests from Israeli sources, so a chat service running elsewhere
 *  (which is most of them) can't reach it directly; the reliable path is
 *  download-then-upload, same as any other file a person hands the chat. */
function renderAiPrompt() {
  const box = el('finAiPrompt');
  if (!state.authority) { box.value = ''; return; }
  box.value = `${AI_PROMPT_INSTRUCTIONS}

מצורף קובץ CSV עם הדוח הכספי המבוקר של הרשות המקומית "${state.authority}" לשנת ${state.year}, כפי שמפרסם משרד הפנים (מקור: data.gov.il). כל שורה בקובץ היא סעיף אחד בדוח (עמודות: שם_רשות, שנה, גיליון, שורה, עמודה, ערך).`;
}
el('finAiPromptCopy').addEventListener('click', async () => {
  const btn = el('finAiPromptCopy');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(el('finAiPrompt').value);
    btn.textContent = 'הועתק ✓';
  } catch {
    el('finAiPrompt').select(); // clipboard API unavailable/denied - at least select it for manual Ctrl+C
    btn.textContent = 'סמנו והעתיקו ידנית (Ctrl+C)';
  }
  setTimeout(() => { btn.textContent = original; }, 2000);
});

async function renderStatement() {
  const box = el('finStatement');
  renderAiPrompt();
  if (!state.authority) {
    box.innerHTML = '<p class="acc-hint">התחילו להקליד שם רשות למעלה כדי לראות את הדוח הכספי המלא שלה.</p>';
    return;
  }
  const cfg = YEAR_RESOURCES[state.year];
  showLoading(box, `טוען דוח כספי — ${state.authority}, ${state.year}…`);
  try {
    const filters = { שם_רשות: state.authority };
    if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
    const { records, total } = await dsQuery(cfg.resourceId, filters);
    state.currentRecords = records;
    if (!records.length) {
      box.innerHTML = `<p class="acc-hint">לא נמצא דוח עבור "${esc(state.authority)}" בשנת ${state.year} (${esc(cfg.coverage)}).</p>`;
      return;
    }

    const bySheet = new Map();
    for (const rec of records) {
      const sheet = rec[cfg.sheetField];
      if (!bySheet.has(sheet)) bySheet.set(sheet, []);
      bySheet.get(sheet).push(rec);
    }

    const sections = [...bySheet.entries()].map(([sheet, rows]) => `
      <details class="fin-sheet">
        <summary>${esc(sheet)} <span class="acc-hint">(${rows.length} סעיפים)</span></summary>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead><tr><th scope="col">שורה</th><th scope="col">עמודה</th><th scope="col">ערך</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr><td dir="auto">${esc(r['שורה'])}</td><td dir="auto">${esc(r['עמודה'])}</td><td>${num(r['ערך'])}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>`).join('');

    box.innerHTML = `
      <p class="acc-hint">${num(total)} סעיפים, ${bySheet.size} גיליונות — ${esc(cfg.coverage)}.</p>
      ${sections}`;
    applyStatementSearch(); // re-apply whatever search was already typed, against the new render
  } catch (err) {
    showError(box, err);
    state.currentRecords = [];
  }
}

/** Filters the already-rendered statement in place - no re-fetch, this is
 *  pure client-side text matching over what's already on screen. A sheet
 *  with zero matching rows is hidden entirely (30+ sheets is too many to
 *  scan past); a sheet with at least one match opens itself, so a result
 *  is never left inside a still-collapsed <details>. Clearing the box shows
 *  everything again, collapsed back to its normal closed state. */
function applyStatementSearch() {
  const q = el('finStatementSearch').value.trim().toLowerCase();
  const sheets = document.querySelectorAll('#finStatement .fin-sheet');
  sheets.forEach((sheet) => {
    if (!q) { sheet.hidden = false; sheet.open = false; sheet.querySelectorAll('tr').forEach((tr) => { tr.hidden = false; }); return; }
    let anyMatch = false;
    sheet.querySelectorAll('tbody tr').forEach((tr) => {
      const match = tr.textContent.toLowerCase().includes(q);
      tr.hidden = !match;
      if (match) anyMatch = true;
    });
    sheet.hidden = !anyMatch;
    if (anyMatch) sheet.open = true;
  });
}
el('finStatementSearch').addEventListener('input', debounce(applyStatementSearch, 200));

/* ---------- CSV export - exactly the statement currently shown ---------- */

el('finCsv').addEventListener('click', () => {
  if (!state.currentRecords?.length) return;
  const cfg = YEAR_RESOURCES[state.year];
  const csv = buildCsv(
    ['שם_רשות', 'שנה', 'גיליון', 'שורה', 'עמודה', 'ערך'],
    state.currentRecords.map((r) => ({
      שם_רשות: r['שם_רשות'], שנה: state.year, גיליון: r[cfg.sheetField], שורה: r['שורה'], עמודה: r['עמודה'], ערך: r['ערך'],
    })),
  );
  saveCsv(csv, `דוח_כספי_${state.authority}_${state.year}.csv`);
});

/* ---------- CSV export - every year available for the selected authority,
   one file. No separate "Excel" format: a CSV opens natively in Excel/Sheets
   with full fidelity for a flat table like this one, so a second binary
   format would just be the same data under a different extension - not a
   real distinction worth a hand-rolled XLSX writer (this project ships no
   external JS dependencies at all, browser-side). Years the authority has no
   rows in (e.g. a city in 2020/2021, when only local councils were found)
   are skipped, not treated as an error - see coverage per year in
   finance-data.js. */
async function downloadAllYearsForAuthority() {
  if (!state.authority) return;
  const btn = el('finCsvAll');
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const all = [];
    let found = 0;
    for (const year of YEARS_DESC) {
      btn.textContent = `טוען ${year}… (${found} שנים עד כה)`;
      const cfg = YEAR_RESOURCES[year];
      const filters = { שם_רשות: state.authority };
      if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
      try {
        const { records } = await dsQuery(cfg.resourceId, filters);
        if (records.length) {
          found += 1;
          records.forEach((r) => all.push({
            שם_רשות: r['שם_רשות'], שנה: year, כיסוי: cfg.coverage,
            גיליון: r[cfg.sheetField], שורה: r['שורה'], עמודה: r['עמודה'], ערך: r['ערך'],
          }));
        }
      } catch { /* one year failing shouldn't abort the rest */ }
      await new Promise((r) => { setTimeout(r, 200); }); // politeness pacing, same spirit as elsewhere on this site
    }
    if (!all.length) {
      alert(`לא נמצאו נתונים עבור "${state.authority}" באף שנה זמינה.`);
      return;
    }
    const csv = buildCsv(['שם_רשות', 'שנה', 'כיסוי', 'גיליון', 'שורה', 'עמודה', 'ערך'], all);
    saveCsv(csv, `דוח_כספי_${state.authority}_כל_השנים.csv`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

el('finCsvAll').addEventListener('click', downloadAllYearsForAuthority);

/* ---------- wiring ---------- */

async function onAuthorityChange() {
  const name = authorityInput.value.trim();
  state.authority = rosterNames.includes(name) ? name : (name || null);
  syncUrl();
  await Promise.all([renderAuthorityCharts(), renderStatement()]);
}

// Deliberately no roster-exact-match gate here (unlike the comment that used
// to be here claimed - the check was actually still there, silently doing
// nothing on anything but a perfect match, including a real name typed
// before loadRoster() had finished). Any non-empty text is accepted as-is;
// fetchAuthorityBundle() naturally returns zero points for a name that
// doesn't exist, and renderAuthorityCharts() below now says so explicitly
// instead of just leaving the chart unchanged with no explanation.
const compareInput = el('finCompare');
async function onCompareChange() {
  const name = compareInput.value.trim();
  state.compareAuthority = name || null;
  syncUrl();
  await renderAuthorityCharts();
}
compareInput.addEventListener('input', debounce(onCompareChange, 300));

el('finYear').addEventListener('change', async (e) => {
  state.year = Number(e.target.value);
  syncUrl();
  await Promise.all([renderKpis(), renderStatement()]);
});
authorityInput.addEventListener('input', debounce(onAuthorityChange, 300));

(async function start() {
  // Runs before anything else trusts YEAR_RESOURCES/YEARS_DESC - readStateFromUrl
  // below validates a ?year= against YEAR_RESOURCES, and the default (state.year,
  // set above at module load) should already point at the newest year if one
  // was just discovered, not silently stay one year behind it.
  const discovered = await discoverNewYears();
  if (discovered.length) state.year = YEARS_DESC[0];
  populateYearSelect();

  readStateFromUrl();
  authorityInput.value = state.authority || '';
  compareInput.value = state.compareAuthority || '';
  el('finYear').value = String(state.year);
  syncUrl(); // normalizes a bare visit (no query string yet) into a real, copyable link immediately
  await loadRoster();
  await Promise.all([renderKpis(), renderAuthorityCharts(), renderStatement()]);
}());
