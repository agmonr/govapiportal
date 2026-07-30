/**
 * Trip map: a canvas basemap (via geo-utils.js's WGS84 tile stitcher, same
 * no-CDN approach as every other map on this site), fit to the WHOLE route
 * driven so far - not a small window following the current position. The
 * fetched area only grows (never shrinks) as the trip covers more ground,
 * refetched (zooming out as needed) only once the route actually outgrows
 * what's currently on screen - not on every GPS update - to stay well
 * inside OSM's tile usage policy (already the reason geo-utils.js caps
 * concurrent tile fetches at 2).
 *
 * Also exports renderStaticRouteCanvas(), a one-shot version of the same
 * fit-to-route+colored-route+event-markers rendering used for the PDF
 * export (buildTripPdfBlob in trip-report.js) - a fresh fetch/draw
 * independent of whatever the live #trCanvas currently shows, so the PDF
 * always gets the full route (including for a past trip reopened from
 * history, which has no live canvas state of its own at all).
 */

import { fetchBasemapCanvasWGS84 } from './geo-utils.js';
import { SPEED_BANDS } from './trip-score.js';

export const MAP_SIZE = 640;
const MAP_PADDING_RATIO = 0.15; // extra margin around the route's own bbox, so it isn't flush against the edges
const MIN_HALF_SPAN_M = 150; // floor for a just-started trip (1-2 points) - keeps it from zooming in absurdly tight
const RECENTER_TRIGGER_RATIO = 0.9; // refetch once the route fills this fraction of what's currently covered

function metersPerDegree(lat) {
  const dLat = 111320;
  const dLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return { dLat, dLon };
}

/** bbox-center (not a mean of all points, which would skew toward a
 * densely-sampled segment) of every point in the trip so far. */
function routeCenter(points) {
  let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/** Half-width (meters) of the smallest centered square that contains every
 * point, plus MAP_PADDING_RATIO margin - the basemap is always fetched
 * square (matching the square MAP_SIZE canvas), so both axes use whichever
 * needs the larger span. */
function routeHalfSpanMeters(points, center) {
  const { dLat, dLon } = metersPerDegree(center.lat);
  let maxM = MIN_HALF_SPAN_M;
  for (const p of points) {
    maxM = Math.max(maxM, Math.abs((p.lon - center.lon) * dLon), Math.abs((p.lat - center.lat) * dLat));
  }
  return maxM * (1 + MAP_PADDING_RATIO);
}

/** True if every point still falls within the square of half-width
 * `halfSpanM` around `center` - i.e. the currently-fetched basemap still
 * covers the whole route, so no refetch is needed yet. */
function stillContained(points, center, halfSpanM) {
  if (!center) return false;
  const { dLat, dLon } = metersPerDegree(center.lat);
  return points.every((p) => Math.abs((p.lon - center.lon) * dLon) <= halfSpanM
    && Math.abs((p.lat - center.lat) * dLat) <= halfSpanM);
}

function bandColor(ratio) {
  return (SPEED_BANDS.find((b) => ratio <= b.max) || SPEED_BANDS[SPEED_BANDS.length - 1]).color;
}

const EVENT_STYLE = {
  brake: { color: '#8800FF', label: 'בלימה חדה' },
  accel: { color: '#00FFFF', label: 'האצה חדה' },
  violation: { color: '#FF0000', label: 'חריגת מהירות' },
  sensitivity: { color: '#FFA500', label: 'שינוי רגישות' },
};

/** Draws the colored route (speed-vs-limit band per segment) and event
 * markers onto `ctx`'s canvas, using `project` (from fetchBasemapCanvasWGS84)
 * to place them - shared by the live map's own redraw() and the one-shot
 * renderStaticRouteCanvas() below, so both draw identically. `current`
 * (the live position dot) is optional - the static PDF render never passes
 * one, since a finished/historical trip has no "current position". */
function drawRoute(ctx, project, points, events, current) {
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const [x0, y0] = project(prev.lon, prev.lat);
    const [x1, y1] = project(cur.lon, cur.lat);
    ctx.strokeStyle = cur.limitKmh ? bandColor(cur.speedKmh / cur.limitKmh) : '#888888';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  events.forEach((ev) => {
    const style = EVENT_STYLE[ev.type];
    if (!style || ev.lat == null) return;
    const [x, y] = project(ev.lon, ev.lat);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = style.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });

  if (current) {
    const [x, y] = project(current.lon, current.lat);
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#1a73e8';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();
  }
}

/** One-shot fetch+draw for the PDF export - always a fresh basemap fit to
 * `points`' full extent, independent of any live map's own state (so a
 * re-exported trip from history, which never had a live map running this
 * session, still gets a real map page). Returns null if there are no
 * points at all (nothing to show) or the fetch fails. */
export async function renderStaticRouteCanvas(points, events) {
  if (!points.length) return null;
  const center = routeCenter(points);
  const halfSpanM = routeHalfSpanMeters(points, center);
  const { dLat, dLon } = metersPerDegree(center.lat);
  const bbox = [
    center.lon - halfSpanM / dLon, center.lat - halfSpanM / dLat,
    center.lon + halfSpanM / dLon, center.lat + halfSpanM / dLat,
  ];
  let basemap;
  try {
    basemap = await fetchBasemapCanvasWGS84(bbox, MAP_SIZE);
  } catch (err) {
    console.warn('trip-map: static route basemap fetch failed', err);
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(basemap.canvas, 0, 0);
  drawRoute(ctx, basemap.project, points, events);
  return canvas;
}

export function createTripMap(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;

  let center = null; // {lat, lon} of the currently-fetched basemap
  let coveredHalfSpanM = 0; // half-width (meters) that basemap actually covers
  let basemap = null; // {canvas, project}
  let autoPan = true;
  let loading = false;

  async function recenter(lat, lon, halfSpanM) {
    if (loading) return; // a slow tile fetch already in flight; the next update() will retry
    loading = true;
    try {
      const { dLat, dLon } = metersPerDegree(lat);
      const bbox = [lon - halfSpanM / dLon, lat - halfSpanM / dLat, lon + halfSpanM / dLon, lat + halfSpanM / dLat];
      basemap = await fetchBasemapCanvasWGS84(bbox, MAP_SIZE);
      center = { lat, lon };
      coveredHalfSpanM = halfSpanM;
    } catch (err) {
      console.warn('trip-map: basemap fetch failed', err);
    } finally {
      loading = false;
    }
  }

  function redraw(points, events, current) {
    if (!basemap) return;
    ctx.drawImage(basemap.canvas, 0, 0);
    drawRoute(ctx, basemap.project, points, events, current);
  }

  /**
   * @param points [{lat, lon, speedKmh, limitKmh}] full trip so far
   * @param events same shape as trip-score.js's event log, each carrying its
   *   own lat/lon
   * @param current {lat, lon} the live position, drawn as the blue dot
   */
  async function update(points, events, current) {
    if (autoPan && points.length && !stillContained(points, center, coveredHalfSpanM * RECENTER_TRIGGER_RATIO)) {
      const newCenter = routeCenter(points);
      await recenter(newCenter.lat, newCenter.lon, routeHalfSpanMeters(points, newCenter));
    }
    redraw(points, events, current);
  }

  return {
    update,
    recenter: (lat, lon) => recenter(lat, lon, Math.max(coveredHalfSpanM, MIN_HALF_SPAN_M)),
    setAutoPan: (value) => { autoPan = value; },
    getAutoPan: () => autoPan,
  };
}
