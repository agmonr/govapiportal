/**
 * data.gov.il in depth - the one portal that rewards going all the way in.
 *
 * The portal drill-in above shows what every source returns. This goes three
 * levels further, because CKAN is the only API here that exposes the records
 * themselves rather than just a catalogue of files:
 *
 *   catalogue  package_search   1,197 datasets, faceted, sorted, paged
 *   dataset    (already in hand) description, licence, tags, resources
 *   records    datastore_search the actual rows inside one resource
 *
 * Every control is server-side. Probed before being wired: `q` (full text),
 * `q={"FIELD":"..."}` (full text within one field), `filters` (exact match),
 * `sort`, `offset`, `fields`. Nothing here filters a fetched page and calls it
 * a search.
 *
 * The ceiling is real and worth knowing: `datastore_search_sql` is WAF-blocked
 * (403), so there is no server-side aggregation. Counting, grouping or joining
 * would have to happen client-side over whatever was fetched, which for a
 * 3,051-row resource would be a subset pretending to be a total. So this offers
 * search, filter, sort and paging - and deliberately offers no statistics.
 */

import { esc, debounce, num, bytes } from './ui.js';

const CK_API = 'https://data.gov.il/api/3/action';
const CK_DATASETS = 20;   // cards are taller than table rows
const CK_RECORDS = 25;

/** Only ~55% of resources are datastore_active; the rest are downloads only. */
const ckQueryable = (r) => Boolean(r.datastore_active);

const ckState = {
  view: 'list',            // list | dataset | records
  q: '', org: '', format: '', sort: '', start: 0,
  pkg: null, resource: null,
  rq: '', rfilters: {}, rsort: '', rdir: 'asc', rstart: 0,
};

let ckFacets = null;        // captured once - CKAN narrows these to the active fq
let ckRoot = null;

const CK_SORTS = [
  ['', 'רלוונטיות'],
  ['metadata_modified desc', 'עודכן לאחרונה'],
  ['title_string asc', 'שם א׳–ת׳'],
  ['organization asc', 'גוף מפרסם'],
];

/* ---------- requests ---------- */

function ckCatalogUrl() {
  const p = new URLSearchParams({ rows: String(CK_DATASETS) });
  if (ckState.q) p.set('q', ckState.q);
  const fq = [];
  if (ckState.org) fq.push(`organization:${ckState.org}`);
  if (ckState.format) fq.push(`res_format:${ckState.format}`);
  if (fq.length) p.set('fq', fq.join(' '));
  if (ckState.sort) p.set('sort', ckState.sort);
  if (ckState.start) p.set('start', String(ckState.start));
  p.set('facet.field', '["organization","res_format"]');
  p.set('facet.limit', '100');
  return `${CK_API}/package_search?${p}`;
}

function ckRecordsUrl() {
  const p = new URLSearchParams({ resource_id: ckState.resource.id, limit: String(CK_RECORDS) });
  // Per-field full text rather than `filters`, which is exact-match and would
  // silently return nothing for a partial value someone typed by hand.
  const per = Object.entries(ckState.rfilters).filter(([, v]) => v.trim());
  if (per.length) p.set('q', JSON.stringify(Object.fromEntries(per)));
  else if (ckState.rq) p.set('q', ckState.rq);
  if (ckState.rsort) p.set('sort', `${ckState.rsort} ${ckState.rdir}`);
  if (ckState.rstart) p.set('offset', String(ckState.rstart));
  return `${CK_API}/datastore_search?${p}`;
}

async function ckGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'CKAN error');
  return json.result;
}

/* ---------- CSV, built here because the file link cannot be trusted ----------
 *
 * The resource's own `url` is served through the site WAF: probed on a 1.4 MB
 * CSV, it answers `200 text/html` with 42 KB of obfuscated challenge script
 * rather than the file. `datastore/dump` is challenged identically. So the
 * download that data.gov.il advertises frequently does not produce a file.
 *
 * `datastore_search` is not challenged - it is the same call this page already
 * uses to show the rows - so for anything in the DataStore the CSV can be
 * assembled here from data we can actually get. Measured: limit=100000 returns
 * 100,000 records in 0.71s, so this is a handful of requests, not thousands.
 */

const CK_DUMP_PAGE = 32000;

/** RFC 4180 quoting, and a BOM so Excel reads Hebrew as UTF-8 rather than mojibake. */
function ckCsv(fields, records) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = records.map((r) => fields.map((f) => cell(r[f])).join(','));
  return `﻿${fields.map(cell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

/**
 * `download` is ignored for cross-origin URLs - that is why the file links open
 * in a tab. A blob: URL is same-origin, so here the attribute does work and the
 * browser saves rather than navigates.
 */
function ckSave(text, name) {
  const href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

/** Pages through the whole result set, reporting progress as it goes. */
async function ckFetchAll(resourceId, extra, onProgress) {
  const records = [];
  let fields = null;
  let offset = 0;

  // A ceiling rather than `while (true)`: if `total` ever disagreed with what
  // the server actually returns, this would otherwise loop forever.
  for (let guard = 0; guard < 500; guard += 1) {
    const p = new URLSearchParams({
      resource_id: resourceId, limit: String(CK_DUMP_PAGE), offset: String(offset), ...extra,
    });
    const r = await ckGet(`${CK_API}/datastore_search?${p}`);
    if (!fields) fields = r.fields.filter((f) => f.id !== '_id').map((f) => f.id);
    records.push(...r.records);
    offset += r.records.length;
    onProgress(records.length, r.total);
    if (!r.records.length || records.length >= r.total) break;
  }
  return { fields, records };
}

/**
 * Wires a "download CSV" button. `extra` carries the active query, so the
 * records view downloads exactly what is on screen rather than the whole table.
 */
function ckBindDownload(btn, resourceId, extra, base) {
  const label = btn.textContent;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    try {
      const { fields, records } = await ckFetchAll(resourceId, extra, (n, total) => {
        btn.textContent = `מוריד… ${num(n)} / ${num(total)}`;
      });
      if (!records.length) { btn.textContent = 'אין רשומות'; return; }
      ckSave(ckCsv(fields, records), `${base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.csv`);
      btn.textContent = `✓ ${num(records.length)} שורות`;
    } catch (err) {
      btn.textContent = err.name === 'AbortError' ? 'תם הזמן — נסה שוב' : 'ההורדה נכשלה';
      console.error(err);
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = label; }, 6000);
    }
  });
}

/* ---------- shared bits ---------- */

const ckLoading = (t = 'טוען…') => `<div class="skeleton" dir="auto">${esc(t)}</div>`;

function ckFailed(err, url) {
  // A cross-origin block reaches JS as an opaque TypeError with no status, and
  // an abort is a timeout. Neither is "the server said no", so say which.
  const why = err.name === 'AbortError'
    ? 'הבקשה חרגה מזמן ההמתנה. נסה שוב.'
    : err instanceof TypeError
      ? 'הבקשה נחסמה על ידי הדפדפן (CORS) או שהרשת נכשלה — הדפדפן אינו חושף את הסיבה המדויקת.'
      : `הבקשה נכשלה: ${esc(err.message)}`;
  return `<div class="notice error" dir="auto">${why}</div>
    <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
}

/** first / last / current's neighbours - never a wall of page numbers. */
function ckPager(cur, last, cls) {
  if (last < 1) return '';
  const want = [...new Set([0, cur - 1, cur, cur + 1, last])]
    .filter((p) => p >= 0 && p <= last).sort((a, b) => a - b);
  const btn = (p, label) => `<button type="button" class="pg${p === cur ? ' cur' : ''}" `
    + `data-${cls}="${p}"${p === cur ? ' aria-current="page"' : ''}>${esc(label)}</button>`;
  const dead = (label) => `<button type="button" class="pg" disabled>${esc(label)}</button>`;

  const out = [];
  let prev = -1;
  for (const p of want) {
    if (prev >= 0 && p > prev + 1) out.push('<span class="pg-gap">…</span>');
    out.push(btn(p, String(p + 1)));
    prev = p;
  }
  return `<nav class="pager" aria-label="ניווט בין עמודים" dir="rtl">
    ${cur > 0 ? btn(cur - 1, 'הקודם') : dead('הקודם')}${out.join('')}${cur < last ? btn(cur + 1, 'הבא') : dead('הבא')}
  </nav>`;
}

const ckCrumbs = (parts) => `<nav class="ck-crumbs" dir="auto">${parts.map((p, i) => (p.to
  ? `<button type="button" class="ck-crumb" data-go="${esc(p.to)}">${esc(p.label)}</button>`
  : `<span class="ck-here">${esc(p.label)}</span>`) + (i < parts.length - 1 ? '<span class="ck-sep">›</span>' : '')).join('')}</nav>`;

/* ---------- level 1: the catalogue ---------- */

async function ckRenderList() {
  const url = ckCatalogUrl();
  ckRoot.querySelector('.ck-body').innerHTML = ckLoading('מחפש מאגרים…');

  let r;
  try { r = await ckGet(url); } catch (err) {
    ckRoot.querySelector('.ck-body').innerHTML = ckFailed(err, url); return;
  }

  if (!ckFacets) ckFacets = r.search_facets || {};
  const last = Math.ceil(r.count / CK_DATASETS) - 1;
  const cur = Math.floor(ckState.start / CK_DATASETS);

  const opts = (field, sel, all) => `<option value="">${esc(all)}</option>` + (ckFacets[field]?.items || [])
    .slice().sort((a, b) => b.count - a.count)
    .map((it) => `<option value="${esc(it.name)}"${sel === it.name ? ' selected' : ''}>`
      + `${esc(it.display_name || it.name)} (${num(it.count)})</option>`).join('');

  ckRoot.querySelector('.ck-body').innerHTML = `
    <div class="ck-controls">
      <input type="search" class="ck-q" dir="auto" spellcheck="false"
             value="${esc(ckState.q)}" placeholder="חפש בכל 1,197 המאגרים…" aria-label="חיפוש מאגרים">
      <select class="ck-org" aria-label="גוף מפרסם" dir="auto">${opts('organization', ckState.org, 'כל הגופים')}</select>
      <select class="ck-fmt" aria-label="פורמט" dir="auto">${opts('res_format', ckState.format, 'כל הפורמטים')}</select>
      <select class="ck-sort" aria-label="מיון" dir="auto">${CK_SORTS.map(([v, l]) =>
        `<option value="${esc(v)}"${ckState.sort === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <span class="drill-scope">הכל בשרת</span>
    </div>

    <div class="ck-count" dir="auto">${r.count
      ? `${num(ckState.start + 1)}–${num(ckState.start + r.results.length)} מתוך <strong>${num(r.count)}</strong> מאגרים`
      : 'לא נמצאו מאגרים'}</div>

    <div class="ck-cards">
      ${r.results.map((ds) => {
        const res = ds.resources || [];
        const fmts = [...new Set(res.map((x) => (x.format || '?').toUpperCase()))];
        const live = res.filter(ckQueryable).length;
        return `
        <button type="button" class="ck-card" data-pkg="${esc(ds.name)}" dir="auto">
          <span class="ck-title">${esc(ds.title || ds.name)}</span>
          <span class="ck-org">${esc(ds.organization?.title || '—')}</span>
          ${ds.notes ? `<span class="ck-notes">${esc(ds.notes.slice(0, 160))}${ds.notes.length > 160 ? '…' : ''}</span>` : ''}
          <span class="ck-meta">
            ${fmts.slice(0, 5).map((f) => `<span class="f-fmt">${esc(f)}</span>`).join('')}
            <span class="ck-n">${res.length} קבצים</span>
            ${live ? `<span class="f-tag">${live} ניתנים לשאילתה</span>` : ''}
          </span>
        </button>`;
      }).join('')}
    </div>
    ${ckPager(cur, last, 'page')}
    <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;

  ckBindList(r);
}

function ckBindList(r) {
  const b = ckRoot.querySelector('.ck-body');
  const q = b.querySelector('.ck-q');
  const reset = (fn) => (...a) => { ckState.start = 0; return fn(...a); };

  const rerun = debounce(reset(() => { ckState.q = q.value.trim(); ckRenderList(); }), 450);
  q.addEventListener('input', rerun);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ckState.start = 0; ckState.q = q.value.trim(); ckRenderList(); }
  });

  const pick = (sel, key) => b.querySelector(sel).addEventListener('change', (e) => {
    ckState[key] = e.target.value; ckState.start = 0; ckRenderList();
  });
  pick('.ck-org', 'org'); pick('.ck-fmt', 'format'); pick('.ck-sort', 'sort');

  b.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    ckState.start = Number(btn.dataset.page) * CK_DATASETS; ckRenderList();
  }));

  b.querySelectorAll('[data-pkg]').forEach((card) => card.addEventListener('click', () => {
    ckState.pkg = r.results.find((d) => d.name === card.dataset.pkg);
    ckState.view = 'dataset';
    ckRender();
  }));
}

/* ---------- level 2: one dataset ---------- */

function ckRenderDataset() {
  const ds = ckState.pkg;
  const res = ds.resources || [];
  const date = (v) => (v ? new Date(v).toLocaleDateString('he-IL') : '—');

  ckRoot.querySelector('.ck-body').innerHTML = `
    <article class="ck-detail" dir="auto">
      <h3>${esc(ds.title || ds.name)}</h3>
      <dl class="ck-facts">
        <dt>גוף מפרסם</dt><dd>${esc(ds.organization?.title || '—')}</dd>
        <dt>רישיון</dt><dd>${esc(ds.license_title || '—')}</dd>
        <dt>עודכן</dt><dd>${esc(date(ds.metadata_modified))}</dd>
        <dt>נוצר</dt><dd>${esc(date(ds.metadata_created))}</dd>
      </dl>
      ${ds.notes ? `<p class="ck-desc">${esc(ds.notes)}</p>` : ''}
      ${ds.tags?.length ? `<p class="ck-tags">${ds.tags.map((t) =>
        `<span class="tag">${esc(t.display_name || t.name)}</span>`).join('')}</p>` : ''}

      <h4>קבצים (${res.length})</h4>
      <ul class="files">
        ${res.map((x, i) => `
          <li>
            <span class="f-fmt">${esc((x.format || '?').toUpperCase())}</span>
            <span class="f-name">${esc(x.name || x.description || '(ללא שם)')}</span>
            ${x.size ? `<span class="f-size">${esc(bytes(x.size))}</span>` : ''}
            ${ckQueryable(x)
              ? `<button type="button" class="ck-open" data-res="${i}">עיין בנתונים ←</button>
                 <button type="button" class="ck-dl" data-dl="${i}"
                         title="נבנה כאן מתוך ה-DataStore, ולכן אינו עובר דרך ה-WAF">הורד CSV</button>`
              : '<span class="ck-nodata" title="המשאב אינו טעון ל-DataStore">קובץ להורדה בלבד</span>'}
            <a class="f-go" href="${esc(x.url)}" target="_blank" rel="noopener"
               title="הקובץ המקורי מהשרת — עלול להיחסם על ידי ה-WAF">⭳ מקור</a>
          </li>`).join('')}
      </ul>
      <p class="files-note" dir="auto">
        <strong>הקישור ⭳ מקור מוביל לקובץ שעל השרת, והוא לעיתים קרובות נחסם:</strong>
        data.gov.il מגיש קבצי CSV/XLSX דרך WAF שמחזיר דף אתגר JavaScript במקום הקובץ
        (נמדד: <code dir="ltr">200 text/html</code>, 42KB, על קובץ CSV בגודל 1.4MB).
        לכן עבור משאבים הטעונים ל-DataStore הכפתור <strong>הורד CSV</strong> בונה את הקובץ
        כאן בדפדפן מתוך אותה שאילתה שמציגה את הנתונים — נתיב שאינו עובר דרך ה-WAF כלל.
        השאר הם קבצים להורדה בלבד, ועבורם הקישור המקורי הוא האפשרות היחידה.
      </p>
    </article>`;

  const b = ckRoot.querySelector('.ck-body');
  b.querySelectorAll('[data-dl]').forEach((btn) => {
    const x = res[Number(btn.dataset.dl)];
    ckBindDownload(btn, x.id, {}, x.name || ds.title || 'data');
  });
  b.querySelectorAll('[data-res]').forEach((btn) => btn.addEventListener('click', () => {
    ckState.resource = res[Number(btn.dataset.res)];
    ckState.rq = ''; ckState.rfilters = {}; ckState.rsort = ''; ckState.rstart = 0;
    ckState.view = 'records';
    ckRender();
  }));
}

/* ---------- level 3: the records inside a resource ---------- */

async function ckRenderRecords() {
  const url = ckRecordsUrl();
  ckRoot.querySelector('.ck-body').innerHTML = ckLoading('שולף רשומות…');

  let r;
  try { r = await ckGet(url); } catch (err) {
    ckRoot.querySelector('.ck-body').innerHTML = ckFailed(err, url); return;
  }

  // _id is CKAN's own row key; showing it as a column is noise.
  const fields = r.fields.filter((f) => f.id !== '_id');
  const last = Math.ceil(r.total / CK_RECORDS) - 1;
  const cur = Math.floor(ckState.rstart / CK_RECORDS);
  const filtered = Object.values(ckState.rfilters).some((v) => v.trim());
  // CKAN estimates the row count for large tables rather than counting them.
  // Printing an estimate as an exact figure would be a precision claim the API
  // never made - it says so in the response, so the UI says so too.
  const est = Boolean(r.total_was_estimated);

  ckRoot.querySelector('.ck-body').innerHTML = `
    <div class="ck-controls">
      <input type="search" class="ck-rq" dir="auto" spellcheck="false" value="${esc(ckState.rq)}"
             placeholder="חיפוש חופשי בכל השדות…" aria-label="חיפוש ברשומות"
             ${filtered ? 'disabled title="בטל את סינון העמודות כדי לחפש בכל השדות"' : ''}>
      <button type="button" class="ck-dl" id="ck-dl-view"
              title="מוריד את כל השורות התואמות לשאילתה הנוכחית, לא רק את העמוד המוצג">הורד CSV</button>
      <span class="drill-scope">חיפוש בשרת, על כל ${num(r.total)} הרשומות</span>
    </div>

    <div class="ck-count" dir="auto">${r.total
      ? `${num(ckState.rstart + 1)}–${num(ckState.rstart + r.records.length)} מתוך
         <strong${est ? ' title="CKAN מחזיר אומדן ולא ספירה מדויקת עבור טבלאות גדולות"' : ''}>${
           est ? '≈' : ''}${num(r.total)}</strong> רשומות${est ? ' (אומדן)' : ''}`
      : 'אין רשומות התואמות לסינון'}</div>

    ${r.records.length ? `
    <div class="matrix-wrap scroll">
      <table class="matrix preview ck-rec">
        <thead>
          <tr>${fields.map((f) => {
            const active = ckState.rsort === f.id;
            const next = active && ckState.rdir === 'asc' ? 'desc' : 'asc';
            return `<th class="sortable${active ? ' sorted' : ''}" data-sort="${esc(f.id)}" data-dir="${next}"
                        tabindex="0" role="button" title="${esc(f.type)} — מיון בשרת"
                        aria-sort="${active ? (ckState.rdir === 'asc' ? 'ascending' : 'descending') : 'none'}">
              ${esc(f.id)}<span class="s-mark">${active ? (ckState.rdir === 'asc' ? '▲' : '▼') : '↕'}</span>
              <span class="ck-type">${esc(f.type)}</span>
            </th>`;
          }).join('')}</tr>
          <tr class="ck-fil">${fields.map((f) => `<th>
            <input type="search" class="ck-cf" data-field="${esc(f.id)}" dir="auto" spellcheck="false"
                   value="${esc(ckState.rfilters[f.id] || '')}" placeholder="סנן…" aria-label="סינון ${esc(f.id)}">
          </th>`).join('')}</tr>
        </thead>
        <tbody>
          ${r.records.map((rec) => `<tr>${fields.map((f) =>
            `<td dir="auto">${esc(rec[f.id] ?? '')}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${ckPager(cur, last, 'rpage')}` : ''}
    <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;

  ckBindRecords();
}

function ckBindRecords() {
  const b = ckRoot.querySelector('.ck-body');

  // The same query the table is showing, minus paging - so what downloads is
  // what the filters match, not the 25 rows on screen.
  const dl = b.querySelector('#ck-dl-view');
  if (dl) {
    const extra = {};
    const per = Object.entries(ckState.rfilters).filter(([, v]) => v.trim());
    if (per.length) extra.q = JSON.stringify(Object.fromEntries(per));
    else if (ckState.rq) extra.q = ckState.rq;
    if (ckState.rsort) extra.sort = `${ckState.rsort} ${ckState.rdir}`;
    ckBindDownload(dl, ckState.resource.id, extra, ckState.resource.name || 'data');
  }

  const rq = b.querySelector('.ck-rq');
  const runQ = debounce(() => { ckState.rstart = 0; ckState.rq = rq.value.trim(); ckRenderRecords(); }, 450);
  rq.addEventListener('input', runQ);

  // Per-column boxes send q={"FIELD":"value"} - full text within that field.
  // Losing focus on every re-ckRender would make typing impossible, so the field
  // being edited is restored and the caret put back at the end.
  const runCol = debounce((field) => {
    ckState.rstart = 0;
    ckRenderRecords().then(() => {
      const back = ckRoot.querySelector(`.ck-cf[data-field="${CSS.escape(field)}"]`);
      if (back) { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    });
  }, 500);

  b.querySelectorAll('.ck-cf').forEach((inp) => inp.addEventListener('input', () => {
    ckState.rfilters[inp.dataset.field] = inp.value;
    if (!inp.value.trim()) delete ckState.rfilters[inp.dataset.field];
    runCol(inp.dataset.field);
  }));

  b.querySelectorAll('th.sortable').forEach((th) => {
    const apply = () => {
      ckState.rsort = th.dataset.sort; ckState.rdir = th.dataset.dir; ckState.rstart = 0; ckRenderRecords();
    };
    th.addEventListener('click', apply);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
  });

  b.querySelectorAll('[data-rpage]').forEach((btn) => btn.addEventListener('click', () => {
    ckState.rstart = Number(btn.dataset.rpage) * CK_RECORDS; ckRenderRecords();
  }));
}

/* ---------- shell ---------- */

function ckRender() {
  const trail = [{ label: 'כל המאגרים', to: ckState.view === 'list' ? null : 'list' }];
  if (ckState.pkg && ckState.view !== 'list') {
    trail.push({ label: ckState.pkg.title || ckState.pkg.name, to: ckState.view === 'dataset' ? null : 'dataset' });
  }
  if (ckState.view === 'records') {
    trail.push({ label: ckState.resource.name || 'נתונים', to: null });
  }
  ckRoot.querySelector('.ck-crumbs-slot').innerHTML = ckCrumbs(trail);
  ckRoot.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => {
    ckState.view = btn.dataset.go;
    ckRender();
  }));

  if (ckState.view === 'list') ckRenderList();
  else if (ckState.view === 'dataset') ckRenderDataset();
  else ckRenderRecords();
}

export function mountCkan(node) {
  ckRoot = node;
  ckRoot.innerHTML = `
    <div class="ckan">
      <p class="lead" dir="auto">
        הפורטל היחיד כאן שחושף את <strong>הרשומות עצמן</strong> ולא רק את קטלוג הקבצים.
        חפש מאגר, פתח אותו, ואז עיין בטבלת הנתונים — חיפוש, סינון לפי עמודה, מיון ודפדוף,
        הכל מתבצע בשרת על כלל הרשומות.
      </p>
      <div class="ck-crumbs-slot"></div>
      <div class="ck-body"></div>
    </div>`;
  ckRender();
}
