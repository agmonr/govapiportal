/**
 * Shared ITM<->WGS84 reprojection and OSM-tile basemap stitching - originally
 * built for blue-lines.js (see that file's own docstring, steps 2 and 4),
 * extracted here once area-cleanup.js needed the exact same "draw a basemap
 * aligned to an ITM bbox, with a pin at its centre" piece. Both pages
 * genuinely need the identical math (Xplan layers and GovMap's WFS layers
 * are both ITM-native), not just similar-looking code.
 */

const GEOMETRY = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/Utilities/Geometry/GeometryServer';
const OSM_TILE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
// Esri's free World Imagery basemap - same anonymous, no-API-key access as
// the OSM tiles above, just row/col reversed (ArcGIS's own tile REST
// convention, {z}/{y}/{x} - same order this codebase already deals with for
// the heat ImageServer, see canopy-map.html's "כתם חום" explainer).
const AERIAL_TILE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
// Esri's free World Topo Map - same service family/URL shape/no-API-key
// access as AERIAL_TILE above (verified directly: both return real tiles
// with no auth), just a different service name. Contour lines/terrain
// shading rather than street or satellite - canopy-map.html's own "show the
// topography under this heat/canopy view" toggle.
const TOPO_TILE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`;
const TILE_ATTRIBUTION = {
  street: '© OpenStreetMap contributors',
  aerial: 'Imagery © Esri, Maxar, Earthstar Geographics',
  topo: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
};
export const TILE_KIND_ATTRIBUTION = TILE_ATTRIBUTION;

// Same three sources as OSM_TILE/AERIAL_TILE/TOPO_TILE above, as plain {z}/
// {x}/{y} URL TEMPLATE strings (Leaflet's own L.tileLayer expects a
// template, not a per-tile function) rather than a second, separately-
// maintained set of URLs - canopy-map.js's own live Leaflet tile layer
// reads these; the function form above stays as-is for the canvas-
// stitching stitchBasemap() still uses (blue-lines.js/area-cleanup.html/
// trip-report.html's own address-lookup maps). Esri's {y}/{x} order is
// written that way here too - Leaflet substitutes each placeholder
// wherever it appears in the string, so this is just the URL each service
// actually expects, not a departure from the function form above.
export const TILE_URL_TEMPLATES = {
  street: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  aerial: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  topo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
};

export const ITM_WKID = 2039;
export const WGS84_WKID = 4326;
const MERCATOR_R = 6378137.0;
const TILE_PX = 256;
const MAX_ZOOM = 19;
const MAX_TILES = 64;

function fetchGeoJson(url, opts) {
  return fetch(url, opts).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

/** Points (list of [x,y]) -> the same points in outSR, via iplan's own
 * GeometryServer - a generic coordinate-transform service, not iplan-
 * specific data, so reusing it for GovMap layers (area-cleanup.js) is
 * legitimate, not a layering violation. Beats letting a WFS/MapServer's own
 * bboxSR reproject a WGS84 bbox itself - that shortcut measurably does NOT
 * centre an address (a ~40-70m offset, verified directly against this same
 * Geometry service when this was first built for blue-lines.js). */
export async function projectPoints(points, inSR, outSR) {
  const body = new URLSearchParams({
    geometries: JSON.stringify({
      geometryType: 'esriGeometryPoint',
      geometries: points.map(([x, y]) => ({ x, y })),
    }),
    inSR: String(inSR),
    outSR: String(outSR),
    f: 'json',
  });
  const result = await fetchGeoJson(`${GEOMETRY}/project`, { method: 'POST', body });
  if (!result.geometries) throw new Error(`בקשת ה-project נכשלה: ${JSON.stringify(result)}`);
  return result.geometries.map((p) => [p.x, p.y]);
}

export const bboxAround = (x, y, radius) => [x - radius, y - radius, x + radius, y + radius];

/** ITM point -> pixel coords for a size x size image covering `bbox` exactly. */
export function itmToPx([xmin, ymin, xmax, ymax], size, x, y) {
  return [(x - xmin) / (xmax - xmin) * size, (ymax - y) / (ymax - ymin) * size];
}

function lonLatToMercator(lon, lat) {
  const mx = (lon * Math.PI) / 180 * MERCATOR_R;
  const my = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * MERCATOR_R;
  return [mx, my];
}

function mercatorToPixel(mx, my, zoom) {
  const worldPx = TILE_PX * 2 ** zoom;
  const px = (mx + Math.PI * MERCATOR_R) / (2 * Math.PI * MERCATOR_R) * worldPx;
  const py = (Math.PI * MERCATOR_R - my) / (2 * Math.PI * MERCATOR_R) * worldPx;
  return [px, py];
}

const TILE_URL_BY_KIND = { aerial: AERIAL_TILE, topo: TOPO_TILE };
async function fetchTileBitmap(z, x, y, kind) {
  const tileUrl = TILE_URL_BY_KIND[kind] || OSM_TILE;
  const res = await fetch(tileUrl(z, x, y));
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** A basemap canvas (size x size), stitched from OSM (or, with kind:
 * 'aerial'/'topo', Esri World Imagery/World Topo Map) tiles and aligned to
 * `bbox` (ITM). */
export async function fetchBasemapCanvas(bbox, size, kind = 'street') {
  const [xmin, ymin, xmax, ymax] = bbox;
  const cornersItm = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
  const cornersWgs84 = await projectPoints(cornersItm, ITM_WKID, WGS84_WKID);
  return (await stitchBasemap(cornersWgs84, size, kind)).canvas;
}

/** Same basemap, for a WGS84 (lon/lat) bbox directly - no iplan Geometry
 * round-trip, since GPS fixes and OSM data are already WGS84 native (unlike
 * blue-lines.js/area-cleanup.js's ITM-native Xplan/GovMap layers above). Also
 * returns `project`, a closure over this same fetch's zoom/tile origin, so a
 * caller can place further points (a live route, not just a static centre
 * pin) on the same canvas without re-deriving the transform. `kind` picks
 * the tile source: 'street' (default, OSM), 'aerial' (Esri World Imagery)
 * or 'topo' (Esri World Topo Map) - all three share the same slippy-tile
 * grid, so the projector math below is identical regardless. */
export async function fetchBasemapCanvasWGS84([lonMin, latMin, lonMax, latMax], size, kind = 'street') {
  const cornersWgs84 = [[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax]];
  return stitchBasemap(cornersWgs84, size, kind);
}

/** Shared tail of both basemap fetchers above: WGS84 corners -> a stitched
 * OSM/aerial canvas plus a lon/lat -> pixel projector for that same canvas. */
async function stitchBasemap(cornersWgs84, size, kind = 'street') {
  const cornersMerc = cornersWgs84.map(([lon, lat]) => lonLatToMercator(lon, lat));

  const mxs = cornersMerc.map((c) => c[0]);
  const mercWidth = Math.max(...mxs) - Math.min(...mxs);
  let zoom = Math.round(Math.log2((2 * Math.PI * MERCATOR_R) / (TILE_PX * mercWidth / size)));
  zoom = Math.max(0, Math.min(MAX_ZOOM, zoom));

  const pxPts = cornersMerc.map(([mx, my]) => mercatorToPixel(mx, my, zoom));
  const pxMin = Math.min(...pxPts.map((p) => p[0]));
  const pxMax = Math.max(...pxPts.map((p) => p[0]));
  const pyMin = Math.min(...pxPts.map((p) => p[1]));
  const pyMax = Math.max(...pxPts.map((p) => p[1]));

  const txMin = Math.floor(pxMin / TILE_PX);
  const txMax = Math.floor(pxMax / TILE_PX);
  const tyMin = Math.floor(pyMin / TILE_PX);
  const tyMax = Math.floor(pyMax / TILE_PX);
  const tiles = [];
  for (let tx = txMin; tx <= txMax; tx += 1) {
    for (let ty = tyMin; ty <= tyMax; ty += 1) tiles.push([tx, ty]);
  }
  if (tiles.length > MAX_TILES) throw new Error(`רדיוס גדול מדי לבסיס מפה (${tiles.length} אריחים)`);

  const canvas = document.createElement('canvas');
  canvas.width = (txMax - txMin + 1) * TILE_PX;
  canvas.height = (tyMax - tyMin + 1) * TILE_PX;
  const ctx = canvas.getContext('2d');

  // OSM's tile usage policy: no more than 2 simultaneous connections. Kept
  // for the aerial source too, rather than a separate/looser limit - simplest
  // to stay polite by default even though Esri's own limit is more lenient.
  const queue = tiles.slice();
  // Esri's World Topo Map ships noticeably paler/lower-contrast than the
  // street or aerial sources (a deliberate style choice on their end for a
  // reference basemap meant to sit under other data layers) - boosted here,
  // scoped to the tile draws only (reset before the attribution label below
  // so the label itself isn't affected), rather than a page-wide CSS filter
  // that would also alter street/aerial, which nobody asked to change.
  if (kind === 'topo') ctx.filter = 'contrast(1.35) saturate(1.15)';
  async function worker() {
    let next;
    // eslint-disable-next-line no-cond-assign
    while ((next = queue.shift())) {
      const [tx, ty] = next;
      const bmp = await fetchTileBitmap(zoom, tx, ty, kind);
      ctx.drawImage(bmp, (tx - txMin) * TILE_PX, (ty - tyMin) * TILE_PX);
    }
  }
  await Promise.all([worker(), worker()]);
  ctx.filter = 'none';

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const octx = out.getContext('2d');
  octx.drawImage(
    canvas,
    pxMin - txMin * TILE_PX, pyMin - tyMin * TILE_PX, pxMax - pxMin, pyMax - pyMin,
    0, 0, size, size,
  );
  octx.font = '11px sans-serif';
  const label = TILE_ATTRIBUTION[kind] || TILE_ATTRIBUTION.street;
  const tw = octx.measureText(label).width;
  octx.fillStyle = 'rgba(255,255,255,0.75)';
  octx.fillRect(0, size - 16, tw + 8, 16);
  octx.fillStyle = '#000';
  octx.fillText(label, 4, size - 4);

  const project = (lon, lat) => {
    const [px, py] = mercatorToPixel(...lonLatToMercator(lon, lat), zoom);
    return [(px - pxMin) / (pxMax - pxMin) * size, (py - pyMin) / (pyMax - pyMin) * size];
  };
  return { canvas: out, project };
}

/** A map-pin marker at the image centre - the requested address/location, by
 * construction: bbox is built symmetrically around it (bboxAround), so it
 * always lands at (size/2, size/2) regardless of radius. Drawn onto the
 * canvas itself (not as a DOM overlay) so it survives a copy/export of the
 * canvas too, not just the on-page view. */
export function drawAddressPin(ctx, size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = 9;
  const tipY = cy + 6; // point of the pin sits slightly below the circle,
  // marking the exact address point rather than the circle's own centre.

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.85, cy - r * 0.4);
  ctx.arc(cx, cy - r * 0.4, r, Math.PI, 0, false);
  ctx.lineTo(cx + r * 0.85, cy - r * 0.4);
  ctx.lineTo(cx, tipY);
  ctx.closePath();
  ctx.fillStyle = '#e0301e';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.4, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}
