/**
 * Entry point for canopy-map.html - a merged view of the three existing
 * city/neighborhood/street datasets on this site (tree-canopy.html, canopy-
 * split.html, heat-islands.html): pick up to 4 cities or neighborhoods on
 * one map (or streets by name, free-form across cities - see below), and
 * see all the metrics that apply to them together, distinguished by color,
 * instead of visiting three separate pages per metric.
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
const state = { level: 'city', layer: 'canopy', cityFilter: null, osm: false, selected: [], view: null };
let currentZoomPan = null; // torn down and replaced fresh each renderMap() - see attachZoomPan's own docstring

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('level') === 'neighborhood' || p.get('level') === 'street') state.level = p.get('level');
  if (METRICS[p.get('layer')]) state.layer = p.get('layer');
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
      // state.view lives in - so findDrillInTarget/shouldDrillOut can
      // compare them directly with no further conversion. Flipping swaps
      // which raw value is the min vs the max.
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

// The view's own aspect ratio is inherited from the national fit (Israel
// is ~3x taller than wide) and stays fixed under uniform zoom, while a
// city's own extent is roughly square - so the view can never actually
// reach anywhere close to "mostly this city" by area alone, no matter how
// far zoomed in on the city's own position (whichever axis lines up with
// the city first always leaves the other axis showing extra context far
// beyond it). Measured directly: zooming in on Tel Aviv until it clearly
// dominates what's visible only reached ~15-20% of the view's total area,
// not the 50%+ a naive "fills most of the screen" reading would suggest.
const DRILL_IN_FRACTION = 0.15;
// Lower than DRILL_IN_FRACTION (hysteresis) so a view sitting right at the
// boundary doesn't flicker between levels.
const DRILL_OUT_FRACTION = 0.06;

/** The city whose bbox covers the largest fraction of `view`'s own area -
 * null if none clears DRILL_IN_FRACTION yet. */
function findDrillInTarget(view) {
  const viewArea = view.w * view.h;
  let best = null;
  let bestFrac = 0;
  for (const [name, bbox] of Object.entries(cityBBoxes())) {
    const frac = overlapArea(bbox, view) / viewArea;
    if (frac > bestFrac) { bestFrac = frac; best = name; }
  }
  return bestFrac >= DRILL_IN_FRACTION ? best : null;
}

function shouldDrillOut(view, cityName) {
  const bbox = cityBBoxes()[cityName];
  if (!bbox) return false;
  return overlapArea(bbox, view) / (view.w * view.h) < DRILL_OUT_FRACTION;
}

function drillIntoCity(cityName, priorView) {
  state.level = 'neighborhood';
  state.cityFilter = cityName;
  state.selected = [];
  state.view = { ...priorView }; // same rectangle of ITM space, now drawing neighborhoods instead - a continuation, not a jump
  syncUrl();
  renderAll();
}

function drillOutToCity(priorView) {
  state.level = 'city';
  state.cityFilter = null;
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

function computeDomain(entities) {
  const vals = entities.map((e) => valueFor(e, state.layer)).filter((v) => v != null);
  if (!vals.length) return [0, 1];
  return [Math.min(...vals), Math.max(...vals)];
}

function colorFor(value, min, max, colorVar) {
  if (value == null) return 'var(--map-nodata)';
  const t = max > min ? (value - min) / (max - min) : 0.5;
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return `color-mix(in srgb, ${colorVar} ${pct}%, var(--bg) ${100 - pct}%)`;
}

/* ---------- selection (up to 4, toggled by map click or street search) ---------- */

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

function renderLegend(min, max, lyr) {
  el('cmLegend').innerHTML = `
    <span class="cm-legend-scale" dir="ltr">
      <span class="cm-legend-label">${num(min)}${esc(lyr.unit)}</span>
      <span class="cm-legend-bar" style="background:linear-gradient(to right, var(--bg), ${lyr.colorVar})"></span>
      <span class="cm-legend-label">${num(max)}${esc(lyr.unit)}</span>
    </span>
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
  const mapSection = el('cmMapSection');
  mapSection.hidden = state.level === 'street';
  if (state.level === 'street') {
    currentZoomPan?.destroy(); // no shapes/interaction while hidden - nothing left to leave listening
    currentZoomPan = null;
    return;
  }

  const entities = currentEntities();
  const lyr = METRICS[state.layer];
  const [min, max] = computeDomain(entities);

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

  const svg = el('cmSvg');
  const opacity = state.osm && !el('cmBasemap').hidden ? '0.72' : '1';
  svg.innerHTML = entities.map((e) => {
    const v = valueFor(e, state.layer);
    const d = ringsToPathD(ringsFor(e), project);
    const fill = colorFor(v, min, max, lyr.colorVar);
    const i = selectedIndex(e.key);
    const stroke = i !== -1 ? PICK_COLORS[i] : 'var(--bg)';
    const strokeWidth = i !== -1 ? '2.4' : '0.6';
    const title = `${e.label}: ${v != null ? num(v) + lyr.unit : 'אין נתונים'}`;
    return `<path d="${d}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${strokeWidth}" data-key="${esc(e.key)}" tabindex="0" role="button" aria-pressed="${i !== -1}"><title>${esc(title)}</title></path>`;
  }).join('');

  // svg (#cmSvg) is a persistent element - only its innerHTML/viewBox get
  // replaced each render, not the element itself - so the PREVIOUS
  // attachment's listeners must be torn down first, or they'd keep firing
  // alongside the new ones (see attachZoomPan's own docstring).
  currentZoomPan?.destroy();
  const cityLevelAtAttach = state.level === 'city';
  const cityFilterAtAttach = state.cityFilter;
  const zoomPan = attachZoomPan(svg, state.view || viewBox, {
    onChange: (v) => {
      state.view = v;
      syncUrlDebounced();
      if (!isItmSpace) return; // OSM's pixel space isn't comparable to cityBBoxes() at all
      if (cityLevelAtAttach) {
        const target = findDrillInTarget(v);
        if (target) drillIntoCity(target, v);
      } else if (cityFilterAtAttach && shouldDrillOut(v, cityFilterAtAttach)) {
        drillOutToCity(v);
      }
    },
  });
  currentZoomPan = zoomPan;
  el('cmZoomIn').onclick = () => zoomPan.zoomIn();
  el('cmZoomOut').onclick = () => zoomPan.zoomOut();
  el('cmZoomReset').onclick = () => { zoomPan.reset(); state.view = null; syncUrl(); };

  svg.querySelectorAll('path[data-key]').forEach((path) => {
    const entity = entities.find((x) => x.key === path.dataset.key);
    if (!entity) return;
    const go = () => { if (!zoomPan.isDragging()) toggleSelect(entity); };
    path.addEventListener('click', go);
    path.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  });

  renderLegend(min, max, lyr);
  el('cmHint').textContent = state.level === 'city'
    ? `${num(entities.length)} ערים - לחיצה בוחרת/מבטלת עד ${MAX_SELECT} להשוואה`
    : (state.cityFilter ? `${num(entities.length)} שכונות ב${state.cityFilter}` : 'בחרו עיר כדי לראות את השכונות שלה');
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

/* ---------- wiring ---------- */

function renderControls() {
  document.querySelectorAll('.cm-level-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  });
  document.querySelectorAll('.cm-layer-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layer === state.layer);
  });
  el('cmLayerSection').hidden = state.level === 'street';
  el('cmCityPickRow').hidden = state.level !== 'neighborhood';
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
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.cityFilter = null;
    state.selected = [];
    state.view = null;
    syncUrl();
    renderAll();
  });
});

document.querySelectorAll('.cm-layer-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.layer === btn.dataset.layer) return;
    state.layer = btn.dataset.layer;
    syncUrl();
    renderControls();
    renderMap();
  });
});

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

el('cmStreetPick').addEventListener('input', debounce((ev) => updateStreetRoster(ev.target.value), 120));
el('cmStreetPick').addEventListener('change', commitStreetPick);
el('cmStreetPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitStreetPick(); } });

el('cmOsmToggle').addEventListener('change', (ev) => {
  state.osm = ev.target.checked;
  state.view = null; // OSM's pixel space and the flat ITM space aren't the same units - a carried-over view would point nowhere sensible
  renderMap();
});

readStateFromUrl();
resolveSelectedFromUrl();
renderAll();
