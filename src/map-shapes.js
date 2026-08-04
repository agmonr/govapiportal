/**
 * Shared SVG shape-rendering and zoom/pan primitives for canopy-map.html -
 * split out of canopy-map.js itself so the geometry/projection math isn't
 * tangled up with that page's own layer/selection/OSM-toggle logic.
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

/**
 * ITM bbox -> a viewBox `{x, y, w, h}` in Y-flipped-ITM units (SVG y grows
 * downward, ITM northing grows upward) plus the matching `project`. Unlike
 * a pixel-fitted projection, this does NOT rescale into a fixed-size box -
 * the viewBox literally IS the real-world extent, in meters, Y-negated -
 * so a zoom/pan state and any entity's own raw ITM bbox stay in the exact
 * same units at every zoom level and across a level switch (city vs
 * neighborhood): a canopy-map.html zoom-to-drill check comparing "is the
 * current view smaller than this city's own extent" would otherwise be
 * comparing two unrelated coordinate spaces (this was a real bug here -
 * the old pixel-fitted version reset its own scale/origin on every
 * render, so a persisted `state.view` meant a different rectangle each
 * time depending on what was last drawn).
 */
export function itmViewBox(bbox, paddingFrac = 0.04) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const w = (xmax - xmin) || 1;
  const h = (ymax - ymin) || 1;
  const pad = Math.max(w, h) * paddingFrac;
  return { x: xmin - pad, y: -(ymax + pad), w: w + pad * 2, h: h + pad * 2 };
}

export function projectItm(x, y) {
  return [x, -y];
}

export function ringsToPathD(rings, project) {
  return rings.map((ring) => {
    const pts = ring.map(([x, y]) => project(x, y).map((n) => n.toFixed(1)).join(','));
    return `M${pts.join('L')}Z`;
  }).join(' ');
}

/* ---------- zoom/pan (mouse wheel + drag on desktop, pinch + drag on
   touch) - mutates the SVG's own viewBox directly rather than a CSS
   transform, so stroke widths and hit-testing stay in the same coordinate
   space at any zoom level. Pointer Events unify mouse/touch/pen into one
   handler rather than needing separate mouse* and touch* listeners. ---------- */

// How far in (smaller viewBox = more zoomed in) relative to the initial
// fit. At city level, "initial" is the whole-country fit - a small city
// can be well under 1% of that width, so this needs to allow real depth,
// not just "somewhat closer than the national view" (0.15 here measured
// as never letting canopy-map.html's zoom-to-drill reach even its own
// largest cities, since the view could never shrink past ~6.7x zoom).
const ZOOM_MIN_FACTOR = 0.002;
const ZOOM_MAX_FACTOR = 6; // how far out
const DRAG_THRESHOLD_PX = 6; // below this, a pointerdown->up counts as a tap, not a pan
// A plain 1:1 drag (the point under the cursor stays under the cursor,
// exactly what contentRect()'s own conversion factor gives you) read as too
// slow/heavy to actually move around the map - deliberately above 1 so a
// given drag distance pans further than the cursor itself moved, at the
// cost of that 1:1 tracking feel.
const DRAG_SENSITIVITY = 1.8;

/**
 * Wires zoom/pan onto `svgEl`, whose viewBox starts at `initial`
 * `{x, y, w, h}`. Returns `{ reset(), zoomIn(), zoomOut(), isDragging(),
 * destroy() }` - `isDragging()` lets a caller's own click handler on child
 * shapes (e.g. one path per city) skip acting when the click that just
 * fired was actually the tail end of a pan/pinch gesture, not a tap.
 *
 * `svgEl` itself is a persistent element that a caller's own re-render
 * only replaces the innerHTML of (not the element itself) - calling this
 * again on the same element WITHOUT destroying the previous attachment
 * first would leave the old wheel/pointer listeners firing alongside the
 * new ones (each wheel tick zooming twice, three times, ... after enough
 * re-renders). Callers that re-render on a timer/on every interaction
 * (canopy-map.html's own zoom-to-drill re-renders mid-gesture) MUST call
 * the previous attachment's destroy() before attaching a new one.
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
  const listeners = []; // [type, handler] - removed on destroy()
  function on(type, handler, opts) {
    svgEl.addEventListener(type, handler, opts);
    listeners.push([type, handler, opts]);
  }

  function apply() {
    svgEl.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    if (onChange) onChange({ ...view });
  }

  // svgEl's own box (.cm-svg) is a fixed, roughly-square aspect-ratio in
  // CSS, but the viewBox it's showing rarely matches that aspect - Israel's
  // own national fit is ~1:2.9 (tall/narrow), a picked city's is closer to
  // 1:1, canopy-map.html's own Jerusalem-zoomed default view is ~1:2.9
  // again. preserveAspectRatio="xMidYMid meet" (the SVG default) letterboxes
  // whichever dimension doesn't fill the box - blank bars on left+right when
  // the view is relatively TALLER than the box, blank bars top+bottom when
  // it's relatively WIDER - so the box's own getBoundingClientRect() is
  // NOT the rendered content's actual on-screen size. Using it directly as
  // the px<->view-units conversion factor (the old version of this
  // function) was fine on whichever axis happens to be the limiting one
  // (no letterboxing there, box size == content size) but wrong on the
  // other - a fixed screen-px drag mapped to a SMALLER view-units change
  // than it geometrically should, on whichever axis has the blank bars
  // (measured: Jerusalem's own default view has bars on left+right, so a
  // given horizontal mouse-drag distance panned noticeably less than the
  // same distance panned vertically - "left/right is harder than up/down").
  function contentRect() {
    const rect = svgEl.getBoundingClientRect();
    const boxAspect = rect.width / rect.height;
    const viewAspect = view.w / view.h;
    let width; let height;
    if (viewAspect < boxAspect) {
      // view is relatively taller than the box - box height is the
      // limiting dimension, width letterboxed (bars left+right).
      height = rect.height;
      width = rect.height * viewAspect;
    } else {
      // view is relatively wider than the box - box width is the limiting
      // dimension, height letterboxed (bars top+bottom).
      width = rect.width;
      height = rect.width / viewAspect;
    }
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height,
    };
  }

  function screenToView(px, py) {
    const rect = contentRect();
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

  on('wheel', (ev) => {
    ev.preventDefault();
    const [vx, vy] = screenToView(ev.clientX, ev.clientY);
    zoomAtView(vx, vy, ev.deltaY > 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  on('pointerdown', (ev) => {
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

  on('pointermove', (ev) => {
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
      const rect = contentRect(); // NOT svgEl.getBoundingClientRect() - see its own comment above
      view.x -= (dx / rect.width) * view.w * DRAG_SENSITIVITY;
      view.y -= (dy / rect.height) * view.h * DRAG_SENSITIVITY;
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
  on('pointerup', endPointer);
  on('pointercancel', endPointer);

  return {
    reset() {
      view.x = initial.x; view.y = initial.y; view.w = initial.w; view.h = initial.h;
      apply();
    },
    zoomIn() { zoomAtView(view.x + view.w / 2, view.y + view.h / 2, 1 / 1.4); },
    zoomOut() { zoomAtView(view.x + view.w / 2, view.y + view.h / 2, 1.4); },
    isDragging: () => dragged,
    destroy() {
      listeners.forEach(([type, handler, opts]) => svgEl.removeEventListener(type, handler, opts));
      listeners.length = 0;
    },
  };
}
