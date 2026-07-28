/**
 * Live posted-speed lookup via OSM's Overpass API - the only source in this
 * spec that isn't a straight tag read: Overpass returns every tagged road in
 * an area, not "the speed limit at this exact point", so nearest-segment
 * matching happens here too. That match is a nearest-line heuristic (see
 * nearestWay below), not real map-matching (no heading/topology check) - at
 * highway-interchange scale it can pick the wrong carriageway. Acceptable
 * for a driving-score estimate; not something to cite in a dispute.
 *
 * Caching is per-session only (an in-memory Map, not localStorage) - a trip
 * lasts at most a few hours, and Overpass's fair-use ask is "don't hammer
 * us", not "persist across visits". A ~1.1km grid cell is fetched once and
 * reused for every fix that lands in it for the rest of the trip.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CELL_DEG = 0.01; // roughly 1.1km N-S, ~0.9km E-W at Israel's latitude
const CELL_PADDING_DEG = 0.003; // query slightly past the cell so roads near its edge still match
const CELL_TTL_MS = 24 * 60 * 60 * 1000;

// Used only when a matched road carries no maxspeed tag (common on
// residential streets) - typical Israeli signed limits by road class, not a
// guess pulled from nowhere.
const DEFAULT_KMH_BY_HIGHWAY = {
  motorway: 110,
  trunk: 90,
  primary: 80,
  secondary: 70,
  tertiary: 60,
  unclassified: 50,
  residential: 50,
  living_street: 30,
  service: 30,
};
const VEHICLE_HIGHWAYS = Object.keys(DEFAULT_KMH_BY_HIGHWAY);

const cellCache = new Map(); // "latIdx_lonIdx" -> { ways, fetchedAt }

function cellIndex(lat, lon) {
  return [Math.floor(lat / CELL_DEG), Math.floor(lon / CELL_DEG)];
}

function parseMaxspeed(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*(mph)?/i);
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] ? Math.round(value * 1.60934) : value;
}

async function fetchWaysForCell(latIdx, lonIdx) {
  const south = latIdx * CELL_DEG - CELL_PADDING_DEG;
  const north = (latIdx + 1) * CELL_DEG + CELL_PADDING_DEG;
  const west = lonIdx * CELL_DEG - CELL_PADDING_DEG;
  const east = (lonIdx + 1) * CELL_DEG + CELL_PADDING_DEG;
  const highwayAlt = VEHICLE_HIGHWAYS.join('|');
  const query = `[out:json][timeout:25];way["highway"~"^(${highwayAlt})$"](${south},${west},${north},${east});out geom;`;

  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  return (json.elements || [])
    .filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => ({
      highway: el.tags?.highway,
      maxspeedKmh: parseMaxspeed(el.tags?.maxspeed),
      geometry: el.geometry.map((p) => [p.lat, p.lon]),
    }));
}

/** Ways covering every cell within `radiusCells` of (lat,lon) - the fix
 * itself might sit right at a cell boundary, so nearestWay needs the
 * neighbours too, not just the fix's own cell. */
async function waysNear(lat, lon) {
  const [latIdx, lonIdx] = cellIndex(lat, lon);
  const cells = [];
  for (let di = -1; di <= 1; di += 1) {
    for (let dj = -1; dj <= 1; dj += 1) cells.push([latIdx + di, lonIdx + dj]);
  }
  const ways = [];
  for (const [li, lj] of cells) {
    const key = `${li}_${lj}`;
    let entry = cellCache.get(key);
    if (!entry || Date.now() - entry.fetchedAt > CELL_TTL_MS) {
      try {
        entry = { ways: await fetchWaysForCell(li, lj), fetchedAt: Date.now() };
        cellCache.set(key, entry);
      } catch (err) {
        console.warn('trip-speed-limits: Overpass fetch failed for cell', key, err);
        entry = { ways: [], fetchedAt: Date.now() };
      }
    }
    ways.push(...entry.ways);
  }
  return ways;
}

/** lat/lon -> local flat meters relative to (lat0,lon0), accurate enough at
 * road-segment scale (a few hundred meters) without a full projection. */
function metersXY(lat0, lon0, lat, lon) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  return [(lon - lon0) * cos * 111320, (lat - lat0) * 111320];
}

function distToSegmentMeters(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq)) : 0;
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

const MAX_MATCH_METERS = 40; // past this, "nearest road" is noise, not the road you're on

function nearestWay(lat, lon, ways) {
  let best = null;
  let bestDist = Infinity;
  for (const way of ways) {
    const pts = way.geometry.map(([la, lo]) => metersXY(lat, lon, la, lo));
    for (let i = 1; i < pts.length; i += 1) {
      const d = distToSegmentMeters([0, 0], pts[i - 1], pts[i]);
      if (d < bestDist) { bestDist = d; best = way; }
    }
  }
  return bestDist <= MAX_MATCH_METERS ? best : null;
}

/**
 * @returns {Promise<{kmh: number, source: 'osm'|'default', highway: string}|null>}
 * null means no road matched close enough to trust - callers must treat
 * that fix as "no limit data" (excluded from violation checks and from the
 * problem-meter's speed-zone bands), never silently default to some number.
 */
export async function getSpeedLimitAt(lat, lon) {
  const ways = await waysNear(lat, lon);
  const way = nearestWay(lat, lon, ways);
  if (!way) return null;
  if (way.maxspeedKmh) return { kmh: way.maxspeedKmh, source: 'osm', highway: way.highway };
  const fallback = DEFAULT_KMH_BY_HIGHWAY[way.highway];
  return fallback ? { kmh: fallback, source: 'default', highway: way.highway } : null;
}

/* ---------- school-zone confirmation ----------
 * Israeli law only actually limits a road to 30 near a school where a real
 * sign (approved by the local traffic committee) has been posted - there is
 * no blanket "30 within X meters of any school" rule, so "near a school"
 * alone is never treated as a speed limit. This just confirms the OTHER
 * direction: when the road's own tagged/matched limit already reads 30,
 * checking for a school nearby turns "some road happens to be 30" into
 * "this 30 is a school zone" - a UI distinction, not a different limit. */
const SCHOOL_CELL_DEG = 0.005; // ~550m - finer than the road-way cache, schools need less padding to catch
const schoolCellCache = new Map();
const SCHOOL_RADIUS_M = 150;

function schoolCellIndex(lat, lon) {
  return [Math.floor(lat / SCHOOL_CELL_DEG), Math.floor(lon / SCHOOL_CELL_DEG)];
}

async function fetchSchoolsForCell(latIdx, lonIdx) {
  const south = latIdx * SCHOOL_CELL_DEG;
  const north = (latIdx + 1) * SCHOOL_CELL_DEG;
  const west = lonIdx * SCHOOL_CELL_DEG;
  const east = (lonIdx + 1) * SCHOOL_CELL_DEG;
  const query = `[out:json][timeout:25];node["amenity"~"^(school|kindergarten)$"](${south},${west},${north},${east});out;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  return (json.elements || [])
    .filter((el) => el.type === 'node' && el.lat != null && el.lon != null)
    .map((el) => [el.lat, el.lon]);
}

/** True when a school/kindergarten node sits within SCHOOL_RADIUS_M of
 * (lat,lon) - only meant to be called when the road's own limit already
 * came back 30 (see onPosition's caller), not on every fix: a school's
 * existence nearby says nothing about the limit on a DIFFERENT road. */
export async function hasSchoolNearby(lat, lon) {
  const [latIdx, lonIdx] = schoolCellIndex(lat, lon);
  const cells = [];
  for (let di = -1; di <= 1; di += 1) {
    for (let dj = -1; dj <= 1; dj += 1) cells.push([latIdx + di, lonIdx + dj]);
  }
  const schools = [];
  for (const [li, lj] of cells) {
    const key = `${li}_${lj}`;
    let entry = schoolCellCache.get(key);
    if (!entry || Date.now() - entry.fetchedAt > CELL_TTL_MS) {
      try {
        entry = { schools: await fetchSchoolsForCell(li, lj), fetchedAt: Date.now() };
        schoolCellCache.set(key, entry);
      } catch (err) {
        console.warn('trip-speed-limits: school lookup failed for cell', key, err);
        entry = { schools: [], fetchedAt: Date.now() };
      }
    }
    schools.push(...entry.schools);
  }
  return schools.some(([sLat, sLon]) => Math.hypot(...metersXY(lat, lon, sLat, sLon)) <= SCHOOL_RADIUS_M);
}
