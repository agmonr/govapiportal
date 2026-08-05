/**
 * Entry point for canopy-map.html - a merged view of the three existing
 * city/neighborhood/street datasets on this site (tree-canopy.html, canopy-
 * split.html, heat-islands.html): click one city or neighborhood on the map
 * to see all the metrics that apply to it together, distinguished by color,
 * instead of visiting three separate pages per metric (clicking a city also
 * zooms/drills straight into its neighborhoods - there is no map-click
 * multi-select any more, just a single current pick per level). Multi-entry
 * compare (up to 4) still exists, but only via the free-form street search
 * below - streets have no map shapes to click at all.
 *
 * No new attribute data is computed here at all - every metric's VALUE
 * comes from a file that already ships elsewhere (see the CITY_/
 * NEIGHBORHOOD_/STREET_ imports below). The only genuinely new thing this
 * page needed was boundary GEOMETRY for cities/neighborhoods - see
 * tools/map_geo_build.py. Streets have no such geometry (~36,000 street-
 * buffer shapes would be a substantially bigger undertaking, not done
 * here) - streets are instead picked by typing a name, the same way
 * tree-canopy.html/heat-islands.html already let you search their own
 * street roster, and are free-form/national rather than scoped to one
 * city, so streets from different cities can sit in the same comparison.
 * Because a street IS the public/road portion by definition, canopy-
 * split.html never had a street level at all - a selected street
 * contributes only 2 of the 3 metrics (total canopy, heat), not all 3.
 *
 * Rendered on a real Leaflet map (canopy-map.html's own <script>/<link>
 * tags load it from a CDN - the first external JS dependency anywhere on
 * this site; see that file's own comment on why) - city/neighborhood
 * shapes are a GeoJSON layer, colored per feature by the active metric.
 * This REPLACED an earlier hand-rolled SVG-viewBox renderer (see git
 * history / map-shapes.js if it's still present) whose optional real-map
 * background was a one-shot stitched-tile snapshot that couldn't follow
 * pan/zoom and only worked for a single bounded neighborhood - a real tile
 * layer needed a real map engine underneath it, not a bigger version of
 * that snapshot.
 *
 * The two hi-res heat/canopy blob overlays (HEAT_BLOBS/CANOPY_BLOBS - see
 * their own header comments) are back too, as L.imageOverlay layers - their
 * own x/y/w/h ship in ITM meters (the old flat SVG's native space, no
 * conversion needed there), which Leaflet's lat/lng-native world does need
 * converted. That conversion goes through iplan's own GeometryServer (see
 * geo-utils.js's projectPoints(), the same one blue-lines.js/area-
 * cleanup.html already use for point lookups) - a real network round trip,
 * so every city's own two corners are batched into ONE request per newly-
 * needed set of cities (not one request per city) and cached forever after
 * (a blob's own geometry never changes) - see ensureBlobBounds() below.
 *
 * Still DEFERRED (not yet ported to the Leaflet engine, see canopy-map.html's
 * own visible note about this): the multi-metric bar glyphs, long-press
 * context menu, label decluttering, and zoom-to-drill (auto level
 * switching).
 */

import { el, esc, num, debounce } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { renderHBarChart } from './charts.js';
import { TILE_URL_TEMPLATES, TILE_KIND_ATTRIBUTION, projectPoints, ITM_WKID, WGS84_WKID } from './geo-utils.js';

import { MAP_CITIES_WGS84 } from './map-boundaries-cities-wgs84.js';
import { MAP_NEIGHBORHOODS_WGS84 } from './map-boundaries-neighborhoods-wgs84.js';

import { CITY_CANOPY } from './tree-canopy-cities.js';
import { NEIGHBORHOOD_CANOPY } from './tree-canopy-neighborhoods.js';
import { STREET_CANOPY } from './tree-canopy-streets.js';
import { CITY_CANOPY_SPLIT } from './canopy-split-cities.js';
import { NEIGHBORHOOD_CANOPY_SPLIT } from './canopy-split-neighborhoods.js';
import { CITY_HEAT } from './heat-cities.js';
import { NEIGHBORHOOD_HEAT } from './heat-neighborhoods.js';
import { STREET_HEAT } from './heat-streets.js';
import { HEAT_BLOBS } from './heat-blobs.js';
import { CANOPY_BLOBS } from './canopy-blobs.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'canopy-map')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- metrics: one shape, three already-shipped sources ----------
 * `valueForStreet` is absent on the "street" (public %) metric on purpose -
 * a street IS the public strip by definition, so canopy-split.html never
 * had a street level to source this from. */
const METRICS = {
  canopy: {
    label: 'כיסוי חופות כולל', unit: '%', colorVar: 'var(--accent)',
    valueForCity: (name) => CITY_CANOPY[name]?.pct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY[key]?.pct,
    valueForStreet: (key) => STREET_CANOPY[key]?.pct,
  },
  street: {
    label: 'עצי רחוב (ציבורי)', unit: '%', colorVar: 'var(--accent)',
    valueForCity: (name) => CITY_CANOPY_SPLIT[name]?.publicPct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY_SPLIT[key]?.publicPct,
  },
  // No valueForStreet here either - same reasoning as "street" above (no
  // meaningful "private yard" concept for a street buffer). Not offered as
  // its own map layer (cmLayerPick has no button for it - "street"/"canopy"
  // already cover the map-layer use case), used only by the combined
  // detail chart below (renderDetailStreetPrivate) - see canopy-heat-
  // compare.js's own identical METRICS.private for the same field.
  private: {
    label: 'עצים פרטיים', unit: '%', colorVar: 'var(--accent)',
    valueForCity: (name) => CITY_CANOPY_SPLIT[name]?.privatePct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY_SPLIT[key]?.privatePct,
  },
  heat: {
    label: 'דלתת חום מרבית', unit: '°C', colorVar: 'var(--danger)',
    valueForCity: (name) => CITY_HEAT[name]?.maxC,
    valueForNb: (key) => NEIGHBORHOOD_HEAT[key]?.maxC,
    valueForStreet: (key) => STREET_HEAT[key]?.maxC,
  },
};

function valueForLevel(metric, level, key) {
  if (level === 'city') return metric.valueForCity(key);
  if (level === 'neighborhood') return metric.valueForNb(key);
  return metric.valueForStreet ? metric.valueForStreet(key) : undefined;
}

// "name (city)" / "name, city" - same constructions tree-canopy.js/heat-
// islands.js already use for neighborhood/street display labels
// respectively, so a full-page link's p1 resolves against those pages'
// own roster.
function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}
function streetLabel(city, name, nb) {
  return `${name}, ${city}${nb ? ` (${nb})` : ''}`;
}

/* ---------- street roster (built once, lazily - ~36k rows) ---------- */

let streetEntriesCache = null;
function streetEntries() {
  if (!streetEntriesCache) {
    const keys = new Set([...Object.keys(STREET_CANOPY), ...Object.keys(STREET_HEAT)]);
    streetEntriesCache = [...keys].map((key) => {
      const [city, name] = key.split('::');
      const nb = STREET_CANOPY[key]?.nb || STREET_HEAT[key]?.nb;
      return { key, label: streetLabel(city, name, nb), city, name, level: 'street' };
    });
  }
  return streetEntriesCache;
}

let streetLabelMapCache = null;
function streetLabelMap() {
  if (!streetLabelMapCache) {
    streetLabelMapCache = new Map(streetEntries().map((e) => [e.label, e]));
  }
  return streetLabelMapCache;
}

/* ---------- neighborhood roster (built once, lazily - ~1.3k rows, small
   enough to search across every city at once, the same way streetEntries()
   does - not just the currently-filtered one). ---------- */

let nbEntriesCache = null;
function nbEntries() {
  if (!nbEntriesCache) {
    nbEntriesCache = Object.entries(MAP_NEIGHBORHOODS_WGS84).map(([key, v]) => {
      const [city, name] = key.split('::');
      return { key, label: neighborhoodLabel(city, name), city, name, level: 'neighborhood', rings: v.rings };
    });
  }
  return nbEntriesCache;
}

let nbLabelMapCache = null;
function nbLabelMap() {
  if (!nbLabelMapCache) {
    nbLabelMapCache = new Map(nbEntries().map((e) => [e.label, e]));
  }
  return nbLabelMapCache;
}

/* ---------- state + URL ---------- */

const MAX_SELECT = 4;
// Same 4-hue idiom as PICK_COLORS on tree-canopy.js/heat-islands.js/
// canopy-split.js - here it identifies WHICH SELECTED ENTITY a row/shape
// belongs to (consistent across the map highlight, the chip list, and all
// three detail charts), not which metric.
const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];

// `view` is the Leaflet map's own {lat, lng, zoom} - null means "not
// customized, use the auto-fit bounds for whatever's currently shown". Kept
// across a layer switch (same geometry, just recolored) but reset on
// level/city change (currentEntities() returns different shapes entirely,
// so a leftover zoom/center wouldn't line up with anything).
// `layer` (single) colors neighborhood/street level, unchanged from the
// original design. `cityLayers` (1-3, toggled independently) is city-level
// only, but the multi-bar glyph that used to distinguish 2-3 active metrics
// is DEFERRED (see this file's own top docstring) - for now, only the
// FIRST active cityLayers entry actually colors the choropleth fill, same
// as a single-metric pick, until the glyph returns.
// Jerusalem, zoomed in - the page's own starting view (and what "איפוס למפה
// המקורית" below returns to), rather than the auto-fit full-country view.
const DEFAULT_VIEW = { lat: 31.78, lng: 35.22, zoom: 13 };

const state = {
  level: 'city', layer: 'heat', cityLayers: ['heat'], cityFilter: null, osm: false, basemapKind: 'street',
  // hiRes defaults ON (this page's own default view) - heatBlob/canopyBlob
  // are the two per-type manual toggles, only meaningful once hiRes is off
  // (see cmBlobRow/cmCanopyBlobRow's own hidden logic in renderMap()).
  hiRes: true, heatBlob: false, canopyBlob: false,
  selected: [], view: { ...DEFAULT_VIEW },
};
let leafletMap = null; // the one Leaflet map instance, created once in initMap() and reused across every renderMap() call

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('level') === 'neighborhood' || p.get('level') === 'street') state.level = p.get('level');
  if (METRICS[p.get('layer')]) state.layer = p.get('layer');
  const layers = (p.get('layers') || '').split(',').filter((id) => METRICS[id]);
  if (layers.length) state.cityLayers = [...new Set(layers)].slice(0, 3);
  if (p.get('city')) state.cityFilter = p.get('city');
  const sel = p.getAll('sel');
  if (sel.length) {
    state.selected = sel.map((key) => ({ key, label: key, city: null, level: state.level }));
  }
  const v = p.get('v');
  if (v) {
    const parts = v.split(',').map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      const [lat, lng, zoom] = parts;
      state.view = { lat, lng, zoom };
    }
  }
}

// Selection labels can't be fully resolved until the level's own roster is
// available (esp. streets, ~36k rows) - called once after first render to
// fix up placeholder `{key, label: key}` entries from readStateFromUrl().
function resolveSelectedFromUrl() {
  if (!state.selected.length) return;
  const roster = currentPickableEntities();
  const byKey = new Map(roster.map((e) => [e.key, e]));
  state.selected = state.selected.map((s) => byKey.get(s.key)).filter(Boolean).slice(0, MAX_SELECT);
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  p.set('layer', state.layer);
  p.set('layers', state.cityLayers.join(','));
  if (state.cityFilter) p.set('city', state.cityFilter);
  state.selected.forEach((e) => p.append('sel', e.key));
  if (state.view) {
    const { lat, lng, zoom } = state.view;
    p.set('v', [lat, lng, zoom].map((n) => Math.round(n * 1000) / 1000).join(','));
  }
  history.replaceState(null, '', `?${p}`);
}
const syncUrlDebounced = debounce(syncUrl, 300); // pan/zoom fire many updates per gesture - one URL write per pause, not per event

/* ---------- entities for the current level ---------- */

function currentEntities() {
  if (state.level === 'city') {
    return Object.keys(MAP_CITIES_WGS84).map((name) => ({ key: name, label: name, city: name, level: 'city', rings: MAP_CITIES_WGS84[name].rings }));
  }
  if (state.level === 'neighborhood') {
    if (!state.cityFilter) return [];
    const prefix = `${state.cityFilter}::`;
    return Object.entries(MAP_NEIGHBORHOODS_WGS84)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, v]) => {
        const [city, name] = key.split('::');
        return { key, label: neighborhoodLabel(city, name), city, name, level: 'neighborhood', rings: v.rings };
      });
  }
  return []; // street: no map shapes, see streetEntries()
}

// The roster a pick (map click or street search) resolves against -
// currentEntities() for city/neighborhood (has geometry), streetEntries()
// for street (does not).
function currentPickableEntities() {
  return state.level === 'street' ? streetEntries() : currentEntities();
}

function valueFor(entity, metricId) {
  return valueForLevel(METRICS[metricId], entity.level, entity.key);
}

/* ---------- color scale (map fill, by the active layer) ---------- */

function computeDomain(entities, metricId) {
  const vals = entities.map((e) => valueFor(e, metricId)).filter((v) => v != null);
  if (!vals.length) return [0, 1];
  return [Math.min(...vals), Math.max(...vals)];
}

function computeDomains(entities, metricIds) {
  return Object.fromEntries(metricIds.map((id) => [id, computeDomain(entities, id)]));
}

function colorFor(value, min, max, colorVar) {
  if (value == null) return 'var(--map-nodata)';
  const t = max > min ? (value - min) / (max - min) : 0.5;
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return `color-mix(in srgb, ${colorVar} ${pct}%, var(--bg) ${100 - pct}%)`;
}

/* ---------- selection: at most 1 entry from map clicks (city/neighborhood
   - see pickSolo below), up to MAX_SELECT from the free-form street search
   (see commitStreetPick), which is the only surviving multi-compare path -
   toggleSelect() itself doesn't know or care which kind of caller it is. ---------- */

function selectedIndex(key) {
  return state.selected.findIndex((e) => e.key === key);
}

function toggleSelect(entity) {
  const i = selectedIndex(entity.key);
  if (i !== -1) {
    state.selected.splice(i, 1);
  } else if (state.selected.length < MAX_SELECT) {
    state.selected.push(entity);
  } else {
    return; // already at the 4-entity cap - ignore rather than bump an existing pick
  }
  syncUrl();
  renderAll();
}

// Map clicks on a city/neighborhood shape replace the current pick outright
// (clicking the same one again clears it) rather than accumulating toward
// MAX_SELECT the way the street search still does - "there will be only one
// pick" from the map itself.
function pickSolo(entity) {
  const isSame = state.selected.length === 1 && state.selected[0].key === entity.key;
  state.selected = isSame ? [] : [entity];
  syncUrl();
  renderAll();
}

/* ---------- legend ---------- */

function renderLegend(metricIds, domains) {
  // One scale per active metric - city level can have up to 3 at once (see
  // the bar-glyph feature above), each with its own unit/domain/color, so a
  // single-scale legend (the old signature) can no longer say which is
  // which. A metric label prefix is only shown when there's more than one
  // to distinguish, so the common single-metric case looks unchanged.
  const rows = metricIds.map((id) => {
    const m = METRICS[id];
    const [min, max] = domains[id];
    const label = metricIds.length > 1 ? `<span class="cm-legend-metric">${esc(m.label)}</span>` : '';
    return `
    <span class="cm-legend-scale" dir="ltr">
      ${label}
      <span class="cm-legend-label">${num(min)}${esc(m.unit)}</span>
      <span class="cm-legend-bar" style="background:linear-gradient(to right, var(--bg), ${m.colorVar})"></span>
      <span class="cm-legend-label">${num(max)}${esc(m.unit)}</span>
    </span>`;
  }).join('');
  el('cmLegend').innerHTML = `${rows}
    <span class="cm-legend-nodata"><span class="acc-legend-swatch" style="background:var(--map-nodata)"></span>אין נתונים</span>
  `;
}

/* ---------- map (city/neighborhood, Leaflet) ---------- */

// GeoJSON MultiPolygon - each of an entity's own rings becomes its OWN
// single-ring polygon within the MultiPolygon, rather than one Polygon with
// the first ring as an exterior and the rest as holes: the old hand-rolled
// SVG renderer this replaced drew every ring as its own independently-
// closed subpath with no hole-cutout behavior, and these simplified shapes
// really do carry disjoint pieces (a city's own exclaves), not holes to cut
// out of a larger exterior.
function entityToFeature(e) {
  return {
    type: 'Feature',
    properties: { key: e.key },
    geometry: { type: 'MultiPolygon', coordinates: e.rings.map((ring) => [ring]) },
  };
}

// Multi-metric bar glyphs are DEFERRED (see this file's own top docstring) -
// for now, city level's own cityLayers (1-3 toggled metrics) only ever
// colors the choropleth fill by the FIRST active one, same as a plain
// single-metric pick, until the glyph returns to actually distinguish 2-3
// active metrics visually.
//
// `blobReplacesFill` (computed once per renderMap() call, see its own
// comment there): once a high-res raster (blob) is showing for the metric
// it belongs to, the per-neighborhood choropleth fill is redundant - it's
// the same value at coarser granularity, sitting right on top of the
// pixel-accurate data - suppressed (fillOpacity 0) instead of just made
// translucent. The outline is suppressed right along with it (weight 0)
// for un-picked shapes: the choropleth layer covers all 186 cities
// regardless of which ones actually have a blob loaded (see this file's
// own citiesInView), so a visible border would trace every city on the
// map, not just the ones the raster is showing - picked/compared shapes
// keep their PICK_COLORS outline, since that's a selection highlight, not
// a boundary line. var(--bg) for the border is deliberate the REST of the
// time (hiRes off) - it reads as a thin gap between two differently-
// colored fills, not a border meant to be seen on its own.
function styleForFeature(feature, entitiesByKey, activeMetricIds, domains, blobReplacesFill) {
  const e = entitiesByKey.get(feature.properties.key);
  const metricId = activeMetricIds[0];
  const fill = colorFor(valueFor(e, metricId), ...domains[metricId], METRICS[metricId].colorVar);
  const i = selectedIndex(e.key);
  return {
    className: 'cm-leaflet-shape',
    fillColor: fill,
    fillOpacity: blobReplacesFill ? 0 : (state.osm ? 0.72 : 1),
    color: i !== -1 ? PICK_COLORS[i] : 'var(--bg)',
    weight: i !== -1 ? 3 : (blobReplacesFill ? 0 : 1.2),
  };
}

function wireFeature(feature, layer, entitiesByKey, activeMetricIds) {
  const e = entitiesByKey.get(feature.properties.key);
  layer.on('click', () => pickSolo(e));
  const title = `${e.label} - ${activeMetricIds
    .map((id) => `${METRICS[id].label}: ${valueFor(e, id) != null ? num(valueFor(e, id)) + METRICS[id].unit : 'אין נתונים'}`)
    .join(' · ')}`;
  layer.bindTooltip(title, { sticky: true });
}

/* ---------- hi-res heat/canopy blob overlays ----------
 * Which cities are "in view" at city level (city-BY-CITY, unlike the
 * choropleth which covers ALL 186 regardless of view) - used only to decide
 * which cities' own hi-res raster to fetch/show, exactly like the old flat-
 * SVG renderer's own citiesInView() did with ITM meters; this is the same
 * idea against Leaflet's own lat/lng bounds instead. Widened to every city
 * clearing a low overlap-fraction floor (not just the single most-dominant
 * one), capped at CITY_VIEW_MAX_COUNT by PROMINENCE (fraction of the view
 * each city's own bbox covers) so a fully zoomed-out national view still
 * shows a bounded number of blobs, not all 186 at once (see HEAT_BLOBS'/
 * CANOPY_BLOBS' own header comments on why these are lazily fetched at all). */

let cityLatLngBoundsCache = null;
function cityLatLngBounds() {
  if (!cityLatLngBoundsCache) {
    cityLatLngBoundsCache = {};
    for (const [name, data] of Object.entries(MAP_CITIES_WGS84)) {
      const b = L.latLngBounds([]);
      for (const ring of data.rings) for (const [lon, lat] of ring) b.extend([lat, lon]);
      cityLatLngBoundsCache[name] = b;
    }
  }
  return cityLatLngBoundsCache;
}

function overlapFraction(viewBounds, cityBounds) {
  const ox = Math.max(0, Math.min(viewBounds.getEast(), cityBounds.getEast()) - Math.max(viewBounds.getWest(), cityBounds.getWest()));
  const oy = Math.max(0, Math.min(viewBounds.getNorth(), cityBounds.getNorth()) - Math.max(viewBounds.getSouth(), cityBounds.getSouth()));
  const viewArea = (viewBounds.getEast() - viewBounds.getWest()) * (viewBounds.getNorth() - viewBounds.getSouth());
  return viewArea ? (ox * oy) / viewArea : 0;
}

const CITY_VIEW_MIN_FRACTION = 0.0002;
const CITY_VIEW_MAX_COUNT = 15;
function citiesInView(viewBounds) {
  const hits = [];
  for (const [name, bounds] of Object.entries(cityLatLngBounds())) {
    const frac = overlapFraction(viewBounds, bounds);
    if (frac >= CITY_VIEW_MIN_FRACTION) hits.push([name, frac]);
  }
  hits.sort((a, b) => b[1] - a[1]);
  return hits.slice(0, CITY_VIEW_MAX_COUNT).map(([name]) => name);
}

// Background warm-up for cities just outside citiesInView()'s own rendered
// top-CITY_VIEW_MAX_COUNT set - see that function's own comment for why the
// set is capped at all. Same reasoning as the old flat-SVG version's own
// prefetchNearbyBlobs(): without this, panning/zooming to reveal a city for
// the first time shows a visible pop-in while its (fresh, uncached) tile
// image is still in flight. `pad()` is Leaflet's own native bounds padding,
// simpler than the old version's manual x/y/w/h math.
const PREFETCH_PAD = 0.5;
const PREFETCH_MAX = 45;
const warmedBlobCities = new Set();
function warmBlobImage(src) {
  const img = new Image();
  if ('fetchPriority' in img) img.fetchPriority = 'low';
  img.src = src;
}
function prefetchNearbyBlobs(viewBounds, renderedCities) {
  const padded = viewBounds.pad(PREFETCH_PAD);
  const rendered = new Set(renderedCities);
  const candidates = [];
  for (const [name, bounds] of Object.entries(cityLatLngBounds())) {
    if (rendered.has(name) || warmedBlobCities.has(name)) continue;
    if (!HEAT_BLOBS[name] && !CANOPY_BLOBS[name]) continue;
    const frac = overlapFraction(padded, bounds);
    if (frac >= CITY_VIEW_MIN_FRACTION) candidates.push([name, frac]);
  }
  candidates.sort((a, b) => b[1] - a[1]);
  for (const [name] of candidates.slice(0, PREFETCH_MAX)) {
    if (HEAT_BLOBS[name]) warmBlobImage(HEAT_BLOBS[name].src);
    if (CANOPY_BLOBS[name]) warmBlobImage(CANOPY_BLOBS[name].src);
    warmedBlobCities.add(name);
  }
}

// A blob's own x/y/w/h ship in ITM meters, Y-flipped (the old flat SVG's
// native space: SVG y = -ITM northing, so the image's own top-left corner
// is its NORTH-west corner, not south-west) - reprojected to WGS84 via
// iplan's own GeometryServer (projectPoints(), see this file's own top
// docstring for why), cached forever per city (a blob's geometry never
// changes) once resolved. Every city newly needed in one renderMap() pass
// is batched into a SINGLE projectPoints() call (both corners of every
// city, one request) rather than one request per city - heat_blobs.py's/
// canopy_blobs.py's own bboxes agree to sub-meter precision for the same
// city (checked directly), so either source's own bbox is used
// interchangeably here, whichever exists.
const blobBoundsCache = new Map(); // city -> L.LatLngBounds | Promise<L.LatLngBounds>
async function ensureBlobBounds(cities) {
  const need = cities.filter((c) => !blobBoundsCache.has(c));
  if (!need.length) return;
  const corners = [];
  for (const c of need) {
    const data = HEAT_BLOBS[c] || CANOPY_BLOBS[c];
    corners.push([data.x, -data.y - data.h], [data.x + data.w, -data.y]);
  }
  const promise = projectPoints(corners, ITM_WKID, WGS84_WKID).then((wgsPoints) => {
    need.forEach((c, i) => {
      const [[lonMin, latMin], [lonMax, latMax]] = [wgsPoints[i * 2], wgsPoints[i * 2 + 1]];
      blobBoundsCache.set(c, L.latLngBounds([latMin, lonMin], [latMax, lonMax]));
    });
  }).catch(() => {
    need.forEach((c) => blobBoundsCache.delete(c)); // failed - allow a retry next time rather than caching a permanent failure
  });
  need.forEach((c) => blobBoundsCache.set(c, promise)); // placeholder so a concurrent call for the same city doesn't double-request
  await promise;
}

// blobOverlayLayer holds the actual L.imageOverlay instances, keyed
// "type:city" (e.g. "heat:הרצליה") so heat and canopy overlays for the same
// city coexist independently (the two manual per-type toggles, only
// reachable once hi-res is off, can still show both together on purpose -
// hi-res mode itself only ever asks for one type at a time, see renderMap()'s
// own activeMetricType). A generation token guards against a slow/stale
// ensureBlobBounds() call
// (real network round trips) clobbering a newer render's own set - the same
// idiom canopy-map.js's own osmToken used to use for the old basemap fetch.
let blobOverlayGroup = null;
const blobOverlayLayers = new Map();
let blobRenderGeneration = 0;

// citiesInView() (an O(186) scan+sort) and the renderMap() it can trigger
// are too expensive to run on every single wheel-tick/pointermove sample of
// an active gesture - debounced so it runs once ~180ms after a gesture
// pauses (including at release, since nothing keeps resetting the timer
// once ticks stop), same idiom/reasoning as the old flat-SVG renderer's own
// checkBlobCitiesDebounced. Only meaningful (and only wired to fire) at
// city level - neighborhood/street's own blob city (if any) comes from
// state.cityFilter, not the view.
let lastBlobCitiesKey = ''; // set inside renderMap() itself - the SAME candidate set that call just rendered with
const checkBlobCitiesDebounced = debounce(() => {
  if (state.level !== 'city' || !leafletMap) return;
  const viewBounds = leafletMap.getBounds();
  const inView = citiesInView(viewBounds);
  if ([...inView].sort().join(' ') !== lastBlobCitiesKey) renderMap();
  prefetchNearbyBlobs(viewBounds, inView); // independent of whether the rendered set itself changed - see its own comment
}, 180);

async function updateBlobOverlays(heatCities, canopyCities) {
  const myGeneration = (blobRenderGeneration += 1);
  const wanted = new Map(); // "type:city" -> { city, type, data }
  for (const c of heatCities) wanted.set(`heat:${c}`, { city: c, type: 'heat', data: HEAT_BLOBS[c] });
  for (const c of canopyCities) wanted.set(`canopy:${c}`, { city: c, type: 'canopy', data: CANOPY_BLOBS[c] });

  for (const [key, layer] of blobOverlayLayers) {
    if (!wanted.has(key)) { blobOverlayGroup.removeLayer(layer); blobOverlayLayers.delete(key); }
  }

  const toAdd = [...wanted.entries()].filter(([key]) => !blobOverlayLayers.has(key));
  if (!toAdd.length) return;
  await ensureBlobBounds([...new Set(toAdd.map(([, w]) => w.city))]);
  if (myGeneration !== blobRenderGeneration) return; // a newer render superseded this one while the projection was in flight

  for (const [key, w] of toAdd) {
    const bounds = blobBoundsCache.get(w.city);
    if (!(bounds instanceof L.LatLngBounds)) continue; // that city's own projection failed - skip it, not the whole batch
    if (blobOverlayLayers.has(key)) continue; // a concurrent call already added this one
    const layer = L.imageOverlay(w.data.src, bounds, { interactive: false, pane: 'cmBlobPane' });
    layer.addTo(blobOverlayGroup);
    blobOverlayLayers.set(key, layer);
  }
}

// Created once, reused across every renderMap() call (clearLayers()+
// addData() each time, rather than tearing the whole Leaflet map down and
// rebuilding it) - shapesLayer's own style/onEachFeature callbacks are
// reassigned fresh each render (see renderMap() below) so they close over
// that render's own entitiesByKey/activeMetricIds/domains, without needing
// a brand new L.GeoJSON instance every time.
let tileLayer = null;
let shapesLayer = null;

/* global L */
function initMap() {
  leafletMap = L.map('cmMap', { zoomControl: false, attributionControl: true })
    .setView([state.view.lat, state.view.lng], state.view.zoom);
  // The zoom/topo/fullscreen buttons and the exit-fullscreen button sit
  // absolutely-positioned ON TOP of the map, not inside Leaflet's own
  // container tree - Leaflet still owns pointer/touch handling for its
  // whole map area underneath them (drag-to-pan, tap-to-select a shape),
  // and a touch that starts (or a click Leaflet's own handler otherwise
  // sees) anywhere over the map can occasionally be claimed by the map
  // instead of the control it visually landed on, especially right at a
  // button's edge (reported live: a control press sometimes selected the
  // city under it instead of firing). disableClickPropagation is Leaflet's
  // own documented fix for exactly this "custom UI overlapping the map"
  // case - stops click/dblclick/mousedown/touchstart on these elements from
  // ever reaching the map's own handlers.
  L.DomEvent.disableClickPropagation(el('cmZoomControls'));
  L.DomEvent.disableClickPropagation(el('cmMapExitFullscreen'));
  // Panes' own fixed z-index ordering (tilePane < overlayPane) already
  // keeps tileLayer below shapesLayer regardless of add order - blobs need
  // to sit BETWEEN those two (over the tiles, under the shape outlines,
  // same stacking the old flat-SVG renderer drew blobImage+paths in), so
  // this gets its own pane at a z-index placed accordingly.
  leafletMap.createPane('cmBlobPane');
  leafletMap.getPane('cmBlobPane').style.zIndex = 350;
  blobOverlayGroup = L.layerGroup().addTo(leafletMap);
  shapesLayer = L.geoJSON(null).addTo(leafletMap);
  // The only place state.view is written FROM the map itself (as opposed to
  // TO it) - every pan/zoom, whether a live gesture or one of renderMap()'s
  // own setView()/fitBounds() calls below, ends up here. Debounced the same
  // way the old attachZoomPan-based onChange was, for the same reason (a
  // drag/wheel gesture fires many intermediate moveend-adjacent updates).
  leafletMap.on('moveend', () => {
    const c = leafletMap.getCenter();
    state.view = { lat: c.lat, lng: c.lng, zoom: leafletMap.getZoom() };
    syncUrlDebounced();
    checkBlobCitiesDebounced();
  });
  // Mobile fullscreen entry on a plain tap (desktop uses the explicit ⛶
  // button instead, see cmMapFullscreenToggle below - a plain click there
  // already means "select this shape," not "give me more room"). Routed
  // through Leaflet's OWN 'click' event (not a raw DOM listener on the
  // wrapping div) specifically because Leaflet already suppresses this
  // event for a click that immediately follows a drag/pinch gesture - the
  // exact "a pan that happens to end wasn't a tap on someplace to look
  // closer at" guard the old hand-rolled isDragging() check used to need,
  // for free. Fires for a feature click too (bubbles up from shapesLayer's
  // own per-shape click handler) - intentional, same as before: a mobile
  // tap on a city/neighborhood both picks it AND enters fullscreen.
  leafletMap.on('click', () => {
    if (isMapFullscreen() || !window.matchMedia(MOBILE_MAP_BREAKPOINT).matches) return;
    enterMapFullscreen();
  });
  // Wired once here (unlike the old per-render zoomPan object) - leafletMap
  // itself is created once and reused across every renderMap() call, so
  // there's no fresh instance each time to re-bind these to.
  el('cmZoomIn').addEventListener('click', () => leafletMap.zoomIn());
  el('cmZoomOut').addEventListener('click', () => leafletMap.zoomOut());
  el('cmZoomReset').addEventListener('click', () => {
    state.view = null;
    renderMap();
  });
}

function updateTileLayer() {
  // Drives .cm-osm-active's own blob-contrast-boost rule in style.css - a
  // container class rather than per-overlay styling so it also applies to
  // blob images that were already added before the basemap was toggled on
  // (see updateBlobOverlays' own caching - it doesn't recreate an overlay
  // just because the basemap underneath it changed).
  leafletMap.getContainer().classList.toggle('cm-osm-active', state.osm);
  if (tileLayer) { leafletMap.removeLayer(tileLayer); tileLayer = null; }
  if (!state.osm) return;
  tileLayer = L.tileLayer(TILE_URL_TEMPLATES[state.basemapKind], {
    attribution: TILE_KIND_ATTRIBUTION[state.basemapKind],
    className: state.basemapKind === 'topo' ? 'cm-tile-topo' : '',
    maxZoom: 19,
  }).addTo(leafletMap);
  // Leaflet's own panes already keep tiles (tilePane) below vector layers
  // (overlayPane) regardless of add order - no bringToBack()/z-index
  // juggling needed for shapesLayer to stay on top of this.
}

function renderMap() {
  const mapSection = el('cmMapSection');
  mapSection.hidden = state.level === 'street';
  if (state.level === 'street') return;
  if (!leafletMap) initMap();

  const entities = currentEntities();
  // cityLayers (1-3) only ever applies at city level - neighborhood/street
  // always use the single `layer` radio-style pick, unchanged from before
  // this feature existed. Only the first is actually used for the fill
  // right now - see styleForFeature's own comment (glyph deferred).
  const activeMetricIds = state.level === 'city' ? state.cityLayers.slice(0, 1) : [state.layer];
  const domains = computeDomains(entities, activeMetricIds);

  el('cmTopoQuickToggle').classList.toggle('active', state.osm && state.basemapKind === 'topo');
  updateTileLayer();

  // View change BEFORE the shapes are (re)added, not after - added first,
  // deliberately tested directly: a LARGE jump (e.g. a fresh page's default
  // city-level view all the way out to a national fitBounds()) left the
  // SVG renderer's already-drawn shapes positioned from the stale pixel
  // origin - right DOM, wrong screen position (confirmed via
  // getBoundingClientRect() on the newly-added paths: single-digit sizes at
  // negative Y, well off-screen, even though fitBounds()'s own computed
  // zoom/center were correct). Leaflet positions a path at whatever the
  // map's CURRENT view is at the moment it's added, so setting the view
  // first and adding shapes into an already-correct view sidesteps the
  // reposition-on-view-change path entirely, rather than depending on it.
  // invalidateSize() first for the same reason at the container level - the
  // map may have been sized/hidden differently since the last render (e.g.
  // switching through street level, which hides #cmMap entirely).
  leafletMap.invalidateSize();
  if (state.view) {
    leafletMap.setView([state.view.lat, state.view.lng], state.view.zoom);
  } else if (entities.length) {
    // Bounds computed from a throwaway L.geoJSON (never added to the map),
    // not shapesLayer.getBounds() - that would need the NEW data already
    // in shapesLayer, which is exactly the ordering this is avoiding.
    const bounds = L.geoJSON({ type: 'FeatureCollection', features: entities.map(entityToFeature) }).getBounds();
    leafletMap.fitBounds(bounds, { padding: [20, 20] });
  }

  // Which cities' hi-res raster (if any) is relevant right now: neighborhood
  // level with a city picked always means exactly that one city; city level
  // means whichever cities are meaningfully on screen (citiesInView), even
  // with nothing picked/selected - one city zoomed in close, or several
  // zoomed out far enough to see as a cluster. Computed AFTER the view is
  // already set above - citiesInView() reads the map's CURRENT bounds.
  const blobCandidates = state.level === 'neighborhood'
    ? (state.cityFilter ? [state.cityFilter] : [])
    : citiesInView(leafletMap.getBounds());
  lastBlobCitiesKey = [...blobCandidates].sort().join(' ');
  const heatBlobCities = blobCandidates.filter((c) => HEAT_BLOBS[c]);
  const canopyBlobCities = blobCandidates.filter((c) => CANOPY_BLOBS[c]);
  // The per-metric toggles are redundant once hi-res-only mode forces the
  // matching raster on - hidden rather than left sitting there unchecked,
  // which would misleadingly imply they're what's controlling the view.
  el('cmBlobRow').hidden = !heatBlobCities.length || state.hiRes;
  el('cmCanopyBlobRow').hidden = !canopyBlobCities.length || state.hiRes;
  // Hi-res mode shows only the raster matching the CURRENTLY ACTIVE metric,
  // not both heat and canopy at once - showing both together (the two
  // rasters being independent images with their own opaque-ish pixels)
  // reads as two overlapping/double-vision layers on the same city rather
  // than "the hi-res version of what you're already looking at". The two
  // manual per-type toggles (state.heatBlob/state.canopyBlob, only reachable
  // once hi-res is off) are unaffected and can still show both together on
  // purpose.
  const activeMetricType = activeMetricIds[0] === 'heat' ? 'heat' : 'canopy';
  const heatCitiesShown = (state.hiRes ? activeMetricType === 'heat' : state.heatBlob) ? heatBlobCities : [];
  const canopyCitiesShown = (state.hiRes ? activeMetricType === 'canopy' : state.canopyBlob) ? canopyBlobCities : [];
  // Which TYPE (not which city) backs blobReplacesFill below - heat wins if
  // somehow both are showing (nothing enforces them mutually exclusive,
  // same as the old renderer).
  const activeBlobType = heatCitiesShown.length ? 'heat' : (canopyCitiesShown.length ? 'canopy' : null);
  // Once a high-res raster is showing for the metric it belongs to, the
  // per-neighborhood choropleth fill is redundant (see styleForFeature's
  // own comment) - hi-res-only mode suppresses it unconditionally, even
  // before a raster is actually available yet (e.g. city level, or
  // neighborhood level before a city is picked) - "borders only" is the
  // point of that mode, not just a side effect of a raster being present.
  const blobReplacesFill = state.hiRes || (activeBlobType != null && activeMetricIds[0] === activeBlobType);
  updateBlobOverlays(heatCitiesShown, canopyCitiesShown); // async (real projection round trips) - fire-and-forget, see its own generation guard

  const entitiesByKey = new Map(entities.map((e) => [e.key, e]));
  shapesLayer.options.style = (feature) => styleForFeature(feature, entitiesByKey, activeMetricIds, domains, blobReplacesFill);
  shapesLayer.options.onEachFeature = (feature, layer) => wireFeature(feature, layer, entitiesByKey, activeMetricIds);
  shapesLayer.clearLayers();
  shapesLayer.addData(entities.map(entityToFeature));

  // The choropleth scale would describe a fill that isn't drawn any more
  // (see blobReplacesFill above) - showing it would just be wrong, not
  // merely redundant, since each raster's own coloring follows a different
  // convention entirely (see cmBlobRow's/cmCanopyBlobRow's own hints): heat
  // is a per-crop, median-relative scale further weighted by how hot each
  // city runs nationally; canopy is a plain "is there a tree crown here,
  // yes/no" mask, not a value scale at all.
  if (state.hiRes) {
    const parts = [];
    if (heatCitiesShown.length) parts.push('כתם החום יחסי לחציון האזור, משוקלל לפי חום העיר ארצית');
    if (canopyCitiesShown.length) parts.push('כל נקודה ירוקה = צמרת עץ בודדת מהמיפוי המקורי');
    el('cmLegend').innerHTML = parts.length
      ? `<span class="cm-legend-nodata">גבולות בלבד, בלי צביעת ממוצע - ${esc(parts.join(' · '))}</span>`
      : '<span class="cm-legend-nodata">גבולות בלבד, בלי צביעת ממוצע - בחרו עיר והתקרבו לשכונות כדי לראות את הכתמים</span>';
  } else if (blobReplacesFill && activeBlobType === 'heat') {
    el('cmLegend').innerHTML = '<span class="cm-legend-nodata">כתם החום מוצג לפי חציון האזור, משוקלל לפי חום העיר ארצית - אין סרגל צבע קבוע להשוואה</span>';
  } else if (blobReplacesFill && activeBlobType === 'canopy') {
    el('cmLegend').innerHTML = '<span class="cm-legend-nodata">כל נקודה ירוקה היא צמרת עץ בודדת מהמיפוי המקורי - לא אחוז כיסוי משוכלל</span>';
  } else {
    renderLegend(activeMetricIds, domains);
  }
  el('cmHint').textContent = state.level === 'city'
    ? `${num(entities.length)} ערים - לחיצה מציגה פרטי עיר; למעבר לשכונות שלה, עברו לרמת "שכונות" והקלידו את שמה`
    : (state.cityFilter ? `${num(entities.length)} שכונות ב${state.cityFilter} - לחיצה בוחרת שכונה אחת לצפייה בפרטים` : 'הקלידו שם עיר למעלה כדי לראות את השכונות שלה');
}

/* ---------- selection chips (shown regardless of how a pick was made) ---------- */

function renderChips() {
  const wrap = el('cmChips');
  if (!state.selected.length) { wrap.innerHTML = ''; wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = state.selected.map((e, i) => `
    <span class="cm-chip" style="border-color:${PICK_COLORS[i]}">
      <span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>
      <span dir="auto">${esc(e.label)}</span>
      <button type="button" class="cm-chip-remove" data-key="${esc(e.key)}" aria-label="הסרה">✕</button>
    </span>`).join('');
  wrap.querySelectorAll('.cm-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entity = state.selected.find((e) => e.key === btn.dataset.key);
      if (entity) toggleSelect(entity);
    });
  });
}

/* ---------- combined detail: total canopy + heat, one chart each, colored
   by which selected entity (not by metric) - see renderDetailStreetPrivate
   right below for the one exception (public/private trees, one COMBINED
   chart, colored by series instead). ---------- */

function renderDetailMetric(metricId, figId) {
  const m = METRICS[metricId];
  const entries = state.selected
    .map((e, i) => ({ e, v: valueForLevel(m, e.level, e.key), i }))
    .filter((row) => row.v != null)
    .map((row) => ({ label: row.e.label, value: row.v, color: PICK_COLORS[row.i] }));
  renderHBarChart(figId, m.label, entries, m.unit);
}

// Fixed (not per-entity) - same reasoning as canopy-heat-compare.js's own
// identical constants: this chart tells entities apart by row label
// already, and needs its two colors to mean the same thing (public vs.
// private) in every row instead of doubling as an entity-color code.
const STACKED_COLOR_STREET = 'var(--accent)';
const STACKED_COLOR_PRIVATE = 'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)';

// Public+private trees shown as ONE two-segment bar per selected entity
// (ported from canopy-heat-compare.js's own renderStackedBarChart, same
// markup/reasoning - see that file's own comment on why the segments
// themselves are square) instead of two separate full-width charts side by
// side - answers "how green, and how much of that is street trees vs.
// private yards" in one thinner block rather than two disconnected ones.
function renderDetailStreetPrivate(figId) {
  const rows = state.selected
    .map((e) => ({
      label: e.label,
      streetVal: valueForLevel(METRICS.street, e.level, e.key),
      privateVal: valueForLevel(METRICS.private, e.level, e.key),
    }))
    .filter((r) => r.streetVal != null || r.privateVal != null);
  const fig = el(figId);
  const caption = 'עצי רחוב (ציבורי) + עצים פרטיים';
  if (!rows.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const totals = rows.map((r) => (r.streetVal ?? 0) + (r.privateVal ?? 0));
  const peak = Math.max(...totals);
  const body = rows.map((r, i) => {
    const total = totals[i];
    const streetPct = peak ? ((r.streetVal ?? 0) / peak) * 100 : 0;
    const privatePct = peak ? ((r.privateVal ?? 0) / peak) * 100 : 0;
    const title = `${r.label}: ${esc(METRICS.street.label)} ${r.streetVal != null ? r.streetVal.toFixed(1) : '—'}%, `
      + `${esc(METRICS.private.label)} ${r.privateVal != null ? r.privateVal.toFixed(1) : '—'}%`;
    return `
    <div class="acc-hbar" title="${esc(title)}">
      <span class="acc-hbar-y" dir="auto">${esc(r.label)}</span>
      <div class="acc-hbar-track acc-hbar-track-stacked">
        <div class="acc-hbar-fill" style="inline-size:${streetPct}%;background:${STACKED_COLOR_STREET}"></div>
        <div class="acc-hbar-fill" style="inline-size:${privatePct}%;background:${STACKED_COLOR_PRIVATE}"></div>
      </div>
      <span class="acc-hbar-v">${num(Number(total.toFixed(1)))}%</span>
    </div>`;
  }).join('');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars">${body}</div>
    <p class="acc-hint" dir="auto">
      <span class="acc-legend-swatch" style="background:${STACKED_COLOR_STREET}"></span> ${esc(METRICS.street.label)}
      · <span class="acc-legend-swatch" style="background:${STACKED_COLOR_PRIVATE}"></span> ${esc(METRICS.private.label)}
    </p>`;
}

function renderDetail() {
  const section = el('cmDetailSection');
  if (!state.selected.length) { section.hidden = true; return; }
  section.hidden = false;
  renderDetailMetric('canopy', 'cmDetailCanopy');
  renderDetailStreetPrivate('cmDetailStreet');
  renderDetailMetric('heat', 'cmDetailHeat');
}

/* ---------- street picker (street level only) ---------- */

function updateStreetRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('cmStreetRoster').innerHTML = ''; return; }
  const hits = streetEntries().filter((e) => e.label.toLowerCase().includes(q)).slice(0, 40);
  el('cmStreetRoster').innerHTML = hits.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function commitStreetPick() {
  const input = el('cmStreetPick');
  const entity = streetLabelMap().get(input.value.trim());
  if (!entity) return;
  input.value = '';
  el('cmStreetRoster').innerHTML = '';
  toggleSelect(entity);
}

/* ---------- city picker (neighborhood level) ---------- */

function updateCityRoster(query) {
  const q = query.trim().toLowerCase();
  const names = Object.keys(MAP_CITIES_WGS84).filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 40);
  el('cmCityRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ---------- city picker (city level) - a map click always REPLACES the
   pick (see pickSolo); this is the manual-add path (like the street/
   neighborhood search) for building a multi-city compare list, up to
   MAX_SELECT, without having to click each one on the map. ---------- */

function updateCityAddRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('cmCityAddRoster').innerHTML = ''; return; }
  const names = Object.keys(MAP_CITIES_WGS84).filter((n) => n.toLowerCase().includes(q)).slice(0, 40);
  el('cmCityAddRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

function commitCityAddPick() {
  const input = el('cmCityAddPick');
  const name = input.value.trim();
  if (!MAP_CITIES_WGS84[name]) return;
  input.value = '';
  el('cmCityAddRoster').innerHTML = '';
  const entity = { key: name, label: name, city: name, level: 'city', rings: MAP_CITIES_WGS84[name].rings };
  // Only on the way IN - toggleSelect() below also handles re-typing an
  // already-selected city to remove it again, and jumping the view to a
  // city that's being taken OFF the comparison list would be backwards.
  const isNew = selectedIndex(entity.key) === -1;
  toggleSelect(entity); // calls renderAll() -> renderMap() internally
  if (isNew && leafletMap) {
    leafletMap.fitBounds(L.geoJSON(entityToFeature(entity)).getBounds());
  }
}

/* ---------- neighborhood picker (neighborhood level) - a map click always
   REPLACES the pick (see pickSolo); this is the manual-add path (like the
   street search) for building a multi-neighborhood compare list, up to
   MAX_SELECT - searches every city's neighborhoods, not just whichever one
   is currently filtered into view (or even before any city is filtered at
   all), the same way the street search always has. ---------- */

function updateNbRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('cmNbRoster').innerHTML = ''; return; }
  const hits = nbEntries().filter((e) => e.label.toLowerCase().includes(q)).slice(0, 40);
  el('cmNbRoster').innerHTML = hits.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function commitNbPick() {
  const input = el('cmNbPick');
  const entity = nbLabelMap().get(input.value.trim());
  if (!entity) return;
  input.value = '';
  el('cmNbRoster').innerHTML = '';
  toggleSelect(entity);
}

/* ---------- wiring ---------- */

function renderControls() {
  document.querySelectorAll('.cm-level-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  });
  document.querySelectorAll('.cm-layer-btn').forEach((btn) => {
    // City level: 1-3 layers can be active at once (multi-metric bar
    // glyphs) - every one of state.cityLayers lights up. Other levels keep
    // the original exclusive/radio behavior on state.layer alone.
    const active = state.level === 'city'
      ? state.cityLayers.includes(btn.dataset.layer)
      : btn.dataset.layer === state.layer;
    btn.classList.toggle('active', active);
  });
  el('cmLayerSection').hidden = state.level === 'street';
  el('cmCityAddRow').hidden = state.level !== 'city';
  el('cmCityPickRow').hidden = state.level !== 'neighborhood';
  el('cmNbPickRow').hidden = state.level !== 'neighborhood';
  el('cmStreetPickRow').hidden = state.level !== 'street';
  el('cmCityPick').value = state.cityFilter || '';
  updateCityRoster('');
}

function renderAll() {
  renderControls();
  renderChips();
  renderDetail();
  renderMap();
}

document.querySelectorAll('.cm-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nextLevel = btn.dataset.level;
    if (state.level === nextLevel) return;
    // Same state.layer <-> state.cityLayers sync as drillOutToCity (zooming
    // back out of a city) - switching level via these tabs is another path
    // between the two, and needs the same fix for the same reason.
    if (state.level === 'city' && nextLevel !== 'city') {
      state.layer = state.cityLayers[state.cityLayers.length - 1] || state.layer;
    } else if (state.level !== 'city' && nextLevel === 'city') {
      state.cityLayers = [state.layer];
    }
    state.level = nextLevel;
    state.cityFilter = null;
    state.selected = [];
    state.view = null;
    syncUrl();
    renderAll();
  });
});

document.querySelectorAll('.cm-layer-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.layer;
    if (state.level === 'city') {
      // Toggle membership (up to 3, at least 1 always active) rather than
      // the exclusive pick used at other levels - this is what feeds the
      // multi-metric bar glyphs in renderMap().
      const i = state.cityLayers.indexOf(id);
      if (i !== -1) {
        if (state.cityLayers.length === 1) return; // never zero active metrics
        state.cityLayers.splice(i, 1);
      } else {
        state.cityLayers.push(id);
      }
    } else {
      if (state.layer === id) return;
      state.layer = id;
    }
    syncUrl();
    renderControls();
    renderMap();
  });
});

el('cmCityAddPick').addEventListener('input', debounce((ev) => updateCityAddRoster(ev.target.value), 120));
el('cmCityAddPick').addEventListener('change', commitCityAddPick);
el('cmCityAddPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitCityAddPick(); } });

el('cmCityPick').addEventListener('input', debounce((ev) => updateCityRoster(ev.target.value), 120));
const commitCity = () => {
  const val = el('cmCityPick').value.trim();
  state.cityFilter = MAP_CITIES_WGS84[val] ? val : null;
  state.selected = [];
  state.view = null;
  syncUrl();
  renderAll();
};
el('cmCityPick').addEventListener('change', commitCity);
el('cmCityPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitCity(); } });

el('cmNbPick').addEventListener('input', debounce((ev) => updateNbRoster(ev.target.value), 120));
el('cmNbPick').addEventListener('change', commitNbPick);
el('cmNbPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitNbPick(); } });

el('cmStreetPick').addEventListener('input', debounce((ev) => updateStreetRoster(ev.target.value), 120));
el('cmStreetPick').addEventListener('change', commitStreetPick);
el('cmStreetPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitStreetPick(); } });

// Street/aerial/topo tile source for the real-map background above - all
// three share the same slippy-tile grid, so switching needs nothing beyond
// swapping the tile layer's own URL template (see updateTileLayer()). Each
// button is its own on/off toggle rather than a plain radio group: clicking
// the currently-active one turns the real-map background off entirely
// (state.osm false), clicking a different one switches state.basemapKind
// and leaves exactly that one active - "just one background" at a time,
// but with an explicit off state too, not a fixed always-on default.
document.querySelectorAll('.cm-basemap-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.basemap;
    const alreadyActive = state.osm && state.basemapKind === kind;
    state.osm = !alreadyActive;
    state.basemapKind = kind;
    document.querySelectorAll('.cm-basemap-btn').forEach((b) => {
      b.classList.toggle('active', state.osm && b.dataset.basemap === kind);
    });
    renderMap();
  });
});

// One-click "show the topography under this view" shortcut right next to
// the fullscreen toggle, driving the exact same state.osm/state.basemapKind
// as the "רקע מפה" section's own button row above, rather than making a
// visitor find that section and turn topo on by hand first. A true toggle:
// pressing it again while topo is already showing turns the real-map
// background off entirely, same as pressing the topo button there would.
el('cmTopoQuickToggle').addEventListener('click', () => {
  const alreadyTopo = state.osm && state.basemapKind === 'topo';
  state.osm = !alreadyTopo;
  state.basemapKind = 'topo';
  document.querySelectorAll('.cm-basemap-btn').forEach((b) => {
    b.classList.toggle('active', state.osm && b.dataset.basemap === 'topo');
  });
  renderMap();
});

// Leaflet caches its own container size and doesn't detect a CSS-only
// resize (window resize, or a layout change like the sidebar wrapping
// under the map on a narrow screen) on its own - invalidateSize() re-
// measures and keeps the current center in place. Debounced since a window
// drag fires many resize events in a row.
const onMapResize = debounce(() => { leafletMap?.invalidateSize(); }, 150);
new ResizeObserver(onMapResize).observe(el('cmMap'));

el('cmHiResToggle').addEventListener('change', (ev) => {
  state.hiRes = ev.target.checked;
  renderMap();
});
el('cmBlobToggle').addEventListener('change', (ev) => {
  state.heatBlob = ev.target.checked;
  renderMap();
});
el('cmCanopyBlobToggle').addEventListener('change', (ev) => {
  state.canopyBlob = ev.target.checked;
  renderMap();
});

// Back to the page's own initial state - level/layer/city pick/selection/
// pan-zoom/every toggle (OSM basemap, hi-res + both blob overlays) all
// reset together, since none of those are reachable any other way once
// several are combined (e.g. hi-res-only + a drilled-in city + a zoomed-in
// view) - a single button beats hunting down which control to switch back.
// Checkboxes are DOM state, not derived from `state` by renderControls()
// the way the level/layer buttons' own `.active` class is - each one needs
// unchecking here explicitly, or a stale checked box would say one thing
// while the map itself shows another.
el('cmFullReset').addEventListener('click', () => {
  state.level = 'city';
  state.layer = 'heat';
  state.cityLayers = ['heat'];
  state.cityFilter = null;
  state.osm = false;
  state.basemapKind = 'street';
  state.hiRes = true;
  state.heatBlob = false;
  state.canopyBlob = false;
  state.selected = [];
  state.view = { ...DEFAULT_VIEW };
  document.querySelectorAll('.cm-basemap-btn').forEach((b) => b.classList.remove('active'));
  el('cmHiResToggle').checked = true;
  el('cmBlobToggle').checked = false;
  el('cmCanopyBlobToggle').checked = false;
  syncUrl();
  renderAll();
});

/* ---------- mobile fullscreen takeover - a tap on the map on a narrow
   viewport expands #cmMap's own container to fill the screen instead of
   navigating anywhere or replacing any element, so the SAME Leaflet map
   instance just gets a bigger box (invalidateSize() below makes Leaflet
   re-measure it - it caches its own container size and has no way to
   detect a CSS-only change on its own). A back-icon button (shown only
   while fullscreen) or Escape exits back to the normal embedded size. ---- */

const MOBILE_MAP_BREAKPOINT = '(max-width: 640px)'; // matches this file's/style.css's own mobile breakpoint elsewhere
const mapWrap = document.querySelector('.cm-map-wrap');

function isMapFullscreen() {
  return mapWrap.classList.contains('cm-map-fullscreen');
}

function enterMapFullscreen() {
  mapWrap.classList.add('cm-map-fullscreen');
  el('cmMapExitFullscreen').hidden = false;
  document.body.style.overflow = 'hidden'; // the map now covers the viewport - nothing behind it should scroll
  leafletMap?.invalidateSize();
}

function exitMapFullscreen() {
  mapWrap.classList.remove('cm-map-fullscreen');
  el('cmMapExitFullscreen').hidden = true;
  document.body.style.overflow = '';
  leafletMap?.invalidateSize();
}

el('cmMapExitFullscreen').addEventListener('click', exitMapFullscreen);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && isMapFullscreen()) exitMapFullscreen();
});

// Explicit toggle button (⛶, alongside the zoom controls) - the only way
// IN on desktop, where a plain click on the map already does something
// else (select a city/neighborhood) and shouldn't also jump to fullscreen
// unprompted. Doubles as an exit on both desktop and mobile, alongside the
// dedicated back-icon button/Escape.
el('cmMapFullscreenToggle').addEventListener('click', () => {
  if (isMapFullscreen()) exitMapFullscreen(); else enterMapFullscreen();
});

readStateFromUrl();
resolveSelectedFromUrl();
renderAll();
