/**
 * קווים כחולים - address in, live-linked plans PDF out.
 *
 * Browser port of tools/iplan_snapshot.py's pipeline (see that file's own
 * docstring for the full reasoning behind each step - summarised here):
 *
 *   1. Geocode the address (OSM Nominatim).
 *   2. Project WGS84 -> the Xplan MapServer's native ITM (EPSG:2039) via
 *      iplan's own Utilities/Geometry service, rather than letting /export
 *      reproject a WGS84 bbox itself - that shortcut measurably does NOT
 *      centre the address (a ~40-70m offset, verified against this same
 *      Geometry service). Build the bbox directly in ITM metres.
 *   3. Export layers 1 (קווים כחולים, plan boundaries), 4 (יעודי קרקע, land
 *      use) and 0 (ישויות נקודתיות, point entities) - the three checked by
 *      default in iplan's own layer panel. Two catch-all/regional land-use
 *      codes are excluded (see EXCLUDE_LANDUSE_CODES) so the image isn't
 *      buried under one giant background hatch.
 *   4. Stitch a real basemap (buildings/streets) from OSM's standard raster
 *      tiles - iplan's MapServer has none of its own - aligned by projecting
 *      the bbox's own corners ITM->WGS84 through the same trusted Geometry
 *      service, then to Web Mercator with the exact formula OSM tiles use.
 *   5. Check whether the address falls inside a metro station's core/first-
 *      ring influence zone (תמ"א 70, layer 4, MAVAT_CODE 6011/6012) - the
 *      area subject to the increased betterment levy ("מס מטרו") under the
 *      Metro Law. See METRO_ZONE_CODES below for how this was found and
 *      verified. Optionally drawn on the map too (fetchMetroZoneShapes).
 *   6. Build a one-page PDF (src/pdf.js - hand-rolled, no library) with a
 *      clickable Link annotation over every visible plan, pointing at its
 *      real page on mavat.iplan.gov.il (pl_url) - same fix as the Python
 *      tool's build_pdf(): each ring is traced as a sequence of small rects,
 *      not one bbox per plan, or an elongated/whole-district plan's box
 *      would swallow most of the page and every overlapping click would
 *      resolve to it.
 *
 * No CDN dependency, matching the rest of this site - OSM tiles and the
 * iplan/GovMap APIs are fetched directly, and the PDF is written by hand.
 */

import { el, esc, param, showError, showLoading } from './ui.js';
import { initThemePicker } from './theme.js';
import { buildPdf } from './pdf.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const GEOMETRY = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/Utilities/Geometry/GeometryServer';
const MAPSERVER = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer';
// תמ"א 70 (Metro master plan) - see METRO_ZONE_CODES below.
const METRO_MAPSERVER = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/tma_70/MapServer';
const OSM_TILE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const ITM_WKID = 2039;
const WGS84_WKID = 4326;
const MERCATOR_R = 6378137.0;
const TILE_PX = 256;
const MAX_ZOOM = 19;
const MAX_TILES = 64;

const DEFAULT_RADIUS = 300;
const IMAGE_SIZE = 800;

// The three layers checked by default in iplan's own layer panel.
const LAYERS = [1, 4, 0];

// יעוד עפ"י תכנית מאושרת אחרת / מגבלות בניה ופיתוח - catch-all/regional
// land-use codes whose polygons can be enormous (one traced back to National
// Master Plan 60, ~29km across), burying the actually-local parcels under a
// full-frame hatch. Same finding as tools/iplan_snapshot.py's
// EXCLUDE_LANDUSE_CODES.
const EXCLUDE_LANDUSE_CODES = [995, 996];

// tma_70 layer 4 (ישויות פוליגונליות), MAVAT_CODE values for the two rings
// that make up a metro station's influence area under the Metro Law
// (רכבת תחתית (מטרו), תשפ"ב-2021): 6012 "מרחב ליבה" (core) and 6011 "תחום
// טבעת ראשונה" (first ring) - together the area subject to the increased
// betterment levy near a station, colloquially "מס מטרו". Found by querying
// every MAVAT_CODE actually present on that layer (312 features total: 105
// core-zone + 103 first-ring + 73 "תחום חיפוש למעבר ציבורי" + 31 "הנחיות
// מיוחדות") and confirmed with a live point-in-polygon test against a known
// core-zone centroid. A third code, 20440 "תחום השפעה", appears in the
// service's legend/renderer but has zero features - not used here.
const METRO_ZONE_CODES = [6011, 6012];

const state = { bbox: null, planLinks: [], address: '' };

function fetchJson(url, opts) {
  return fetch(url, opts).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

async function geocode(address) {
  const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: 1, countrycodes: 'il' });
  const results = await fetchJson(`${NOMINATIM}?${params}`);
  if (!results.length) throw new Error(`לא נמצאה כתובת תואמת ל"${address}"`);
  const r = results[0];
  return { lon: Number(r.lon), lat: Number(r.lat), displayName: r.display_name };
}

/** Points (list of [x,y]) -> the same points in outSR, via iplan's own
 * GeometryServer - see module docstring for why this beats bboxSR on /export. */
async function projectPoints(points, inSR, outSR) {
  const body = new URLSearchParams({
    geometries: JSON.stringify({
      geometryType: 'esriGeometryPoint',
      geometries: points.map(([x, y]) => ({ x, y })),
    }),
    inSR: String(inSR),
    outSR: String(outSR),
    f: 'json',
  });
  const result = await fetchJson(`${GEOMETRY}/project`, { method: 'POST', body });
  if (!result.geometries) throw new Error(`בקשת ה-project נכשלה: ${JSON.stringify(result)}`);
  return result.geometries.map((p) => [p.x, p.y]);
}

const bboxAround = (x, y, radius) => [x - radius, y - radius, x + radius, y + radius];

/** ITM point -> pixel coords for a size x size image covering `bbox` exactly -
 * both the iplan export and the aligned basemap crop are built to that. */
function itmToPx([xmin, ymin, xmax, ymax], size, x, y) {
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

async function fetchTileBitmap(z, x, y) {
  const res = await fetch(OSM_TILE(z, x, y));
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** A basemap canvas (size x size), stitched from OSM tiles and aligned to
 * `bbox` - see module docstring, step 4. */
async function fetchBasemapCanvas(bbox, size) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const cornersItm = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
  const cornersWgs84 = await projectPoints(cornersItm, ITM_WKID, WGS84_WKID);
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

  // OSM's tile usage policy: no more than 2 simultaneous connections.
  const queue = tiles.slice();
  async function worker() {
    let next;
    // eslint-disable-next-line no-cond-assign
    while ((next = queue.shift())) {
      const [tx, ty] = next;
      const bmp = await fetchTileBitmap(zoom, tx, ty);
      ctx.drawImage(bmp, (tx - txMin) * TILE_PX, (ty - tyMin) * TILE_PX);
    }
  }
  await Promise.all([worker(), worker()]);

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
  const label = '© OpenStreetMap contributors';
  const tw = octx.measureText(label).width;
  octx.fillStyle = 'rgba(255,255,255,0.75)';
  octx.fillRect(0, size - 16, tw + 8, 16);
  octx.fillStyle = '#000';
  octx.fillText(label, 4, size - 4);
  return out;
}

/** One iplan Xplan export (whichever `layerIds` are given), transparent, as
 * an ImageBitmap. `showLabels` controls layer 1's own plan-number boxes
 * (e.g. "507-0220277") - off by default: even at a modest radius there can
 * be dozens of plans, and the labels alone cover most of the map, obscuring
 * the actual boundary lines/basemap underneath.
 *
 * Always goes through dynamicLayers, never the top-level layerDefs param,
 * for both label suppression and the land-use exclusion below - found the
 * hard way, twice. ArcGIS quirk: once dynamicLayers is present at all, it
 * takes over deciding both which layers render AND their filtering - a
 * layer left out of it stops appearing even though `layers=show:` still
 * lists it (bug #1: with only layer 1 in dynamicLayers, layer 4 silently
 * dropped when this fetched everything in one call), and the *separate*
 * top-level layerDefs stops being applied to any layer that IS in
 * dynamicLayers (bug #2: layer 4's EXCLUDE_LANDUSE_CODES filter silently
 * stopped applying the moment dynamicLayers existed for any reason - i.e.
 * always, since labels are off by default - so the giant background hatch
 * this project already fixed once, in tools/iplan_snapshot.py, came right
 * back here under a different trigger). Every layer passed in gets its own
 * dynamicLayers entry unconditionally, with definitionExpression/drawingInfo
 * set directly on it rather than split across two parameters that turn out
 * not to compose. */
async function fetchXplanImage(bbox, size, layerIds, showLabels) {
  const dynamicLayers = layerIds.map((id) => {
    const layer = { id, source: { type: 'mapLayer', mapLayerId: id } };
    if (id === 4) layer.definitionExpression = `mavat_code NOT IN (${EXCLUDE_LANDUSE_CODES.join(',')})`;
    if (id === 1) layer.drawingInfo = { showLabels };
    return layer;
  });
  const params = new URLSearchParams({
    bbox: bbox.map((v) => v.toFixed(3)).join(','),
    bboxSR: String(ITM_WKID),
    size: `${size},${size}`,
    layers: `show:${layerIds.join(',')}`,
    dynamicLayers: JSON.stringify(dynamicLayers),
    format: 'png32',
    transparent: 'true',
    f: 'json',
  });
  const result = await fetchJson(`${MAPSERVER}/export?${params}`);
  if (!result.href) throw new Error(`בקשת ה-export נכשלה: ${JSON.stringify(result)}`);
  const res = await fetch(result.href);
  return createImageBitmap(await res.blob());
}

/** Whether (x,y) in ITM falls inside a metro station's core/first-ring
 * influence zone - see METRO_ZONE_CODES above. */
async function checkMetroZone(x, y) {
  const params = new URLSearchParams({
    geometry: `${x},${y}`,
    geometryType: 'esriGeometryPoint',
    inSR: String(ITM_WKID),
    spatialRel: 'esriSpatialRelIntersects',
    where: `MAVAT_CODE IN (${METRO_ZONE_CODES.join(',')})`,
    outFields: 'MAVAT_CODE,MAVAT_NAME',
    returnGeometry: 'false',
    f: 'json',
  });
  const result = await fetchJson(`${METRO_MAPSERVER}/4/query?${params}`);
  const feats = result.features || [];
  return { inZone: feats.length > 0, zones: feats.map((f) => f.attributes.MAVAT_NAME) };
}

/** Core/first-ring metro zone polygons intersecting `bbox` (not just the
 * address point), for drawing the actual zone shape on the map - opt-in via
 * a checkbox, since checkMetroZone() above already answers the yes/no
 * question this app exists to answer without needing the geometry at all. */
async function fetchMetroZoneShapes(bbox) {
  const params = new URLSearchParams({
    where: `MAVAT_CODE IN (${METRO_ZONE_CODES.join(',')})`,
    geometry: bbox.map((v) => v.toFixed(3)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: String(ITM_WKID),
    outFields: 'MAVAT_CODE',
    returnGeometry: 'true',
    geometryPrecision: '1',
    f: 'json',
  });
  const result = await fetchJson(`${METRO_MAPSERVER}/4/query?${params}`);
  return (result.features || []).map((f) => f.geometry?.rings || []).flat();
}

/** Draws metro-zone rings (already ITM) onto the canvas, in the same
 * itmToPx pixel space as everything else composited there. */
function drawMetroZones(ctx, bbox, size, rings) {
  ctx.save();
  ctx.fillStyle = 'rgba(224, 48, 30, 0.16)';
  ctx.strokeStyle = 'rgba(180, 30, 15, 0.9)';
  ctx.lineWidth = 2;
  for (const ring of rings) {
    ctx.beginPath();
    ring.forEach(([x, y], i) => {
      const [px, py] = itmToPx(bbox, size, x, y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Every plan (layer 1) intersecting bbox, with its pl_url - see module
 * docstring step 6 / tools/iplan_snapshot.py's fetch_plan_links(). */
async function fetchPlanLinks(bbox) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: bbox.map((v) => v.toFixed(3)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: String(ITM_WKID),
    outFields: 'pl_number,pl_url',
    returnGeometry: 'true',
    geometryPrecision: '1',
    f: 'json',
  });
  const result = await fetchJson(`${MAPSERVER}/1/query?${params}`);
  return (result.features || [])
    .filter((f) => f.attributes.pl_url && f.geometry?.rings)
    .map((f) => ({ url: f.attributes.pl_url, rings: f.geometry.rings }));
}

/**
 * Traces `points` (already in output pixel space) as a sequence of small
 * rects, each grown until adding the next point would push it past
 * MAX_CHUNK_PX on a side, then restarted from that same point so
 * consecutive chunks touch rather than gap. See tools/iplan_snapshot.py's
 * build_pdf() docstring: one bbox per whole ring (let alone per whole,
 * possibly multi-ring plan) let an elongated or whole-district plan's
 * boundary produce a rect spanning the entire page, so every overlapping
 * click resolved to the same plan. Chunking in output pixels rather than by
 * a fixed vertex count is what actually fixes it - a sparsely-vertexed long
 * boundary stretch (no denser than an ordinary plan's, just covering more
 * ground per vertex) still failed under vertex-count chunking.
 */
const MAX_CHUNK_PX = 200;
function* traceRing(points) {
  if (points.length < 2) return;
  let prev = points[0];
  let [cx0, cy0, cx1, cy1] = [prev[0], prev[1], prev[0], prev[1]];
  let hasChunk = false;
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = points[i];
    const nx0 = Math.min(cx0, x); const ny0 = Math.min(cy0, y);
    const nx1 = Math.max(cx1, x); const ny1 = Math.max(cy1, y);
    if (hasChunk && (nx1 - nx0 > MAX_CHUNK_PX || ny1 - ny0 > MAX_CHUNK_PX)) {
      yield [cx0, cy0, cx1, cy1];
      cx0 = Math.min(prev[0], x); cy0 = Math.min(prev[1], y);
      cx1 = Math.max(prev[0], x); cy1 = Math.max(prev[1], y);
    } else {
      [cx0, cy0, cx1, cy1] = [nx0, ny0, nx1, ny1];
    }
    hasChunk = true;
    prev = [x, y];
  }
  if (hasChunk) yield [cx0, cy0, cx1, cy1];
}

function planLinkRects(planLinks, bbox, size) {
  const rects = [];
  for (const plan of planLinks) {
    for (const ring of plan.rings) {
      const points = ring.map(([x, y]) => itmToPx(bbox, size, x, y));
      for (const [x0, y0, x1, y1] of traceRing(points)) {
        const cx0 = Math.max(x0, 0); const cy0 = Math.max(y0, 0);
        const cx1 = Math.min(x1, size); const cy1 = Math.min(y1, size);
        if (cx1 > cx0 && cy1 > cy0) rects.push({ url: plan.url, x0: cx0, y0: cy0, x1: cx1, y1: cy1 });
      }
    }
  }
  // Larger rects first, smaller/more-precise ones last, so a canvas drawn
  // in this order (and a PDF whose viewer resolves overlapping clicks to
  // the last-added annotation) both favour the fine-grained one.
  rects.sort((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0)) - ((a.x1 - a.x0) * (a.y1 - a.y0)));
  return rects;
}

/** A map-pin marker at the image centre - the requested address, by
 * construction: bbox is built symmetrically around it (bboxAround), so it
 * always lands at (size/2, size/2) regardless of radius. Drawn onto the
 * canvas itself (not as a DOM overlay) so it's baked into the downloaded
 * PDF too, not just the on-page view. */
function drawAddressPin(ctx, size) {
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

function canvasToJpeg(canvas, quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality));
}

function downloadBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

function safeFilename(address) {
  return address.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'blue-lines';
}

/** Puts the current search in the URL (?address=...&radius=...&labels=1) via
 * replaceState - no new history entry per search, but the address bar is a
 * link someone can copy, bookmark or send, and reloading it re-runs the same
 * search (see start()). radius/labels are only added when they differ from
 * the default, so a plain address search keeps a plain, short URL. */
function syncUrl(address, radius, showLabels, showPoints, showMetroZone) {
  const params = new URLSearchParams();
  params.set('address', address);
  if (radius !== DEFAULT_RADIUS) params.set('radius', String(radius));
  if (showLabels) params.set('labels', '1');
  if (!showPoints) params.set('points', '0');
  if (showMetroZone) params.set('metroZone', '1');
  history.replaceState(null, '', `?${params}`);
}

async function run(address, radius, showLabels, showPoints, showMetroZone) {
  syncUrl(address, radius, showLabels, showPoints, showMetroZone);
  const status = el('blStatus');
  const resultBox = el('blResult');
  resultBox.hidden = true;
  el('blMetro').hidden = true;
  showLoading(status, `מאתר כתובת: ${address}…`);

  const { lon, lat, displayName } = await geocode(address);
  showLoading(status, `נמצא: ${displayName} — מטיל מפה...`);

  const [[x, y]] = await projectPoints([[lon, lat]], WGS84_WKID, ITM_WKID);
  const bbox = bboxAround(x, y, radius);

  showLoading(status, 'שולף שכבות תכנוניות ובסיס מפה...');
  const [overlay, points, basemap, metro, planLinks, metroZoneRings] = await Promise.all([
    fetchXplanImage(bbox, IMAGE_SIZE, [1, 4], showLabels),
    // Fetched and drawn separately, always last/topmost - see drawing order
    // below - rather than in the same combined export as layers 1/4, so
    // point markers stay visible above every other overlay (metro zone
    // included), not just above the export's own internal layer order.
    showPoints ? fetchXplanImage(bbox, IMAGE_SIZE, [0], showLabels) : Promise.resolve(null),
    fetchBasemapCanvas(bbox, IMAGE_SIZE),
    checkMetroZone(x, y),
    fetchPlanLinks(bbox),
    showMetroZone ? fetchMetroZoneShapes(bbox) : Promise.resolve([]),
  ]);

  const canvas = el('blCanvas');
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(basemap, 0, 0);
  ctx.drawImage(overlay, 0, 0);
  if (showMetroZone) drawMetroZones(ctx, bbox, IMAGE_SIZE, metroZoneRings);
  if (points) ctx.drawImage(points, 0, 0);
  drawAddressPin(ctx, IMAGE_SIZE);

  state.bbox = bbox;
  state.planLinks = planLinks;
  state.address = address;

  const metroBox = el('blMetro');
  metroBox.hidden = false;
  if (metro.inZone) {
    metroBox.className = 'notice error';
    metroBox.innerHTML = `<strong>הכתובת בתחום ההשפעה של תחנת מטרו</strong>
      (${esc(metro.zones.join(', '))}) — לפי חוק המטרו, בעלי נכסים באזור זה
      עשויים לחוב בהיטל השבחה מוגבר ("מס מטרו").`;
  } else {
    metroBox.className = 'notice info';
    metroBox.textContent = 'הכתובת מחוץ לתחום ההשפעה הידוע של תחנות מטרו (תמ״א 70).';
  }

  el('blPlanCount').textContent = String(planLinks.length);
  el('blDownload').disabled = false;
  status.innerHTML = '';
  resultBox.hidden = false;
}

async function downloadPdf() {
  const btn = el('blDownload');
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'בונה PDF…';
  try {
    const canvas = el('blCanvas');
    const jpegBlob = await canvasToJpeg(canvas);
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const links = planLinkRects(state.planLinks, state.bbox, IMAGE_SIZE);
    const pdfBlob = buildPdf({ jpegBytes, width: IMAGE_SIZE, height: IMAGE_SIZE, links });
    downloadBlob(pdfBlob, `${safeFilename(state.address)}.pdf`);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

function submitForm() {
  const address = el('blAddress').value.trim();
  if (!address) return;
  const radius = Number(el('blRadius').value) || DEFAULT_RADIUS;
  const showLabels = el('blShowLabels').checked;
  const showPoints = el('blShowPoints').checked;
  const showMetroZone = el('blShowMetroZone').checked;
  run(address, radius, showLabels, showPoints, showMetroZone).catch((err) => showError(el('blStatus'), err));
}

function start() {
  initThemePicker(el('themePick'));
  el('created').textContent = document.lastModified;

  // A linked search (?address=...&radius=...&labels=1&points=0&metroZone=1)
  // prefills the form and runs immediately, so the URL someone shares is the
  // result they saw, not just an empty form - same shape as syncUrl() writes
  // on every search.
  const urlAddress = param('address');
  el('blAddress').value = urlAddress || '';
  el('blRadius').value = param('radius') || String(DEFAULT_RADIUS);
  el('blShowLabels').checked = param('labels') === '1';
  el('blShowPoints').checked = param('points') !== '0';
  el('blShowMetroZone').checked = param('metroZone') === '1';

  const form = el('blForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm();
  });

  // Re-runs the search immediately on a checkbox flip, rather than making
  // someone toggle it and then separately press "הצג מפה" again - only once
  // there's already an address to search for, so this does nothing on first
  // load before any search has run.
  ['blShowLabels', 'blShowPoints', 'blShowMetroZone'].forEach((id) => {
    el(id).addEventListener('change', () => {
      if (el('blAddress').value.trim()) submitForm();
    });
  });

  el('blDownload').addEventListener('click', () => {
    downloadPdf().catch((err) => showError(el('blStatus'), err));
  });

  if (urlAddress) submitForm();
}

start();
