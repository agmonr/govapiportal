/**
 * קווים כחולים - address in, live-linked plans PDF out.
 *
 * Browser port of tools/iplan_snapshot.py's pipeline (see that file's own
 * docstring for the full reasoning behind each step - summarised here):
 *
 *   1. Locate the centre point - either geocode an address (OSM Nominatim),
 *      or look up a plan by its exact number (fetchPlanCenter) and use its
 *      own extent, sized to fit it.
 *   2. Project WGS84 -> the Xplan MapServer's native ITM (EPSG:2039) via
 *      iplan's own Utilities/Geometry service, rather than letting /export
 *      reproject a WGS84 bbox itself - that shortcut measurably does NOT
 *      centre the address (a ~40-70m offset, verified against this same
 *      Geometry service). Build the bbox directly in ITM metres.
 *   3. Export layer 1 (קווים כחולים, plan boundaries) and, if opted in via
 *      checkbox, layer 0 (ישויות נקודתיות, point entities) and layer 4
 *      (יעודי קרקע, land use - off by default, matching the real site's own
 *      layer panel and confirmed live via its network traffic: it never
 *      fetches this layer until a user opts in). When land use is shown, two
 *      catch-all/regional codes are still excluded (see
 *      EXCLUDE_LANDUSE_CODES) so it isn't buried under one giant background
 *      hatch even then, and it's drawn at reduced opacity
 *      (LAND_USE_OPACITY) - even a single legitimate polygon can span
 *      several km2 (a heritage conservation zone, say) and at full strength
 *      reads as foreground noise over the basemap/boundaries.
 *   4. Stitch a real basemap (buildings/streets) from OSM's standard raster
 *      tiles - iplan's MapServer has none of its own - aligned by projecting
 *      the bbox's own corners ITM->WGS84 through the same trusted Geometry
 *      service, then to Web Mercator with the exact formula OSM tiles use.
 *   5. Check whether the centre point falls inside a metro station's core/first-
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
import { buildPdf, downloadBlob, safeFilename } from './pdf.js';
import { ITM_WKID, WGS84_WKID, projectPoints, bboxAround, itmToPx, fetchBasemapCanvas, drawAddressPin } from './geo-utils.js';
import { renderAppContext, loadAppsData } from './apps.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAPSERVER = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer';
// תמ"א 70 (Metro master plan) - see METRO_ZONE_CODES below.
const METRO_MAPSERVER = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/tma_70/MapServer';

const DEFAULT_RADIUS = 300;
const IMAGE_SIZE = 800;
const LAND_USE_OPACITY = 0.3;

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

const state = { bbox: null, planLinks: [], label: '' };

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

/** Looks up a plan by its exact pl_number (layer 1) and returns its centre
 * (ITM), a display name, and a radius sized to fit the plan's own extent -
 * so "search by plan" lands on the plan itself rather than an arbitrary
 * default-radius box that might not even overlap it. Two lightweight
 * queries (attributes, extent) rather than one fetch of the full geometry -
 * a plan's boundary can run to thousands of vertices (see
 * tools/iplan_snapshot.py's build_pdf() docstring) and none of them are
 * needed just to centre and size the view. */
async function fetchPlanCenter(planNumber) {
  const where = `pl_number='${planNumber.replace(/'/g, "''")}'`;
  const [attrs, extentResult] = await Promise.all([
    fetchJson(`${MAPSERVER}/1/query?${new URLSearchParams({
      where, outFields: 'pl_number,pl_name', returnGeometry: 'false', f: 'json',
    })}`),
    fetchJson(`${MAPSERVER}/1/query?${new URLSearchParams({
      where, returnGeometry: 'false', returnExtentOnly: 'true', f: 'json',
    })}`),
  ]);
  const feat = attrs.features && attrs.features[0];
  const extent = extentResult.extent;
  if (!feat || !extent) throw new Error(`לא נמצאה תכנית "${planNumber}"`);

  const { xmin, ymin, xmax, ymax } = extent;
  const x = (xmin + xmax) / 2;
  const y = (ymin + ymax) / 2;
  // Half the plan's longer side, padded 30% for margin around it, clamped
  // to the radius field's own min/max (100-3000) so neither a tiny plan nor
  // a whole-district one produces a degenerate or absurd request.
  const half = Math.max(xmax - xmin, ymax - ymin) / 2;
  const radius = Math.min(3000, Math.max(100, Math.round(half * 1.3)));

  return { x, y, radius, displayName: `${feat.attributes.pl_name || planNumber} (${feat.attributes.pl_number})` };
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

function canvasToJpeg(canvas, quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality));
}

/** Puts the current search in the URL (?address=...&radius=...&labels=1, or
 * ?mode=plan&plan=...) via replaceState - no new history entry per search,
 * but the address bar is a link someone can copy, bookmark or send, and
 * reloading it re-runs the same search (see start()). radius/labels are
 * only added when they differ from the default, so a plain address search
 * keeps a plain, short URL. */
function syncUrl(query, radius, showLabels, showLandUse, showPoints, showMetroZone) {
  const params = new URLSearchParams();
  if (query.mode === 'plan') {
    params.set('mode', 'plan');
    params.set('plan', query.value);
  } else {
    params.set('address', query.value);
  }
  if (radius !== DEFAULT_RADIUS) params.set('radius', String(radius));
  if (showLabels) params.set('labels', '1');
  if (showLandUse) params.set('landUse', '1');
  if (!showPoints) params.set('points', '0');
  if (!showMetroZone) params.set('metroZone', '0');
  history.replaceState(null, '', `?${params}`);
}

/** @param {{mode: 'address'|'plan', value: string}} query */
async function run(query, radius, showLabels, showLandUse, showPoints, showMetroZone) {
  const status = el('blStatus');
  const resultBox = el('blResult');
  resultBox.hidden = true;
  el('blMetro').hidden = true;

  let x;
  let y;
  let displayName;
  if (query.mode === 'plan') {
    showLoading(status, `מאתר תכנית: ${query.value}…`);
    const found = await fetchPlanCenter(query.value);
    ({ x, y, displayName } = found);
    radius = found.radius; // sized to the plan's own extent - see fetchPlanCenter
    el('blRadius').value = String(radius); // reflect it in the form, not just silently used
    showLoading(status, `נמצאה: ${displayName} — מטיל מפה...`);
  } else {
    showLoading(status, `מאתר כתובת: ${query.value}…`);
    const geo = await geocode(query.value);
    displayName = geo.displayName;
    showLoading(status, `נמצא: ${displayName} — מטיל מפה...`);
    [[x, y]] = await projectPoints([[geo.lon, geo.lat]], WGS84_WKID, ITM_WKID);
  }

  syncUrl(query, radius, showLabels, showLandUse, showPoints, showMetroZone);
  const bbox = bboxAround(x, y, radius);

  showLoading(status, 'שולף שכבות תכנוניות ובסיס מפה...');
  const [landUse, planBoundaries, points, basemap, metro, planLinks, metroZoneRings] = await Promise.all([
    // Off by default - checked directly against the real site
    // (ags.iplan.gov.il/xplan): its own layer panel ships with יעודי קרקע
    // unchecked, and confirmed live (network trace, not guessed) that it
    // never fetches this layer at all until a user opts in. Matched here
    // rather than the earlier approach of always showing it dimmed - the
    // real site doesn't dim it either, it just doesn't default to showing
    // it, because even with the truly-meaningless 995/996 catch-alls
    // excluded, land use still includes large area-wide designations (e.g.
    // a heritage conservation zone spanning several km2) that read as
    // foreground noise over the basemap unless someone actually asked for
    // land use specifically.
    showLandUse ? fetchXplanImage(bbox, IMAGE_SIZE, [4], showLabels) : Promise.resolve(null),
    fetchXplanImage(bbox, IMAGE_SIZE, [1], showLabels),
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
  if (landUse) {
    // Shown at reduced opacity when opted in - the real site renders it at
    // full strength, but even a single land-use polygon can span several
    // km2 (a heritage conservation zone, say), and at full strength that
    // reads as foreground noise burying the basemap/boundaries under it.
    ctx.globalAlpha = LAND_USE_OPACITY;
    ctx.drawImage(landUse, 0, 0);
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(planBoundaries, 0, 0);
  if (showMetroZone) drawMetroZones(ctx, bbox, IMAGE_SIZE, metroZoneRings);
  if (points) ctx.drawImage(points, 0, 0);
  drawAddressPin(ctx, IMAGE_SIZE);

  state.bbox = bbox;
  state.planLinks = planLinks;
  state.label = displayName;

  const subject = query.mode === 'plan' ? 'התכנית' : 'הכתובת';
  const metroBox = el('blMetro');
  metroBox.hidden = false;
  if (metro.inZone) {
    metroBox.className = 'notice error';
    // A ready-made search query, not a bare "תמ"א 70" link - names the
    // actual address/plan so the results (and Google's AI tab, which reads
    // the query itself) address this specific location, not the plan in
    // the abstract.
    const aiQuery = `הסבר בקצרה על תמ"א 70, הסבר את ההשפעות על ${displayName}. `
      + 'הסבר על ההשפעות הכלכליות הצפויות בכתובת. '
      + 'הסבר בקצרה כיצד תמ"א 70 גוברת על תוכנית המתאר המאושרת באזור';
    const aiUrl = `https://www.google.com/search?q=${encodeURIComponent(aiQuery)}`;
    metroBox.innerHTML = `<strong>${esc(subject)} בתחום ההשפעה של תחנת מטרו</strong>
      (${esc(metro.zones.join(', '))}) — לפי חוק המטרו, בעלי נכסים באזור זה
      עשויים לחוב בהיטל השבחה מוגבר ("מס מטרו").
      <p class="acc-hint">
        <a href="${esc(aiUrl)}" target="_blank" rel="noopener">הסבר על תמ"א 70 ועל ההשפעה כאן ↗</a>
        — בתוצאות החיפוש של Google, לחצו על הלשונית <strong>AI</strong> לקבלת סיכום.
      </p>`;
  } else {
    metroBox.className = 'notice info';
    metroBox.textContent = `${subject} מחוץ לתחום ההשפעה הידוע של תחנות מטרו (תמ״א 70).`;
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
    downloadBlob(pdfBlob, `${safeFilename(state.label, 'blue-lines')}.pdf`);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

/** Which of the two search-mode inputs is currently selected/relevant. */
function currentQuery() {
  const mode = el('blModePlan').checked ? 'plan' : 'address';
  const value = (mode === 'plan' ? el('blPlanNumber') : el('blAddress')).value.trim();
  return { mode, value };
}

function updateSearchModeFields() {
  const isPlan = el('blModePlan').checked;
  // Both fields sit in the same row now (desktop - see #blSearchRow in
  // style.css); the inactive one is disabled rather than removed, so
  // switching modes doesn't reflow the row. On mobile, style.css hides
  // whichever input is disabled instead, since there's no room to show a
  // field nobody can type into.
  el('blAddress').disabled = isPlan;
  el('blPlanNumber').disabled = !isPlan;
}

function submitForm() {
  const query = currentQuery();
  if (!query.value) return;
  const radius = Number(el('blRadius').value) || DEFAULT_RADIUS;
  const showLabels = el('blShowLabels').checked;
  const showLandUse = el('blShowLandUse').checked;
  const showPoints = el('blShowPoints').checked;
  const showMetroZone = el('blShowMetroZone').checked;
  run(query, radius, showLabels, showLandUse, showPoints, showMetroZone)
    .catch((err) => showError(el('blStatus'), err));
}

function start() {
  initThemePicker(el('themePick'));
  loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'blue-lines')).catch(() => {});
  el('created').textContent = document.lastModified;

  // A linked search (?address=...&radius=...&labels=1&landUse=1&points=0&metroZone=0,
  // or ?mode=plan&plan=...) prefills the form and runs immediately, so the
  // URL someone shares is the result they saw, not just an empty form - same
  // shape as syncUrl() writes on every search.
  const urlIsPlan = param('mode') === 'plan';
  const urlAddress = param('address');
  const urlPlan = param('plan');
  el('blModePlan').checked = urlIsPlan;
  el('blModeAddress').checked = !urlIsPlan;
  el('blAddress').value = urlAddress || '';
  el('blPlanNumber').value = urlPlan || '';
  updateSearchModeFields();
  el('blRadius').value = param('radius') || String(DEFAULT_RADIUS);
  el('blShowLabels').checked = param('labels') === '1';
  el('blShowLandUse').checked = param('landUse') === '1';
  el('blShowPoints').checked = param('points') !== '0';
  el('blShowMetroZone').checked = param('metroZone') !== '0';

  const form = el('blForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm();
  });

  [el('blModeAddress'), el('blModePlan')].forEach((radio) => {
    radio.addEventListener('change', updateSearchModeFields);
  });

  // Re-runs the search immediately on a checkbox flip, rather than making
  // someone toggle it and then separately press "הצג מפה" again - only once
  // there's already something to search for, so this does nothing on first
  // load before any search has run.
  ['blShowLabels', 'blShowLandUse', 'blShowPoints', 'blShowMetroZone'].forEach((id) => {
    el(id).addEventListener('change', () => {
      if (currentQuery().value) submitForm();
    });
  });

  el('blDownload').addEventListener('click', () => {
    downloadPdf().catch((err) => showError(el('blStatus'), err));
  });

  if (urlIsPlan ? urlPlan : urlAddress) submitForm();
}

start();
