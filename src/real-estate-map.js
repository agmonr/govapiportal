/**
 * Entry point for real-estate-map.html - a city/neighborhood choropleth of
 * CPI-adjusted median price per square meter, mirroring canopy-map.html's
 * own architecture (same map-shapes.js projection/pan-zoom, same
 * MAP_CITIES/MAP_NEIGHBORHOODS boundary geometry, same multi-select ->
 * compare-page deep-link idiom) but for a single new data source instead of
 * three existing ones: see tools/real_estate_build.py for how
 * real-estate-cities.js/real-estate-neighborhoods.js are computed (GovMap's
 * public real-estate deals API, CPI-adjusted, assigned to a city/
 * neighborhood the same point-in-polygon way canopy_build.py already
 * assigns tree canopy).
 *
 * No street level (no street-buffer polygons built for this dataset - see
 * canopy-map.html's own reasoning for why it skipped a street level's
 * shapes too) and no high-res "blob" raster overlay (that pipeline needs a
 * per-city pre-rendered PNG built from raw pixel/point data - skipped here,
 * see the real-estate-build session notes). Two metrics only (מחיר למ״ר /
 * כמות עסקאות), so the "1-3 active metrics with bar glyphs" mechanism
 * canopy-map.js has is kept but naturally caps at 2.
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

import { CITY_REAL_ESTATE } from './real-estate-cities.js';
import { NEIGHBORHOOD_REAL_ESTATE } from './real-estate-neighborhoods.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'real-estate-map')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- metrics ---------- */
const METRICS = {
  price: {
    label: 'מחיר למ״ר', unit: ' ₪', colorVar: 'var(--accent)',
    valueForCity: (name) => CITY_REAL_ESTATE[name]?.medianPricePerSqm,
    valueForNb: (key) => NEIGHBORHOOD_REAL_ESTATE[key]?.medianPricePerSqm,
  },
  volume: {
    label: 'כמות עסקאות', unit: '', colorVar: 'var(--danger)',
    valueForCity: (name) => CITY_REAL_ESTATE[name]?.n,
    valueForNb: (key) => NEIGHBORHOOD_REAL_ESTATE[key]?.n,
  },
};

function valueForLevel(metric, level, key) {
  return level === 'city' ? metric.valueForCity(key) : metric.valueForNb(key);
}

function neighborhoodLabel(city, name) {
  return `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`;
}

/* ---------- neighborhood roster (built once, lazily) ---------- */

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

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/* ---------- state + URL ---------- */

const MAX_SELECT = 4;
const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];

// Tel Aviv/Gush Dan, zoomed in - the highest-priced, most active part of the
// dataset, a more useful default first view than the whole-country fit.
const DEFAULT_VIEW = { x: 172000, y: -670000, w: 30000, h: 46000 };

const state = {
  level: 'city', layer: 'price', cityLayers: ['price'], cityFilter: null, osm: false, selected: [], view: { ...DEFAULT_VIEW },
};
let currentZoomPan = null;
let lastViewBox = null;

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('level') === 'neighborhood') state.level = 'neighborhood';
  if (METRICS[p.get('layer')]) state.layer = p.get('layer');
  const layers = (p.get('layers') || '').split(',').filter((id) => METRICS[id]);
  if (layers.length) state.cityLayers = [...new Set(layers)].slice(0, 2);
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
const syncUrlDebounced = debounce(syncUrl, 300);

/* ---------- zoom-to-drill (see canopy-map.js's own comments - identical
   mechanism, reused verbatim) ---------- */

let cityBBoxCache = null;
function cityBBoxes() {
  if (!cityBBoxCache) {
    cityBBoxCache = {};
    for (const [name, data] of Object.entries(MAP_CITIES)) {
      const [xmin, ymin, xmax, ymax] = bboxOfRingsList([data.rings]);
      const fymin = -ymax;
      const fymax = -ymin;
      cityBBoxCache[name] = [xmin, fymin, xmax, fymax, (xmin + xmax) / 2, (fymin + fymax) / 2];
    }
  }
  return cityBBoxCache;
}

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a[2], b.x + b.w) - Math.max(a[0], b.x));
  const oy = Math.max(0, Math.min(a[3], b.y + b.h) - Math.max(a[1], b.y));
  return ox * oy;
}

const DRILL_OUT_FRACTION = 0.06;

function shouldDrillOut(view, cityName) {
  const bbox = cityBBoxes()[cityName];
  if (!bbox) return false;
  return overlapArea(bbox, view) / (view.w * view.h) < DRILL_OUT_FRACTION;
}

function drillOutToCity(priorView) {
  state.level = 'city';
  state.cityFilter = null;
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
  if (!state.cityFilter) return [];
  const prefix = `${state.cityFilter}::`;
  return Object.entries(MAP_NEIGHBORHOODS)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, v]) => {
      const [city, name] = key.split('::');
      return { key, label: neighborhoodLabel(city, name), city, name, level: 'neighborhood', rings: v.rings };
    });
}

function currentPickableEntities() {
  return currentEntities();
}

function valueFor(entity, metricId) {
  return valueForLevel(METRICS[metricId], entity.level, entity.key);
}

/* ---------- per-year deal counts for the long-press menu - lazily fetched
   from the same per-city deal files real-estate-compare.js already uses
   (assets/deals/<city>.json), not precomputed into real-estate-cities.js/
   real-estate-neighborhoods.js, since it's only ever needed for the one
   entity currently long-pressed. ---------- */

const cityDealsCache = new Map();
function fetchCityDeals(cityName) {
  if (!cityDealsCache.has(cityName)) {
    cityDealsCache.set(cityName, fetch(`./assets/deals/${encodeURIComponent(cityName)}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []));
  }
  return cityDealsCache.get(cityName);
}

function dealsForEntity(entity, cityDeals) {
  return entity.level === 'neighborhood' ? cityDeals.filter((d) => d.nb === entity.name) : cityDeals;
}

function yearCountsText(deals) {
  if (!deals.length) return 'אין נתונים';
  const counts = {};
  for (const d of deals) {
    const y = d.dt.slice(0, 4);
    counts[y] = (counts[y] || 0) + 1;
  }
  return Object.keys(counts).sort().map((y) => `${y}: ${num(counts[y])}`).join(' · ');
}

const MAX_DIM = 720;

/* ---------- color scale ---------- */

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

/* ---------- multi-metric glyph (city level, 2 active metrics at once) ---------- */

const GLYPH_BAR_W = 900;
const GLYPH_BAR_GAP = 220;
const GLYPH_MAX_H = 4200;
const GLYPH_MIN_H = 60;

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
  return `<g pointer-events="none">${bars}</g>`;
}

/* ---------- name labels ---------- */

const LABEL_MIN_PX = 26;
const LABEL_FONT_PX = 12;

function entityLabelMarkup(e) {
  const [xmin, ymin, xmax, ymax] = bboxOfRingsList([e.rings]);
  const cx = (xmin + xmax) / 2;
  const cy = -(ymin + ymax) / 2;
  const minDim = Math.min(xmax - xmin, ymax - ymin);
  return `<text class="cm-label" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" data-min="${minDim.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" pointer-events="none">${esc(e.label)}</text>`;
}

const LABEL_DECLUTTER_PAD_PX = 2;

function updateLabelVisibility(svg, view) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height || !view || !view.w || !view.h) return null;
  const scale = Math.min(rect.width / view.w, rect.height / view.h);
  const fontSize = LABEL_FONT_PX / scale;
  svg.querySelectorAll('.cm-label').forEach((elm) => {
    const visible = Number(elm.dataset.min) * scale >= LABEL_MIN_PX;
    elm.style.display = visible ? '' : 'none';
    if (visible) elm.setAttribute('font-size', fontSize.toFixed(2));
  });
  return scale;
}

function declutterOverlappingLabels(svg, scale) {
  if (!scale) return;
  const padMeters = LABEL_DECLUTTER_PAD_PX / scale;
  const candidates = [...svg.querySelectorAll('.cm-label')].filter((elm) => elm.style.display !== 'none');
  candidates.sort((a, b) => Number(b.dataset.min) - Number(a.dataset.min));
  const accepted = [];
  candidates.forEach((elm) => {
    const box = elm.getBBox();
    const box2 = { x: box.x - padMeters, y: box.y - padMeters, w: box.width + 2 * padMeters, h: box.height + 2 * padMeters };
    const overlaps = accepted.some((o) => box2.x < o.x + o.w && box2.x + box2.w > o.x && box2.y < o.y + o.h && box2.y + box2.h > o.y);
    if (overlaps) elm.style.display = 'none';
    else accepted.push(box2);
  });
}

const declutterDebounced = debounce(declutterOverlappingLabels, 120);

function updateLabels(svg, view, { immediate = false } = {}) {
  const scale = updateLabelVisibility(svg, view);
  if (immediate) declutterOverlappingLabels(svg, scale);
  else declutterDebounced(svg, scale);
}

/* ---------- selection ---------- */

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
    return;
  }
  syncUrl();
  renderAll();
}

function pickSolo(entity) {
  const isSame = state.selected.length === 1 && state.selected[0].key === entity.key;
  state.selected = isSame ? [] : [entity];
  syncUrl();
  renderAll();
}

/* ---------- legend ---------- */

function renderLegend(metricIds, domains) {
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
  el('remLegend').innerHTML = `${rows}
    <span class="cm-legend-nodata"><span class="acc-legend-swatch" style="background:var(--map-nodata)"></span>אין נתונים (פחות מ-5 עסקאות)</span>
  `;
}

/* ---------- OSM basemap overlay (neighborhood level only, default off) ---------- */

let osmToken = 0;

async function renderOsmBasemap(entities) {
  const myToken = (osmToken += 1);
  const canvasEl = el('remBasemap');
  const statusEl = el('remOsmStatus');
  const wgsRingsList = entities.map((e) => MAP_NEIGHBORHOODS_WGS84[e.key]?.rings || []);
  const bbox = bboxOfRingsList(wgsRingsList);
  statusEl.textContent = 'טוען מפת רקע…';
  try {
    const { canvas, project } = await fetchBasemapCanvasWGS84(bbox, MAX_DIM);
    if (myToken !== osmToken) return null;
    canvasEl.replaceChildren(canvas);
    canvasEl.hidden = false;
    statusEl.textContent = '';
    return {
      width: MAX_DIM,
      height: MAX_DIM,
      project: (lon, lat) => project(lon, lat),
      wgsRingsByKey: Object.fromEntries(entities.map((e, i) => [e.key, wgsRingsList[i]])),
    };
  } catch (err) {
    if (myToken !== osmToken) return null;
    canvasEl.hidden = true;
    statusEl.textContent = 'לא ניתן לטעון מפת רקע (אזור גדול מדי או שגיאת רשת) - מוצג ללא רקע.';
    state.osm = false;
    el('remOsmToggle').checked = false;
    return null;
  }
}

/* ---------- map ---------- */

async function renderMap() {
  hideContextMenu();
  cancelActivePress();

  const entities = currentEntities();
  const activeMetricIds = state.level === 'city' ? state.cityLayers : [state.layer];
  const domains = computeDomains(entities, activeMetricIds);
  const isMultiMetric = activeMetricIds.length > 1;

  el('remOsmRow').hidden = state.level !== 'neighborhood' || !state.cityFilter;
  el('remBasemap').hidden = true;

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

  const svg = el('remSvg');
  const opacity = (state.osm && !el('remBasemap').hidden) ? '0.72' : '1';
  const titleFor = (e) => `${e.label} - ${activeMetricIds
    .map((id) => `${METRICS[id].label}: ${valueFor(e, id) != null ? num(valueFor(e, id)) + METRICS[id].unit : 'אין נתונים'}`)
    .join(' · ')}`;
  const paths = entities.map((e) => {
    const d = ringsToPathD(ringsFor(e), project);
    const fill = isMultiMetric
      ? 'var(--map-nodata)'
      : colorFor(valueFor(e, activeMetricIds[0]), ...domains[activeMetricIds[0]], METRICS[activeMetricIds[0]].colorVar);
    const i = selectedIndex(e.key);
    const stroke = i !== -1 ? PICK_COLORS[i] : 'var(--bg)';
    const strokeWidth = i !== -1 ? '3' : '1.2';
    return `<path d="${d}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="all" data-key="${esc(e.key)}" tabindex="0" role="button" aria-pressed="${i !== -1}"><title>${esc(titleFor(e))}</title></path>`;
  }).join('');
  const glyphs = isMultiMetric && isItmSpace
    ? entities.map((e) => glyphMarkup(e, activeMetricIds, domains)).filter(Boolean).join('')
    : '';
  const labels = isItmSpace ? entities.map(entityLabelMarkup).join('') : '';
  svg.innerHTML = paths + glyphs + labels;

  currentZoomPan?.destroy();
  const cityFilterAtAttach = state.cityFilter;
  const zoomPan = attachZoomPan(svg, state.view || viewBox, {
    onChange: (v) => {
      state.view = v;
      syncUrlDebounced();
      updateLabels(svg, v);
      if (!isItmSpace) return;
      if (cityFilterAtAttach && shouldDrillOut(v, cityFilterAtAttach)) {
        drillOutToCity(v);
      }
    },
  });
  currentZoomPan = zoomPan;
  lastViewBox = viewBox;
  updateLabels(svg, state.view || viewBox, { immediate: true });
  el('remZoomIn').onclick = () => zoomPan.zoomIn();
  el('remZoomOut').onclick = () => zoomPan.zoomOut();
  el('remZoomReset').onclick = () => { zoomPan.reset(); state.view = null; syncUrl(); };

  svg.querySelectorAll('path[data-key]').forEach((path) => {
    const entity = entities.find((x) => x.key === path.dataset.key);
    if (!entity) return;
    path.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pickSolo(entity); } });
    path.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      cancelActivePress();
      const timer = setTimeout(() => {
        activePress = null;
        lastLongPressKey = entity.key;
        const myToken = (contextMenuToken += 1);
        const x = ev.clientX; const y = ev.clientY;
        showContextMenu(x, y, contextMenuItems(entity, null));
        fetchCityDeals(entity.city).then((cityDeals) => {
          if (myToken !== contextMenuToken || el('remContextMenu').hidden) return;
          showContextMenu(x, y, contextMenuItems(entity, yearCountsText(dealsForEntity(entity, cityDeals))));
        });
      }, LONG_PRESS_MS);
      activePress = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, timer };
    });
  });

  renderLegend(activeMetricIds, domains);
  el('remHint').textContent = state.level === 'city'
    ? `${num(entities.length)} ערים - לחיצה מציגה פרטי עיר; למעבר לשכונות שלה, עברו לרמת "שכונות" והקלידו את שמה`
    : (state.cityFilter ? `${num(entities.length)} שכונות ב${state.cityFilter} - לחיצה בוחרת שכונה אחת לצפייה בפרטים` : 'הקלידו שם עיר למעלה כדי לראות את השכונות שלה');
}

/* ---------- selection chips ---------- */

function renderChips() {
  const wrap = el('remChips');
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

/* ---------- combined detail ---------- */

function renderDetailMetric(metricId, figId) {
  const m = METRICS[metricId];
  const entries = state.selected
    .map((e, i) => ({ e, v: valueForLevel(m, e.level, e.key), i }))
    .filter((row) => row.v != null)
    .map((row) => ({ label: row.e.label, value: row.v, color: PICK_COLORS[row.i] }));
  renderHBarChart(figId, m.label, entries, m.unit);
}

function renderDetail() {
  const section = el('remDetailSection');
  if (!state.selected.length) { section.hidden = true; return; }
  section.hidden = false;
  renderDetailMetric('price', 'remDetailPrice');
  renderDetailMetric('volume', 'remDetailVolume');
}

/* ---------- city picker (neighborhood level) ---------- */

function updateCityRoster(query) {
  const q = query.trim().toLowerCase();
  const names = Object.keys(MAP_CITIES).filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 40);
  el('remCityRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ---------- city picker (city level, manual multi-add) ---------- */

function updateCityAddRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('remCityAddRoster').innerHTML = ''; return; }
  const names = Object.keys(MAP_CITIES).filter((n) => n.toLowerCase().includes(q)).slice(0, 40);
  el('remCityAddRoster').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

function commitCityAddPick() {
  const input = el('remCityAddPick');
  const name = input.value.trim();
  if (!MAP_CITIES[name]) return;
  input.value = '';
  el('remCityAddRoster').innerHTML = '';
  const entity = { key: name, label: name, city: name, level: 'city', rings: MAP_CITIES[name].rings };
  if (selectedIndex(entity.key) === -1) {
    state.view = itmViewBox(bboxOfRingsList([entity.rings]));
  }
  toggleSelect(entity);
}

/* ---------- neighborhood picker ---------- */

function updateNbRoster(query) {
  const q = query.trim().toLowerCase();
  if (!q) { el('remNbRoster').innerHTML = ''; return; }
  const hits = nbEntries().filter((e) => e.label.toLowerCase().includes(q)).slice(0, 40);
  el('remNbRoster').innerHTML = hits.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function commitNbPick() {
  const input = el('remNbPick');
  const entity = nbLabelMap().get(input.value.trim());
  if (!entity) return;
  input.value = '';
  el('remNbRoster').innerHTML = '';
  toggleSelect(entity);
}

/* ---------- wiring ---------- */

function renderControls() {
  document.querySelectorAll('.cm-level-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  });
  document.querySelectorAll('.cm-layer-btn').forEach((btn) => {
    const active = state.level === 'city'
      ? state.cityLayers.includes(btn.dataset.layer)
      : btn.dataset.layer === state.layer;
    btn.classList.toggle('active', active);
  });
  el('remCityAddRow').hidden = state.level !== 'city';
  el('remCityPickRow').hidden = state.level !== 'neighborhood';
  el('remNbPickRow').hidden = state.level !== 'neighborhood';
  el('remCityPick').value = state.cityFilter || '';
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
      const i = state.cityLayers.indexOf(id);
      if (i !== -1) {
        if (state.cityLayers.length === 1) return;
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

el('remCityAddPick').addEventListener('input', debounce((ev) => updateCityAddRoster(ev.target.value), 120));
el('remCityAddPick').addEventListener('change', commitCityAddPick);
el('remCityAddPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitCityAddPick(); } });

el('remCityPick').addEventListener('input', debounce((ev) => updateCityRoster(ev.target.value), 120));
const commitCity = () => {
  const val = el('remCityPick').value.trim();
  state.cityFilter = MAP_CITIES[val] ? val : null;
  state.selected = [];
  state.view = null;
  syncUrl();
  renderAll();
};
el('remCityPick').addEventListener('change', commitCity);
el('remCityPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitCity(); } });

el('remNbPick').addEventListener('input', debounce((ev) => updateNbRoster(ev.target.value), 120));
el('remNbPick').addEventListener('change', commitNbPick);
el('remNbPick').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitNbPick(); } });

el('remOsmToggle').addEventListener('change', (ev) => {
  state.osm = ev.target.checked;
  state.view = null;
  renderMap();
});

const onSvgResize = debounce(() => {
  currentZoomPan?.invalidateRect();
  const svg = el('remSvg');
  const view = state.view || lastViewBox;
  if (view) updateLabels(svg, view, { immediate: true });
}, 150);
new ResizeObserver(onSvgResize).observe(el('remSvg'));

el('remFullReset').addEventListener('click', () => {
  state.level = 'city';
  state.layer = 'price';
  state.cityLayers = ['price'];
  state.cityFilter = null;
  state.osm = false;
  state.selected = [];
  state.view = { ...DEFAULT_VIEW };
  el('remOsmToggle').checked = false;
  syncUrl();
  renderAll();
});

/* ---------- press-and-hold submenu trigger (see canopy-map.js's own
   detailed comment on why this listens on the svg element itself via
   elementFromPoint, not a per-path click - identical mechanism here) ---------- */

let activePress = null;
let lastLongPressKey = null;
let contextMenuToken = 0;

// yearText is null while the per-city deal file (see fetchCityDeals above)
// is still in flight - the menu opens immediately with "טוען…" for that one
// line and re-renders in place once it resolves, rather than waiting on the
// fetch before showing anything.
function contextMenuItems(entity, yearText) {
  const priceVal = valueFor(entity, 'price');
  const volVal = valueFor(entity, 'volume');
  const priceText = priceVal != null ? `${num(priceVal)} ₪` : 'אין נתונים';
  const volText = volVal != null ? num(volVal) : 'אין נתונים';
  return [
    { info: entity.label },
    { info: `${METRICS.price.label}: ${priceText}` },
    { info: `${METRICS.volume.label}: ${volText}` },
    { info: `לפי שנה: ${yearText ?? 'טוען…'}` },
    {
      label: 'מידע איזורי על מחירי נדל״ן ←',
      onSelect: () => {
        const p = new URLSearchParams();
        p.set('level', entity.level);
        p.set('p', entity.label);
        if (entity.level === 'neighborhood' && state.cityFilter) p.set('city', state.cityFilter);
        location.href = `./real-estate-compare.html?${p}`;
      },
    },
  ];
}

function cancelActivePress() {
  if (activePress) clearTimeout(activePress.timer);
  activePress = null;
}

el('remSvg').addEventListener('click', (ev) => {
  if (currentZoomPan?.isDragging()) return;
  const hit = document.elementFromPoint(ev.clientX, ev.clientY);
  const path = hit?.closest?.('path[data-key]');
  if (!path) return;
  if (lastLongPressKey === path.dataset.key) {
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

function hideContextMenu() {
  const menu = el('remContextMenu');
  menu.hidden = true;
  menu.innerHTML = '';
}

function showContextMenu(x, y, items) {
  const menu = el('remContextMenu');
  menu.innerHTML = items.map((item, i) => (item.info
    ? `<li role="none" class="cm-context-menu-info" dir="auto">${esc(item.info)}</li>`
    : `<li role="none"><button type="button" role="menuitem" data-idx="${i}">${esc(item.label)}</button></li>`)).join('');
  menu.hidden = false;
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

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#remContextMenu')) hideContextMenu();
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideContextMenu(); });
window.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', hideContextMenu);

/* ---------- mobile fullscreen takeover ---------- */

const MOBILE_MAP_BREAKPOINT = '(max-width: 640px)';
const mapWrap = document.querySelector('.cm-map-wrap');

function isMapFullscreen() {
  return mapWrap.classList.contains('cm-map-fullscreen');
}
function enterMapFullscreen() {
  mapWrap.classList.add('cm-map-fullscreen');
  el('remMapExitFullscreen').hidden = false;
  document.body.style.overflow = 'hidden';
}
function exitMapFullscreen() {
  mapWrap.classList.remove('cm-map-fullscreen');
  el('remMapExitFullscreen').hidden = true;
  document.body.style.overflow = '';
}
el('remMapExitFullscreen').addEventListener('click', exitMapFullscreen);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && isMapFullscreen()) exitMapFullscreen();
});
el('remMapFullscreenToggle').addEventListener('click', () => {
  if (isMapFullscreen()) exitMapFullscreen(); else enterMapFullscreen();
});
mapWrap.addEventListener('click', (ev) => {
  if (isMapFullscreen()) return;
  if (ev.target.closest('.cm-zoom-controls, .cm-map-exit-fullscreen')) return;
  if (!window.matchMedia(MOBILE_MAP_BREAKPOINT).matches) return;
  if (currentZoomPan?.isDragging()) return;
  enterMapFullscreen();
});

readStateFromUrl();
resolveSelectedFromUrl();
renderAll();
