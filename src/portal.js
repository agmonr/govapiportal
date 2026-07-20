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

import { esc } from './ui.js';

const num = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL'));

/**
 * One entry per browser-callable portal.
 *   url     - the live request, kept small; this is a preview, not a dump
 *   total   - how many records exist overall, when the API says so
 *   columns - [key, label]; first column carries the row's identity
 *   rows    - shape-specific extraction
 */
const PREVIEWS = {
  datagov: {
    label: 'חיפוש מאגרים (package_search)',
    url: 'https://data.gov.il/api/3/action/package_search?rows=15',
    total: (j) => j.result.count,
    unit: 'מאגרים',
    columns: [['title', 'מאגר'], ['org', 'גוף מפרסם'], ['formats', 'פורמטים'], ['res', 'משאבים']],
    rows: (j) => j.result.results.map((ds) => ({
      title: ds.title,
      org: ds.organization?.title || '—',
      formats: [...new Set((ds.resources || []).map((r) => (r.format || '?').toUpperCase()))].join(', ') || '—',
      res: (ds.resources || []).length,
    })),
  },

  cbs: {
    label: 'קטלוג מדדים (index/catalog)',
    url: 'https://api.cbs.gov.il/index/catalog/catalog',
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
    url: 'https://open-bus-stride-api.hasadna.org.il/gtfs_stops/list?limit=15',
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
    url: 'https://open.govmap.gov.il/geoserver/opendata/wfs?service=WFS&version=2.0.0'
       + '&request=GetFeature&typeNames=opendata:PARCEL_ALL&outputFormat=application/json'
       + '&srsName=EPSG:4326&count=15',
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
    url: 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer/1/query'
       + '?where=1%3D1&outFields=pl_number,pl_name,pl_area_dunam,jurstiction_area_name,pl_landuse_string'
       + '&returnGeometry=false&orderByFields=last_update_date%20DESC&resultRecordCount=15&f=json',
    unit: 'תכניות',
    columns: [['number', 'מספר תכנית'], ['name', 'שם'], ['area', 'שטח'], ['juris', 'תחום שיפוט']],
    rows: (j) => (j.features || []).map((f) => ({
      number: f.attributes.pl_number || '—',
      name: f.attributes.pl_name || '—',
      area: f.attributes.pl_area_dunam == null ? '—'
        : `${Number(f.attributes.pl_area_dunam).toLocaleString('he-IL', { maximumFractionDigits: 1 })} דונם`,
      juris: f.attributes.jurstiction_area_name || '—',
    })),
  },
};

export const hasPreview = (portalId) => Boolean(PREVIEWS[portalId]);

function table(spec, rows) {
  if (!rows.length) return '<div class="notice info" dir="auto">הבקשה הצליחה אך לא הוחזרו רשומות.</div>';
  return `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>${spec.columns.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>${spec.columns
            .map(([key], i) => `<td dir="auto"${i === 0 ? ' class="ident"' : ''}>${esc(r[key])}</td>`)
            .join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
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
      <div class="skeleton" dir="auto">שולח בקשה…</div>
    </div>`;
  const body = node.querySelector('.drill');
  const slot = body.querySelector('.skeleton');

  const t0 = performance.now();
  try {
    const res = await fetch(spec.url);
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = spec.rows(json);
    const total = spec.total?.(json);

    slot.outerHTML = `
      <div class="ex-status">
        <span class="badge ok">HTTP ${res.status}</span>
        <span class="tag">${ms} ms</span>
        <span class="tag" dir="auto">${rows.length} מוצגות${total != null ? ` מתוך ${num(total)}` : ''} ${esc(spec.unit)}</span>
      </div>
      ${table(spec, rows)}
      <p class="drill-url" dir="ltr"><code>${esc(spec.url)}</code></p>`;
  } catch (err) {
    // A cross-origin block reaches JS as an opaque TypeError with no status.
    // Say which of the two it might be rather than inventing a cause.
    const cors = err instanceof TypeError;
    slot.outerHTML = `
      <div class="notice error" dir="auto">
        ${cors
          ? 'הבקשה נחסמה על ידי הדפדפן (CORS) או שהרשת נכשלה — הדפדפן אינו חושף את הסיבה המדויקת.'
          : `הבקשה נכשלה: ${esc(err.message)}`}
      </div>
      <p class="drill-url" dir="ltr"><code>${esc(spec.url)}</code></p>`;
  }
}
