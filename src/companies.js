/**
 * Entry point for companies.html - מאגר החברות (רשם החברות, משרד המשפטים).
 *
 * Everything here is a LIVE browser fetch against data.gov.il's DataStore API
 * (`ica_companies`, resource f004176c-b85f-4542-8901-7b3176f9a054), the same
 * CKAN engine local-finance.html and ckan.js already use. Verified before
 * building: 728,280 rows, CORS open (`Access-Control-Allow-Origin: *`),
 * `filters` (exact match), `q` (full text), and `distinct=true` (unique
 * values for a field) all work server-side, and a single request comfortably
 * returns 50,000 rows in ~3.3s. Unlike local-finance.html's per-authority
 * statement, this page's whole point is browsing/searching across all 728K
 * rows, so - unlike committees.html's "load everything into the browser" -
 * filtering, search and paging here MUST stay server-side end to end. There
 * is no client-side fallback: fetching the full table would be ~15x the size
 * of the CSV export ckan.js already measured as safe.
 *
 * KPIs and the two distribution charts are global reference numbers (over the
 * whole registry, not the active filter) - computed once at load from cheap
 * per-value COUNT queries (`limit=1` with a `filters` scope just reads
 * `result.total`), not a scan. The dropdowns themselves are populated from
 * `distinct=true` rather than a hand-typed list, so a status string like
 * "בפרוק ע~י בימ"ש" (the source data really does use `~` in place of a
 * gershayim in some values) can never be mistyped into a filter that silently
 * matches nothing.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, showError, showLoading } from './ui.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

const DATASTORE = 'https://data.gov.il/api/3/action/datastore_search';
const RESOURCE_ID = 'f004176c-b85f-4542-8901-7b3176f9a054';
const PAGE_SIZE = 50;
const F_STATUS = 'סטטוס חברה';
const F_TYPE = 'סוג תאגיד';
const F_VIOLATOR = 'מפרה';
const F_GOV = 'חברה ממשלתית';

async function dsQuery(params) {
  const p = new URLSearchParams({ resource_id: RESOURCE_ID, ...params });
  const res = await fetch(`${DATASTORE}?${p}`);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'network' });
  const j = await res.json();
  if (!j.success) throw new Error(j.error?.message || 'שגיאת שרת');
  return j.result;
}

const countOf = (filters) => dsQuery({ limit: '1', filters: JSON.stringify(filters) }).then((r) => r.total);

/* ---------- state ---------- */

const state = {
  q: '', status: '', type: '', violator: false, government: false,
  offset: 0, total: 0, records: [],
};

function activeFilters() {
  const f = {};
  if (state.status) f[F_STATUS] = state.status;
  if (state.type) f[F_TYPE] = state.type;
  if (state.violator) f[F_VIOLATOR] = 'מפרה';
  if (state.government) f[F_GOV] = 'כן';
  return f;
}

/* ---------- global reference stats: KPIs + charts + dropdown options,
   computed once at load, independent of the active filter (same "dated
   snapshot fact" spirit as accidents.html's KPIs, just computed live instead
   of precomputed offline - cheap enough here that it doesn't need to be). */

// Terminal/dissolved statuses (מחוקה, מחוסלת*, חיסול*, נגרעה) read as
// "unknown" (neutral gray) rather than "bad" (red) - ending is not a fault,
// only an ongoing dissolution process (בפרוק*) or a conditionally-active
// status (פעילה/בפירוק) is flagged as "in progress".
function statusClass(status) {
  if (status.startsWith('פעילה')) return status.includes('בפירוק') ? 'warn' : 'ok';
  if (status.startsWith('בפרוק')) return 'warn';
  return 'unknown';
}

function renderBarChart(figId, caption, entries, colorClass) {
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...entries.map((e) => e.value));
  const bars = entries.map((e) => {
    const h = peak ? Math.round((e.value / peak) * 150) : 0;
    return `
      <div class="acc-bar" title="${esc(e.label)}: ${num(e.value)}">
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

async function loadGlobalStats() {
  showLoading(el('coKpis'), 'סופר תאגידים…');
  try {
    const [totalRes, statusFacet, typeFacet, violators, government] = await Promise.all([
      dsQuery({ limit: '1' }),
      dsQuery({ fields: F_STATUS, distinct: 'true', limit: '100' }),
      dsQuery({ fields: F_TYPE, distinct: 'true', limit: '100' }),
      countOf({ [F_VIOLATOR]: 'מפרה' }),
      countOf({ [F_GOV]: 'כן' }),
    ]);
    const total = totalRes.total;

    const statusValues = statusFacet.records.map((r) => r[F_STATUS]).filter(Boolean);
    const typeValues = typeFacet.records.map((r) => r[F_TYPE]).filter(Boolean);

    const [statusCounts, typeCounts] = await Promise.all([
      Promise.all(statusValues.map((v) => countOf({ [F_STATUS]: v }).then((n) => ({ label: v, value: n })))),
      Promise.all(typeValues.map((v) => countOf({ [F_TYPE]: v }).then((n) => ({ label: v, value: n })))),
    ]);
    statusCounts.sort((a, b) => b.value - a.value);
    typeCounts.sort((a, b) => b.value - a.value);

    const activeCount = statusCounts.filter((s) => statusClass(s.label) === 'ok')
      .reduce((sum, s) => sum + s.value, 0);
    const activePct = total ? Math.round((activeCount / total) * 100) : 0;

    el('coKpis').innerHTML = `
      <div class="stat">
        <span class="stat-n">${num(total)}</span>
        <span class="stat-l">סה"כ תאגידים במרשם</span>
      </div>
      <div class="stat ok">
        <span class="stat-n">${num(activeCount)}</span>
        <span class="stat-l">פעילות (${activePct}%)</span>
      </div>
      <div class="stat warn">
        <span class="stat-n">${num(violators)}</span>
        <span class="stat-l">מסומנות "מפרה"</span>
      </div>
      <div class="stat">
        <span class="stat-n">${num(government)}</span>
        <span class="stat-l">חברות ממשלתיות</span>
      </div>`;

    // Only the status breakdown is charted - type isn't: 723,280 of 728,280
    // companies are a single type (חברה פרטית ישראלית), so a bar chart of it
    // is one full-height bar and a row of invisible slivers, not a picture of
    // anything. The counts still drive the coType dropdown below, unchanged.
    renderBarChart('coChartStatus', 'פילוח לפי סטטוס חברה', statusCounts, 'total');

    el('coStatus').innerHTML = `<option value="">הכל (${num(total)})</option>`
      + statusCounts.map((s) => `<option value="${esc(s.label)}">${esc(s.label)} (${num(s.value)})</option>`).join('');
    el('coType').innerHTML = `<option value="">הכל</option>`
      + typeCounts.map((t) => `<option value="${esc(t.label)}">${esc(t.label)} (${num(t.value)})</option>`).join('');
  } catch (err) {
    showError(el('coKpis'), err);
    el('coChartStatus').innerHTML = '';
  }
}

/* ---------- results table: fully server-side search/filter/page ---------- */

function statusBadge(status) {
  return `<span class="badge ${statusClass(status)}" dir="auto">${esc(status)}</span>`;
}

// Fields ica_companies already carries but the row itself has no room for -
// tucked behind the expand arrow instead of a 7th/8th/9th column.
function detailRow(r) {
  const address = [
    [r['שם רחוב'], r['מספר בית']].filter(Boolean).join(' '),
    r['מיקוד'] ? `מיקוד ${r['מיקוד']}` : '',
    r['ת.ד.'] ? `ת.ד. ${r['ת.ד.']}` : '',
    r['מדינה'] && r['מדינה'] !== 'ישראל' ? r['מדינה'] : '',
  ].filter(Boolean).join(', ');
  const fields = [
    ['שם באנגלית', r['שם באנגלית']],
    ['אצל', r['אצל']],
    ['כתובת', address],
    ['תת סטטוס', r['תת סטטוס']],
    ['מגבלות', r['מגבלות']],
    ['מטרה', r['מטרה']],
    ['דוח שנתי אחרון שהוגש', r['שנה אחרונה של דוח שנתי (שהוגש)']],
  ].filter(([, v]) => v);
  if (!fields.length) return '<p class="acc-hint">אין פרטים נוספים לתאגיד זה.</p>';
  return `<dl class="co-detail">${fields.map(([k, v]) => `
    <div><dt>${esc(k)}</dt><dd dir="auto">${esc(v)}</dd></div>`).join('')}</dl>`;
}

function renderTable() {
  const box = el('coTableWrap');
  if (!state.records.length) {
    box.innerHTML = '<p class="acc-hint">לא נמצאו תאגידים התואמים לסינון הנוכחי.</p>';
    return;
  }
  const rows = state.records.map((r, i) => `
    <tr class="has-detail" data-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      <td dir="ltr">${num(r['מספר חברה'])}</td>
      <td dir="auto">${esc(r['שם חברה'])}${r[F_VIOLATOR] === 'מפרה' ? ' <span class="badge bad">מפרה</span>' : ''}</td>
      <td dir="auto">${esc(r[F_TYPE] || '—')}</td>
      <td dir="auto">${statusBadge(r[F_STATUS] || '—')}</td>
      <td dir="auto">${esc(r['שם עיר'] || '—')}</td>
      <td dir="auto">${esc(r['תאריך התאגדות'] || '—')}</td>
    </tr>
    <tr class="detail-row" data-detail="${i}" hidden><td colspan="7">${detailRow(r)}</td></tr>`).join('');
  box.innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead>
          <tr>
            <th class="c-x"></th>
            <th scope="col">מס׳ חברה</th>
            <th scope="col">שם חברה</th>
            <th scope="col">סוג תאגיד</th>
            <th scope="col">סטטוס</th>
            <th scope="col">עיר</th>
            <th scope="col">תאריך התאגדות</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  bindDetailRows(box);
}

/** Same has-files/files-row/x-mark toggle convention as portal.js/committees.js. */
function bindDetailRows(scope) {
  scope.querySelectorAll('tr.has-detail').forEach((tr) => {
    const toggle = () => {
      const target = scope.querySelector(`tr[data-detail="${tr.dataset.row}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

function renderPager() {
  const cur = Math.floor(state.offset / PAGE_SIZE);
  const last = Math.max(0, Math.ceil(state.total / PAGE_SIZE) - 1);
  el('coPager').innerHTML = `
    <button type="button" class="pg" id="coPrev" ${cur <= 0 ? 'disabled' : ''}>‹ הקודם</button>
    <span>${state.total ? `${num(state.offset + 1)}–${num(state.offset + state.records.length)} מתוך ${num(state.total)}` : ''}</span>
    <button type="button" class="pg" id="coNext" ${cur >= last ? 'disabled' : ''}>הבא ›</button>`;
  el('coPrev')?.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadResults(); });
  el('coNext')?.addEventListener('click', () => { state.offset += PAGE_SIZE; loadResults(); });
}

async function loadResults() {
  showLoading(el('coTableWrap'), 'מחפש…');
  el('coPager').innerHTML = '';
  try {
    const params = { limit: String(PAGE_SIZE), offset: String(state.offset) };
    const filters = activeFilters();
    if (Object.keys(filters).length) params.filters = JSON.stringify(filters);
    if (state.q) params.q = state.q;
    const r = await dsQuery(params);
    state.records = r.records;
    state.total = r.total;
    el('coCount').textContent = r.total
      ? `${num(state.offset + 1)}–${num(state.offset + r.records.length)} מתוך ${num(r.total)} תוצאות`
      : 'אין תוצאות התואמות לסינון';
    renderTable();
    renderPager();
  } catch (err) {
    showError(el('coTableWrap'), err);
    state.records = []; state.total = 0;
    el('coCount').textContent = '';
  }
}

function onFilterChange() {
  state.offset = 0;
  loadResults();
}

/* ---------- CSV export of the active filtered query, paginated through the
   whole result set - same reasoning as ckan.js's ckFetchAll: datastore_search
   isn't WAF-challenged the way the raw file download is, so the export is
   assembled here from data actually fetched, not trusted from a file link
   this dataset doesn't even expose per-query anyway. ---------- */

const EXPORT_FIELDS = [
  'מספר חברה', 'שם חברה', 'שם באנגלית', 'סוג תאגיד', 'סטטוס חברה', 'תת סטטוס',
  'תאור חברה', 'מטרת החברה', 'תאריך התאגדות', 'חברה ממשלתית', 'מגבלות', 'מפרה',
  'שנה אחרונה של דוח שנתי (שהוגש)', 'שם עיר', 'שם רחוב', 'מספר בית', 'מיקוד',
];
const DUMP_PAGE = 32000;

async function fetchAllFiltered(onProgress) {
  const filters = activeFilters();
  const records = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const params = { limit: String(DUMP_PAGE), offset: String(offset) };
    if (Object.keys(filters).length) params.filters = JSON.stringify(filters);
    if (state.q) params.q = state.q;
    const r = await dsQuery(params);
    records.push(...r.records);
    offset += r.records.length;
    onProgress(records.length, r.total);
    if (!r.records.length || records.length >= r.total) break;
  }
  return records;
}

el('coCsv').addEventListener('click', async () => {
  const btn = el('coCsv');
  const label = btn.textContent;
  if (state.total > 20000
    && !confirm(`השאילתה הנוכחית כוללת ${state.total.toLocaleString('he-IL')} תוצאות. ההורדה תשלח כמה עשרות בקשות ברצף ועלולה לקחת זמן. להמשיך?`)) return;
  btn.disabled = true;
  try {
    const records = await fetchAllFiltered((n, total) => { btn.textContent = `מוריד… ${num(n)} / ${num(total)}`; });
    if (!records.length) { btn.textContent = 'אין רשומות'; return; }
    saveCsv(buildCsv(EXPORT_FIELDS, records), 'מאגר_החברות.csv');
    btn.textContent = `✓ ${num(records.length)} שורות`;
  } catch (err) {
    btn.textContent = 'ההורדה נכשלה';
    console.error(err);
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = label; }, 6000);
  }
});

/* ---------- wiring ---------- */

el('coQ').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); onFilterChange(); }, 400));
el('coStatus').addEventListener('change', (e) => { state.status = e.target.value; onFilterChange(); });
el('coType').addEventListener('change', (e) => { state.type = e.target.value; onFilterChange(); });
el('coViolator').addEventListener('change', (e) => { state.violator = e.target.checked; onFilterChange(); });
el('coGov').addEventListener('change', (e) => { state.government = e.target.checked; onFilterChange(); });

(async function start() {
  await Promise.all([loadGlobalStats(), loadResults()]);
}());
