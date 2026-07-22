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
import { YEAR_RESOURCES, YEARS_DESC, ROSTER_YEAR, ROSTER_FILTERS, SUMMARY_SHEET, SUMMARY_ROWS, SUMMARY_COLUMN, form2RowsFor, BALANCE_COLUMN, balanceRowsFor, AREA_SHEET, AREA_CATEGORIES, areaColumnFor, JURISDICTION_SHEET, JURISDICTION_ROW, JURISDICTION_YEAR } from './finance-data.js';
import { renderBarChart, renderHBarChart, renderGroupedChart, CITY_COLOR_MAIN, CITY_COLOR_COMPARE, citySwatchCell } from './charts.js';
import { dsFilter } from './datastore.js';
import { CBS_POPULATION_YEAR, fetchPopulation } from './population.js';

initThemePicker(el('themePick'));

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- state ---------- */

// הוד השרון is the default landing authority (not because it's special
// statistically - it just needs to be *something* real rather than a blank
// prompt on first load) and doubles as the one this whole data pipeline was
// hand-verified against earlier, so it's also the safest default to show.
const DEFAULT_AUTHORITY = 'הוד השרון';
// רעננה as the default comparison - a similarly-sized neighboring city, so
// the comparison the page opens with is a meaningful one rather than an
// empty compare field the visitor has to know to fill in themselves.
const DEFAULT_COMPARE_AUTHORITY = 'רעננה';

const state = {
  authority: DEFAULT_AUTHORITY,
  compareAuthority: DEFAULT_COMPARE_AUTHORITY,
  year: YEARS_DESC[0],
  summaryCache: new Map(), // year -> { totals, byAuthority[] } | 'unsupported'
};

/* Bumped on every call to renderAuthorityCharts()/renderStatement() -
 * neither guards against being superseded mid-flight otherwise. Typing a
 * second authority before the first one's fetch resolves starts a second
 * call while the first is still awaiting; the first call's captions/legends
 * read state.authority LIVE (after its own await), so by the time it
 * finishes it can render the FIRST city's fetched numbers under the SECOND
 * city's name - the data and the label come from two different calls,
 * silently. A per-function generation counter lets a call detect it's been
 * superseded right after its await and bail before touching the DOM, so
 * only the newest call (whose captured state.authority is still current)
 * ever renders. Two separate counters because the two functions fire on
 * different triggers (year alone re-runs renderStatement but not
 * renderAuthorityCharts; compare alone re-runs renderAuthorityCharts but
 * not renderStatement) - sharing one counter would make an unrelated
 * change falsely look like it superseded a still-valid in-flight call. */
let authorityChartsGeneration = 0;
let statementGeneration = 0;

/* ---------- URL state: makes the current authority+year copyable/shareable
   as a link, and a shared link reproduces the same view on open. Read once
   on load (before the first render), written back with replaceState (not
   pushState) on every change - a link should reflect the latest view, not
   grow a back-button history entry per keystroke. */
function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const authority = p.get('authority')?.trim();
  const year = Number(p.get('year'));
  if (authority) state.authority = authority;
  // A `compare` param that's PRESENT but empty means "explicitly no
  // comparison" (a visitor cleared the field and shared/reloaded that URL)
  // - distinct from the param being entirely ABSENT (a bare/fresh visit,
  // where DEFAULT_COMPARE_AUTHORITY, already in `state`, should stand).
  // Collapsing those two would make a shared "no compare" link silently
  // grow the default comparison back on open.
  if (p.has('compare')) state.compareAuthority = p.get('compare').trim() || null;
  if (YEAR_RESOURCES[year]) state.year = year;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.authority) p.set('authority', state.authority);
  p.set('compare', state.compareAuthority || '');
  p.set('year', String(state.year));
  history.replaceState(null, '', `?${p}`);
}

/* ---------- authority roster (one cheap query, cached) ---------- */

const authorityInput = el('finAuthority');
let rosterNames = [];

async function loadRoster() {
  try {
    const cfg = YEAR_RESOURCES[ROSTER_YEAR];
    const { records } = await dsFilter(cfg.resourceId, {
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

  const { records } = await dsFilter(cfg.resourceId, {
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

/* ---------- charts - renderBarChart/renderHBarChart/renderGroupedChart are shared, see charts.js ---------- */

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
 *  3x (to 9, 18 with compare) was the first fix.
 *
 *  Comparing two authorities then doubled that back up to 18: one request
 *  per (year, authority) pair, even though both authorities' requests hit
 *  the SAME resource with the SAME גליון/שורה/עמודה filters and differ only
 *  in שם_רשות. CKAN OR-matches an array value within one field (already
 *  relied on for גליון/שורה/עמודה above), so שם_רשות: [main, compare] in
 *  ONE request returns both authorities' rows mixed together, split back out
 *  client-side by each record's own שם_רשות - down to 9 requests total
 *  regardless of whether a compare authority is set, not 9 or 18. Measured
 *  directly against the two-request version: same records, half the
 *  round-trips, and the one year that happened to be slow/erroring on
 *  data.gov.il (2017, ~2s to a 503) only pays that cost once instead of
 *  twice.
 *
 *  Years fetch concurrently, same reasoning as before: no reason to wait
 *  for 2024 to answer before asking 2023. A year failing (or an authority
 *  not being covered that year) resolves to `null` for that authority rather
 *  than rejecting, so one bad year - or one authority missing from it -
 *  can't hide the rest. */
async function fetchAuthorityBundles(authorities) {
  const perYear = await Promise.all(YEARS_DESC.map(async (year) => {
    const cfg = YEAR_RESOURCES[year];
    const form2 = form2RowsFor(year);
    const balRows = balanceRowsFor(year);
    const areaCol = areaColumnFor(year);
    const filters = {
      שם_רשות: authorities.length === 1 ? authorities[0] : authorities,
      [cfg.sheetField]: ['טופס 2', 'טופס 1 אקטיב', 'טופס 1 פאסיב', AREA_SHEET],
      שורה: [form2.revenue, form2.expense, balRows.assets, balRows.liabilities, balRows.currentLiabilities, ...AREA_CATEGORIES],
      עמודה: [form2.column, BALANCE_COLUMN, areaCol],
    };
    if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
    try {
      const { records } = await dsFilter(cfg.resourceId, filters);
      if (!records.length) return null; // neither authority covered this year - a real gap, not an error
      const byAuthority = new Map();
      for (const name of authorities) {
        const own = records.filter((r) => r['שם_רשות'] === name);
        if (!own.length) { byAuthority.set(name, null); continue; } // THIS authority not covered this year, even though the other one is
        const val = (row) => Number(own.find((r) => r['שורה'] === row)?.['ערך']) || 0;
        const areas = {};
        for (const cat of AREA_CATEGORIES) {
          const rec = own.find((r) => r['שורה'] === cat);
          const v = rec ? Number(rec['ערך']) : null;
          areas[cat] = Number.isFinite(v) ? v : null;
        }
        byAuthority.set(name, {
          year,
          revenue: val(form2.revenue), expense: val(form2.expense),
          assets: val(balRows.assets), liabilities: val(balRows.liabilities), currentLiabilities: val(balRows.currentLiabilities),
          areas,
        });
      }
      return byAuthority;
    } catch { return null; /* one year failing shouldn't hide the rest */ }
  }));
  const result = new Map(authorities.map((name) => [name, []]));
  for (const byAuthority of perYear) {
    if (!byAuthority) continue;
    for (const name of authorities) {
      const p = byAuthority.get(name);
      if (p) result.get(name).push(p);
    }
  }
  for (const points of result.values()) points.sort((a, b) => a.year - b.year); // oldest first - a trend reads left-to-right in time
  return result;
}

// renderGroupedChart, niceAxisStep, buildYearSlots, FIN_PLOT_PX,
// CITY_COLOR_MAIN/COMPARE and citySwatchCell are shared - see charts.js.

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
  const myGeneration = ++authorityChartsGeneration;
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
  const authorities = hasCompare ? [state.authority, state.compareAuthority] : [state.authority];
  // 3 outer fetches now (1 fewer with no compare authority set, 3 fewer with
  // one): the bundle (revenue+balance+areas, BOTH authorities in one request
  // per year - see fetchAuthorityBundles), population and jurisdiction area,
  // each x2 when comparing since those two aren't mergeable the same way
  // (CBS population and the jurisdiction-area row are each already a single
  // small per-authority request, not 9 - merging them would save 1 request
  // instead of 9). Racing them still pins the wait to the slowest one
  // instead of their sum, and a failure in any one can't take down the
  // others.
  const [
    bundlesMap, population, comparePopulation, jurisdictionArea, compareJurisdictionArea,
  ] = await Promise.all([
    fetchAuthorityBundles(authorities),
    fetchPopulation(state.authority),
    hasCompare ? fetchPopulation(state.compareAuthority) : Promise.resolve(null),
    fetchJurisdictionArea(state.authority),
    hasCompare ? fetchJurisdictionArea(state.compareAuthority) : Promise.resolve(null),
  ]);
  const bundle = bundlesMap.get(state.authority) || [];
  const compareBundle = hasCompare ? (bundlesMap.get(state.compareAuthority) || []) : null;
  // A newer authority/compare/year change already started its own call while
  // this one was awaiting - state.authority etc. have moved on, so anything
  // built from them below would mislabel the data this call actually fetched.
  // Bail silently; the newer call owns rendering from here.
  if (myGeneration !== authorityChartsGeneration) return;

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
      state.authority, undefined, compare);
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
        state.authority, undefined, comparePerCapita);
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
      'אלפי ש"ח', state.authority, { front: 'שוטפות', back: 'סה"כ' }, compareBalance);
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

/** Jurisdiction area (דונם) - a single figure, 2024 only (see
 *  finance-data.js) - not a per-year loop like everything else here. */
async function fetchJurisdictionArea(authority) {
  const cfg = YEAR_RESOURCES[JURISDICTION_YEAR];
  try {
    const { records } = await dsFilter(cfg.resourceId, { שם_רשות: authority, [cfg.sheetField]: JURISDICTION_SHEET, שורה: JURISDICTION_ROW });
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

/** A ready-to-paste pandas starting point for the multi-year CSV the
 *  "כל השנים" button produces - same filename and column set
 *  (שם_רשות/שנה/כיסוי/גיליון/שורה/עמודה/ערך) as downloadAllYearsForAuthority()
 *  actually writes, so the script runs unmodified against a file the user
 *  already has. The revenue/expense filter matches the SAME two exact
 *  row-label spellings form2RowsFor() uses internally (legacy "סה"כ
 *  תקבולים"/"סה"כ תשלומים" vs. current-era "פעולות רגילות - סהכ תקבולים"/
 *  "...תשלומים" - see finance-data.js), not a loose substring - a substring
 *  match on "תקבולים" alone was tried first and verified (by actually
 *  running this exact script against a real downloaded CSV) to also catch
 *  every category SUBTOTAL that happens to contain that word
 *  ("סה"כ מיסים ומענקים - תקבולים" and five others), burying the one grand-
 *  total row the reader actually wants under a pile of look-alikes. */
function renderPyTemplate() {
  const box = el('finPyTemplate');
  if (!state.authority) { box.value = ''; return; }
  box.value = `import pandas as pd

# הדוח הכספי המבוקר של ${state.authority} - כל השנים הזמינות
# מקור: data.gov.il, משרד הפנים (ראו כפתור "הורדת CSV — כל השנים לרשות זו" בעמוד)
df = pd.read_csv('דוח_כספי_${state.authority}_כל_השנים.csv')

print("מספר שורות:", len(df))
print("שנים זמינות:", sorted(df['שנה'].unique()))
print("גיליונות זמינים:", df['גיליון'].unique())

# הכנסות/הוצאות (טופס 2) - שורת הסה"כ הכללית מאויתת אחרת בין שנים: עד 2022
# "סה"כ תקבולים"/"סה"כ תשלומים" (עם גרשיים), מ-2023 ואילך "פעולות רגילות -
# סהכ תקבולים"/"פעולות רגילות - סהכ תשלומים" (בלי גרשיים, עם קידומת) -
# מסננים לפי שני הכינויים המדויקים, לא לפי מחרוזת חלקית, כדי לתפוס רק את
# שורת הסה"כ עצמה ולא את תתי-הסכומים (מיסים/שירותים/מפעלים וכו') שגם הם
# מכילים "תקבולים"/"תשלומים" במילה
form2 = df[df['גיליון'] == 'טופס 2']
current_col = form2['עמודה'].str.contains('ביצוע', na=False) & form2['עמודה'].str.contains('שנה נוכחית', na=False)
revenue = form2[current_col & form2['שורה'].isin(['סה"כ תקבולים', 'פעולות רגילות - סהכ תקבולים'])]
expense = form2[current_col & form2['שורה'].isin(['סה"כ תשלומים', 'פעולות רגילות - סהכ תשלומים'])]
print("\\n--- הכנסות (טופס 2), לפי שנה ---")
print(revenue[['שנה', 'ערך']].sort_values('שנה'))
print("\\n--- הוצאות (טופס 2), לפי שנה ---")
print(expense[['שנה', 'ערך']].sort_values('שנה'))

# דוח לתושב (קיים רק החל מ-2023) - השנה האחרונה בקובץ
latest_year = df['שנה'].max()
resident_report = df[(df['שנה'] == latest_year) & (df['גיליון'] == 'דוח לתושב')]
print(f"\\n--- דוח לתושב, {latest_year} ---")
print(resident_report[['שורה', 'עמודה', 'ערך']].head(10))`;
  // Same text, shown again as plain read-only content at the true end of the
  // page - see finPyTemplateFooter in local-finance.html - so a reader who
  // scrolled past the full statement below doesn't have to scroll back up to
  // find the copy box.
  const footer = el('finPyTemplateFooter');
  if (footer) footer.textContent = box.value;
}
el('finPyTemplateCopy').addEventListener('click', async () => {
  const btn = el('finPyTemplateCopy');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(el('finPyTemplate').value);
    btn.textContent = 'הועתק ✓';
  } catch {
    el('finPyTemplate').select();
    btn.textContent = 'סמנו והעתיקו ידנית (Ctrl+C)';
  }
  setTimeout(() => { btn.textContent = original; }, 2000);
});

async function renderStatement() {
  const myGeneration = ++statementGeneration;
  const box = el('finStatement');
  renderAiPrompt();
  renderPyTemplate();
  if (!state.authority) {
    box.innerHTML = '<p class="acc-hint">התחילו להקליד שם רשות למעלה כדי לראות את הדוח הכספי המלא שלה.</p>';
    return;
  }
  const cfg = YEAR_RESOURCES[state.year];
  showLoading(box, `טוען דוח כספי — ${state.authority}, ${state.year}…`);
  try {
    const filters = { שם_רשות: state.authority };
    if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
    const { records, total } = await dsFilter(cfg.resourceId, filters);
    // A newer authority/year change already started its own call while this
    // one was awaiting - the fetch above is scoped correctly to what THIS
    // call asked for, but writing it now would show stale data (or overwrite
    // the newer call's already-current render) under whatever state.authority
    // has since become. Bail; the newer call owns the DOM from here.
    if (myGeneration !== statementGeneration) return;
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
        const { records } = await dsFilter(cfg.resourceId, filters);
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
