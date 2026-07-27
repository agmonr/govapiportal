/**
 * Ministry of Agriculture (ArcGIS Hub) in depth - the moag equivalent of
 * ckan.js, going three levels into data1-moag.opendata.arcgis.com the same
 * way ckan.js goes three levels into data.gov.il:
 *
 *   catalogue  DCAT feed              93 datasets, arrives whole, filtered locally
 *   dataset    (already in hand)      description, publisher, files, data-service link
 *   records    ArcGIS FeatureServer   the actual rows behind one layer
 *
 * The catalogue is one DCAT-US 1.1 JSON document (see apis.json's "DCAT —
 * קטלוג מאגרים" entry) - small enough to hold whole, so unlike data.gov.il's
 * package_search this filters client-side, honestly badged "סינון מקומי"
 * the same way the CBS preview in portal.js is.
 *
 * The hard part is level 2: DCAT's own "ArcGIS GeoService" distribution is
 * only sometimes a direct FeatureServer/MapServer URL - probed against the
 * live feed (2026-07-27): 37 of 93 datasets. The other 56 point at an
 * Experience Builder / Instant Apps page, which is not itself queryable.
 * For those, this tries one more thing before giving up: a public sharing
 * API search for a "Web Map" item with the exact same title, which (when it
 * exists) lists its operational layers' FeatureServer URLs directly. That
 * resolves 24 more (61/93 total, probed the same day) - the remaining 32
 * genuinely have no queryable service behind them, and say so rather than
 * showing a broken panel.
 *
 * Search here is client-composed SQL (UPPER(field) LIKE UPPER('%q%') OR ...
 * across the layer's string fields) - ArcGIS REST has no equivalent of
 * CKAN's full-text q, so this is the honest substitute, same family as the
 * LIKE filters portal.js already builds for GovMap and iplan.
 */

import { esc, debounce, num, buildCsv, saveCsv } from './ui.js';

const MG_DCAT = 'https://data1-moag.opendata.arcgis.com/api/feed/dcat-us/1.1.json';
const MG_SHARING = 'https://www.arcgis.com/sharing/rest';
const MG_ORG = 'Fqk0gVrfcnumlR5m'; // moag's ArcGIS Online org id - narrows the Web Map search to their own content
const MG_PAGE = 25;
const MG_CARDS = 24;

/** DCAT distributions that are pages/services, not files someone downloads. */
const MG_NON_FILE = new Set(['ArcGIS Hub Dataset', 'ArcGIS GeoService']);

const mgState = {
  view: 'list', // list | dataset | records
  q: '', onlyDirect: false, start: 0,
  ds: null,
  layerUrl: null, layerLabel: null,
  rq: '', rsort: '', rdir: 'asc', rstart: 0,
};

let mgRoot = null;
let mgCatalog = null;   // the whole DCAT feed, fetched once
let mgLayerMeta = null; // { _url, fields, name, maxRecordCount } for the currently open layer

/* ---------- small shared bits (own copies - see ckan.js's identical note:
   each source's shape is different enough that a shared renderer would be
   unreadable, so each explorer on this site keeps its own) ---------- */

const mgLoading = (t = 'טוען…') => `<div class="skeleton" dir="auto">${esc(t)}</div>`;

function mgFailed(err, url) {
  const why = err.name === 'AbortError'
    ? 'הבקשה חרגה מזמן ההמתנה. נסה שוב.'
    : err instanceof TypeError
      ? 'הבקשה נחסמה על ידי הדפדפן (CORS) או שהרשת נכשלה — הדפדפן אינו חושף את הסיבה המדויקת.'
      : `הבקשה נכשלה: ${esc(err.message)}`;
  return `<div class="notice error" dir="auto">${why}</div>
    <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
}

function mgPager(cur, last, cls) {
  if (last == null || last < 1) return '';
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

const mgCrumbs = (parts) => `<nav class="ck-crumbs" dir="auto">${parts.map((p, i) => (p.to
  ? `<button type="button" class="ck-crumb" data-go="${esc(p.to)}">${esc(p.label)}</button>`
  : `<span class="ck-here">${esc(p.label)}</span>`) + (i < parts.length - 1 ? '<span class="ck-sep">›</span>' : '')).join('')}</nav>`;

/** DCAT descriptions carry raw HTML (and, on a handful of records, a literal
 *  "{{description}}" templating placeholder that was never filled in server-
 *  side). DOMParser only parses, never executes, so this is safe to run on
 *  untrusted text - the result still goes through esc() before it is ever
 *  written back into markup. */
function mgStripHtml(html) {
  if (!html || html === '{{description}}') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent.trim();
}

const mgDate = (v) => (v ? new Date(v).toLocaleDateString('he-IL') : '—');

/** The item id lives inside `identifier`, e.g. ".../item.html?id=<32 hex>". */
function mgItemId(ds) {
  return ds.identifier?.match(/id=([0-9a-f]{32})/i)?.[1] || null;
}

/* ---------- resolving a dataset to a queryable layer ---------- */

/** True 37/93 times (probed 2026-07-27): the DCAT service distribution IS the
 *  FeatureServer/MapServer, no extra request needed to know it. */
function mgDirectServiceUrl(ds) {
  const geo = (ds.distribution || []).find((d) => d.title === 'ArcGIS GeoService');
  const url = geo?.accessURL || '';
  return /\/(FeatureServer|MapServer)(\/\d+)?$/.test(url) ? url : null;
}

/** Given a FeatureServer/MapServer URL (root or already a specific layer),
 *  returns the queryable layer(s) under it. Two of the 37 direct URLs are a
 *  bare service root (no trailing layer index) - probed 2026-07-27 - so this
 *  is needed even on the "easy" path, not just the resolved one. */
async function mgServiceLayers(url) {
  const m = url.match(/^(.*\/(?:Feature|Map)Server)(?:\/(\d+))?$/);
  if (!m) return [];
  const [, root, idx] = m;
  if (idx != null) return [{ id: Number(idx), name: null, url }];
  const res = await fetch(`${root}?f=json`);
  if (!res.ok) return [];
  const j = await res.json();
  if (j.error) return [];
  return [...(j.layers || []), ...(j.tables || [])].map((l) => ({ id: l.id, name: l.name, url: `${root}/${l.id}` }));
}

/** Best-effort fallback for the 56 datasets whose DCAT service link is an
 *  Experience/Instant-Apps page: search ArcGIS Online for a "Web Map" item
 *  with the exact same title, owned by moag's own org, and read its
 *  operational layers' FeatureServer URLs out of the map's saved JSON. Finds
 *  a match for 24/56 (probed 2026-07-27) - the rest have no separately
 *  published Web Map to search for.
 *
 *  Every operational layer that resolves is kept, not just the first - a map
 *  titled "אגני ותת אגני ניקוז" (drainage basins AND sub-basins) turned out to
 *  hold two distinct FeatureServer layers, one per half of that title, and
 *  taking only the first would have silently dropped the second. The map's
 *  own layer titles are already in hand here, so this skips the extra
 *  mgServiceLayers() round trip the direct path needs. */
async function mgResolveViaWebMap(ds) {
  const q = `title:"${ds.title.replace(/"/g, '')}" AND type:"Web Map" AND orgid:${MG_ORG}`;
  const res = await fetch(`${MG_SHARING}/search?q=${encodeURIComponent(q)}&f=json&num=5`);
  if (!res.ok) return [];
  const r = await res.json();
  const exact = (r.results || []).find((x) => x.title === ds.title);
  if (!exact) return [];
  const dres = await fetch(`${MG_SHARING}/content/items/${exact.id}/data?f=json`);
  if (!dres.ok) return [];
  const data = await dres.json();
  return (data.operationalLayers || [])
    .filter((l) => l.url && /\/(FeatureServer|MapServer)\/(\d+)$/.test(l.url))
    .map((l) => ({ id: Number(l.url.match(/\/(\d+)$/)[1]), name: l.title || null, url: l.url }));
}

/** Tries the deterministic path first, then the Web Map fallback. Never
 *  throws - a failed resolution attempt is reported as "not found", same as
 *  a genuine absence, with `error` set so the message can say which. */
async function mgResolveDataset(ds) {
  try {
    const direct = mgDirectServiceUrl(ds);
    if (direct) {
      const layers = await mgServiceLayers(direct);
      if (layers.length) return { layers, via: 'direct' };
    }
    const layers = await mgResolveViaWebMap(ds);
    if (layers.length) return { layers, via: 'webmap' };
    return { layers: [], via: null };
  } catch (err) {
    console.error(err);
    return { layers: [], via: null, error: true };
  }
}

/* ---------- level 1: the catalogue ---------- */

async function mgLoadCatalog() {
  if (mgCatalog) return mgCatalog;
  const res = await fetch(MG_DCAT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  mgCatalog = (j.dataset || []).map((ds) => ({ ...ds, _direct: Boolean(mgDirectServiceUrl(ds)) }));
  return mgCatalog;
}

function mgFilterCatalog(all) {
  let rows = mgState.onlyDirect ? all.filter((ds) => ds._direct) : all;
  const q = mgState.q.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((ds) => [ds.title, mgStripHtml(ds.description), ds.publisher?.name, ...(ds.keyword || [])]
    .join(' ').toLowerCase().includes(q));
}

async function mgRenderList() {
  const body = mgRoot.querySelector('.ck-body');
  body.innerHTML = mgLoading('טוען קטלוג…');

  let all;
  try { all = await mgLoadCatalog(); } catch (err) { body.innerHTML = mgFailed(err, MG_DCAT); return; }

  const rows = mgFilterCatalog(all);
  const last = Math.ceil(rows.length / MG_CARDS) - 1;
  const cur = Math.min(Math.floor(mgState.start / MG_CARDS), Math.max(last, 0));
  const page = rows.slice(cur * MG_CARDS, cur * MG_CARDS + MG_CARDS);
  const directCount = all.filter((ds) => ds._direct).length;

  body.innerHTML = `
    <div class="ck-controls">
      <input type="search" class="mg-q" dir="auto" spellcheck="false"
             value="${esc(mgState.q)}" placeholder="חפש בכל 93 המאגרים…" aria-label="חיפוש מאגרים">
      <label class="mg-only" dir="auto">
        <input type="checkbox" class="mg-direct"${mgState.onlyDirect ? ' checked' : ''}>
        רק מאגרים עם קישור ישיר לנתונים (${num(directCount)})
      </label>
      <span class="drill-scope">סינון מקומי</span>
    </div>

    <div class="ck-count" dir="auto">${rows.length
      ? `${num(cur * MG_CARDS + 1)}–${num(cur * MG_CARDS + page.length)} מתוך <strong>${num(rows.length)}</strong> מאגרים`
      : 'לא נמצאו מאגרים'}</div>

    <div class="ck-cards">
      ${page.map((ds, i) => {
        const desc = mgStripHtml(ds.description);
        const fmts = [...new Set((ds.distribution || [])
          .filter((d) => !MG_NON_FILE.has(d.title)).map((d) => d.title))];
        return `
        <button type="button" class="ck-card" data-idx="${cur * MG_CARDS + i}" dir="auto">
          <span class="ck-title">${esc(ds.title)}</span>
          <span class="ck-org">${esc(ds.publisher?.name || '—')}</span>
          ${desc ? `<span class="ck-notes">${esc(desc.slice(0, 160))}${desc.length > 160 ? '…' : ''}</span>` : ''}
          <span class="ck-meta">
            ${fmts.slice(0, 5).map((f) => `<span class="f-fmt">${esc(f)}</span>`).join('')}
            ${ds._direct ? '<span class="f-tag">ניתן לשאילתה ישירות</span>' : ''}
          </span>
        </button>`;
      }).join('')}
    </div>
    ${mgPager(cur, Math.max(last, 0), 'page')}
    <p class="drill-url" dir="ltr"><code>${esc(MG_DCAT)}</code></p>`;

  mgBindList(rows);
}

function mgBindList(rows) {
  const b = mgRoot.querySelector('.ck-body');
  const q = b.querySelector('.mg-q');
  const reset = (fn) => (...a) => { mgState.start = 0; return fn(...a); };

  const rerun = debounce(reset(() => { mgState.q = q.value.trim(); mgRenderList(); }), 200);
  q.addEventListener('input', rerun);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); mgState.start = 0; mgState.q = q.value.trim(); mgRenderList(); }
  });

  b.querySelector('.mg-direct').addEventListener('change', (e) => {
    mgState.onlyDirect = e.target.checked; mgState.start = 0; mgRenderList();
  });

  b.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    mgState.start = Number(btn.dataset.page) * MG_CARDS; mgRenderList();
  }));

  b.querySelectorAll('[data-idx]').forEach((card) => card.addEventListener('click', () => {
    mgState.ds = rows[Number(card.dataset.idx)];
    mgState.view = 'dataset';
    mgRender();
  }));
}

/* ---------- level 2: one dataset ---------- */

function mgRenderDataset() {
  const body = mgRoot.querySelector('.ck-body');
  const ds = mgState.ds;
  const files = (ds.distribution || []).filter((d) => !MG_NON_FILE.has(d.title));
  const desc = mgStripHtml(ds.description);
  const home = (ds.distribution || []).find((d) => d.title === 'ArcGIS Hub Dataset')?.accessURL || ds.landingPage;

  body.innerHTML = `
    <article class="ck-detail" dir="auto">
      <h3>${esc(ds.title)}</h3>
      <dl class="ck-facts">
        <dt>גוף מפרסם</dt><dd>${esc(ds.publisher?.name || '—')}</dd>
        <dt>עודכן</dt><dd>${esc(mgDate(ds.modified))}</dd>
        <dt>נוצר</dt><dd>${esc(mgDate(ds.issued))}</dd>
        ${home ? `<dt>מקור</dt><dd><a href="${esc(home)}" target="_blank" rel="noopener">דף המאגר ב-ArcGIS Hub ↗</a></dd>` : ''}
      </dl>
      ${desc ? `<p class="ck-desc">${esc(desc)}</p>` : ''}
      ${ds.keyword?.length ? `<p class="ck-tags">${ds.keyword.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</p>` : ''}

      <h4>נתונים</h4>
      <div class="mg-service">${mgLoading('מאתר שירות נתונים…')}</div>

      ${files.length ? `
      <h4>קבצים להורדה (${files.length})</h4>
      <ul class="files">
        ${files.map((f) => `
          <li>
            <span class="f-fmt">${esc(f.format || '?')}</span>
            <span class="f-name">${esc(f.title || f.format || 'קובץ')}</span>
            <a class="f-go" href="${esc(f.accessURL)}" target="_blank" rel="noopener" title="הורדה ישירה מ-ArcGIS Hub">⭳</a>
          </li>`).join('')}
      </ul>` : ''}
    </article>`;

  mgResolveDataset(ds).then(({ layers, via, error }) => {
    const box = mgRoot.querySelector('.mg-service');
    if (!box) return; // navigated to a different level meanwhile
    if (!layers.length) {
      const itemId = mgItemId(ds);
      box.innerHTML = `<div class="notice info" dir="auto">
        ${error ? 'הבקשה לאיתור שירות הנתונים נכשלה — ייתכן שהרשת איטית כרגע, נסה שוב.'
          : 'לא אותר שירות ArcGIS הניתן לשאילתה עבור מאגר זה — הוא ככל הנראה חשוף רק כאפליקציית מפה (Experience/Instant App), לא כשירות נתונים נפרד.'}
        ${itemId ? ` <a href="https://www.arcgis.com/home/item.html?id=${esc(itemId)}" target="_blank" rel="noopener">פתח באתר ArcGIS ↗</a>` : ''}
      </div>`;
      return;
    }
    box.innerHTML = layers.length === 1
      ? `<button type="button" class="ck-open" data-layer="0">עיין בנתונים ←</button>
         <p class="drill-sub" dir="auto">${via === 'direct' ? 'קישור ישיר מהקטלוג' : 'אותר דרך Web Map באותו שם — לא קישור רשמי מהקטלוג'}</p>`
      : `<p class="drill-sub" dir="auto">${via === 'direct' ? 'קישור ישיר מהקטלוג' : 'אותר דרך Web Map באותו שם — לא קישור רשמי מהקטלוג'}, ${layers.length} שכבות:</p>
         <ul class="files">${layers.map((l, i) => `
           <li>
             <span class="f-name">${esc(l.name || `שכבה ${l.id}`)}</span>
             <button type="button" class="ck-open" data-layer="${i}">עיין בנתונים ←</button>
           </li>`).join('')}</ul>`;
    box.querySelectorAll('[data-layer]').forEach((btn) => btn.addEventListener('click', () => {
      const l = layers[Number(btn.dataset.layer)];
      mgState.layerUrl = l.url;
      mgState.layerLabel = l.name || ds.title;
      mgLayerMeta = null;
      mgState.rq = ''; mgState.rsort = ''; mgState.rdir = 'asc'; mgState.rstart = 0;
      mgState.view = 'records';
      mgRender();
    }));
  });
}

/* ---------- level 3: the records inside a layer ---------- */

async function mgLayerMetaFor(url) {
  if (mgLayerMeta && mgLayerMeta._url === url) return mgLayerMeta;
  const res = await fetch(`${url}?f=json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'שגיאת שרת');
  const fields = (j.fields || []).filter((f) => f.type !== 'esriFieldTypeOID' && f.type !== 'esriFieldTypeGeometry');
  mgLayerMeta = { _url: url, fields, name: j.name, maxRecordCount: j.maxRecordCount || 1000 };
  return mgLayerMeta;
}

/** ArcGIS REST has no full-text search - this ORs a LIKE across every string
 *  field instead, the closest honest equivalent. Field names come from the
 *  server's own metadata, never from user input, so only the typed value
 *  needs escaping (single quotes doubled, same as portal.js's `like()`). */
function mgWhere(meta) {
  const q = mgState.rq.trim();
  if (!q) return '1=1';
  const textFields = meta.fields.filter((f) => f.type === 'esriFieldTypeString').map((f) => f.name);
  if (!textFields.length) return '1=1';
  const needle = q.replace(/'/g, "''");
  return textFields.map((f) => `UPPER(${f}) LIKE UPPER('%${needle}%')`).join(' OR ');
}

function mgRecordsUrl(meta, opts = {}) {
  const p = new URLSearchParams({
    where: mgWhere(meta),
    outFields: meta.fields.map((f) => f.name).join(','),
    resultRecordCount: String(opts.limit || MG_PAGE),
    resultOffset: String(opts.start ?? mgState.rstart),
    f: 'json',
  });
  if (mgState.rsort) p.set('orderByFields', `${mgState.rsort} ${mgState.rdir}`);
  return `${mgState.layerUrl}/query?${p}`;
}

function mgCountUrl(meta) {
  const p = new URLSearchParams({ where: mgWhere(meta), returnCountOnly: 'true', f: 'json' });
  return `${mgState.layerUrl}/query?${p}`;
}

function mgCell(field, value) {
  if (value == null || value === '') return '—';
  if (field.type === 'esriFieldTypeDate' && typeof value === 'number') return mgDate(value);
  return String(value);
}

async function mgFetchAllRecords(meta, onProgress) {
  const rows = [];
  let start = 0;
  const limit = Math.min(meta.maxRecordCount, 2000);
  for (let guard = 0; guard < 500; guard += 1) {
    const url = mgRecordsUrl(meta, { start, limit });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'שגיאת שרת');
    const page = j.features || [];
    rows.push(...page.map((f) => f.attributes));
    start += page.length;
    onProgress(rows.length);
    if (!page.length || page.length < limit) break;
  }
  return rows;
}

async function mgRenderRecords() {
  const body = mgRoot.querySelector('.ck-body');
  body.innerHTML = mgLoading('שולף רשומות…');

  let meta;
  try { meta = await mgLayerMetaFor(mgState.layerUrl); } catch (err) { body.innerHTML = mgFailed(err, mgState.layerUrl); return; }

  const url = mgRecordsUrl(meta);
  let r;
  let count;
  try {
    [r, count] = await Promise.all([
      fetch(url).then((x) => x.json()),
      fetch(mgCountUrl(meta)).then((x) => x.json()),
    ]);
  } catch (err) { body.innerHTML = mgFailed(err, url); return; }
  if (r.error) { body.innerHTML = mgFailed(new Error(r.error.message || 'שגיאת שרת'), url); return; }

  const total = typeof count.count === 'number' ? count.count : null;
  const last = total != null ? Math.ceil(total / MG_PAGE) - 1 : null;
  const cur = Math.floor(mgState.rstart / MG_PAGE);
  const features = r.features || [];

  body.innerHTML = `
    <div class="ck-controls">
      <input type="search" class="mg-rq" dir="auto" spellcheck="false" value="${esc(mgState.rq)}"
             placeholder="חיפוש בכל שדות הטקסט…" aria-label="חיפוש ברשומות">
      <button type="button" class="ck-dl" id="mg-dl">הורד CSV</button>
      <span class="drill-scope">חיפוש בשרת${total != null ? `, על כל ${num(total)} הרשומות` : ''}</span>
    </div>

    <div class="ck-count" dir="auto">${total
      ? `${num(mgState.rstart + 1)}–${num(mgState.rstart + features.length)} מתוך <strong>${num(total)}</strong> רשומות`
      : total === 0 ? 'אין רשומות התואמות לסינון' : `${num(features.length)} רשומות מוצגות`}</div>

    ${features.length ? `
    <div class="matrix-wrap scroll">
      <table class="matrix preview ck-rec">
        <thead><tr>
          ${meta.fields.map((f) => {
            const active = mgState.rsort === f.name;
            const next = active && mgState.rdir === 'asc' ? 'desc' : 'asc';
            return `<th class="sortable${active ? ' sorted' : ''}" data-sort="${esc(f.name)}" data-dir="${next}"
                        tabindex="0" role="button" title="${esc(f.type)} — מיון בשרת"
                        aria-sort="${active ? (mgState.rdir === 'asc' ? 'ascending' : 'descending') : 'none'}">
              ${esc(f.alias || f.name)}<span class="s-mark">${active ? (mgState.rdir === 'asc' ? '▲' : '▼') : '↕'}</span>
            </th>`;
          }).join('')}
        </tr></thead>
        <tbody>
          ${features.map((f) => `<tr>${meta.fields.map((fld) =>
            `<td dir="auto">${esc(mgCell(fld, f.attributes[fld.name]))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${mgPager(cur, last, 'rpage')}` : ''}
    <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;

  mgBindRecords(meta);
}

function mgBindRecords(meta) {
  const b = mgRoot.querySelector('.ck-body');

  const dl = b.querySelector('#mg-dl');
  const dlLabel = dl.textContent;
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      const rows = await mgFetchAllRecords(meta, (n) => { dl.textContent = `מוריד… ${num(n)}`; });
      if (!rows.length) { dl.textContent = 'אין רשומות'; return; }
      const fields = meta.fields.map((f) => f.name);
      const name = (mgState.layerLabel || 'moag_data').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      saveCsv(buildCsv(fields, rows), `${name}.csv`);
      dl.textContent = `✓ ${num(rows.length)} שורות`;
    } catch (err) {
      dl.textContent = err.name === 'AbortError' ? 'תם הזמן — נסה שוב' : 'ההורדה נכשלה';
      console.error(err);
    } finally {
      dl.disabled = false;
      setTimeout(() => { dl.textContent = dlLabel; }, 6000);
    }
  });

  const rq = b.querySelector('.mg-rq');
  const runQ = debounce(() => { mgState.rstart = 0; mgState.rq = rq.value.trim(); mgRenderRecords(); }, 450);
  rq.addEventListener('input', runQ);
  rq.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); mgState.rstart = 0; mgState.rq = rq.value.trim(); mgRenderRecords(); }
  });

  b.querySelectorAll('th.sortable').forEach((th) => {
    const apply = () => {
      mgState.rsort = th.dataset.sort; mgState.rdir = th.dataset.dir; mgState.rstart = 0; mgRenderRecords();
    };
    th.addEventListener('click', apply);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
  });

  b.querySelectorAll('[data-rpage]').forEach((btn) => btn.addEventListener('click', () => {
    mgState.rstart = Number(btn.dataset.rpage) * MG_PAGE; mgRenderRecords();
  }));
}

/* ---------- shell ---------- */

function mgRender() {
  const trail = [{ label: 'כל המאגרים', to: mgState.view === 'list' ? null : 'list' }];
  if (mgState.ds && mgState.view !== 'list') {
    trail.push({ label: mgState.ds.title, to: mgState.view === 'dataset' ? null : 'dataset' });
  }
  if (mgState.view === 'records') {
    trail.push({ label: mgState.layerLabel || 'נתונים', to: null });
  }
  mgRoot.querySelector('.ck-crumbs-slot').innerHTML = mgCrumbs(trail);
  mgRoot.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => {
    mgState.view = btn.dataset.go;
    mgRender();
  }));

  if (mgState.view === 'list') mgRenderList();
  else if (mgState.view === 'dataset') mgRenderDataset();
  else mgRenderRecords();
}

export function mountMoag(node) {
  mgRoot = node;
  mgRoot.innerHTML = `
    <div class="ckan">
      <p class="lead" dir="auto">
        קטלוג של 93 המאגרים הגאוגרפיים של משרד החקלאות ← מאגר בודד ← טבלת הנתונים.
        חיפוש הקטלוג הוא מקומי (93 רשומות, נטענות בבת אחת); חיפוש, מיון ודפדוף בתוך מאגר
        מתבצעים בשרת, מול שירות ה-ArcGIS FeatureServer של אותו מאגר.
      </p>
      <div class="ck-crumbs-slot"></div>
      <div class="ck-body"></div>
    </div>`;
  mgRender();
}
