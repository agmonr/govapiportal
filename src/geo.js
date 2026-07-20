/**
 * Clients for the three services the address→plan lookup walks through.
 *
 * All were probed on 2026-07-20 and are browser-callable:
 *   GovMap open WFS  - Access-Control-Allow-Origin: *
 *   iplan Xplan      - echoes the requesting Origin
 *   Nominatim (OSM)  - Access-Control-Allow-Origin: *
 *
 * Nominatim is the only non-government link in the chain, and the only one that
 * can be quietly wrong, so callers must treat its output as provisional.
 */

const WFS = 'https://open.govmap.gov.il/geoserver/opendata/wfs';
const XPLAN =
  'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer/1/query';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Carries a kind that ui.js showError() already knows how to phrase. */
export class GeoError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function getJSON(url, params, { timeout = 25000 } = {}) {
  const qs = new URLSearchParams(params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${url}?${qs}`, { signal: ctrl.signal });
    if (res.status === 403) throw new GeoError('blocked', `HTTP 403 from ${new URL(url).host}`);
    if (res.status === 429) throw new GeoError('rate_limit', 'HTTP 429');
    if (!res.ok) throw new GeoError('http', `HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } catch (err) {
    if (err instanceof GeoError) throw err;
    // A cross-origin block and a dead network both surface as an opaque
    // TypeError with no status. Say so rather than inventing a cause.
    if (err.name === 'AbortError') throw new GeoError('network', 'הבקשה חרגה מזמן ההמתנה.');
    throw new GeoError('network', `${new URL(url).host}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * WGS84 -> Web Mercator.
 *
 * PARCEL_ALL declares EPSG:3857. Passing lon/lat degrees to its CQL filter does
 * not error - it silently matches nothing, which is the worst possible failure
 * and cost a debugging round to find.
 */
export function toWebMercator(lon, lat) {
  const R = 20037508.342789244;
  return {
    x: (lon * R) / 180,
    y: (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R / 180),
  };
}

/** Rough centroid of a GeoJSON geometry - good enough to hand to a point query. */
function centroid(geometry) {
  const pts = [];
  (function walk(node) {
    if (typeof node[0] === 'number') pts.push(node);
    else node.forEach(walk);
  })(geometry.coordinates);
  return {
    lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
  };
}

function asParcel(feature) {
  const p = feature.properties;
  return {
    gush: p.GUSH_NUM,
    parcel: p.PARCEL,
    locality: p.LOCALITY_N,
    area: p.LEGAL_AREA,
    status: p.STATUS_TEX,
    centre: feature.geometry ? centroid(feature.geometry) : null,
  };
}

const WFS_BASE = {
  service: 'WFS',
  version: '2.0.0',
  request: 'GetFeature',
  typeNames: 'opendata:PARCEL_ALL',
  outputFormat: 'application/json',
};

/** Which cadastral parcel contains this point? */
export async function parcelAt(lon, lat) {
  const { x, y } = toWebMercator(lon, lat);
  const data = await getJSON(WFS, {
    ...WFS_BASE,
    srsName: 'EPSG:4326',
    count: '3',
    CQL_FILTER: `INTERSECTS(the_geom, POINT(${x.toFixed(2)} ${y.toFixed(2)}))`,
  });
  return (data.features || []).map(asParcel);
}

/** Exact lookup - no geocoder, no third party, no guessing. */
export async function parcelByGush(gush, parcel) {
  const data = await getJSON(WFS, {
    ...WFS_BASE,
    srsName: 'EPSG:4326',
    count: '5',
    CQL_FILTER: `GUSH_NUM=${Number(gush)} AND PARCEL=${Number(parcel)}`,
  });
  return (data.features || []).map(asParcel);
}

const PLAN_FIELDS = [
  'pl_number', 'pl_name', 'pl_area_dunam', 'pl_landuse_string', 'pl_url',
  'pl_date_8', 'depositing_date', 'ja_concat', 'entity_subtype_desc',
  'jurstiction_area_name', 'mp_id',
].join(',');

function asPlan(feature) {
  const a = feature.attributes;
  const date = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  const number = a.pl_number || '';
  return {
    number,
    name: a.pl_name || '',
    dunam: a.pl_area_dunam ?? null,
    landuse: a.pl_landuse_string || '',
    url: a.pl_url || null,
    committee: a.ja_concat || '',
    jurisdiction: a.jurstiction_area_name || '',
    kind: a.entity_subtype_desc || '',
    published: date(a.pl_date_8),
    deposited: date(a.depositing_date),
    // תמא / תתל are national-scale. They legitimately cover the parcel and are
    // never the answer to "what is being built on this plot".
    national: /^\s*(תמא|תתל|תממ)/.test(number),
  };
}

/**
 * Plans whose boundary covers a point.
 *
 * Sorted smallest-area-first, national plans last. This ordering is the feature:
 * a real parcel returns ~10 plans, and the useful one is the most specific.
 * A 117,696-dunam metro corridor matches just as truly and helps nobody.
 */
export async function plansAt(lon, lat) {
  const data = await getJSON(XPLAN, {
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: PLAN_FIELDS,
    returnGeometry: 'false',
    f: 'json',
  });
  if (data.error) throw new GeoError('http', data.error.message || 'Xplan error');
  return (data.features || [])
    .map(asPlan)
    .sort((a, b) => Number(a.national) - Number(b.national) || (a.dunam ?? 1e12) - (b.dunam ?? 1e12));
}

/** Free-text plan search - name, or the planning committee's area. */
export async function plansWhere(clause, limit = 25) {
  const data = await getJSON(XPLAN, {
    where: clause,
    outFields: PLAN_FIELDS,
    returnGeometry: 'false',
    orderByFields: 'last_update_date DESC',
    resultRecordCount: String(limit),
    f: 'json',
  });
  if (data.error) throw new GeoError('http', data.error.message || 'Xplan error');
  return (data.features || []).map(asPlan);
}

/**
 * Address -> coordinate, via OpenStreetMap.
 *
 * The weak link, and deliberately the only step whose result is labelled
 * provisional in the UI: it is not a government source, it resolved
 * "השיזף 10, רעננה" to house-number precision but returned nothing at all for
 * a newer neighbourhood name in the same area. Nominatim asks for <=1
 * request/second, hence this never runs in a loop.
 */
export async function geocode(query) {
  const results = await getJSON(NOMINATIM, {
    q: query,
    format: 'json',
    limit: '3',
    countrycodes: 'il',
    'accept-language': 'he',
  });
  return results.map((r) => ({
    lon: Number(r.lon),
    lat: Number(r.lat),
    label: r.display_name,
    precise: r.addresstype === 'building' || Boolean(r.address?.house_number) ||
      ['house', 'building'].includes(r.type),
  }));
}

