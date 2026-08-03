/**
 * Shared SVG choropleth/shape rendering, extracted from canopy-map.js once
 * tree-canopy.js/heat-islands.js/canopy-split.js needed the same "draw these
 * city/neighborhood boundary shapes on an SVG, fit to their own bounding
 * box" piece for their own compare sections - a small map next to the
 * existing chart/table showing exactly which picked entities are being
 * compared, not a replacement for canopy-map.html's full choropleth (which
 * still has its own extra layer/OSM-overlay logic on top of these same
 * primitives).
 */

export function bboxOfRingsList(ringsList) {
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

/** ITM bbox -> a projector fit into a maxDim x maxDim box (aspect-
 * preserving) plus the resulting viewBox width/height. SVG y grows
 * downward, ITM northing grows upward - flipped here so shapes come out
 * right-side-up without every ring needing its own flip. */
export function buildFlatProjector(bbox, maxDim, padding) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const w = (xmax - xmin) || 1;
  const h = (ymax - ymin) || 1;
  const scale = maxDim / Math.max(w, h);
  const width = Math.round(w * scale) + padding * 2;
  const height = Math.round(h * scale) + padding * 2;
  const project = (x, y) => [padding + (x - xmin) * scale, padding + (ymax - y) * scale];
  return { width, height, project };
}

export function ringsToPathD(rings, project) {
  return rings.map((ring) => {
    const pts = ring.map(([x, y]) => project(x, y).map((n) => n.toFixed(1)).join(','));
    return `M${pts.join('L')}Z`;
  }).join(' ');
}

/**
 * Renders `items` (each `{ rings, fill, title }`) into `svgEl`, fit to their
 * combined bounding box. Returns false (and leaves the SVG empty) if no
 * item has any geometry, so a caller can hide the whole map section rather
 * than show an empty box.
 */
export function renderShapesMap(svgEl, items, { maxDim = 360, padding = 10 } = {}) {
  const withRings = items.filter((it) => it.rings && it.rings.length);
  if (!withRings.length) {
    svgEl.innerHTML = '';
    return false;
  }
  const bbox = bboxOfRingsList(withRings.map((it) => it.rings));
  const { width, height, project } = buildFlatProjector(bbox, maxDim, padding);
  svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svgEl.innerHTML = withRings.map((it) => {
    const d = ringsToPathD(it.rings, project);
    const titleHtml = it.title ? `<title>${it.title}</title>` : '';
    return `<path d="${d}" fill="${it.fill}" stroke="var(--bg)" stroke-width="0.8">${titleHtml}</path>`;
  }).join('');
  return true;
}

/* ---------- zoom/pan (mouse wheel + drag on desktop, pinch + drag on
   touch) - mutates the SVG's own viewBox directly rather than a CSS
   transform, so stroke widths and hit-testing stay in the same coordinate
   space at any zoom level. Pointer Events unify mouse/touch/pen into one
   handler rather than needing separate mouse* and touch* listeners. ---------- */

const ZOOM_MIN_FACTOR = 0.15; // how far in (smaller viewBox = more zoomed in) relative to the initial fit
const ZOOM_MAX_FACTOR = 6; // how far out
const DRAG_THRESHOLD_PX = 6; // below this, a pointerdown->up counts as a tap, not a pan

/**
 * Wires zoom/pan onto `svgEl`, whose viewBox starts at `initial`
 * `{x, y, w, h}`. Returns `{ reset(), zoomIn(), zoomOut(), isDragging() }` -
 * `isDragging()` lets a caller's own click handler on child shapes (e.g.
 * one path per city) skip acting when the click that just fired was
 * actually the tail end of a pan/pinch gesture, not a tap. Each call
 * attaches fresh listeners to the given element - safe to call once per
 * render (a re-render replaces the SVG's innerHTML/viewBox anyway, so the
 * zoom/pan state resetting along with it is expected, not a bug).
 */
export function attachZoomPan(svgEl, initial, { onChange } = {}) {
  const view = { ...initial };
  // Set directly (not via apply()) so restoring a URL-provided view on
  // attach doesn't also fire onChange for a "change" that didn't happen.
  svgEl.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  let dragging = false;
  let dragged = false;
  let lastSingle = null; // {x,y} screen px, single-pointer pan
  let lastPinchDist = null;
  const pointers = new Map(); // pointerId -> {x,y} screen px

  function apply() {
    svgEl.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    if (onChange) onChange({ ...view });
  }

  function screenToView(px, py) {
    const rect = svgEl.getBoundingClientRect();
    return [
      view.x + ((px - rect.left) / rect.width) * view.w,
      view.y + ((py - rect.top) / rect.height) * view.h,
    ];
  }

  function zoomAtView(vx, vy, factor) {
    const minW = initial.w * ZOOM_MIN_FACTOR;
    const maxW = initial.w * ZOOM_MAX_FACTOR;
    const newW = Math.min(maxW, Math.max(minW, view.w * factor));
    const appliedFactor = newW / view.w;
    const newH = view.h * appliedFactor;
    view.x = vx - (vx - view.x) * appliedFactor;
    view.y = vy - (vy - view.y) * appliedFactor;
    view.w = newW;
    view.h = newH;
    apply();
  }

  svgEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [vx, vy] = screenToView(ev.clientX, ev.clientY);
    zoomAtView(vx, vy, ev.deltaY > 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  svgEl.addEventListener('pointerdown', (ev) => {
    svgEl.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 1) {
      dragging = true;
      dragged = false;
      lastSingle = { x: ev.clientX, y: ev.clientY };
    } else {
      lastSingle = null;
    }
    lastPinchDist = null;
  });

  svgEl.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist != null) {
        const [vx, vy] = screenToView((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAtView(vx, vy, lastPinchDist / dist);
      }
      lastPinchDist = dist;
      dragged = true;
      return;
    }

    if (dragging && lastSingle) {
      const dx = ev.clientX - lastSingle.x;
      const dy = ev.clientY - lastSingle.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) dragged = true;
      const rect = svgEl.getBoundingClientRect();
      view.x -= (dx / rect.width) * view.w;
      view.y -= (dy / rect.height) * view.h;
      apply();
      lastSingle = { x: ev.clientX, y: ev.clientY };
    }
  });

  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    lastPinchDist = null;
    if (pointers.size === 0) {
      dragging = false;
      lastSingle = null;
    } else if (pointers.size === 1) {
      const [p] = pointers.values();
      lastSingle = { x: p.x, y: p.y };
    }
  }
  svgEl.addEventListener('pointerup', endPointer);
  svgEl.addEventListener('pointercancel', endPointer);

  return {
    reset() {
      view.x = initial.x; view.y = initial.y; view.w = initial.w; view.h = initial.h;
      apply();
    },
    zoomIn() { zoomAtView(view.x + view.w / 2, view.y + view.h / 2, 1 / 1.4); },
    zoomOut() { zoomAtView(view.x + view.w / 2, view.y + view.h / 2, 1.4); },
    isDragging: () => dragged,
  };
}
