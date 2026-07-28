/**
 * Live trip map: a canvas basemap (via geo-utils.js's WGS84 tile stitcher,
 * same no-CDN approach as every other map on this site) that recenters as
 * the vehicle moves, with the trip's route redrawn on top of it after every
 * fix. Recentering refetches OSM tiles, so it only happens when the current
 * position actually nears the edge of what's on screen - not on every GPS
 * update - to stay well inside OSM's tile usage policy (already the reason
 * geo-utils.js caps concurrent tile fetches at 2).
 *
 * Unlike blue-lines.html/area-cleanup.html (one static pin, one fetch, done),
 * this basemap is refetched repeatedly through a trip, so recenter() always
 * replaces the previous cached canvas+projector rather than composing with
 * it - there is never more than one live basemap in memory at a time.
 */

import { fetchBasemapCanvasWGS84 } from './geo-utils.js';
import { SPEED_BANDS } from './trip-score.js';

export const MAP_SIZE = 640;
const RECENTER_RADIUS_M = 450; // half-width of the fetched bbox
const RECENTER_TRIGGER_RATIO = 0.7; // recenter once the fix passes 70% of the way to the edge

function metersPerDegree(lat) {
  const dLat = 111320;
  const dLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return { dLat, dLon };
}

export function createTripMap(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;

  let center = null; // {lat, lon}
  let basemap = null; // {canvas, project}
  let autoPan = true;
  let loading = false;

  async function recenter(lat, lon) {
    if (loading) return; // a slow tile fetch already in flight; the next redraw() will retry
    loading = true;
    try {
      const { dLat, dLon } = metersPerDegree(lat);
      const bbox = [
        lon - RECENTER_RADIUS_M / dLon, lat - RECENTER_RADIUS_M / dLat,
        lon + RECENTER_RADIUS_M / dLon, lat + RECENTER_RADIUS_M / dLat,
      ];
      basemap = await fetchBasemapCanvasWGS84(bbox, MAP_SIZE);
      center = { lat, lon };
    } catch (err) {
      console.warn('trip-map: basemap fetch failed', err);
    } finally {
      loading = false;
    }
  }

  function needsRecenter(lat, lon) {
    if (!center) return true;
    const { dLat, dLon } = metersPerDegree(lat);
    const dxM = (lon - center.lon) * dLon;
    const dyM = (lat - center.lat) * dLat;
    const distM = Math.hypot(dxM, dyM);
    return distM > RECENTER_RADIUS_M * RECENTER_TRIGGER_RATIO;
  }

  function bandColor(ratio) {
    return (SPEED_BANDS.find((b) => ratio <= b.max) || SPEED_BANDS[SPEED_BANDS.length - 1]).color;
  }

  const EVENT_STYLE = {
    brake: { color: '#8800FF', label: 'בלימה חדה' },
    accel: { color: '#00FFFF', label: 'האצה חדה' },
    violation: { color: '#FF0000', label: 'חריגת מהירות' },
  };

  /**
   * @param points [{lat, lon, speedKmh, limitKmh}] full trip so far - points
   *   that fall outside the current basemap simply render off-canvas
   *   (canvas draws those segments partially or not at all, same as any
   *   slippy map showing only what's currently in view).
   * @param events same shape as trip-score.js's event log, each carrying its
   *   own lat/lon
   * @param current {lat, lon} the live position, drawn as the blue dot
   */
  function redraw(points, events, current) {
    if (!basemap) return;
    ctx.drawImage(basemap.canvas, 0, 0);

    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      const [x0, y0] = basemap.project(prev.lon, prev.lat);
      const [x1, y1] = basemap.project(cur.lon, cur.lat);
      ctx.strokeStyle = cur.limitKmh ? bandColor(cur.speedKmh / cur.limitKmh) : '#888888';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    events.forEach((ev) => {
      const style = EVENT_STYLE[ev.type];
      if (!style || ev.lat == null) return;
      const [x, y] = basemap.project(ev.lon, ev.lat);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = style.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    });

    if (current) {
      const [x, y] = basemap.project(current.lon, current.lat);
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#1a73e8';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Called on every new fix. Recenters first (awaited) when needed and
   * auto-pan is on, then always redraws - so a frozen (auto-pan off) map
   * still reflects new route/event data on the basemap it already has. */
  async function update(points, events, current) {
    if (autoPan && current && needsRecenter(current.lat, current.lon)) {
      await recenter(current.lat, current.lon);
    }
    redraw(points, events, current);
  }

  return {
    update,
    recenter,
    setAutoPan: (value) => { autoPan = value; },
    getAutoPan: () => autoPan,
  };
}
