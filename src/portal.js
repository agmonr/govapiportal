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

import { esc, debounce, num, bytes, buildCsv, saveCsv } from './ui.js';

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

/** HUMRAT_TEUNA / SUG_DEREH are coded columns - values taken from the resource's
 *  own Dictionary file (MS_TAVLA 4 and 2), not guessed. */
const ACCIDENT_SEVERITY = { 1: 'קטלנית', 2: 'קשה', 3: 'קלה' };
const ACCIDENT_ROAD = {
  1: 'עירונית בצומת', 2: 'עירונית לא בצומת',
  3: 'לא-עירונית בצומת', 4: 'לא-עירונית לא בצומת', 5: 'שטח',
};
const ACCIDENTS_RESOURCE_2024 = '05d14adb-fe54-49f7-b7ce-f30348e2d959';
// Settlement code -> name. A separate dataset (Population and Immigration
// Authority), not part of the accidents resource - its own dictionary never
// spells out city names, only codes.
const SETTLEMENTS_RESOURCE = '5c78e9fa-c2e2-4771-93ff-7f400a12f7ba';
const OUTSIDE_SETTLEMENT = 'מחוץ לתחום ישוב';

/** Shared by the live preview and the CSV download, so "download what's
 *  shown" and "what's shown" can never drift apart into two answers. */
function accidentFilters(query, primed) {
  const needle = query.trim();
  if (!needle || !primed) return null;
  const codes = [...primed.entries()]
    .filter(([, name]) => name.includes(needle))
    .map(([code]) => Number(code));
  // No match still has to ask the server something, or the empty filter is
  // ignored and the request silently returns everything instead of the "no
  // results" the search text promised.
  return { SEMEL_YISHUV: codes.length ? codes : [-1] };
}

const PREVIEWS = {
  accidents: {
    label: 'רשומות תאונה (DataStore, נתוני 2024)',
    placeholder: 'סנן לפי יישוב — למשל חיפה',
    pageSize: 15,
    paged: true,
    // One request to resolve a typed settlement name to its code(s), cached -
    // 1,310 rows is small enough to hold whole, and it almost never changes
    // mid-session.
    prime: async () => {
      const fields = encodeURIComponent('סמל_ישוב,שם_ישוב');
      const res = await fetch(
        `https://data.gov.il/api/3/action/datastore_search?resource_id=${SETTLEMENTS_RESOURCE}&fields=${fields}&limit=1500`);
      const j = await res.json();
      const map = new Map();
      (j.result?.records || []).forEach((r) => {
        const code = String(r['סמל_ישוב'] ?? '').trim();
        const name = String(r['שם_ישוב'] ?? '').trim();
        if (code) map.set(code, name);
      });
      return map;
    },
    // Filters, not q: every column here is a numeric code, so CKAN's full-text
    // q would search codes, not the city name someone actually types.
    url: (q, o, primed) => {
      const p = new URLSearchParams({ resource_id: ACCIDENTS_RESOURCE_2024, limit: String(o.limit || 15) });
      if (o.start) p.set('offset', String(o.start));
      const filters = accidentFilters(q, primed);
      if (filters) p.set('filters', JSON.stringify(filters));
      return `https://data.gov.il/api/3/action/datastore_search?${p}`;
    },
    total: (j) => j.result.total,
    unit: 'תאונות',
    columns: [['year', 'שנה'], ['severity', 'חומרה'], ['city', 'יישוב'], ['road', 'סוג דרך'], ['hour', 'שעה']],
    rows: (j, primed) => (j.result.records || []).map((r) => {
      const code = String(r.SEMEL_YISHUV ?? '').trim();
      return {
        year: r.SHNAT_TEUNA ?? '—',
        severity: ACCIDENT_SEVERITY[r.HUMRAT_TEUNA] || '—',
        city: !code || code === '0' ? OUTSIDE_SETTLEMENT : (primed?.get(code) || `יישוב #${code}`),
        road: ACCIDENT_ROAD[r.SUG_DEREH] || '—',
        hour: r.SHAA ?? '—',
      };
    }),
    // Downloads exactly the active filter, not the whole 8,315-row table by
    // default - the same distinction the datagov preview draws for its own
    // per-dataset download, just one level up. Reuses this spec's own url()/
    // rows()/total() - see fetchAllRows() - so what downloads can never show
    // different columns or a different filter than what's on screen.
    download: {
      filename: (q) => `תאונות_דרכים_2024${q ? `_${q}` : ''}`,
    },
  },

  datagov: {
    label: 'חיפוש מאגרים (package_search)',
    placeholder: 'חפש בכל 1,197 המאגרים — נושא, גוף מפרסם…',
    // This preview stops at the catalogue. The records themselves live on their
    // own page - relative, so it resolves to dist/datagov.html from the offline
    // bundle and to /datagov.html from the served site.
    more: { href: './datagov.html', label: 'חקירה מלאה: קטלוג ← מאגר ← טבלת הנתונים' },
    // 50 rows rather than 15: the table scrolls in its own box, so a longer page
    // costs no page height. Measured 445 KB / 0.35s against 169 KB / 0.18s.
    pageSize: 50,
    scroll: true,
    // 1,197 datasets is 24 pages. CKAN takes `start` as a plain offset, returns
    // a short last page and an empty list past the end rather than erroring
    // (probed at start=0/100/1150/1190/5000).
    paged: true,
    // Column sort, done by Solr over all 1,197 - not over the rows on screen.
    // Only these two columns get a control. 'formats' is multivalued and 'res'
    // is not an indexed field at all, so neither can be sorted server-side, and
    // sorting them client-side would reorder 50 rows while looking exactly like
    // it had reordered the collection. Same reason the POST endpoint gets no
    // open-in-tab badge: a control that does something other than what it says.
    sortable: { title: 'title_string', org: 'organization' },
    // Column filters, as fq clauses. The options come out of search_facets on
    // the very same response, so the dropdowns cost no extra request.
    facets: [
      { key: 'org', field: 'organization', all: 'כל הגופים' },
      { key: 'formats', field: 'res_format', all: 'כל הפורמטים' },
    ],
    facetsOf: (j) => j.result.search_facets || {},
    url: (q, o = {}) => {
      const p = new URLSearchParams({ rows: '50' });
      if (q) p.set('q', q);
      const fq = [];
      if (o.org) fq.push(`organization:${o.org}`);
      if (o.formats) fq.push(`res_format:${o.formats}`);
      if (fq.length) p.set('fq', fq.join(' '));
      if (o.sort) p.set('sort', `${o.sort} ${o.dir}`);
      if (o.start) p.set('start', String(o.start));
      p.set('facet.field', '["organization","res_format"]');
      p.set('facet.limit', '100');
      return `https://data.gov.il/api/3/action/package_search?${p}`;
    },
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
    // Measured: unfiltered 0.7s, LIKE on locality ~12s. The table is not
    // indexed on attributes, so a filtered query is slow by nature, not broken.
    slow: true,
    slowNote: 'סינון על 1.1 מיליון חלקות אינו מאונדקס — התשובה עשויה להימשך 10-40 שניות.',
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

/**
 * A column header, interactive only where the server can actually sort by it.
 *
 * A plain <th> for the rest is deliberate. The alternative - sorting the fetched
 * page client-side - produces a header that behaves identically to its
 * neighbours while answering a different question ("first of these 50" rather
 * than "first of 1,197").
 */
function headCell(spec, key, label, state) {
  const field = spec.sortable?.[key];
  if (!field) return `<th>${esc(label)}</th>`;

  const active = state.sort === field;
  const next = active && state.dir === 'asc' ? 'desc' : 'asc';
  const mark = active ? (state.dir === 'asc' ? '▲' : '▼') : '↕';
  return `
    <th class="sortable${active ? ' sorted' : ''}" data-sort="${esc(field)}" data-dir="${next}"
        tabindex="0" role="button" aria-sort="${active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"
        title="מיון בשרת, על כל התוצאות ולא על העמוד המוצג">${esc(label)}<span class="s-mark">${mark}</span></th>`;
}

function table(spec, rows, state) {
  if (!rows.length) return '<div class="notice info" dir="auto">הבקשה הצליחה אך לא הוחזרו רשומות.</div>';
  const expandable = rows.some((r) => r._files?.length);

  return `
    <div class="matrix-wrap${spec.scroll ? ' scroll' : ''}">
      <table class="matrix preview${expandable ? ' expandable' : ''}">
        <thead><tr>
          ${expandable ? '<th class="c-x"></th>' : ''}
          ${spec.columns.map(([key, label]) => headCell(spec, key, label, state)).join('')}
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

/**
 * Page numbers to actually render: first, last, and the current one's immediate
 * neighbours. 1,197 datasets is 24 pages and 626 filtered is 13 - listing them
 * all would be a wall of numbers nobody aims at.
 */
function pageWindow(cur, last) {
  const want = [...new Set([0, cur - 1, cur, cur + 1, last])];
  return want.filter((p) => p >= 0 && p <= last).sort((a, b) => a - b);
}

/**
 * Offset paging over the whole result set - not over what was fetched. `start`
 * is a server offset, so page 5 of a filtered search is the server's page 5 of
 * that filter, which is why every control that changes the result set resets it
 * to 0: page 20 of 1,197 does not exist once a filter cuts it to 626.
 */
function pager(spec, state, total, shown) {
  if (!spec.paged || total == null || !shown) return '';
  const last = Math.ceil(total / spec.pageSize) - 1;
  if (last < 1) return '';
  const cur = Math.floor(state.start / spec.pageSize);

  const btn = (p, label) =>
    `<button type="button" class="pg${p === cur ? ' cur' : ''}" data-start="${p * spec.pageSize}"${
      p === cur ? ' aria-current="page"' : ''}>${esc(label)}</button>`;
  const dead = (label) => `<button type="button" class="pg" disabled>${esc(label)}</button>`;

  const nums = [];
  let prev = -1;
  for (const p of pageWindow(cur, last)) {
    if (prev >= 0 && p > prev + 1) nums.push('<span class="pg-gap">…</span>');
    nums.push(btn(p, String(p + 1)));
    prev = p;
  }

  return `
    <nav class="pager" aria-label="ניווט בין עמודים" dir="rtl">
      ${cur > 0 ? btn(cur - 1, 'הקודם') : dead('הקודם')}
      ${nums.join('')}
      ${cur < last ? btn(cur + 1, 'הבא') : dead('הבא')}
    </nav>`;
}

function bindPager(scope, state, reload) {
  scope.querySelectorAll('.pager .pg[data-start]').forEach((b) => {
    b.addEventListener('click', () => { state.start = Number(b.dataset.start); reload(); });
  });
}

/** The Hebrew column label behind an active sort field, for the status line. */
function sortLabel(spec, state) {
  const key = Object.keys(spec.sortable || {}).find((k) => spec.sortable[k] === state.sort);
  const col = spec.columns.find(([k]) => k === key);
  return `${col ? col[1] : state.sort} ${state.dir === 'asc' ? '↑' : '↓'}`;
}

/**
 * Wires the sortable headers. Each click re-requests with a new `sort=` rather
 * than reordering what is on screen - the whole point is that it sorts the
 * collection, not the page.
 */
function bindSort(scope, state, reload) {
  scope.querySelectorAll('th.sortable').forEach((th) => {
    const apply = () => {
      state.sort = th.dataset.sort;
      state.dir = th.dataset.dir;
      reload();
    };
    th.addEventListener('click', apply);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
  });
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
 * Pages through a spec's own url()/rows()/total() until the whole filtered
 * result set is in hand, decoded exactly as the on-screen table decodes it
 * (severity, city names, ...) - so a download can never show different
 * columns or a different filter than what's on screen. A large `limit`
 * override keeps this to a handful of requests rather than one per on-screen
 * page; `spec.pageSize` stays untouched for the live table.
 */
const DUMP_PAGE = 32000;

async function fetchAllRows(spec, query, primed, onProgress) {
  const rows = [];
  let start = 0;
  // A ceiling rather than `while (true)`: if the server's own total ever
  // disagreed with what it actually returns, this would otherwise loop forever.
  for (let guard = 0; guard < 500; guard += 1) {
    const url = spec.url(query, { start, limit: DUMP_PAGE }, primed);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const total = spec.total(json);
    const page = spec.rows(json, primed);
    rows.push(...page);
    start += page.length;
    onProgress(rows.length, total);
    if (!page.length || rows.length >= total) break;
  }
  return rows;
}

/**
 * `home` sits on every portal/app entry but nothing ever rendered it - the
 * drill-in is where it belongs, as a source citation. The close button only
 * makes sense inline on the map, where "close" means "back to browsing
 * portals" - a dedicated page has nothing to close back to, so `standalone`
 * omits it.
 */
function drillHead(portal, standalone) {
  return `
    <div class="drill-head">
      <span class="drill-title">
        <h2 dir="auto">${esc(portal.name_he)}</h2>
        ${portal.home ? `<a class="drill-home" href="${esc(portal.home)}" target="_blank" rel="noopener">מקור הנתונים ↗</a>` : ''}
      </span>
      ${standalone ? '' : '<button type="button" class="drill-close">סגור ✕</button>'}
    </div>`;
}

/**
 * Renders into `node` for a portal (or an app whose data lives on its own
 * page - see accidents.js).
 *
 * Portals that are not browser-callable get an explanation rather than a failed
 * request - that distinction is the whole point of the map, so the drill-in has
 * to respect it instead of showing a broken panel.
 */
export async function openPortal(node, portal, { standalone = false } = {}) {
  const spec = PREVIEWS[portal.id];

  if (!spec) {
    node.innerHTML = `
      <div class="drill">
        ${drillHead(portal, standalone)}
        <div class="notice info" dir="auto">
          ${portal.api_count === 0
            ? 'זהו כלי חיצוני ולא API ממשלתי — הדוח עצמו נמצא בקישור לאתר הבית שלמעלה.'
            : portal.browser_count === 0
              ? 'אף ממשק בפורטל הזה אינו ניתן לקריאה מדפדפן — ראה את הסיבה בכרטיסי הממשקים למטה.'
              : 'אין תצוגה מקדימה מוגדרת לפורטל הזה.'}
        </div>
      </div>`;
    return;
  }

  node.innerHTML = `
    <div class="drill">
      ${drillHead(portal, standalone)}
      <p class="drill-sub" dir="auto">${esc(spec.label)}${spec.more
        ? ` <a class="drill-more" href="${esc(spec.more.href)}">${esc(spec.more.label)} ←</a>` : ''}</p>
      <div class="drill-filter">
        <input type="search" class="drill-q" dir="auto" spellcheck="false"
               placeholder="${esc(spec.placeholder)}" aria-label="סינון">
        <span class="drill-scope">${spec.local ? 'סינון מקומי' : 'סינון בשרת'}</span>
        ${spec.download ? '<button type="button" class="drill-dl">הורדת CSV ⭳</button>' : ''}
      </div>
      ${spec.facets ? '<div class="drill-cols"></div>' : ''}
      <div class="drill-out"></div>
    </div>`;

  const out = node.querySelector('.drill-out');
  const input = node.querySelector('.drill-q');
  const cols = node.querySelector('.drill-cols');
  const dl = node.querySelector('.drill-dl');
  let cached = null;   // local-filter portals fetch once and re-filter in place
  let primed = null;   // spec.prime()'s result (e.g. a code -> name lookup), fetched once

  if (dl) {
    const dlLabel = dl.textContent;
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      try {
        if (spec.prime && !primed) primed = await spec.prime();
        const query = input.value.trim();
        const rows = await fetchAllRows(spec, query, primed, (n, total) => {
          dl.textContent = `מוריד… ${num(n)} / ${num(total)}`;
        });
        if (!rows.length) { dl.textContent = 'אין רשומות'; return; }
        const fields = spec.columns.map(([, label]) => label);
        const csvRows = rows.map((r) => Object.fromEntries(spec.columns.map(([key, label]) => [label, r[key]])));
        const name = spec.download.filename(query).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        saveCsv(buildCsv(fields, csvRows), `${name}.csv`);
        dl.textContent = `✓ ${num(rows.length)} שורות`;
      } catch (err) {
        dl.textContent = err.name === 'AbortError' ? 'תם הזמן — נסה שוב' : 'ההורדה נכשלה';
        console.error(err);
      } finally {
        dl.disabled = false;
        setTimeout(() => { dl.textContent = dlLabel; }, 6000);
      }
    });
  }

  // Column sort + column filters. Sort starts unset so the first view keeps
  // CKAN's own relevance order rather than imposing one.
  const state = { sort: null, dir: 'asc', start: 0 };
  spec.facets?.forEach((f) => { state[f.key] = ''; });

  /**
   * Anything that changes *which* records match sends you back to page 1.
   * Without this, filtering while on page 20 asks the server for offset 950 of a
   * 626-row result and renders an empty table that looks like "no matches".
   */
  const fromStart = (fn) => (...args) => { state.start = 0; return fn(...args); };

  /**
   * Dropdown options are populated once, from the first unfiltered response.
   *
   * They are deliberately not refreshed afterwards: CKAN narrows search_facets
   * to match the active fq, so re-reading them after a pick would leave the
   * chosen organisation as the only option and strand the user there.
   */
  let facetOpts = null;

  function renderCols() {
    if (!cols || !facetOpts) return;
    cols.innerHTML = spec.facets.map((f) => {
      const items = facetOpts[f.field]?.items || [];
      const opts = items
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((it) => `<option value="${esc(it.name)}"${state[f.key] === it.name ? ' selected' : ''}>`
          + `${esc(it.display_name || it.name)} (${num(it.count)})</option>`)
        .join('');
      return `<select class="col-f" data-key="${esc(f.key)}" aria-label="${esc(f.all)}" dir="auto">
          <option value="">${esc(f.all)}</option>${opts}
        </select>`;
    }).join('');   // No scope badge here: the one above already covers the panel.

    cols.querySelectorAll('.col-f').forEach((sel) => {
      sel.addEventListener('change', () => {
        state[sel.dataset.key] = sel.value;
        fromStart(load)(input.value.trim());
      });
    });
  }

  async function load(query) {
    out.innerHTML = `<div class="skeleton" dir="auto">שולח בקשה…${
      spec.slow && query ? ` <span class="slow-note">${esc(spec.slowNote)}</span>` : ''}</div>`;
    // Runs once per drill-in, not per keystroke - primed stays cached across
    // reloads the same way `cached` does for a local-filter portal.
    if (spec.prime && !primed) primed = await spec.prime();
    const url = spec.url(spec.local ? '' : query, state, primed);
    const t0 = performance.now();

    try {
      // A local-filter collection is fetched once; re-filtering must not re-hit
      // someone else's server for data already in hand.
      let json = spec.local ? cached : null;
      let ms = 0;
      let status = 200;
      if (!json) {
        // Without a deadline this spins forever on a slow host. GovMap's WFS
        // attribute filters are unindexed over 1.1M parcels and measured at
        // 12-40s, so the ceiling has to clear that or it would abort a request
        // that was going to succeed.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), spec.slow ? 75000 : 25000);
        const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        ms = Math.round(performance.now() - t0);
        status = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
        if (spec.local) cached = json;
      }

      let rows = spec.rows(json, primed);
      const total = spec.total?.(json);

      if (spec.facetsOf && !facetOpts) {
        facetOpts = spec.facetsOf(json);
        renderCols();
      }

      if (spec.local && query) {
        const q = query.toLowerCase();
        rows = rows.filter((r) => Object.values(r).join(' ').toLowerCase().includes(q));
      }

      out.innerHTML = `
        <div class="ex-status">
          <span class="badge ok">HTTP ${status}</span>
          ${ms ? `<span class="tag">${ms} ms</span>` : '<span class="tag">מהמטמון</span>'}
          ${spec.paged && total != null && rows.length
            ? `<span class="tag" dir="auto">${num(state.start + 1)}–${num(state.start + rows.length)} מתוך ${num(total)} ${esc(spec.unit)}</span>`
            : `<span class="tag" dir="auto">${rows.length} מוצגות${
                total != null ? ` מתוך ${num(total)}` : ''} ${esc(spec.unit)}</span>`}
          ${query ? `<span class="tag" dir="auto">סינון: ${esc(query)}</span>` : ''}
          ${state.sort ? `<span class="tag" dir="auto">ממוין: ${esc(sortLabel(spec, state))}</span>` : ''}
        </div>
        ${rows.length
          ? table(spec, rows, state)
          : `<div class="notice info" dir="auto">אין תוצאות${query ? ` עבור <strong>${esc(query)}</strong>` : ' עבור הסינון שנבחר'}.</div>`}
        ${pager(spec, state, total, rows.length)}
        <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
      bindRows(out);
      bindSort(out, state, fromStart(() => load(input.value.trim())));
      bindPager(out, state, () => load(input.value.trim()));
    } catch (err) {
      // A cross-origin block reaches JS as an opaque TypeError with no status.
      // Say which of the two it might be rather than inventing a cause.
      const cors = err instanceof TypeError;
      out.innerHTML = `
        <div class="notice error" dir="auto">
          ${err.name === 'AbortError'
            ? 'הבקשה חרגה מזמן ההמתנה. השרת איטי כרגע — נסה שוב, או צמצם את הסינון.'
            : cors
              ? 'הבקשה נחסמה על ידי הדפדפן (CORS) או שהרשת נכשלה — הדפדפן אינו חושף את הסיבה המדויקת.'
              : `הבקשה נכשלה: ${esc(err.message)}`}
        </div>
        <p class="drill-url" dir="ltr"><code>${esc(url)}</code></p>`;
    }
  }

  // Server-side filters hit a government host on every keystroke without this.
  const rerun = debounce(fromStart((q) => load(q)), spec.local ? 120 : 450);
  input.addEventListener('input', (e) => rerun(e.target.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fromStart(load)(input.value.trim()); }
  });

  await load('');
}
