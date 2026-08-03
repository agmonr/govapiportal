/**
 * Entry point for canopy-map.html - a visual index into the three existing
 * city/neighborhood datasets on this site (tree-canopy.html, canopy-
 * split.html, heat-islands.html), drawn as a choropleth instead of a table.
 *
 * No new attribute data is computed here at all - every layer's VALUE comes
 * from a file that already ships elsewhere (see the CITY_ and
 * NEIGHBORHOOD_ imports below). The only genuinely new thing this page
 * needed was boundary GEOMETRY - see tools/map_geo_build.py, which
 * simplifies the same city/neighborhood shapes canopy_build.py already
 * uses for computation, and ships them here purely to draw.
 *
 * Rendered as SVG, not canvas - a national/city-scale choropleth is a
 * few hundred distinct regions that each need their own hover/click, which
 * SVG gives for free via normal DOM events (a canvas would need manual
 * point-in-polygon hit-testing on every mouse move instead). No basemap
 * tiles by default: the shapes' own outlines already read as a map (the
 * same convention any thematic/choropleth map uses - an election-result
 * map doesn't show street-level tiles underneath either), and skipping a
 * live OSM fetch keeps the default view instant and self-contained,
 * matching how every other page here avoids a live dependency at render
 * time. An optional real-OSM-tile background is offered anyway (default
 * off) - see the "osm" toggle below - but only at neighborhood level, once
 * a single city is picked: geo-utils.js's tile stitcher caps itself at 64
 * tiles (OSM's own usage policy), and a whole-country bbox at any legible
 * resolution needs far more than that, while a single city's extent does
 * not.
 */

import { el, esc, num, debounce } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { fetchBasemapCanvasWGS84 } from './geo-utils.js';

import { MAP_CITIES } from './map-boundaries-cities.js';
import { MAP_NEIGHBORHOODS } from './map-boundaries-neighborhoods.js';
import { MAP_NEIGHBORHOODS_WGS84 } from './map-boundaries-neighborhoods-wgs84.js';

import { CITY_CANOPY } from './tree-canopy-cities.js';
import { NEIGHBORHOOD_CANOPY } from './tree-canopy-neighborhoods.js';
import { CITY_CANOPY_SPLIT } from './canopy-split-cities.js';
import { NEIGHBORHOOD_CANOPY_SPLIT } from './canopy-split-neighborhoods.js';
import { CITY_HEAT } from './heat-cities.js';
import { NEIGHBORHOOD_HEAT } from './heat-neighborhoods.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'canopy-map')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- layers: one shape, three already-shipped sources ---------- */

const LAYERS = {
  canopy: {
    label: 'כיסוי חופות כולל', unit: '%', colorVar: 'var(--accent)', page: './tree-canopy.html',
    valueForCity: (name) => CITY_CANOPY[name]?.pct,
    valueForNb: (key) => NEIGHBORHOOD_CANOPY[key]?.pct,
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
  },
};

// "name (city)" - same construction tree-canopy.js/heat-islands.js/
// canopy-split.js already use for a neighborhood's own display label, so a
// click-through link's p1 resolves against those pages' own roster.
function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}

/* ---------- state + URL ---------- */

const state = { level: 'city', layer: 'canopy', cityFilter: null, osm: false };

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('level') === 'neighborhood') state.level = 'neighborhood';
  if (LAYERS[p.get('layer')]) state.layer = p.get('layer');
  if (p.get('city')) state.cityFilter = p.get('city');
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  p.set('layer', state.layer);
  if (state.cityFilter) p.set('city', state.cityFilter);
  history.replaceState(null, '', `?${p}`);
}

/* ---------- entities for the current level ---------- */

function currentEntities() {
  if (state.level === 'city') {
    return Object.keys(MAP_CITIES).map((name) => ({ key: name, label: name, city: name, rings: MAP_CITIES[name].rings }));
  }
  if (!state.cityFilter) return [];
  const prefix = `${state.cityFilter}::`;
  return Object.entries(MAP_NEIGHBORHOODS)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, v]) => {
      const [city, name] = key.split('::');
      return { key, label: neighborhoodLabel(city, name), city, name, rings: v.rings };
    });
}

function valueFor(entity) {
  const lyr = LAYERS[state.layer];
  return state.level === 'city' ? lyr.valueForCity(entity.key) : lyr.valueForNb(entity.key);
}

/* ---------- projection: ITM -> SVG viewBox, aspect-preserving ---------- */

function bboxOfRingsList(ringsList) {
  let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity;
  for (const rings of ringsList) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
    }
  }
  return [xmin, ymin, xmax, ymax];
}

const MAX_DIM = 720;
const PADDING = 16;

function buildFlatProjector(bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const w = (xmax - xmin) || 1;
  const h = (ymax - ymin) || 1;
  const scale = MAX_DIM / Math.max(w, h);
  const width = Math.round(w * scale) + PADDING * 2;
  const height = Math.round(h * scale) + PADDING * 2;
  // SVG y grows downward, ITM northing grows upward - flipped here so the
  // shapes come out right-side-up without every ring needing its own flip.
  const project = (x, y) => [PADDING + (x - xmin) * scale, PADDING + (ymax - y) * scale];
  return { width, height, project };
}

function ringsToPathD(rings, project) {
  return rings.map((ring) => {
    const pts = ring.map(([x, y]) => project(x, y).map((n) => n.toFixed(1)).join(','));
    return `M${pts.join('L')}Z`;
  }).join(' ');
}

/* ---------- color scale ---------- */

function computeDomain(entities) {
  const vals = entities.map(valueFor).filter((v) => v != null);
  if (!vals.length) return [0, 1];
  return [Math.min(...vals), Math.max(...vals)];
}

function colorFor(value, min, max, colorVar) {
  if (value == null) return 'var(--map-nodata)';
  const t = max > min ? (value - min) / (max - min) : 0.5;
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return `color-mix(in srgb, ${colorVar} ${pct}%, var(--bg) ${100 - pct}%)`;
}

/* ---------- click-through: this map is an index INTO the existing pages,
   not a replacement for their tables/leaderboards/CSV export ---------- */

function linkFor(entity) {
  const lyr = LAYERS[state.layer];
  const p = new URLSearchParams();
  p.set('level', state.level);
  p.set('p1', entity.label);
  if (state.level === 'neighborhood') p.set('city', state.cityFilter);
  return `${lyr.page}?${p}`;
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

/* ---------- main render ---------- */

async function renderMap() {
  const entities = currentEntities();
  const lyr = LAYERS[state.layer];
  const [min, max] = computeDomain(entities);

  el('cmOsmRow').hidden = state.level !== 'neighborhood' || !state.cityFilter;
  el('cmBasemap').hidden = true;

  let width; let height; let project; let ringsFor = (e) => e.rings;
  if (state.osm && state.level === 'neighborhood' && state.cityFilter && entities.length) {
    const osm = await renderOsmBasemap(entities);
    if (osm) {
      ({ width, height } = osm);
      project = (x, y) => osm.project(x, y);
      ringsFor = (e) => osm.wgsRingsByKey[e.key] || [];
    }
  }
  if (!project) {
    const bbox = entities.length ? bboxOfRingsList(entities.map((e) => e.rings)) : [0, 0, 1, 1];
    ({ width, height, project } = buildFlatProjector(bbox));
  }

  const svg = el('cmSvg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const opacity = state.osm && !el('cmBasemap').hidden ? '0.72' : '1';
  svg.innerHTML = entities.map((e) => {
    const v = valueFor(e);
    const d = ringsToPathD(ringsFor(e), project);
    const fill = colorFor(v, min, max, lyr.colorVar);
    const title = `${e.label}: ${v != null ? num(v) + lyr.unit : 'אין נתונים'}`;
    return `<path d="${d}" fill="${fill}" fill-opacity="${opacity}" stroke="var(--bg)" stroke-width="0.6" data-key="${esc(e.key)}" tabindex="0" role="link"><title>${esc(title)}</title></path>`;
  }).join('');

  svg.querySelectorAll('path[data-key]').forEach((path) => {
    const entity = entities.find((x) => x.key === path.dataset.key);
    if (!entity) return;
    const go = () => { location.href = linkFor(entity); };
    path.addEventListener('click', go);
    path.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  });

  renderLegend(min, max, lyr);
  el('cmHint').textContent = state.level === 'city'
    ? `${num(entities.length)} ערים - לחיצה על עיר עוברת ל${esc(lyr.label)} שלה בפירוט המלא`
    : (state.cityFilter ? `${num(entities.length)} שכונות ב${state.cityFilter}` : 'בחרו עיר כדי לראות את השכונות שלה');
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
  el('cmCityPickRow').hidden = state.level !== 'neighborhood';
  el('cmCityPick').value = state.cityFilter || '';
  updateCityRoster('');
}

document.querySelectorAll('.cm-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    if (state.level === 'city') state.cityFilter = null;
    syncUrl();
    renderControls();
    renderMap();
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
  syncUrl();
  renderMap();
};
el('cmCityPick').addEventListener('change', commitCity);
el('cmCityPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitCity(); } });

el('cmOsmToggle').addEventListener('change', (ev) => {
  state.osm = ev.target.checked;
  renderMap();
});

readStateFromUrl();
renderControls();
renderMap();
