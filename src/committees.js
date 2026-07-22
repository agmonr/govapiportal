/**
 * Entry point for committees.html - ישיבות ועדות תכנון ובנייה (מקומיות/מרחביות).
 *
 * Everything here is a LIVE browser fetch against handasi.complot.co.il, the
 * same public, no-auth, CORS-open engine ~68 municipal/regional planning
 * committees run their "meeting locator" pages on (verified by sweeping
 * siteid 1-120 - see /home/ram/Documents/scrapers/FINDINGS.md). It returns
 * HTML fragments, not JSON, so the two parse* functions below are a straight
 * port of that scraper's regexes - re-verified against live responses before
 * porting, not just translated blind.
 *
 * Deliberately NOT included, and NOT faked: plan number, decision outcome,
 * יח"ד, מ"ר, land-use, or any text pulled from inside a protocol. All of that
 * lives only inside the protocol PDFs themselves, which nothing here parses -
 * doing that honestly needs OCR/NLP over each PDF, not a page like this one.
 * See the notice at the top of committees.html for the full list of what the
 * original request asked for that isn't here yet.
 *
 * District/national committees (הועדה המחוזית) are asked for by meeting-type
 * code 3 the same as any other - the engine simply returns zero rows for it
 * on every site checked, because district-level protocols live on a
 * different system (mavat.iplan.gov.il) that gates its search behind
 * reCAPTCHA v3. Not circumvented; also not silently hidden - the filter stays
 * choosable and empty results say so.
 */

import { el, esc, num, debounce, buildCsv, saveCsv, showError, showLoading } from './ui.js';
import { initThemePicker } from './theme.js';
import { COMMITTEE_SITES, MEETING_TYPES } from './committee-sites.js';
import { renderBarChart } from './charts.js';

const CM_EMPTY_MSG = { emptyMessage: 'אין נתונים להצגה בטווח שנבחר.' };

initThemePicker(el('themePick'));

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

const ENGINE = 'https://handasi.complot.co.il/magicscripts/mgrqispi.dll';

/* ---------- date helpers: native <input type=date> (YYYY-MM-DD) <-> the
   engine's DD/MM/YYYY ---------- */
const isoToApi = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const todayIso = (offsetDays = 0) => {
  const t = new Date(); t.setDate(t.getDate() + offsetDays);
  return t.toISOString().slice(0, 10);
};

/* ---------- HTML-fragment parsing: ported 1:1 from
   scrape_hodhasharon_meetings.py, re-verified against live responses. ---------- */

function parseMeetingList(html) {
  const rowRe = /<tr>\s*<td class="hidden-on-mobile">[\s\S]*?<\/tr>/g;
  const numRe = /showMeetingDocs\((\d+),\s*(\d+)/;
  const cellRe = /<td[^>]*>\s*(?:<a[^>]*>)?([^<]*)(?:<\/a>)?\s*<\/td>/g;
  const meetings = [];
  for (const row of html.match(rowRe) || []) {
    const m = numRe.exec(row);
    if (!m) continue; // no document archive button -> nothing to show
    // The icon cell (leading <td class="hidden-on-mobile"><a><span/></a></td>)
    // and the trailing archive-button cell both fail cellRe outright (their
    // content isn't plain text or a single wrapped <a>text</a>), so matchAll
    // skips both silently - cells[0] here really is the meeting number, not a
    // placeholder for the icon.
    const cells = [...row.matchAll(cellRe)].map((c) => c[1].trim());
    meetings.push({
      vaadaId: m[1],
      meetingNumber: m[2],
      committee: cells[1] || MEETING_TYPES[m[1]] || '—',
      date: cells[2] || '',
      day: cells[3] || '',
    });
  }
  return meetings;
}

function parseMeetingDocs(html) {
  const rows = html.match(/<tr>\s*<td>[\s\S]*?<\/tr>/g) || [];
  const docs = [];
  for (const row of rows) {
    const href = /<a href="([^"]+)"/.exec(row);
    if (!href) continue;
    const titleM = /<a href="[^"]+"[^>]*>(?:<span[^>]*><\/span>)?\s*([^<]*)<\/a>/.exec(row);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
    docs.push({
      url: href[1],
      title: (titleM ? titleM[1] : '').trim(),
      subject: cells[1] || '',
      date: cells[2] || '',
    });
  }
  return docs;
}

/* ---------- state ---------- */

const state = {
  siteid: '33', // הוד השרון - the one this data source was verified against end-to-end
  meetings: [],   // last fetch, unfiltered
  filtered: [],   // after the free-text quick filter
  docsCache: new Map(), // docsKeyFor(meeting) -> docs[]
  docsLoaded: 0,  // running count, across this session, of doc-lists fetched
  filterGen: 0,   // bumped on every quick-filter change; lets a stale bulk-doc loop abandon itself
};

/* ---------- filter bar: committee/settlement is type-to-search, same
   pattern as accidents.html's ישוב field - a <datalist> autocompletes over
   all 68 sites, and only an exact label resolves to a siteid. ---------- */

const siteLabel = (s) => (s.name_he
  ? `${s.name_he} (${s.kind === 'regional' ? 'מרחבית' : 'מקומית'})`
  : `${s.slug} (שם לא מזוהה)`);
const SITE_BY_LABEL = new Map(COMMITTEE_SITES.map((s) => [siteLabel(s), s.siteid]));

const cmSite = el('cmSite');
el('cmSiteList').innerHTML = [...COMMITTEE_SITES]
  .sort((a, b) => (a.name_he || a.slug).localeCompare(b.name_he || b.slug, 'he'))
  .map((s) => `<option value="${esc(siteLabel(s))}"></option>`).join('');
cmSite.value = siteLabel(COMMITTEE_SITES.find((s) => s.siteid === Number(state.siteid)));

function onSiteInput() {
  const id = SITE_BY_LABEL.get(cmSite.value.trim());
  if (id == null || String(id) === state.siteid) return;
  state.siteid = String(id);
  loadMeetings();
}

const typeSelect = el('cmType');
typeSelect.innerHTML = Object.entries(MEETING_TYPES)
  .map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
typeSelect.value = '0';

el('cmFrom').value = todayIso(-365 * 3);
el('cmTo').value = todayIso(60);

/* ---------- fetch + render ---------- */

async function loadMeetings() {
  const siteid = state.siteid;
  const v = typeSelect.value;
  const fd = isoToApi(el('cmFrom').value);
  const td = isoToApi(el('cmTo').value);

  showLoading(el('cmTableWrap'), 'טוען ישיבות…');
  el('cmKpis').innerHTML = '';
  el('cmChartByYear').innerHTML = '';
  el('cmChartByType').innerHTML = '';
  el('cmAllDocs').innerHTML = ''; // stale docs from the previous list would mislead otherwise

  const p = new URLSearchParams({
    appname: 'cixpa', prgname: 'GetMeetingByDate', siteid, v, fd, td, l: 'false',
    arguments: 'siteid,v,fd,td,l',
  });
  try {
    const res = await fetch(`${ENGINE}?${p}`);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'network' });
    const html = await res.text();
    state.meetings = parseMeetingList(html);
    applyQuickFilter();
  } catch (err) {
    showError(el('cmTableWrap'), err);
    state.meetings = [];
    applyQuickFilter();
  }
}

function applyQuickFilter() {
  const q = el('cmSearch').value.trim();
  state.filtered = q
    ? state.meetings.filter((m) => `${m.meetingNumber} ${m.committee} ${m.date}`.includes(q))
    : state.meetings;
  renderKpis();
  renderCharts();
  renderTable();
  state.filterGen += 1; // any earlier script build still running now belongs to a stale filter

  // Auto-build the script only once an actual filter narrows things down
  // (the free-text box) - not on the raw, possibly hundreds-strong default
  // list, where fetching every meeting's document list unasked would be a
  // much heavier hit than a visitor asked for. Committee/type/date-range
  // changes still require the explicit "הורדת כל המסמכים" button for the
  // same reason.
  if (q) buildDownloadScript(state.filterGen);
  else el('cmAllDocs').innerHTML = '';
}

/* ---------- KPI tiles - same visual vocabulary as accidents.html's .stat-row ---------- */

function renderKpis() {
  const list = state.filtered;
  const dates = list.map((m) => m.date).filter(Boolean).sort((a, b) => {
    const [da, ma, ya] = a.split('/'); const [db, mb, yb] = b.split('/');
    return `${ya}${ma}${da}`.localeCompare(`${yb}${mb}${db}`);
  });
  const types = new Set(list.map((m) => m.committee));
  const span = dates.length ? `${dates[0]} — ${dates[dates.length - 1]}` : '—';

  el('cmKpis').innerHTML = `
    <div class="stat">
      <span class="stat-n">${num(list.length)}</span>
      <span class="stat-l">סה"כ ישיבות (בסינון הנוכחי)</span>
    </div>
    <div class="stat ok">
      <span class="stat-n">${num(types.size)}</span>
      <span class="stat-l">סוגי ישיבה שונים</span>
    </div>
    <div class="stat">
      <span class="stat-n" style="font-size:1.05rem">${esc(span)}</span>
      <span class="stat-l">טווח תאריכים בפועל</span>
    </div>
    <div class="stat warn">
      <span class="stat-n">${num(state.docsLoaded)}</span>
      <span class="stat-l">רשימות מסמכים שנטענו (הפעלה זו)</span>
    </div>`;
}

/* ---------- charts - shared renderBarChart from charts.js ---------- */

function renderCharts() {
  const list = state.filtered;

  const byYear = new Map();
  for (const m of list) {
    const y = m.date.split('/')[2];
    if (y) byYear.set(y, (byYear.get(y) || 0) + 1);
  }
  const yearEntries = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value }));
  renderBarChart('cmChartByYear', 'ישיבות לפי שנה', yearEntries, '', 'total', CM_EMPTY_MSG);

  const byType = new Map();
  for (const m of list) byType.set(m.committee, (byType.get(m.committee) || 0) + 1);
  let typeEntries = [...byType.entries()].sort(([, a], [, b]) => b - a)
    .map(([label, value]) => ({ label, value }));
  if (typeEntries.length > 7) {
    const rest = typeEntries.slice(6).reduce((s, e) => s + e.value, 0);
    typeEntries = [...typeEntries.slice(0, 6), { label: 'אחר', value: rest }];
  }
  renderBarChart('cmChartByType', 'התפלגות לפי סוג ישיבה', typeEntries, '', '', CM_EMPTY_MSG);
}

/* ---------- detailed table, with a per-row live doc fetch on expand ---------- */

// Same has-files/files-row/x-mark convention as portal.js's own expandable
// table (see table()/bindRows() there) - visual consistency with the rest of
// the site. It differs underneath: portal.js's _files are pre-fetched with
// the row, these are fetched lazily on first expand, so 565 meetings never
// means 565 requests up front - only the ones a visitor actually opens.
function renderTable() {
  const list = state.filtered;
  if (!list.length) {
    el('cmTableWrap').innerHTML = '<p class="acc-hint">לא נמצאו ישיבות עבור הסינון הנוכחי.</p>';
    return;
  }
  const rows = list.map((m, i) => `
    <tr class="has-files" data-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      <td dir="auto" class="ident">${esc(m.meetingNumber)}</td>
      <td dir="auto">${esc(m.committee)}</td>
      <td dir="auto">${esc(m.date)}</td>
      <td dir="auto">${esc(m.day)}</td>
    </tr>
    <tr class="files-row" data-files="${i}" hidden><td colspan="5"></td></tr>`).join('');
  el('cmTableWrap').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead>
          <tr>
            <th class="c-x"></th>
            <th scope="col">מספר ישיבה</th>
            <th scope="col">סוג ישיבה</th>
            <th scope="col">תאריך</th>
            <th scope="col">יום</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  bindRows();
}

function bindRows() {
  document.querySelectorAll('#cmTableWrap tr.has-files').forEach((tr) => {
    const toggle = () => toggleDocs(Number(tr.dataset.row), tr);
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

const docsKeyFor = (meeting) => `${state.siteid}_${meeting.vaadaId}_${meeting.meetingNumber}`;

/** Shared by the per-row expand and the "load all" bulk action below, so a
 *  document list can never come out differently fetched one-by-one than in
 *  bulk. Caches on success; throws on failure rather than swallowing it, so
 *  each caller decides how to show that failure. */
async function fetchDocsFor(meeting) {
  const key = docsKeyFor(meeting);
  if (state.docsCache.has(key)) return state.docsCache.get(key);
  const p = new URLSearchParams({
    appname: 'cixpa', prgname: 'GetMeetingDocs', siteid: state.siteid,
    v: meeting.vaadaId, m: meeting.meetingNumber, arguments: 'siteid,v,m',
  });
  const res = await fetch(`${ENGINE}?${p}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const docs = parseMeetingDocs(await res.text());
  state.docsCache.set(key, docs);
  state.docsLoaded += 1;
  renderKpis();
  return docs;
}

async function toggleDocs(i, tr) {
  const target = document.querySelector(`#cmTableWrap tr[data-files="${i}"]`);
  const mark = tr.querySelector('.x-mark');
  if (!target.hidden) { target.hidden = true; mark.textContent = '▾'; return; }
  target.hidden = false;
  mark.textContent = '▴';

  const meeting = state.filtered[i];
  const cell = target.querySelector('td');
  const cached = state.docsCache.get(docsKeyFor(meeting));
  if (cached) { renderDocsCell(cell, cached); return; }

  cell.innerHTML = '<span class="acc-hint">טוען מסמכים…</span>';
  try {
    renderDocsCell(cell, await fetchDocsFor(meeting));
  } catch (err) {
    cell.innerHTML = `<span class="acc-hint">שגיאה בטעינת המסמכים (${esc(err.message)}).</span>`;
  }
}

function renderDocsCell(cell, docs) {
  if (!docs.length) { cell.innerHTML = '<span class="acc-hint">לא נמצאו מסמכים לישיבה זו.</span>'; return; }
  cell.innerHTML = `<ul class="cm-doclist">${docs.map((d) => `
    <li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title || d.subject || 'מסמך')}</a>
        <span class="acc-hint">(${esc(d.subject)}${d.date ? `, ${esc(d.date)}` : ''})</span></li>`).join('')}</ul>`;
}

/* ---------- "download all documents" - not a browser download at all, but a
   generated shell script: one curl call per document in the current filter,
   ready to copy into a terminal. This sidesteps every browser-side wall the
   earlier approaches ran into - curl is a separate program, so none of it
   applies: no popup blocker (nothing opens a tab), no CORS (that's a
   browser-fetch/XHR restriction on reading a cross-origin *response in JS*,
   irrelevant to a standalone process making its own request), and no
   "did it finish downloading" ambiguity (curl writes the file and exits).
   Fetching the per-meeting document *lists* to build the script still goes
   through handasi.complot.co.il (the listing engine) exactly as everywhere
   else on this page - only the resulting script's curl calls hit
   archive.gis-net.co.il, the same one-file-at-a-time act as clicking each
   link by hand, just batched into a paste. */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Strips characters that break either a shell command or a filesystem path
 *  - mirrors sanitize_filename() in scrape_hodhasharon_meetings.py. */
function sanitizeFilename(name) {
  return String(name || 'מסמך')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'מסמך';
}

/** POSIX single-quoting: wraps in '...', escaping any embedded ' as '"'"'.
 *  Safe for any text - not just the ASCII curl expects most arguments to be. */
const shQuote = (s) => `'${String(s).replace(/'/g, "'\"'\"'")}'`;

// `gen` lets an auto-triggered run (from typing in the quick filter) abandon
// itself the moment a newer keystroke changes the filter again, instead of
// two runs racing to overwrite the script panel - see applyQuickFilter().
async function buildDownloadScript(gen = state.filterGen) {
  const list = state.filtered;
  if (!list.length) return;
  if (list.length > 150 && !confirm(`הרשימה כוללת ${list.length} ישיבות - בניית הסקריפט תשלח כ-${list.length} בקשות לרשימת המסמכים בזו אחר זו ותימשך זמן מה. להמשיך?`)) return;

  const btn = el('cmLoadAllDocs');
  const box = el('cmAllDocs');
  btn.disabled = true;
  try {
    const lines = [];
    let failedMeetings = 0;
    let docCount = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (gen !== state.filterGen) return; // a newer filter took over mid-loop
      const meeting = list[i];
      box.innerHTML = `<p class="acc-hint">בונה רשימת קבצים… (ישיבה ${i + 1}/${list.length})</p>`;
      let docs = state.docsCache.get(docsKeyFor(meeting));
      if (!docs) {
        try {
          docs = await fetchDocsFor(meeting);
        } catch {
          failedMeetings += 1;
          continue;
        }
        await sleep(150); // politeness pacing on the listing engine, same spirit as the original scraper's rate limiter
      }
      for (const doc of docs) {
        docCount += 1;
        const fname = sanitizeFilename(
          `${meeting.date.replace(/\//g, '-')}_${meeting.meetingNumber}_${doc.title || doc.subject}.pdf`,
        );
        lines.push(
          `curl -sS --retry 2 --retry-delay 3 -o ${shQuote(fname)} ${shQuote(doc.url)} `
          + `&& echo "הורד: ${fname}" || echo "נכשל: ${fname}"`,
        );
        lines.push('sleep 0.5'); // politeness pacing on the archive host itself, run at the visitor's own pace, not this page's
      }
    }
    if (gen === state.filterGen) renderDownloadScript(lines, docCount, failedMeetings); // stale otherwise - a newer run owns the panel now
  } finally {
    btn.disabled = false;
  }
}

function renderDownloadScript(lines, docCount, failedMeetings) {
  const box = el('cmAllDocs');
  if (!docCount) {
    box.innerHTML = `<p class="acc-hint">לא נמצאו מסמכים לרשימה הנוכחית.${failedMeetings ? ` (${failedMeetings} ישיבות נכשלו בטעינת רשימת המסמכים)` : ''}</p>`;
    return;
  }
  const folder = sanitizeFilename(`ועדה_${state.siteid}_${el('cmFrom').value}_${el('cmTo').value}`);
  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `mkdir -p ${shQuote(folder)}`,
    `cd ${shQuote(folder)}`,
    '',
    ...lines,
    '',
    'echo "הסתיים."',
  ].join('\n') + '\n';

  box.innerHTML = `
    <p class="acc-hint">
      ${num(docCount)} קבצים.${failedMeetings ? ` (${failedMeetings} ישיבות נכשלו בטעינת רשימת המסמכים)` : ''}
      הריצו בטרמינל (למשל <code dir="ltr">bash script.sh</code>) - יוצר תיקייה משלו ומוריד לתוכה, קובץ אחר קובץ.
    </p>
    <div class="cm-script-wrap">
      <textarea id="cmScript" class="cm-script" readonly rows="10" dir="ltr" spellcheck="false">${esc(script)}</textarea>
      <button type="button" id="cmCopyScript" class="drill-dl">העתקת הסקריפט ⧉</button>
    </div>`;

  el('cmCopyScript').addEventListener('click', async () => {
    const copyBtn = el('cmCopyScript');
    const original = copyBtn.textContent;
    try {
      await navigator.clipboard.writeText(script);
      copyBtn.textContent = 'הועתק ✓';
    } catch {
      el('cmScript').select(); // clipboard API unavailable/denied - at least select it for manual Ctrl+C
      copyBtn.textContent = 'סמנו והעתיקו ידנית (Ctrl+C)';
    }
    setTimeout(() => { copyBtn.textContent = original; }, 2000);
  });
}

// Not `buildDownloadScript` directly - addEventListener would pass the click
// Event as `gen`, clobbering the default parameter.
el('cmLoadAllDocs').addEventListener('click', () => buildDownloadScript());

/* ---------- CSV export - exactly the filtered rows on screen ---------- */

el('cmCsv').addEventListener('click', () => {
  const csv = buildCsv(
    ['קוד_ועדה', 'מספר_ישיבה', 'סוג_ישיבה', 'תאריך', 'יום'],
    state.filtered.map((m) => ({
      קוד_ועדה: state.siteid,
      מספר_ישיבה: m.meetingNumber,
      סוג_ישיבה: m.committee,
      תאריך: m.date,
      יום: m.day,
    })),
  );
  saveCsv(csv, `ישיבות_ועדת_תכנון_${state.siteid}.csv`);
});

/* ---------- wiring ---------- */

cmSite.addEventListener('input', debounce(onSiteInput, 300));

['change'].forEach((evt) => {
  typeSelect.addEventListener(evt, loadMeetings);
  el('cmFrom').addEventListener(evt, loadMeetings);
  el('cmTo').addEventListener(evt, loadMeetings);
});
el('cmSearch').addEventListener('input', debounce(applyQuickFilter, 250));

loadMeetings();
