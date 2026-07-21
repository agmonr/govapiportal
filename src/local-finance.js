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
import { YEAR_RESOURCES, YEARS_DESC, ROSTER_YEAR, ROSTER_FILTERS, SUMMARY_SHEET, SUMMARY_ROWS, SUMMARY_COLUMN, form2RowsFor, ARNONA_ROW, ARNONA_COLUMN } from './finance-data.js';

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
  const year = Number(p.get('year'));
  if (authority) state.authority = authority;
  if (YEAR_RESOURCES[year]) state.year = year;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.authority) p.set('authority', state.authority);
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

el('finYear').innerHTML = YEARS_DESC.map((y) => `<option value="${y}">${y}</option>`).join('');
el('finYear').value = String(state.year);

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
 *  a different mark from renderBarChart, not that same one rotated. */
function renderHBarChart(figId, caption, entries, unit) {
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...entries.map((e) => e.value));
  const rows = entries.map((e) => `
    <div class="acc-hbar" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
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

async function fetchAuthorityYearly(authority) {
  const points = []; // { year, revenue, expense }
  for (const year of YEARS_DESC) {
    const cfg = YEAR_RESOURCES[year];
    const rows = form2RowsFor(year);
    const filters = { שם_רשות: authority, [cfg.sheetField]: 'טופס 2', שורה: [rows.revenue, rows.expense], עמודה: rows.column };
    if (cfg.yearFilter) filters[cfg.yearFilter.field] = cfg.yearFilter.value;
    try {
      const { records } = await dsQuery(cfg.resourceId, filters);
      if (!records.length) continue; // authority not covered this year - a real gap, not an error
      const revenue = Number(records.find((r) => r['שורה'] === rows.revenue)?.['ערך']) || 0;
      const expense = Number(records.find((r) => r['שורה'] === rows.expense)?.['ערך']) || 0;
      points.push({ year, revenue, expense });
    } catch { /* one year failing shouldn't hide the rest */ }
  }
  return points.sort((a, b) => a.year - b.year); // oldest first - a trend reads left-to-right in time
}

/** Revenue (front, narrower, green) layered over expense (back, full-width,
 *  accent) sharing one baseline per year - the back bar's edges show on both
 *  sides of the front one regardless of how close the two values are, so
 *  neither series depends on a height gap to stay visible. Peak is taken
 *  across BOTH series together, not per-series, so a year where expense
 *  exceeds revenue (a deficit year) doesn't get its back bar clipped taller
 *  than the chart while the front bar looks artificially short. */
function renderComboChart(figId, caption, points, unit) {
  const fig = el(figId);
  if (!points.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...points.flatMap((p) => [p.revenue, p.expense]));
  const bars = points.map((p) => {
    const revH = peak ? Math.round((p.revenue / peak) * 150) : 0;
    const expH = peak ? Math.round((p.expense / peak) * 150) : 0;
    return `
      <div class="acc-bar" title="${esc(String(p.year))} — הכנסות: ${num(p.revenue)} ${esc(unit)}, הוצאות: ${num(p.expense)} ${esc(unit)}">
        <div class="acc-bar-track acc-bar-track-combo">
          <div class="acc-bar-fill acc-bar-back" style="block-size:${expH}px"></div>
          <div class="acc-bar-fill acc-bar-front" style="block-size:${revH}px"></div>
        </div>
        <span class="acc-bar-y">${esc(String(p.year))}</span>
      </div>`;
  }).join('');
  fig.className = 'acc-chart';
  fig.innerHTML = `
    <figcaption>${esc(caption)}</figcaption>
    <div class="acc-legend">
      <span class="acc-legend-item"><span class="acc-legend-swatch" style="background:#1a7f45"></span>הכנסות</span>
      <span class="acc-legend-item"><span class="acc-legend-swatch" style="background:color-mix(in srgb, var(--accent) 55%, transparent)"></span>הוצאות</span>
    </div>
    <div class="acc-bars">${bars}</div>`;
}

// The chart's own values only show on hover (the title attribute) - a plain
// table underneath makes every year's figures visible at once, newest year
// first (a table is read top-down, so the most recent row leads).
function renderAuthorityTable(points) {
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const surplus = p.revenue - p.expense;
    // A subtle text-color flag, not a full row/cell fill - visible on a
    // glance down the column without turning a deficit year into an alarm.
    const color = surplus >= 0 ? 'var(--fin-ok)' : 'var(--fin-bad)';
    return `
      <tr>
        <th scope="row">${p.year}</th>
        <td>${num(p.revenue)}</td>
        <td>${num(p.expense)}</td>
        <td dir="ltr" style="color:${color}; font-weight:600">${surplus >= 0 ? '+' : ''}${num(surplus)}</td>
      </tr>`;
  }).join('');
  el('finAuthTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            <th scope="col">הכנסות (אלפי ש"ח)</th>
            <th scope="col">הוצאות (אלפי ש"ח)</th>
            <th scope="col">עודף (גרעון)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function renderAuthorityCharts() {
  const wrap = el('finAuthCharts');
  if (!state.authority) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  el('finChartAuthRevenue').innerHTML = '<p class="acc-hint">טוען…</p>';
  const points = await fetchAuthorityYearly(state.authority);
  if (!points.length) {
    el('finChartAuthRevenue').innerHTML = `<p class="acc-hint">לא נמצאו נתוני הכנסות/הוצאות עבור "${esc(state.authority)}" באף שנה זמינה.</p>`;
    return;
  }
  renderComboChart('finChartAuthRevenue', `הכנסות והוצאות לפי שנה — ${state.authority}`, points, 'אלפי ש"ח');
  renderAuthorityTable(points);

  // ממוצע ארנונה למגורים למ"ר: same sheet as the national summary above, so
  // the same 2023-2024-only limit applies (confirmed absent from every
  // earlier year checked) - a separate, smaller fetch, not part of the
  // Form 2 loop above, since it lives on a different sheet entirely.
  el('finChartAuthArnona').innerHTML = '<p class="acc-hint">טוען…</p>';
  const arnonaPoints = await fetchAuthorityArnona(state.authority);
  renderBarChart('finChartAuthArnona', `ממוצע ארנונה למגורים למ"ר, לפי שנה — ${state.authority}`,
    arnonaPoints.map((p) => ({ label: String(p.year), value: p.value })), 'ש"ח למ"ר', 'ok-chart');
}

async function fetchAuthorityArnona(authority) {
  const points = []; // { year, value }
  for (const year of YEARS_DESC) {
    const cfg = YEAR_RESOURCES[year];
    if (!cfg.hasSummary) continue; // this sheet only exists for 2023-2024
    try {
      const { records } = await dsQuery(cfg.resourceId, {
        שם_רשות: authority, [cfg.sheetField]: SUMMARY_SHEET, שורה: ARNONA_ROW, עמודה: ARNONA_COLUMN,
      });
      if (records.length) points.push({ year, value: Number(records[0]['ערך']) || 0 });
    } catch { /* one year failing shouldn't hide the other */ }
  }
  return points.sort((a, b) => a.year - b.year);
}

/* ---------- detailed per-authority statement - fully live, any year ---------- */

async function renderStatement() {
  const box = el('finStatement');
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
  } catch (err) {
    showError(box, err);
    state.currentRecords = [];
  }
}

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

el('finYear').addEventListener('change', async (e) => {
  state.year = Number(e.target.value);
  syncUrl();
  await Promise.all([renderKpis(), renderStatement()]);
});
authorityInput.addEventListener('input', debounce(onAuthorityChange, 300));

(async function start() {
  readStateFromUrl();
  authorityInput.value = state.authority || '';
  el('finYear').value = String(state.year);
  syncUrl(); // normalizes a bare visit (no query string yet) into a real, copyable link immediately
  await loadRoster();
  await Promise.all([renderKpis(), renderAuthorityCharts(), renderStatement()]);
}());
