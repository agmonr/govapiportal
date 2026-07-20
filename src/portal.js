/**
 * Portal drill-in: fire the portal's own API and render what comes back as
 * something readable.
 *
 * There is no generic parser here on purpose. Every source returns a different
 * shape - CKAN packages, nested CBS series, flat GTFS rows, GeoJSON features,
 * ArcGIS attribute records - so each gets a small explicit renderer. A generic
 * "dump any JSON as a table" would technically work and would be unreadable for
 * four of the five.
 *
 * Endpoints and shapes were probed on 2026-07-20; the weekly prober watches
 * them, so if one changes the map reports it rather than this quietly breaking.
 */

import { esc, debounce } from './ui.js';

const num = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL'));

/** Bytes -> a size someone can judge a download by. */
function bytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

/**
 * One entry per browser-callable portal.
 *   url     - the live request, kept small; this is a preview, not a dump
 *   url     - (query) => request URL; the query is applied server-side where the
 *             API supports it, so filtering searches the whole collection rather
 *             than the 15 rows already on screen. That distinction matters: a
 *             client-side filter over GovMap would search 15 of 1,097,502 parcels.
 *   local   - set instead when the collection is small enough to arrive whole
 *             (CBS is 14 chapters) and filtering client-side is honest.
 *   total   - how many records exist overall, when the API says so
 *   columns - [key, label]; first column carries the row's identity
 *   rows    - shape-specific extraction
 */

/** Encodes a value for a CQL / SQL LIKE clause. Quotes are the injection risk. */
const like = (q) => `%${q.replace(/'/g, "''")}%`;
const PREVIEWS = {
  datagov: {
    label: 'חיפוש מאגרים (package_search)',
    placeholder: 'חפש בכל 1,197 המאגרים — נושא, גוף מפרסם…',
    url: (q) => 'https://data.gov.il/api/3/action/package_search?rows=15'
      + (q ? `&q=${encodeURIComponent(q)}` : ''),
    total: (j) => j.result.count,
    unit: 'מאגרים',
    columns: [['title', 'מאגר'], ['org', 'גוף מפרסם'], ['formats', 'פורמטים'], ['res', 'קבצים']],
    rows: (j) => j.result.results.map((ds) => ({
      title: ds.title,
      org: ds.organization?.title || '—',
      formats: [...new Set((ds.resources || []).map((r) => (r.format || '?').toUpperCase()))].join(', ') || '—',
      res: (ds.resources || []).length,
      // Files live one level down. Carried here so the row can expand without
      // a second round-trip - package_search already returned them.
      _files: (ds.resources || []).map((r) => ({
        name: r.name || r.description || '(ללא שם)',
        format: (r.format || '?').toUpperCase(),
        size: r.size,
        url: r.url,
        rows: r.datastore_active,
      })),
    })),
  },

  cbs: {
    label: 'קטלוג מדדים (index/catalog)',
    placeholder: 'סנן פרקים…',
    // 14 chapters arrive in one response - filtering them client-side is the
    // whole collection, not a subset pretending to be one.
    local: true,
    url: () => 'https://api.cbs.gov.il/index/catalog/catalog',
    unit: 'פרקים',
    columns: [['name', 'פרק'], ['code', 'קוד ראשי'], ['order', 'סדר']],
    rows: (j) => (j.chapters || []).map((c) => ({
      name: c.chapterName,
      code: c.mainCode ?? '—',
      order: c.chapterOrder ?? '—',
    })),
  },

  openbus: {
    label: 'תחנות GTFS (gtfs_stops/list)',
    placeholder: 'סנן לפי עיר — למשל רעננה',
    url: (q) => 'https://open-bus-stride-api.hasadna.org.il/gtfs_stops/list?limit=15'
      + (q ? `&city=${encodeURIComponent(q)}` : ''),
    unit: 'תחנות',
    columns: [['name', 'תחנה'], ['city', 'עיר'], ['code', 'קוד'], ['pos', 'קואורדינטות']],
    rows: (j) => j.map((s) => ({
      name: s.name,
      city: s.city || '—',
      code: s.code,
      pos: `${Number(s.lat).toFixed(4)}, ${Number(s.lon).toFixed(4)}`,
    })),
  },

  govmap: {
    label: 'חלקות קדסטר (WFS PARCEL_ALL)',
    placeholder: 'סנן לפי יישוב — למשל רעננה',
    url: (q) => 'https://open.govmap.gov.il/geoserver/opendata/wfs?service=WFS&version=2.0.0'
      + '&request=GetFeature&typeNames=opendata:PARCEL_ALL&outputFormat=application/json'
      + '&srsName=EPSG:4326&count=15'
      + (q ? `&CQL_FILTER=${encodeURIComponent(`LOCALITY_N LIKE '${like(q)}'`)}` : ''),
    total: (j) => j.totalFeatures,
    unit: 'חלקות',
    columns: [['gush', 'גוש'], ['parcel', 'חלקה'], ['locality', 'יישוב'], ['area', 'שטח רשום'], ['status', 'סטטוס']],
    rows: (j) => (j.features || []).map((f) => ({
      gush: f.properties.GUSH_NUM,
      parcel: f.properties.PARCEL,
      locality: f.properties.LOCALITY_N || '—',
      area: `${num(f.properties.LEGAL_AREA)} מ״ר`,
      status: f.properties.STATUS_TEX || '—',
    })),
  },

  iplan: {
    label: 'תכניות בנייה (Xplan, קווים כחולים)',
    placeholder: 'סנן לפי שם תכנית או יישוב…',
    url: (q) => 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer/1/query'
      + '?where=' + encodeURIComponent(
        q ? `pl_name LIKE '${like(q)}' OR jurstiction_area_name LIKE '${like(q)}'` : '1=1')
      + '&outFields=pl_number,pl_name,pl_area_dunam,jurstiction_area_name,pl_landuse_string'
      + '&returnGeometry=false&orderByFields=last_update_date%20DESC&resultRecordCount=15&f=json',
    unit: 'תכניות',
    columns: [['number', 'מספר תכנית'], ['name', 'שם'], ['area', 'שטח'], ['juris', 'תחום שיפוט']],
    rows: (j) => (j.features || []).map((f) => ({
      number: f.attributes.pl_number || '—',
      name: f.attributes.pl_name || '—',
      area: f.attributes.pl_area_dunam == null ? '—'
        : `${Number(f.attributes.pl_area_dunam).toLocaleString('he-IL', { maximumFractionDigits: 1 })} דונם`,
      juris: f.attributes.jurstiction_area_name || '—',
      _files: f.attributes.pl_url
        ? [{ name: 'מסמכי התכנית (תקנון, תשריט)', format: 'מבא״ת', url: f.attributes.pl_url, external: true }]
        : [],
    })),
  },
};

export const hasPreview = (portalId) => Boolean(PREVIEWS[portalId]);

/**
 * The files under one row.
 *
 * Plain link navigations, so CORS never applies - these reach hosts a fetch()
 * could not read. Two things learned by probing rather than assuming:
 *
 * 1. The `download` attribute is ignored for cross-origin URLs. Every one of
 *    these is cross-origin, so it would have done nothing; the link opens in a
 *    new tab instead, which is also where a WAF interstitial can run.
 * 2. data.gov.il serves PDFs directly (200 application/pdf) but answers CSV and
 *    XLSX with a JavaScript WAF challenge page. A real browser passes it; an
 *    automated client does not, so this could not be verified end-to-end here.
 *    The note under the list warns rather than letting a blank page surprise.
 *
 * Size and format are shown up front - one of these is a 71 MB CSV.
 */
const WAF_FORMATS = new Set(['CSV', 'XLSX', 'XLS', 'ZIP']);

function files(list) {
  const mayChallenge = list.some((f) => WAF_FORMATS.has(f.format));
  return `
    <ul class="files">
      ${list.map((f) => `
        <li>
          <a href="${esc(f.url)}" target="_blank" rel="noopener" dir="auto">
            <span class="f-fmt">${esc(f.format)}</span>
            <span class="f-name">${esc(f.name)}</span>
            ${f.size ? `<span class="f-size">${esc(bytes(f.size))}</span>` : ''}
            ${f.rows ? '<span class="f-tag">ניתן לשאילתה</span>' : ''}
            <span class="f-go">${f.external ? '↗' : '⭳'}</span>
          </a>
        </li>`).join('')}
    </ul>
    ${mayChallenge ? `
      <p class="files-note" dir="auto">
        קבצי CSV/XLSX מוגשים דרך ה-WAF של data.gov.il. אם נפתח דף ביניים —
        המתן רגע, ההורדה מתחילה מעצמה. קבצי PDF מוגשים ישירות.
      </p>` : ''}`;
}

function table(spec, rows) {
  if (!rows.length) return '<div class="notice info" dir="auto">הבקשה הצליחה אך לא הוחזרו רשומות.</div>';
  const expandable = rows.some((r) => r._files?.length);

  return `
    <div class="matrix-wrap">
      <table class="matrix preview${expandable ? ' expandable' : ''}">
        <thead><tr>
          ${expandable ? '<th class="c-x"></th>' : ''}
          ${spec.columns.map(([, label]) => `<th>${esc(label)}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => {
            const has = r._files?.length;
            return `
            <tr class="${has ? 'has-files' : ''}" ${has ? `data-row="${i}" tabindex="0" role="button"` : ''}>
              ${expandable ? `<td class="c-x">${has ? '<span class="x-mark">▾</span>' : ''}</td>` : ''}
              ${spec.columns.map(([key], c) =>
                `<td dir="auto"${c === 0 ? ' class="ident"' : ''}>${esc(r[key])}</td>`).join('')}
            </tr>
            ${has ? `
            <tr class="files-row" data-files="${i}" hidden>
              <td colspan="${spec.columns.length + 1}">${files(r._files)}</td>
            </tr>` : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/** Wires row expansion. Called after every render, since the table is replaced. */
function bindRows(scope) {
  scope.querySelectorAll('tr.has-files').forEach((tr) => {
    const toggle = () => {
      const target = scope.querySelector(`tr[data-files="${tr.dataset.row}"]`);
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

/**
 * Renders into `node` for a portal.
 *
 * Portals that are not browser-callable get an explanation rather than a failed
 * request - that distinction is the whole point of the map, so the drill-in has
 * to respect it instead of showing a broken panel.
 */
export async function openPortal(node, portal) {
  const spec = PREVIEWS[portal.id];

  if (!spec) {
    node.innerHTML = `
      <div class="drill">
        <div class="drill-head">
          <h2 dir="auto">${esc(portal.name_he)}</h2>
          <button type="button" class="drill-close">סגור ✕</button>
        </div>
        <div class="notice info" dir="auto">
          ${portal.browser_count === 0
            ? 'אף ממשק בפורטל הזה אינו ניתן לקריאה מדפדפן — ראה את הסיבה בכרטיסי הממשקים למטה.'
            : 'אין תצוגה מקדימה מוגדרת לפורטל הזה.'}
        </div>
      </div>`;
    return;
  }

  node.innerHTML = `
    <div class="drill">
      <div class="drill-head">
        <h2 dir="auto">${esc(portal.name_he)}</h2>
        <button type="button" class="drill-close">סגור ✕</button>
      </div>
      <p class="drill-sub" dir="auto">${esc(spec.label)}</p>
      <div class="drill-filter">
        <input type="search" class="drill-q" dir="auto" spellcheck="false"
               placeholder="${esc(spec.placeholder)}" aria-label="סינון">
        <span class="drill-scope">${spec.local ? 'סינון מקומי' : 'סינון בשרת'}</span>
      </div>
      <div class="drill-out"></div>
    </div>`;

  const out = node.querySelector('.drill-out');
  const input = node.querySelector('.drill-q');
  let cached = null;   // local-filter portals fetch once and re-filter in place

  async function load(query) {
    out.innerHTML = '<div class="skeleton" dir="auto">שולח בקשה…</div>';
    const url = spec.url(spec.local ? '' : query);
    const t0 = performance.now();

    try {
      // A local-filter collection is fetched once; re-filtering must not re-hit
      // someone else's server for data already in hand.
      let json = spec.local ? cached : null;
      let ms = 0;
      let status = 200;
      if (!json) {
        const res = await fetch(url);
        ms = Math.round(performance.now() - t0);
        status = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
        if (spec.local) cached = json;
      }

      let rows = spec.rows(json);
      const total = spec.total?.(json);

      if (spec.local && query) {
        const q = query.toLowerCase();
        rows = rows.filter((r) => Object.values(r).join(' ').toLowerCase().includes(q));
      }

      out.innerHTML = `
        <div class="ex-status">
          <span class="badge ok">HTTP ${status}</span>
          ${ms ? `<span class="tag">${ms} ms</span>` : '<span class="tag">מהמטמון</span>'}
          <span class="tag" dir="auto">${rows.length} מוצגות${
            total != null && !query ? ` מתוך ${num(total)}` : ''} ${esc(spec.unit)}</span>
          ${query ? `<span class="tag" dir="auto">סינון: ${esc(query)}</span>` : ''}
        </div>
        ${rows.length
          ? table(spec, rows)
          : `<div class="notice info" dir="auto">אין תוצאות עבור <strong>${esc(query)}</strong>.</div>`}
        <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
      bindRows(out);
    } catch (err) {
      // A cross-origin block reaches JS as an opaque TypeError with no status.
      // Say which of the two it might be rather than inventing a cause.
      const cors = err instanceof TypeError;
      out.innerHTML = `
        <div class="notice error" dir="auto">
          ${cors
            ? 'הבקשה נחסמה על ידי הדפדפן (CORS) או שהרשת נכשלה — הדפדפן אינו חושף את הסיבה המדויקת.'
            : `הבקשה נכשלה: ${esc(err.message)}`}
        </div>
        <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
    }
  }

  // Server-side filters hit a government host on every keystroke without this.
  const rerun = debounce((q) => load(q), spec.local ? 120 : 450);
  input.addEventListener('input', (e) => rerun(e.target.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); load(input.value.trim()); }
  });

  await load('');
}
