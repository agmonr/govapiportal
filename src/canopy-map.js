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
 * Rendered as SVG, not canvas, for free per-shape hover/click via normal
 * DOM events. No basemap tiles by default - the shapes' own outlines
 * already read as a map (the same convention any thematic/choropleth map
 * uses), and skipping a live OSM fetch keeps the default view instant and
 * self-contained. An optional real-OSM-tile background is offered anyway
 * (default off), only at neighborhood level once a single city is picked -
 * geo-utils.js's tile stitcher caps itself at 64 tiles (OSM's own usage
 * policy), and a whole-country bbox at any legible resolution needs far
 * more than that, while a single city's extent does not.
 */

import { el, esc, num, debounce } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchBasemapCanvasWGS84 } from './geo-utils.js';
import { renderHBarChart } from './charts.js';
import { bboxOfRingsList, itmViewBox, projectItm, ringsToPathD, attachZoomPan } from './map-shapes.js';

import { MAP_CITIES } from './map-boundaries-cities.js';
import { MAP_NEIGHBORHOODS } from './map-boundaries-neighborhoods.js';
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
    label: 'כיסוי חופות כולל', unit: '%', colorVar: 'var(--accent)', page: './tree-canopy.html',
    valueForCity: (name) => CITY_CANOPY[name]?.pct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY[key]?.pct,
    valueForStreet: (key) => STREET_CANOPY[key]?.pct,
  },
  street: {
    label: 'עצי רחוב (ציבורי)', unit: '%', colorVar: 'var(--accent)', page: './canopy-split.html',
    valueForCity: (name) => CITY_CANOPY_SPLIT[name]?.publicPct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY_SPLIT[key]?.publicPct,
  },
  heat: {
    label: 'דלתת חום מרבית', unit: '°C', colorVar: 'var(--danger)', page: './heat-islands.html',
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
    nbEntriesCache = Object.entries(MAP_NEIGHBORHOODS).map(([key, v]) => {
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

// Press-and-hold (mouse or touch) on a city/neighborhood shape, used by the
// context-submenu wiring further down - a fixed delay before it fires
// (matches the general "long press" feel on mobile OSes) and a small
// movement tolerance (a real long press on a touchscreen rarely holds
// perfectly still) before it's cancelled as a pan/drag starting instead.
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

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

// `view` is the map's own zoom/pan viewBox {x,y,w,h} - null means "not
// customized, use the auto-fit box for whatever's currently shown". Kept
// across a layer switch (same geometry, just recolored) but reset on
// level/city change (currentEntities() returns different shapes entirely,
// so a leftover zoom rectangle wouldn't line up with anything).
// `layer` (single) colors neighborhood/street level, unchanged from the
// original design. `cityLayers` (1-3, toggled independently) is city-level
// only: with exactly one active it behaves identically to `layer` (a
// single choropleth fill); with 2-3 active, each city instead gets a small
// multi-bar glyph (one bar per active metric, sized to its own value) -
// scoped to city level specifically because that's the only level where
// zooming in doesn't immediately drill away to something else, and where
// ~186 shapes stay legible with an extra glyph on each.
// Jerusalem, zoomed in - the page's own starting view (and what "איפוס למפה
// המקורית" below returns to), rather than the auto-fit full-country box.
const DEFAULT_VIEW = { x: 208021, y: -653494.8, w: 12749.7, h: 36901.5 };

const state = {
  level: 'city', layer: 'heat', cityLayers: ['heat'], cityFilter: null, osm: false, heatBlob: false, canopyBlob: false, hiRes: true, selected: [], view: { ...DEFAULT_VIEW },
};
let currentZoomPan = null; // torn down and replaced fresh each renderMap() - see attachZoomPan's own docstring
let lastViewBox = null; // the ResizeObserver below (outside renderMap's own scope) falls back on this when state.view is still null (nothing panned/zoomed yet)

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
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [x, y, w, h] = parts;
      state.view = { x, y, w, h };
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
    const { x, y, w, h } = state.view;
    p.set('v', [x, y, w, h].map((n) => Math.round(n * 10) / 10).join(','));
  }
  history.replaceState(null, '', `?${p}`);
}
const syncUrlDebounced = debounce(syncUrl, 300); // wheel/drag fire many updates per gesture - one URL write per pause, not per event

/* ---------- zoom-to-drill: zooming into one city on the city-level map
   switches to its own neighborhoods (and zooming back out switches back),
   like how a real map app reveals finer detail as you zoom in, rather
   than just enlarging the same coarse shapes forever. ---------- */

// [xmin, ymin, xmax, ymax, cx, cy] per city, built once from the already-
// loaded MAP_CITIES rings - cheap enough (186 cities) to keep around for
// every zoom/pan event, rather than recomputing bboxes on each one.
let cityBBoxCache = null;
function cityBBoxes() {
  if (!cityBBoxCache) {
    cityBBoxCache = {};
    for (const [name, data] of Object.entries(MAP_CITIES)) {
      const [xmin, ymin, xmax, ymax] = bboxOfRingsList([data.rings]);
      // Stored Y-flipped (see itmViewBox's docstring) - the same space
      // state.view lives in - so shouldDrillOut can compare them directly
      // with no further conversion. Flipping swaps which raw value is the
      // min vs the max.
      const fymin = -ymax;
      const fymax = -ymin;
      cityBBoxCache[name] = [xmin, fymin, xmax, fymax, (xmin + xmax) / 2, (fymin + fymax) / 2];
    }
  }
  return cityBBoxCache;
}

// Comparing view.w/view.h against a city's own w/h directly doesn't work:
// the view's aspect ratio is inherited from the national fit (Israel is
// ~3x taller than wide) and essentially never matches a given city's own
// roughly-square extent, and zooming scales both dimensions by the same
// factor - so a still-tall, narrow-enough-in-x view could satisfy a
// width-based check while its height still spans clear past the target
// city into another city's territory entirely (found exactly this bug
// live: zooming toward Tel Aviv drilled into Dimona instead, because the
// view's still-large height reached that far south). What actually
// matters is what FRACTION OF THE CURRENT VIEW a city's bbox covers -
// aspect-ratio-agnostic, and directly answers "is this city dominating
// what's on screen right now."
function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a[2], b.x + b.w) - Math.max(a[0], b.x));
  const oy = Math.max(0, Math.min(a[3], b.y + b.h) - Math.max(a[1], b.y));
  return ox * oy;
}

// Lower fraction of the view a city's bbox needs to cover before zooming
// back OUT drops back to city level - picking a city to view (the reverse
// direction) is manual only now (see the path click handler below and
// commitCity), the map itself no longer drills IN on its own.
const DRILL_OUT_FRACTION = 0.06;

function shouldDrillOut(view, cityName) {
  const bbox = cityBBoxes()[cityName];
  if (!bbox) return false;
  return overlapArea(bbox, view) / (view.w * view.h) < DRILL_OUT_FRACTION;
}

// Different question from shouldDrillOut, used only to decide which
// cities' hi-res blobs to show at city level itself, without an actual
// level switch or city pick: which cities are meaningfully on screen right
// now? Originally just the single most-dominant city above a high
// threshold (so blobs only ever appeared zoomed in close on one city) -
// widened to every city clearing a much lower bar, so blobs also show
// while zoomed out far enough to see a cluster of cities at once, not just
// one. CITY_VIEW_MAX_COUNT (the top N by view-overlap) is what actually
// bounds this now, NOT the fraction floor: a percentage-of-view threshold
// mathematically can't survive zooming out much further than "a handful of
// cities visible at once" - once a dozen-plus cities share the view, every
// one of them individually drops under almost any fixed floor, which was a
// real bug (blobs would vanish - "holes in the map" - well before the
// count cap ever kicked in, even though visibly showing up to
// CITY_VIEW_MAX_COUNT cities was exactly the point). CITY_VIEW_MIN_FRACTION
// only filters out a city barely grazing the view's edge, not "is this
// city prominent" - that's what the sort + slice below is for. Even the
// fully-zoomed-out national view stays bounded at CITY_VIEW_MAX_COUNT
// simultaneous fetches (the largest cities by view-overlap), rather than
// all 186 at once, which would defeat the point of lazy-loading them in
// the first place (see HEAT_BLOBS'/CANOPY_BLOBS' own header comments).
const CITY_VIEW_MIN_FRACTION = 0.0002;
const CITY_VIEW_MAX_COUNT = 15;
function citiesInView(view) {
  if (!view) return [];
  const hits = [];
  for (const [name, bbox] of Object.entries(cityBBoxes())) {
    const frac = overlapArea(bbox, view) / (view.w * view.h);
    if (frac >= CITY_VIEW_MIN_FRACTION) hits.push([name, frac]);
  }
  hits.sort((a, b) => b[1] - a[1]);
  return hits.slice(0, CITY_VIEW_MAX_COUNT).map(([name]) => name);
}

// Background warm-up for cities just outside citiesInView()'s own rendered
// top-CITY_VIEW_MAX_COUNT set: right now a city's blob PNG only starts
// downloading the instant it becomes one of the RENDERED cities, so
// panning, zooming out to reveal more cities, or zooming further into one
// that was on screen but past the render cap, all show a visible pop-in
// while that first-ever fetch is in flight. The browser's own HTTP cache
// already makes a REVISIT free (no re-fetch for a city already viewed) -
// this only adds a proactive warm-up for cities close enough that panning/
// zooming to bring them into the rendered set is one gesture away, so
// their fetch is already resolved (or well under way) by the time they'd
// actually need to appear. `pad` widens the scan past the exact current
// view (covers panning/zooming out just beyond the edges); cities pushed
// out by the render cap while still literally on screen (the zoom-IN case)
// are covered too, since the scan has no count cap of its own here - only
// PREFETCH_MAX bounds how many NEW warm-ups happen per call, so a fully
// zoomed-out national view doesn't warm every one of the 186 cities.
const PREFETCH_PAD = 0.5; // view padded by this fraction (each side) before scanning for candidates
const PREFETCH_MAX = 45;
const warmedBlobCities = new Set(); // cities already warmed this page load - re-triggering Image().src is a harmless cache hit, but no need to bother
function warmBlobImage(src) {
  const img = new Image();
  if ('fetchPriority' in img) img.fetchPriority = 'low'; // best-effort - Chromium supports it, a browser without it just fetches at normal priority
  img.src = src;
}
function prefetchNearbyBlobs(view, renderedCities) {
  if (!view) return;
  const padded = {
    x: view.x - (view.w * PREFETCH_PAD) / 2,
    y: view.y - (view.h * PREFETCH_PAD) / 2,
    w: view.w * (1 + PREFETCH_PAD),
    h: view.h * (1 + PREFETCH_PAD),
  };
  const rendered = new Set(renderedCities);
  const candidates = [];
  for (const [name, bbox] of Object.entries(cityBBoxes())) {
    if (rendered.has(name) || warmedBlobCities.has(name)) continue;
    if (!HEAT_BLOBS[name] && !CANOPY_BLOBS[name]) continue;
    const frac = overlapArea(bbox, padded) / (padded.w * padded.h);
    if (frac >= CITY_VIEW_MIN_FRACTION) candidates.push([name, frac]);
  }
  candidates.sort((a, b) => b[1] - a[1]); // nearest/most-prominent first, in case PREFETCH_MAX cuts the list off
  for (const [name] of candidates.slice(0, PREFETCH_MAX)) {
    if (HEAT_BLOBS[name]) warmBlobImage(HEAT_BLOBS[name].src);
    if (CANOPY_BLOBS[name]) warmBlobImage(CANOPY_BLOBS[name].src);
    warmedBlobCities.add(name);
  }
}

function drillOutToCity(priorView) {
  state.level = 'city';
  state.cityFilter = null;
  // Neighborhood/street level color by the single state.layer, city level
  // by state.cityLayers (1-3 at once, for the bar glyphs) - these are two
  // separate fields that don't sync themselves, so without this the map
  // would silently fall back to whatever cityLayers was last set to
  // (possibly the ['canopy'] default) instead of the metric just being
  // viewed at neighborhood level.
  state.cityLayers = [state.layer];
  state.selected = [];
  state.view = { ...priorView };
  syncUrl();
  renderAll();
}

/* ---------- entities for the current level ---------- */

function currentEntities() {
  if (state.level === 'city') {
    return Object.keys(MAP_CITIES).map((name) => ({ key: name, label: name, city: name, level: 'city', rings: MAP_CITIES[name].rings }));
  }
  if (state.level === 'neighborhood') {
    if (!state.cityFilter) return [];
    const prefix = `${state.cityFilter}::`;
    return Object.entries(MAP_NEIGHBORHOODS)
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

const MAX_DIM = 720; // OSM basemap fetch size in px - the flat (non-OSM) viewBox no longer scales into a fixed pixel box, see itmViewBox

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

/* ---------- multi-metric glyph (city level, 2-3 active metrics) - one
   small bar per active metric at the city's own centroid, height scaled to
   that metric's own value/domain, instead of one shared fill color. Sizes
   are plain ITM meters, not screen pixels - reasonable at city level's own
   zoom range specifically because zooming in past a threshold there
   already hands off to neighborhood level (zoom-to-drill) before a fixed
   meter size would look wrong. ---------- */

const GLYPH_BAR_W = 900;
const GLYPH_BAR_GAP = 220;
const GLYPH_MAX_H = 4200;
const GLYPH_MIN_H = 60; // a 0-value bar still reads as "a bar," not a missing sliver

function glyphMarkup(entity, metricIds, domains) {
  const bbox = cityBBoxes()[entity.key];
  if (!bbox) return '';
  const [, , , , cx, cy] = bbox;
  const n = metricIds.length;
  const totalW = n * GLYPH_BAR_W + (n - 1) * GLYPH_BAR_GAP;
  const startX = cx - totalW / 2;
  const bars = metricIds.map((id, i) => {
    const v = valueFor(entity, id);
    const [min, max] = domains[id];
    const frac = v != null && max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
    const h = Math.max(frac * GLYPH_MAX_H, GLYPH_MIN_H);
    const x = startX + i * (GLYPH_BAR_W + GLYPH_BAR_GAP);
    return `<rect x="${x.toFixed(1)}" y="${(cy - h).toFixed(1)}" width="${GLYPH_BAR_W}" height="${h.toFixed(1)}" fill="${METRICS[id].colorVar}" />`;
  }).join('');
  // pointer-events none: clicking/hovering the glyph still hits the city
  // shape underneath (same select/tooltip behavior as clicking anywhere
  // else on that city), not a second, separate interaction target.
  return `<g pointer-events="none">${bars}</g>`;
}

/* ---------- name labels (city/neighborhood) - shown only once a shape is
   big enough on screen to fit its name legibly, updated live as the user
   zooms/pans (see updateLabels, called from attachZoomPan's onChange). ---- */

const LABEL_MIN_PX = 26; // the shape's own smaller bbox dimension must render at least this big first
const LABEL_FONT_PX = 12; // desired ON-SCREEN size, independent of current zoom

function entityLabelMarkup(e) {
  const [xmin, ymin, xmax, ymax] = bboxOfRingsList([e.rings]);
  const cx = (xmin + xmax) / 2;
  const cy = -(ymin + ymax) / 2; // Y-flipped, same convention projectItm/cityBBoxes use
  const minDim = Math.min(xmax - xmin, ymax - ymin);
  return `<text class="cm-label" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" data-min="${minDim.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" pointer-events="none">${esc(e.label)}</text>`;
}

const LABEL_DECLUTTER_PAD_PX = 2; // a little breathing room beyond exact pixel touch, not just zero-gap

// scale = screen px per meter, matching preserveAspectRatio="xMidYMid meet"'s
// own (smaller-of-the-two-axes) fit - the same reason a city's roughly-
// square bbox never fills 100% of the national view's tall/narrow one (see
// overlapArea's own comment on this). Cheap - just a per-element number
// comparison and attribute set, safe to run on every single zoom/pan tick.
function updateLabelVisibility(svg, view) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height || !view || !view.w || !view.h) return null;
  const scale = Math.min(rect.width / view.w, rect.height / view.h);
  const fontSize = LABEL_FONT_PX / scale; // constant on-screen size at any zoom level
  svg.querySelectorAll('.cm-label').forEach((el) => {
    const visible = Number(el.dataset.min) * scale >= LABEL_MIN_PX;
    el.style.display = visible ? '' : 'none';
    if (visible) el.setAttribute('font-size', fontSize.toFixed(2));
  });
  return scale;
}

// A cluster of small, tightly-packed neighborhoods can each individually
// pass updateLabelVisibility()'s own per-shape size test while their
// rendered text still overlaps each other - that test only ever looks at
// one shape at a time, not its neighbors. This hides whichever labels in
// a crowded cluster would visually collide, keeping only one per cluster
// rather than shipping illegible overlapping text. getBBox() forces a
// layout flush per call - expensive enough during a live drag/zoom to
// visibly lag it, which is why the caller (updateLabels, below) only runs
// this debounced, once a gesture actually settles.
function declutterOverlappingLabels(svg, scale) {
  if (!scale) return;
  const padMeters = LABEL_DECLUTTER_PAD_PX / scale;
  const candidates = [...svg.querySelectorAll('.cm-label')].filter((el) => el.style.display !== 'none');
  // Bigger shapes win a crowded cluster - keeping the small one instead
  // would be the least useful pick, not an arbitrary one.
  candidates.sort((a, b) => Number(b.dataset.min) - Number(a.dataset.min));
  const accepted = [];
  candidates.forEach((el) => {
    const box = el.getBBox();
    const box2 = { x: box.x - padMeters, y: box.y - padMeters, w: box.width + 2 * padMeters, h: box.height + 2 * padMeters };
    const overlaps = accepted.some((o) => box2.x < o.x + o.w && box2.x + box2.w > o.x && box2.y < o.y + o.h && box2.y + box2.h > o.y);
    if (overlaps) el.style.display = 'none';
    else accepted.push(box2);
  });
}

const declutterDebounced = debounce(declutterOverlappingLabels, 120);

function updateLabels(svg, view, { immediate = false } = {}) {
  const scale = updateLabelVisibility(svg, view);
  if (immediate) declutterOverlappingLabels(svg, scale);
  else declutterDebounced(svg, scale);
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

/* ---------- full-page links: canopy-map is an index INTO the existing
   pages, not a replacement for their tables/leaderboards/CSV export ---------- */

function fullPageLink(metricId) {
  const m = METRICS[metricId];
  const entries = state.selected.filter((e) => valueForLevel(m, e.level, e.key) != null);
  if (!entries.length) return null;
  const p = new URLSearchParams();
  p.set('level', state.level);
  entries.forEach((e, i) => p.set(`p${i + 1}`, e.label));
  if (state.level === 'neighborhood' && state.cityFilter) p.set('city', state.cityFilter);
  return `${m.page}?${p}`;
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

/* ---------- OSM basemap overlay (neighborhood level only, default off) ---------- */

let osmToken = 0; // guards a slow fetch from clobbering a newer render

async function renderOsmBasemap(entities) {
  const myToken = (osmToken += 1);
  const canvasEl = el('cmBasemap');
  const statusEl = el('cmOsmStatus');
  const wgsRingsList = entities.map((e) => MAP_NEIGHBORHOODS_WGS84[e.key]?.rings || []);
  const bbox = bboxOfRingsList(wgsRingsList);
  statusEl.textContent = 'טוען מפת רקע…';
  try {
    const { canvas, project } = await fetchBasemapCanvasWGS84(bbox, MAX_DIM);
    if (myToken !== osmToken) return null; // superseded meanwhile
    canvasEl.replaceChildren(canvas);
    canvasEl.hidden = false;
    statusEl.textContent = '';
    return {
      width: MAX_DIM,
      height: MAX_DIM,
      // Same 2-arg (x, y) shape ringsToPathD already calls for the flat
      // projector - here x/y are lon/lat (see ringsFor below, which swaps in
      // the WGS84 rings for this mode), not ITM meters.
      project: (lon, lat) => project(lon, lat),
      wgsRingsByKey: Object.fromEntries(entities.map((e, i) => [e.key, wgsRingsList[i]])),
    };
  } catch (err) {
    if (myToken !== osmToken) return null;
    canvasEl.hidden = true;
    statusEl.textContent = 'לא ניתן לטעון מפת רקע (אזור גדול מדי או שגיאת רשת) - מוצג ללא רקע.';
    state.osm = false;
    el('cmOsmToggle').checked = false;
    return null;
  }
}

/* ---------- map (city/neighborhood only) ---------- */

async function renderMap() {
  hideContextMenu(); // a fresh render replaces svg.innerHTML entirely - an open menu's own item(s) would point at now-stale entities/closures
  cancelActivePress(); // same reason - a pending long-press timer's own closure (entity, ev.clientX/Y) would otherwise fire against a path that no longer exists
  const mapSection = el('cmMapSection');
  mapSection.hidden = state.level === 'street';
  if (state.level === 'street') {
    currentZoomPan?.destroy(); // no shapes/interaction while hidden - nothing left to leave listening
    currentZoomPan = null;
    return;
  }

  const entities = currentEntities();
  // cityLayers (1-3) only ever applies at city level - neighborhood/street
  // always use the single `layer` radio-style pick, unchanged from before
  // this feature existed.
  const activeMetricIds = state.level === 'city' ? state.cityLayers : [state.layer];
  const domains = computeDomains(entities, activeMetricIds);
  const isMultiMetric = activeMetricIds.length > 1;

  el('cmOsmRow').hidden = state.level !== 'neighborhood' || !state.cityFilter;
  el('cmBasemap').hidden = true;

  // `viewBox` is always {x,y,w,h} - ITM meters (Y-negated) in flat mode,
  // OSM's own fixed pixel space when that mode is active. The two are NOT
  // interchangeable (see itmViewBox's own docstring for why this used to
  // be a real bug) - isItmSpace tells the onChange handler below whether
  // it's safe to compare the live view against cityBBoxes() at all.
  let viewBox; let project; let ringsFor = (e) => e.rings; let isItmSpace = true;
  if (state.osm && state.level === 'neighborhood' && state.cityFilter && entities.length) {
    const osm = await renderOsmBasemap(entities);
    if (osm) {
      viewBox = { x: 0, y: 0, w: osm.width, h: osm.height };
      project = (x, y) => osm.project(x, y);
      ringsFor = (e) => osm.wgsRingsByKey[e.key] || [];
      isItmSpace = false;
    }
  }
  if (!project) {
    const bbox = entities.length ? bboxOfRingsList(entities.map((e) => e.rings)) : [0, -1, 1, 0];
    viewBox = itmViewBox(bbox);
    project = projectItm;
  }
  // Which cities' raw-pixel/tree data (if any) backs the two hi-res blobs:
  // the traditional case is neighborhood level with a city chosen via the
  // text picker (always exactly one), but at city level - even with
  // nothing picked or selected - every city meaningfully on screen counts
  // too, whether that's one city zoomed in close or several zoomed out far
  // enough to see as a cluster (see citiesInView's own comment).
  const blobCities = state.level === 'neighborhood'
    ? (state.cityFilter ? [state.cityFilter] : [])
    : (state.level === 'city' && isItmSpace ? citiesInView(state.view || viewBox) : []);
  const heatBlobCities = blobCities.filter((c) => HEAT_BLOBS[c]);
  const canopyBlobCities = blobCities.filter((c) => CANOPY_BLOBS[c]);
  // The per-metric toggles are redundant once "hi-res only" mode (below)
  // forces both rasters on together - hidden rather than left sitting
  // there unchecked, which would misleadingly imply they're what's
  // controlling the current view.
  el('cmBlobRow').hidden = !heatBlobCities.length || state.hiRes;
  el('cmCanopyBlobRow').hidden = !canopyBlobCities.length || state.hiRes;
  // Same ITM-meters space as the neighborhood shapes themselves (see
  // heat-blobs.js's/canopy-blobs.js's own build comments) - drawn straight
  // under them with no conversion, but only when that space is actually
  // what's on screen (isItmSpace false means OSM's own fixed pixel space is
  // active instead). Normal mode: at most one raster TYPE shows (heat or
  // canopy, whichever per-metric toggle is on - heat wins if both somehow
  // are, nothing enforces them mutually exclusive, a rare enough case not
  // to be worth a UI lock for), but every in-view city's own image for
  // that type. Hi-res-only mode forces BOTH types on together regardless
  // of those toggles - "the high-res map of heat AND trees", not either/or.
  const heatBlobs = isItmSpace && (state.hiRes || state.heatBlob)
    ? heatBlobCities.map((c) => ({ data: HEAT_BLOBS[c], metric: 'heat' })) : [];
  const canopyBlobPicks = isItmSpace && (state.hiRes || state.canopyBlob)
    ? canopyBlobCities.map((c) => ({ data: CANOPY_BLOBS[c], metric: 'canopy' })) : [];
  const blobs = [...heatBlobs, ...canopyBlobPicks];
  const blob = blobs[0] || null; // single-blob call sites below (legend text, blobReplacesFill's own metric check) only care which TYPE is present, not which city - every entry of a given type shares the same metric

  const svg = el('cmSvg');
  // Once a high-res raster (blob) is showing for the metric it belongs to,
  // the per-neighborhood choropleth fill is redundant - it's the same
  // value at coarser granularity, sitting right on top of the pixel-
  // accurate data. Suppressed instead of just made translucent, so only
  // the raster and the neighborhood outlines/labels are visible - "the
  // high-res map, not the old by-neighborhood one" together in one view.
  // Hi-res-only mode suppresses the fill unconditionally, even at city
  // level or before a raster is actually available yet (e.g. city level,
  // or neighborhood level before a city is picked) - "borders only" is the
  // point of the mode, not just a side effect of a raster being present.
  const blobReplacesFill = state.hiRes || (!!blob && !isMultiMetric && activeMetricIds[0] === blob.metric);
  const opacity = (state.osm && !el('cmBasemap').hidden) || blobs.length ? '0.72' : '1';
  const titleFor = (e) => `${e.label} - ${activeMetricIds
    .map((id) => `${METRICS[id].label}: ${valueFor(e, id) != null ? num(valueFor(e, id)) + METRICS[id].unit : 'אין נתונים'}`)
    .join(' · ')}`;
  const paths = entities.map((e) => {
    const d = ringsToPathD(ringsFor(e), project);
    // Single metric: the shape's own fill carries the value, as before.
    // Multiple: the fill goes neutral and a bar glyph (drawn after all
    // shapes, see below) carries the values instead - a colored fill AND
    // bars on top would visually compete for the same city-shaped space.
    const fill = blobReplacesFill
      ? 'none'
      : isMultiMetric
      ? 'var(--map-nodata)'
      : colorFor(valueFor(e, activeMetricIds[0]), ...domains[activeMetricIds[0]], METRICS[activeMetricIds[0]].colorVar);
    const fillOpacity = blobReplacesFill ? '0' : opacity;
    const i = selectedIndex(e.key);
    // Normally var(--bg) here is deliberate - it reads as a thin gap
    // between two differently-COLORED fills, not a border meant to be seen
    // on its own. Once the fill itself is gone too (blobReplacesFill), that
    // same var(--bg) stroke made the whole shape invisible against the
    // page's own background - "the map is empty" wasn't the raster
    // failing to load, it was every border blending into the page.
    const stroke = i !== -1 ? PICK_COLORS[i] : (blobReplacesFill ? 'var(--fg)' : 'var(--bg)');
    const strokeWidth = i !== -1 ? '3' : '1.2';
    // pointer-events="all": SVG's own default (visiblePainted) only counts
    // a hit on the STROKE once fill="none" (hi-res-only mode, the site's
    // own default state) - the shape's entire interior silently stopped
    // registering clicks/right-clicks/long-presses the moment fill-opacity
    // dropped to 0, leaving only its ~1.2px-wide outline as a real target.
    // "all" restores hit-testing across the whole shape regardless of
    // whether its fill is actually painted.
    return `<path d="${d}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="all" data-key="${esc(e.key)}" tabindex="0" role="button" aria-pressed="${i !== -1}"><title>${esc(titleFor(e))}</title></path>`;
  }).join('');
  // Glyphs render after (on top of) every shape, positioned at each
  // city's own centroid (cityBBoxes() already computes one, reused here)
  // - city level + isItmSpace only, since neighborhood/street never reach
  // multi-metric mode and OSM's pixel space has no matching centroid cache.
  // Suppressed in hi-res-only mode too - a value-sized bar glyph is really
  // a second way of drawing the same choropleth values the fill would have
  // carried, which that mode is specifically trying to get out of the way.
  const glyphs = !state.hiRes && isMultiMetric && isItmSpace
    ? entities.map((e) => glyphMarkup(e, activeMetricIds, domains)).filter(Boolean).join('')
    : '';
  // Drawn first (underneath every shape) - the paths above them go semi-
  // transparent (see opacity above) so the raster(s) actually show through
  // instead of being fully hidden under an opaque fill. Both stack when
  // hi-res-only mode has turned both on - order doesn't matter much between
  // them since each is already alpha-punched to its own real coverage, not
  // a solid rectangle.
  const blobImage = blobs
    .map((b) => `<image href="${esc(b.data.src)}" x="${b.data.x}" y="${b.data.y}" width="${b.data.w}" height="${b.data.h}" preserveAspectRatio="none" pointer-events="none" />`)
    .join('');
  // Only in ITM/flat space - OSM mode projects through a different (WGS84
  // lon/lat -> its own fixed pixel space) function entirely, so a label
  // positioned from the entity's raw ITM bbox would land nowhere near its
  // actual OSM-mode shape.
  const labels = isItmSpace ? entities.map(entityLabelMarkup).join('') : '';
  svg.innerHTML = blobImage + paths + glyphs + labels;

  // svg (#cmSvg) is a persistent element - only its innerHTML/viewBox get
  // replaced each render, not the element itself - so the PREVIOUS
  // attachment's listeners must be torn down first, or they'd keep firing
  // alongside the new ones (see attachZoomPan's own docstring).
  currentZoomPan?.destroy();
  const cityFilterAtAttach = state.cityFilter;
  const levelAtAttach = state.level;
  const blobCitiesKeyAtAttach = [...blobCities].sort().join(' ');
  // citiesInView() (an O(186) scan + sort) and the renderMap() it can
  // trigger (full svg.innerHTML rebuild + attachZoomPan teardown/recreate)
  // are too expensive to run on every single wheel tick/pointermove sample
  // of an active gesture - debounced so they run once ~180ms after the
  // gesture pauses (including at release, since nothing keeps resetting
  // the timer once ticks stop) rather than on every intermediate sample.
  // Blobs still refresh live as a pan/zoom continues (the earlier "holes
  // in the map" fix's whole point) - just once per pause, not per event.
  const checkBlobCitiesDebounced = debounce((v) => {
    const inView = citiesInView(v);
    // .sort() here is alphabetical (a stable order for the SET-equality
    // string comparison below, matching blobCitiesKeyAtAttach's own
    // construction) - NOT the same as citiesInView's own internal
    // by-overlap-fraction sort, which prefetchNearbyBlobs below still
    // wants (nearest/most-prominent first), so it gets the pre-sort array.
    if ([...inView].sort().join(' ') !== blobCitiesKeyAtAttach) renderMap();
    prefetchNearbyBlobs(v, inView); // independent of whether the rendered set itself changed - see its own comment
  }, 180);
  const zoomPan = attachZoomPan(svg, state.view || viewBox, {
    onChange: (v) => {
      state.view = v;
      syncUrlDebounced();
      updateLabels(svg, v);
      if (!isItmSpace) return; // OSM's pixel space isn't comparable to cityBBoxes() at all
      // Leaving a city (zooming back out past DRILL_OUT_FRACTION) still
      // happens on the map - only ENTERING one no longer does (see the
      // path click handler below) - picking which city to view is manual
      // only now (level tab + the "בחירת עיר" text input), not something
      // the map itself triggers by scrolling/pinching in far enough. Kept
      // un-debounced (unlike the blob check below) - it's a cheap O(1)
      // bbox comparison, not a scan, so there's no per-tick cost to defer.
      if (cityFilterAtAttach && shouldDrillOut(v, cityFilterAtAttach)) {
        drillOutToCity(v);
        return;
      }
      // City level's own hi-res blobs (see blobCities above) track
      // whichever cities are currently in view, purely from panning/
      // zooming - no drill, no pick. A full re-render is the only way to
      // swap which cities' blob images are on screen, so one is triggered,
      // but only when the actual set changed (not on every pan/zoom tick,
      // and not just because the same cities got reordered by distance).
      if (levelAtAttach === 'city') checkBlobCitiesDebounced(v);
    },
  });
  currentZoomPan = zoomPan;
  lastViewBox = viewBox; // for the ResizeObserver below, which has no view of its own to fall back on
  // Immediate here (not debounced) - this is a fresh render, not a live
  // drag/zoom tick, so there's no gesture to wait out and a 120ms flash of
  // overlapping labels before the debounce fires would just be visible lag
  // for no reason.
  updateLabels(svg, state.view || viewBox, { immediate: true });
  el('cmZoomIn').onclick = () => zoomPan.zoomIn();
  el('cmZoomOut').onclick = () => zoomPan.zoomOut();
  el('cmZoomReset').onclick = () => { zoomPan.reset(); state.view = null; syncUrl(); };

  svg.querySelectorAll('path[data-key]').forEach((path) => {
    const entity = entities.find((x) => x.key === path.dataset.key);
    if (!entity) return;
    path.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pickSolo(entity); } });
    // Press-and-hold (mouse or touch) opens a submenu (see showContextMenu
    // below) - a right-click's own native 'contextmenu' event turned out
    // unreliable here in practice (mobile has no right-click at all, and
    // desktop browsers don't consistently deliver one once
    // setPointerCapture() - already in use by attachZoomPan's own
    // wheel/drag handling on this same svg - has claimed the pointer).
    // Only pointerdown is attached here, on the path itself, to learn
    // WHICH entity is being pressed - the cancel-tracking half (movement/
    // release) is a single shared document-level listener further below
    // (activePress), not one per path, specifically because that same
    // setPointerCapture() retargets every subsequent pointermove/pointerup
    // for this pointer to the svg element regardless of which child was
    // actually pressed - a pointermove/pointerup listener attached to this
    // path would simply never fire once capture kicks in on the very same
    // pointerdown.
    path.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return; // a real right-click still shouldn't ALSO start a long-press timer
      cancelActivePress();
      const timer = setTimeout(() => {
        activePress = null;
        lastLongPressKey = entity.key;
        // Quick data preview (canopy % + heat °C, the same two METRICS
        // canopy-heat-compare.html itself charts) shown right in the menu -
        // the numbers a visitor most likely wants are visible without
        // navigating anywhere; the link below is for the full compare view.
        const canopyVal = valueFor(entity, 'canopy');
        const heatVal = valueFor(entity, 'heat');
        const canopyText = canopyVal != null ? `${canopyVal.toFixed(1)}%` : 'אין נתונים';
        const heatText = heatVal != null ? `${heatVal > 0 ? '+' : ''}${heatVal.toFixed(1)}°C` : 'אין נתונים';
        showContextMenu(ev.clientX, ev.clientY, [
          { info: entity.label },
          { info: `${METRICS.canopy.label}: ${canopyText}` },
          { info: `${METRICS.heat.label}: ${heatText}` },
          {
            label: 'מידע איזורי על עצים וחום ←',
            onSelect: () => {
              const p = new URLSearchParams();
              p.set('level', entity.level);
              p.set('p1', entity.label);
              if (entity.level === 'neighborhood' && state.cityFilter) p.set('city', state.cityFilter);
              location.href = `./canopy-heat-compare.html?${p}`;
            },
          },
        ]);
      }, LONG_PRESS_MS);
      activePress = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, timer };
    });
  });

  // The choropleth scale would describe a fill that isn't drawn any more
  // (see blobReplacesFill above) - showing it would just be wrong, not
  // merely redundant, since each raster's own coloring follows a different
  // convention entirely (see cmBlobRow's/cmCanopyBlobRow's own hints): heat
  // is a per-crop, median-relative scale further weighted by how hot each
  // city runs nationally (see tools/heat_blobs.py's own render_city_heat);
  // canopy is a plain "is there a tree crown here, yes/no" mask, not a
  // value scale at all.
  if (state.hiRes) {
    const parts = [];
    if (heatBlobs.length) parts.push('כתם החום יחסי לחציון האזור, משוקלל לפי חום העיר ארצית');
    if (canopyBlobPicks.length) parts.push('כל נקודה ירוקה = צמרת עץ בודדת מהמיפוי המקורי');
    el('cmLegend').innerHTML = parts.length
      ? `<span class="cm-legend-nodata">גבולות בלבד, בלי צביעת ממוצע - ${esc(parts.join(' · '))}</span>`
      : '<span class="cm-legend-nodata">גבולות בלבד, בלי צביעת ממוצע - בחרו עיר והתקרבו לשכונות כדי לראות את הכתמים</span>';
  } else if (blobReplacesFill && blob.metric === 'heat') {
    el('cmLegend').innerHTML = '<span class="cm-legend-nodata">כתם החום מוצג לפי חציון האזור, משוקלל לפי חום העיר ארצית - אין סרגל צבע קבוע להשוואה</span>';
  } else if (blobReplacesFill && blob.metric === 'canopy') {
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

/* ---------- combined detail: all 3 metrics, one chart each, colored by
   which selected entity (not by metric) ---------- */

function renderDetailMetric(metricId, figId) {
  const m = METRICS[metricId];
  const entries = state.selected
    .map((e, i) => ({ e, v: valueForLevel(m, e.level, e.key), i }))
    .filter((row) => row.v != null)
    .map((row) => ({ label: row.e.label, value: row.v, color: PICK_COLORS[row.i] }));
  renderHBarChart(figId, m.label, entries, m.unit);
  const link = fullPageLink(metricId);
  const linkEl = el(`${figId}Link`);
  if (link) { linkEl.hidden = false; linkEl.href = link; } else { linkEl.hidden = true; }
}

function renderDetail() {
  const section = el('cmDetailSection');
  if (!state.selected.length) { section.hidden = true; return; }
  section.hidden = false;
  renderDetailMetric('canopy', 'cmDetailCanopy');
  renderDetailMetric('street', 'cmDetailStreet');
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
  const names = Object.keys(MAP_CITIES).filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 40);
  el('cmCityRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ---------- city picker (city level) - a map click always REPLACES the
   pick (see pickSolo); this is the manual-add path (like the street/
   neighborhood search) for building a multi-city compare list, up to
   MAX_SELECT, without having to click each one on the map. ---------- */

function updateCityAddRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('cmCityAddRoster').innerHTML = ''; return; }
  const names = Object.keys(MAP_CITIES).filter((n) => n.toLowerCase().includes(q)).slice(0, 40);
  el('cmCityAddRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

function commitCityAddPick() {
  const input = el('cmCityAddPick');
  const name = input.value.trim();
  if (!MAP_CITIES[name]) return;
  input.value = '';
  el('cmCityAddRoster').innerHTML = '';
  const entity = { key: name, label: name, city: name, level: 'city', rings: MAP_CITIES[name].rings };
  // Only on the way IN - toggleSelect() below also handles re-typing an
  // already-selected city to remove it again, and jumping the view to a
  // city that's being taken OFF the comparison list would be backwards.
  if (selectedIndex(entity.key) === -1) {
    state.view = itmViewBox(bboxOfRingsList([entity.rings]));
  }
  toggleSelect(entity);
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
  state.cityFilter = MAP_CITIES[val] ? val : null;
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

el('cmOsmToggle').addEventListener('change', (ev) => {
  state.osm = ev.target.checked;
  state.view = null; // OSM's pixel space and the flat ITM space aren't the same units - a carried-over view would point nowhere sensible
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

el('cmHiResToggle').addEventListener('change', (ev) => {
  state.hiRes = ev.target.checked;
  renderMap();
});

// The SVG's own shapes/image always redraw correctly on a container-size
// change - viewBox + preserveAspectRatio handle that without any JS
// involvement. Label sizing/visibility does not: it's computed in JS from
// the container's pixel dimensions (see updateLabelVisibility), which only
// ever got recomputed on a pan/zoom tick - resizing the window (or a
// layout change like the sidebar wrapping under the map on a narrow
// screen) left labels sized/shown for the OLD dimensions until the next
// zoom/pan, which read as the map "not always refreshing". Debounced the
// same way declutterOverlappingLabels is - a resize firing many times in a
// drag (window edge) shouldn't force a getBBox layout flush on every one.
const onSvgResize = debounce(() => {
  currentZoomPan?.invalidateRect(); // attachZoomPan's own cached getBoundingClientRect() - see its own comment - is now stale
  const svg = el('cmSvg');
  const view = state.view || lastViewBox;
  if (view) updateLabels(svg, view, { immediate: true });
}, 150);
new ResizeObserver(onSvgResize).observe(el('cmSvg'));

// Back to the page's own initial state - level/layer/city pick/selection/
// pan-zoom/every toggle (OSM basemap, both blob overlays, hi-res-only) all
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
  state.heatBlob = false;
  state.canopyBlob = false;
  state.hiRes = true;
  state.selected = [];
  state.view = { ...DEFAULT_VIEW };
  el('cmOsmToggle').checked = false;
  el('cmBlobToggle').checked = false;
  el('cmCanopyBlobToggle').checked = false;
  el('cmHiResToggle').checked = true;
  syncUrl();
  renderAll();
});

/* ---------- press-and-hold submenu trigger + right-click-style menu ----------
   Shared, single tracker (not one per path) for the "cancel a pending long
   press" half of the pointerdown wiring above - see that wiring's own
   comment for why a per-path pointermove/pointerup listener doesn't work
   here (setPointerCapture retargeting). At most one press can be
   candidate/active at a time (one pointer), so one module-level slot is
   enough regardless of how many shapes exist. */

let activePress = null; // { pointerId, startX, startY, timer } | null
let lastLongPressKey = null; // entity.key a long press JUST fired for - the click below (see its own comment) that follows release should skip picking it

function cancelActivePress() {
  if (activePress) clearTimeout(activePress.timer);
  activePress = null;
}

// Single delegated listener (attached once here, to the persistent #cmSvg
// element itself, NOT one per path/per render) for every city/neighborhood
// pick - the per-path 'click' listener this used to be attached directly
// to each <path> turned out to never fire for a REAL mouse/touch user:
// attachZoomPan's own pointerdown handler (map-shapes.js) calls
// svgEl.setPointerCapture() on every press (needed for drag-panning), and
// once that capture is active, Chromium retargets the resulting 'click'
// event's own `target` to the CAPTURING element (the svg) rather than
// whatever was actually under the cursor - verified directly (a real
// Playwright mouse click, not a synthetic dispatchEvent, landed with
// ev.target === the svg element itself, every single time). A path-level
// listener silently never receiving real clicks read as "picking a city/
// neighborhood on the map doesn't work" - not caught earlier because
// every prior test in this codebase used dispatchEvent(), which bypasses
// real hit-testing/capture retargeting entirely and gave false confidence.
// Fix: listen on the (never-retargeted) svg element and use
// document.elementFromPoint() - itself dependent on the path having
// pointer-events="all" (see the paths.map() above) rather than SVG's
// default visiblePainted, which stops registering hits the moment a
// shape's fill is transparent (hi-res-only mode, the site's own default) -
// to find which shape, if any, is actually under ev.clientX/clientY.
el('cmSvg').addEventListener('click', (ev) => {
  if (currentZoomPan?.isDragging()) return;
  const hit = document.elementFromPoint(ev.clientX, ev.clientY);
  const path = hit?.closest?.('path[data-key]');
  if (!path) return;
  if (lastLongPressKey === path.dataset.key) {
    // Releasing a long press also fires this click (ordinary browser
    // behavior for a pointerdown+pointerup with little movement between
    // them) - don't ALSO treat it as a pick, and stop it from bubbling to
    // the document-level dismiss listener below, which would otherwise
    // close the submenu this exact press just opened.
    lastLongPressKey = null;
    ev.stopPropagation();
    return;
  }
  const entity = currentEntities().find((x) => x.key === path.dataset.key);
  if (entity) pickSolo(entity);
});

document.addEventListener('pointermove', (ev) => {
  if (!activePress || ev.pointerId !== activePress.pointerId) return;
  const dx = ev.clientX - activePress.startX;
  const dy = ev.clientY - activePress.startY;
  if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) cancelActivePress();
});
document.addEventListener('pointerup', (ev) => {
  if (activePress && ev.pointerId === activePress.pointerId) cancelActivePress();
});
document.addEventListener('pointercancel', (ev) => {
  if (activePress && ev.pointerId === activePress.pointerId) cancelActivePress();
});

/* ---------- the submenu itself - a plain floating <ul> positioned at the
   cursor/touch point, currently offering one item (the canopy-heat-
   compare.html deep link), but built generically (a list of
   {label, onSelect}) so a second item later doesn't need a second menu
   component. ---------- */

function hideContextMenu() {
  const menu = el('cmContextMenu');
  menu.hidden = true;
  menu.innerHTML = '';
}

// items: {label, onSelect}[] for an actionable row, or {info}[] for a
// plain, non-interactive text row (e.g. a quick data preview above the
// actionable rows) - only the former gets a <button data-idx>, so the
// click-wiring loop further down only ever touches actionable rows.
function showContextMenu(x, y, items) {
  const menu = el('cmContextMenu');
  menu.innerHTML = items.map((item, i) => (item.info
    ? `<li role="none" class="cm-context-menu-info" dir="auto">${esc(item.info)}</li>`
    : `<li role="none"><button type="button" role="menuitem" data-idx="${i}">${esc(item.label)}</button></li>`)).join('');
  menu.hidden = false;
  // Measured only after becoming visible (hidden elements have no real
  // box) - clamped so a press near the map's own edge doesn't open a menu
  // that spills off-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll('button[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      hideContextMenu();
      items[Number(btn.dataset.idx)].onSelect();
    });
  });
}

// Dismiss on a click anywhere else - the long press's own trailing click
// (see the path-level 'click' handler's own comment above) is
// stopPropagation()'d before it ever reaches here, so this only ever sees
// a GENUINE click elsewhere, not the same press that just opened the menu
// - Escape, or the viewport changing under it (scroll/resize - a still-
// open menu positioned for a stale cursor location would otherwise float
// over the wrong spot).
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#cmContextMenu')) hideContextMenu();
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideContextMenu(); });
window.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', hideContextMenu);

/* ---------- mobile fullscreen takeover - a tap on the map on a narrow
   viewport expands #cmSvg's own container to fill the screen instead of
   navigating anywhere or replacing any element, so the already-attached
   zoom/pan listeners and current view just get a bigger box to work with
   (the ResizeObserver above already re-measures/re-labels on any size
   change to that same element, fullscreen included - nothing extra needed
   here for that part). A back-icon button (shown only while fullscreen)
   or Escape exits back to the normal embedded size. ---------- */

const MOBILE_MAP_BREAKPOINT = '(max-width: 640px)'; // matches this file's/style.css's own mobile breakpoint elsewhere
const mapWrap = document.querySelector('.cm-map-wrap');

function isMapFullscreen() {
  return mapWrap.classList.contains('cm-map-fullscreen');
}

function enterMapFullscreen() {
  mapWrap.classList.add('cm-map-fullscreen');
  el('cmMapExitFullscreen').hidden = false;
  document.body.style.overflow = 'hidden'; // the map now covers the viewport - nothing behind it should scroll
}

function exitMapFullscreen() {
  mapWrap.classList.remove('cm-map-fullscreen');
  el('cmMapExitFullscreen').hidden = true;
  document.body.style.overflow = '';
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

// A single wrap-level listener (not one per path/shape) - city/neighborhood
// clicks and the zoom/pan gestures underneath keep working exactly as
// before, this only ADDS the fullscreen-entry side effect on top of
// whatever a mobile tap already does. Excludes the zoom controls (which
// includes the toggle button above - it has its own handling; bubbling
// into this too would immediately re-toggle whatever it just did) and
// end-of-drag/pinch taps (isDragging() - a pan that happens to end wasn't
// a tap on someplace to look closer at). Desktop only gets the explicit
// button above, not this auto-trigger - a plain click there already means
// "select this shape," not "give me more room."
mapWrap.addEventListener('click', (ev) => {
  if (isMapFullscreen()) return;
  if (ev.target.closest('.cm-zoom-controls, .cm-map-exit-fullscreen')) return;
  if (!window.matchMedia(MOBILE_MAP_BREAKPOINT).matches) return; // desktop uses the explicit toggle button instead
  if (currentZoomPan?.isDragging()) return;
  enterMapFullscreen();
});

readStateFromUrl();
resolveSelectedFromUrl();
renderAll();
