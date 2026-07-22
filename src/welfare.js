/**
 * Entry point for welfare.html - תשלומים למסגרות רווחה (משרד הרווחה).
 *
 * Both source resources are small (7 national rows, 232 per-authority rows) -
 * fetched WHOLE, once, on load. Every authority/year/compare selection after
 * that is a client-side filter over the cached rows, not a new request - see
 * src/welfare-data.js for why this differs from local-finance.js's per-year
 * fetch pattern.
 *
 * Deliberately NOT included: any per-resident (population-normalized) figure.
 * Unlike local-finance.js, nothing here merges in a population source, so
 * there is no guarded/ungarded distinction to get wrong - there is simply no
 * per-capita number anywhere on this page.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, showError, showLoading } from './ui.js';
import { initThemePicker } from './theme.js';
import { NATIONAL_RESOURCE_ID, NATIONAL_FIELDS, AUTHORITY_RESOURCE_ID, AUTHORITY_FIELDS, CATEGORY_COMMUNITY, CATEGORY_OUT_OF_HOME, normalizeCategory, parseAuthorityField, RECIPIENTS_RESOURCE_ID, RECIPIENTS_AUTHORITY_FIELD, parseRecipientsYearField } from './welfare-data.js';
import { renderGroupedChart, CITY_COLOR_MAIN, CITY_COLOR_COMPARE, citySwatchCell } from './charts.js';
import { dsQuery } from './datastore.js';

initThemePicker(el('themePick'));

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

// Both source tables are fetched whole (no filters) - the shared dsQuery
// returns the full result object, so callers destructure .records themselves.
const dsAll = (resourceId) => dsQuery(resourceId, { limit: '10000' }).then((r) => r.records);

/* ---------- state ---------- */

const DEFAULT_AUTHORITY = 'ירושלים';
const DEFAULT_COMPARE_AUTHORITY = 'תל אביב-יפו';

const state = {
  authority: DEFAULT_AUTHORITY,
  compareAuthority: DEFAULT_COMPARE_AUTHORITY,
  year: null, // set once national data loads and the real max year is known
};

// code -> { name, byYear: Map<year, { קהילה: {recipients,amount}|null, 'חוץ-ביתי': {...}|null }> }
// - the 18 "big" authorities with a ₪+category breakdown.
let authorityByCode = new Map();
// code -> { name, byYear: Map<year, totalRecipients> } - the ~243 "small"
// authorities with only a combined recipient total, no ₪, no category split.
// Never overlaps authorityByCode - see loadRecipientsOnly().
let smallAuthorityByCode = new Map();
// display name -> code, covering every spelling of every authority (big AND
// small, all historical spellings - see welfare-data.js) - the roster a
// visitor actually picks from.
let nameToCode = new Map();
let nationalRows = []; // [{year, community:{recipients,amount}, outOfHome:{recipients,amount}}], ascending

/* ---------- URL state - same shareable-link pattern as local-finance.html ---------- */

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const authority = p.get('authority')?.trim();
  const year = Number(p.get('year'));
  if (authority) state.authority = authority;
  if (p.has('compare')) state.compareAuthority = p.get('compare').trim() || null;
  if (nationalRows.some((r) => r.year === year)) state.year = year;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.authority) p.set('authority', state.authority);
  p.set('compare', state.compareAuthority || '');
  p.set('year', String(state.year));
  history.replaceState(null, '', `?${p}`);
}

/* ---------- loading + processing (once) ---------- */

async function loadNational() {
  const records = await dsAll(NATIONAL_RESOURCE_ID);
  nationalRows = records.map((r) => ({
    year: Number(r[NATIONAL_FIELDS.year]),
    community: {
      recipients: Number(String(r[NATIONAL_FIELDS.community.recipients]).replace(/,/g, '')) || 0,
      amount: Number(String(r[NATIONAL_FIELDS.community.amount]).replace(/,/g, '')) || 0,
    },
    outOfHome: {
      recipients: Number(String(r[NATIONAL_FIELDS.outOfHome.recipients]).replace(/,/g, '')) || 0,
      amount: Number(String(r[NATIONAL_FIELDS.outOfHome.amount]).replace(/,/g, '')) || 0,
    },
  })).sort((a, b) => a.year - b.year);
}

async function loadAuthorities() {
  const records = await dsAll(AUTHORITY_RESOURCE_ID);
  const byCode = new Map();
  for (const r of records) {
    const parsed = parseAuthorityField(r[AUTHORITY_FIELDS.authority]);
    const category = normalizeCategory(r[AUTHORITY_FIELDS.category]);
    const year = Number(r[AUTHORITY_FIELDS.year]);
    if (!parsed || !category || !Number.isFinite(year)) continue; // unrecognized row shape - skip rather than misfile it
    let entry = byCode.get(parsed.code);
    if (!entry) { entry = { name: parsed.name, latestYear: year, byYear: new Map() }; byCode.set(parsed.code, entry); }
    // Prefer the NEWEST spelling as the display name ("תל אביב-יפו" over
    // "תל אביב") - rows arrive in no guaranteed order, so this is compared
    // per row rather than assumed from fetch order.
    if (year >= entry.latestYear) { entry.name = parsed.name; entry.latestYear = year; }
    let yearEntry = entry.byYear.get(year);
    if (!yearEntry) { yearEntry = {}; entry.byYear.set(year, yearEntry); }
    yearEntry[category] = {
      recipients: Number(String(r[AUTHORITY_FIELDS.recipients]).replace(/,/g, '')) || 0,
      amount: Number(String(r[AUTHORITY_FIELDS.amount]).replace(/,/g, '')) || 0,
    };
  }
  authorityByCode = byCode;
  // Kept for buildNameIndex() below, which also needs every OLDER spelling
  // (e.g. "313 תל אביב"), not just each code's final canonical name.
  return records;
}

/** The ~243 authorities with only a combined recipient total - see
 *  RECIPIENTS_RESOURCE_ID in welfare-data.js. A code already covered by
 *  loadAuthorities() is skipped here even if it also appears in this
 *  resource, so a "big" authority's numbers always come from exactly one
 *  source, never a mix of two not-quite-matching totals. */
async function loadRecipientsOnly() {
  const records = await dsAll(RECIPIENTS_RESOURCE_ID);
  const yearFields = records.length
    ? Object.keys(records[0]).filter((k) => parseRecipientsYearField(k) != null) : [];
  const byCode = new Map();
  for (const r of records) {
    const parsed = parseAuthorityField(r[RECIPIENTS_AUTHORITY_FIELD]);
    if (!parsed || authorityByCode.has(parsed.code)) continue;
    const byYear = new Map();
    for (const field of yearFields) {
      const year = parseRecipientsYearField(field);
      const n = Number(String(r[field]).replace(/,/g, ''));
      if (Number.isFinite(n)) byYear.set(year, n);
    }
    byCode.set(parsed.code, { name: parsed.name, byYear });
  }
  smallAuthorityByCode = byCode;
}

/** Builds the single name->code index every input/URL lookup uses, covering
 *  both authority tiers and every historical spelling. Run once both loads
 *  are done, not inside either loader - loadAuthorities() must finish
 *  deciding each big authority's canonical (newest) name before anything
 *  indexes by name. */
function buildNameIndex(bigAuthorityRecords) {
  nameToCode = new Map();
  for (const [code, entry] of authorityByCode) nameToCode.set(entry.name, code); // canonical (newest) spelling wins first
  for (const [code, entry] of smallAuthorityByCode) if (!nameToCode.has(entry.name)) nameToCode.set(entry.name, code);
  // Older spelling(s) of a BIG authority also resolve, so a shared link or
  // typed-in old name still finds it instead of silently matching nothing.
  for (const r of bigAuthorityRecords) {
    const parsed = parseAuthorityField(r[AUTHORITY_FIELDS.authority]);
    if (parsed && !nameToCode.has(parsed.name)) nameToCode.set(parsed.name, parsed.code);
  }
}

function authorityYears(code) {
  const entry = authorityByCode.get(code);
  if (!entry) return [];
  return [...entry.byYear.keys()].sort((a, b) => a - b)
    .map((year) => ({ year, ...entry.byYear.get(year) }));
}

/* ---------- authority roster (datalist) ---------- */

function populateRoster() {
  const names = [
    ...[...authorityByCode.values()].map((e) => e.name),
    ...[...smallAuthorityByCode.values()].map((e) => e.name),
  ].sort((a, b) => a.localeCompare(b, 'he'));
  el('welAuthorityList').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

/* ---------- year select ---------- */

function populateYearSelect() {
  const years = nationalRows.map((r) => r.year).sort((a, b) => b - a);
  el('welYear').innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  el('welYear').value = String(state.year);
}

/* ---------- national KPIs + trend chart ---------- */

function renderKpis() {
  const row = nationalRows.find((r) => r.year === state.year);
  el('welYearLabel').textContent = state.year;
  const box = el('welKpis');
  if (!row) { box.innerHTML = '<p class="acc-hint">אין נתונים לשנה זו.</p>'; return; }
  const totalRecipients = row.community.recipients + row.outOfHome.recipients;
  const totalAmount = row.community.amount + row.outOfHome.amount;
  box.innerHTML = `
    <div class="stat">
      <span class="stat-n">${num(totalAmount)}</span>
      <span class="stat-l">סה"כ תשלומים (₪)</span>
    </div>
    <div class="stat">
      <span class="stat-n">${num(totalRecipients)}</span>
      <span class="stat-l">סה"כ מקבלי שירות</span>
    </div>
    <div class="stat">
      <span class="stat-n">${num(row.community.amount)}</span>
      <span class="stat-l">${CATEGORY_COMMUNITY} (₪) — ${num(row.community.recipients)} מקבלים</span>
    </div>
    <div class="stat warn">
      <span class="stat-n">${num(row.outOfHome.amount)}</span>
      <span class="stat-l">${CATEGORY_OUT_OF_HOME} (₪) — ${num(row.outOfHome.recipients)} מקבלים</span>
    </div>`;
}

function renderNationalChart() {
  const points = nationalRows.map((r) => ({
    year: r.year, revenue: r.community.amount, expense: r.outOfHome.amount,
  }));
  renderGroupedChart('welNatChart', 'תשלומים ארציים לפי שנה וסוג מסגרת', points, '₪',
    null, { front: CATEGORY_COMMUNITY, back: CATEGORY_OUT_OF_HOME }, null);
}

// renderGroupedChart, CITY_COLOR_MAIN/COMPARE and citySwatchCell are
// shared - see charts.js. Note: this page's chart never has internal
// year-gaps within an authority's own span (checked directly), but the
// shared renderer's gap-handling is a no-op in that case, not a behavior
// change from the simpler version this used to have.

/* ---------- per-authority section ---------- */

function renderAuthorityTable(points, compare) {
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const cmp = compareByYear.get(p.year);
    const mainRow = `
      <tr>
        <th scope="row"${cmp ? ' rowspan="2"' : ''}>${p.year}</th>
        ${compare ? citySwatchCell(state.authority, CITY_COLOR_MAIN) : ''}
        <td>${num(p.revenue)}</td>
        <td>${num(p.communityRecipients)}</td>
        <td>${num(p.expense)}</td>
        <td>${num(p.outOfHomeRecipients)}</td>
      </tr>`;
    if (!cmp) return mainRow;
    const cmpRow = `
      <tr class="fin-row-compare">
        ${citySwatchCell(compare.name, CITY_COLOR_COMPARE)}
        <td>${num(cmp.revenue)}</td>
        <td>${num(cmp.communityRecipients)}</td>
        <td>${num(cmp.expense)}</td>
        <td>${num(cmp.outOfHomeRecipients)}</td>
      </tr>`;
    return mainRow + cmpRow;
  }).join('');
  el('welAuthTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            ${compare ? '<th scope="col">רשות</th>' : ''}
            <th scope="col">${esc(CATEGORY_COMMUNITY)} (₪)</th>
            <th scope="col">${esc(CATEGORY_COMMUNITY)} — מקבלים</th>
            <th scope="col">${esc(CATEGORY_OUT_OF_HOME)} (₪)</th>
            <th scope="col">${esc(CATEGORY_OUT_OF_HOME)} — מקבלים</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function pointsFor(code) {
  return authorityYears(code).map((y) => ({
    year: y.year,
    revenue: y[CATEGORY_COMMUNITY]?.amount ?? 0,
    communityRecipients: y[CATEGORY_COMMUNITY]?.recipients ?? 0,
    expense: y[CATEGORY_OUT_OF_HOME]?.amount ?? 0,
    outOfHomeRecipients: y[CATEGORY_OUT_OF_HOME]?.recipients ?? 0,
  }));
}

function authorityDisplayName(code) {
  return authorityByCode.get(code)?.name ?? smallAuthorityByCode.get(code)?.name ?? null;
}

/** Total recipients by year, for ANY authority - big or small. This is the
 *  one number every one of the 261 authorities has, so it's the only chart
 *  that can compare a small authority against a big one (or two smalls, or
 *  two bigs) without dropping down to a lowest-common-denominator dataset
 *  mid-comparison. Fed into renderGroupedChart as `revenue` with `expense`
 *  always 0 - a real single-series chart, not a category split pretending
 *  to be one (a small authority's total is NOT known to split into
 *  קהילה/חוץ-ביתי, so it must not be plotted as if it were all קהילה). */
function totalRecipientsPointsFor(code) {
  if (authorityByCode.has(code)) {
    return pointsFor(code).map((p) => ({ year: p.year, revenue: p.communityRecipients + p.outOfHomeRecipients, expense: 0 }));
  }
  const entry = smallAuthorityByCode.get(code);
  if (!entry) return [];
  return [...entry.byYear.entries()].sort(([a], [b]) => a - b)
    .map(([year, total]) => ({ year, revenue: total, expense: 0 }));
}

function renderRecipientsTable(points, compare) {
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const rows = [...points].sort((a, b) => b.year - a.year).map((p) => {
    const cmp = compareByYear.get(p.year);
    const mainRow = `
      <tr>
        <th scope="row"${cmp ? ' rowspan="2"' : ''}>${p.year}</th>
        ${compare ? citySwatchCell(state.authority, CITY_COLOR_MAIN) : ''}
        <td>${num(p.revenue)}</td>
      </tr>`;
    if (!cmp) return mainRow;
    const cmpRow = `
      <tr class="fin-row-compare">
        ${citySwatchCell(compare.name, CITY_COLOR_COMPARE)}
        <td>${num(cmp.revenue)}</td>
      </tr>`;
    return mainRow + cmpRow;
  }).join('');
  el('welRecipientsTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            ${compare ? '<th scope="col">רשות</th>' : ''}
            <th scope="col">מקבלי שירות</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderAuthoritySection() {
  const recipientsSection = el('welRecipientsSection');
  const amountsSection = el('welAuthSection');
  const code = state.authority ? nameToCode.get(state.authority) : null;
  if (!state.authority || !code) {
    recipientsSection.hidden = true;
    amountsSection.hidden = true;
    el('welCompareWarn').hidden = true;
    return;
  }

  const compareCode = state.compareAuthority ? nameToCode.get(state.compareAuthority) : null;
  const compareWarn = el('welCompareWarn');
  compareWarn.hidden = !(state.compareAuthority && !compareCode);
  if (state.compareAuthority && !compareCode) {
    compareWarn.textContent = `לא נמצאו נתונים עבור "${state.compareAuthority}" לצורך השוואה בכל אחד מ-261 הרשויות.`;
  }

  // Recipients: always shown, for either tier, on either side of the compare.
  recipientsSection.hidden = false;
  const recipientsPoints = totalRecipientsPointsFor(code);
  const recipientsCompare = compareCode
    ? { name: authorityDisplayName(compareCode), points: totalRecipientsPointsFor(compareCode) }
    : null;
  renderGroupedChart('welRecipientsChart', `מקבלי שירות, לפי שנה — ${state.authority}`, recipientsPoints, 'מקבלים',
    state.authority, { front: 'מקבלי שירות', back: '' }, recipientsCompare);
  renderRecipientsTable(recipientsPoints, recipientsCompare);

  // ₪+category breakdown: only for the 18 big authorities - a small
  // authority has no such data to show, on either side of the compare. Per
  // the request: comparing a small authority against a big one drops the
  // big one's "extra" ₪/category detail rather than erroring or faking a
  // number for the small side - so this section's OWN compare backdrop
  // only appears when the compare authority is ALSO big.
  const isBig = authorityByCode.has(code);
  amountsSection.hidden = !isBig;
  if (isBig) {
    const points = pointsFor(code);
    const compareIsBig = compareCode && authorityByCode.has(compareCode);
    const compare = compareIsBig
      ? { name: authorityByCode.get(compareCode).name, points: pointsFor(compareCode) }
      : null;
    el('authChartH').textContent = `תשלומים לפי שנה — ${state.authority}`;
    renderGroupedChart('welAuthChart', `תשלומים למסגרות רווחה, לפי שנה — ${state.authority}`, points, '₪',
      state.authority, { front: CATEGORY_COMMUNITY, back: CATEGORY_OUT_OF_HOME }, compare);
    renderAuthorityTable(points, compare);
  }
}

/* ---------- CSV export ---------- */

el('welCsv').addEventListener('click', () => {
  if (!state.authority) return;
  const code = nameToCode.get(state.authority);
  if (!code) return;
  if (authorityByCode.has(code)) {
    const fields = ['רשות', 'שנה', 'קטגוריה', 'סכום', 'מספר_מקבלים'];
    const records = [];
    for (const y of authorityYears(code)) {
      for (const cat of [CATEGORY_COMMUNITY, CATEGORY_OUT_OF_HOME]) {
        if (!y[cat]) continue;
        records.push({
          רשות: state.authority, שנה: y.year, קטגוריה: cat,
          סכום: y[cat].amount, מספר_מקבלים: y[cat].recipients,
        });
      }
    }
    saveCsv(buildCsv(fields, records), `תשלומי_רווחה_${state.authority}.csv`);
  } else {
    // A small authority has no ₪/category breakdown - the export matches
    // what's actually shown for it: total recipients only.
    const fields = ['רשות', 'שנה', 'מספר_מקבלים'];
    const records = totalRecipientsPointsFor(code).map((p) => ({ רשות: state.authority, שנה: p.year, מספר_מקבלים: p.revenue }));
    saveCsv(buildCsv(fields, records), `מקבלי_רווחה_${state.authority}.csv`);
  }
});

/* ---------- wiring ---------- */

const authorityInput = el('welAuthority');
const compareInput = el('welCompare');

function onAuthorityChange() {
  const name = authorityInput.value.trim();
  state.authority = name || null;
  syncUrl();
  renderAuthoritySection();
}
authorityInput.addEventListener('input', debounce(onAuthorityChange, 300));

function onCompareChange() {
  const name = compareInput.value.trim();
  state.compareAuthority = name || null;
  syncUrl();
  renderAuthoritySection();
}
compareInput.addEventListener('input', debounce(onCompareChange, 300));

el('welYear').addEventListener('change', (e) => {
  state.year = Number(e.target.value);
  syncUrl();
  renderKpis();
});

(async function start() {
  const box = el('welKpis');
  showLoading(box, 'טוען נתונים ארציים…');
  try {
    // loadRecipientsOnly() must run AFTER loadAuthorities() - it checks
    // authorityByCode to skip any code the richer resource already covers,
    // so it needs that map already populated, not raced against it.
    const [, bigRecords] = await Promise.all([loadNational(), loadAuthorities()]);
    await loadRecipientsOnly();
    buildNameIndex(bigRecords);
  } catch (err) {
    showError(box, err);
    return;
  }

  state.year = Math.max(...nationalRows.map((r) => r.year));
  readStateFromUrl();
  populateYearSelect();
  populateRoster();
  authorityInput.value = state.authority || '';
  compareInput.value = state.compareAuthority || '';
  syncUrl();

  renderKpis();
  renderNationalChart();
  renderAuthoritySection();
})();
