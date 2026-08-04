"""Shared per-city crop-window helper for canopy-map.html's two high-
resolution raster "blob" overlays (heat_blobs_build.py, canopy_blobs.py) -
both need the same "one padded crop per city" boundary logic, and neither
needs osgeo for it (see canopy_blobs.py's own module docstring for why that
matters here): city/neighborhood geometry already exists as plain
ITM-meter ring coordinates in src/map-boundaries-*.js, built once by
tools/map_geo_build.py for the map's own rendering.

Every city in MAP_CITIES gets a crop window, not just the ones with
OSM-mapped neighborhoods (~96 of 186) - a city with no OSM neighborhood
coverage falls back to its own full municipal boundary instead of being
skipped outright, so both blob overlays cover the whole country rather
than roughly half of it.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# A huge rural/desert jurisdiction around a small built-up core (or a
# regional council grouping scattered villages) produces a crop that's
# almost entirely empty land - not a meaningful "which street is greener/
# hotter" image. Same cutoff heat_build.py's own build_heat_blobs already
# used before this module existed.
MAX_SPAN_M = 30_000
PAD_FRAC = 0.25  # crop margin beyond the exact bounds, so a cluster near the edge doesn't cut off sharply


def _load_js_export(path, varname):
    text = path.read_text(encoding="utf-8")
    m = re.search(rf"export const {varname} = (\{{.*\}});", text, re.S)
    return json.loads(m.group(1))


def _bbox_of_rings(rings):
    xs = [pt[0] for ring in rings for pt in ring]
    ys = [pt[1] for ring in rings for pt in ring]
    return min(xs), min(ys), max(xs), max(ys)


def load_city_heat_weights():
    """city -> a multiplier in [0.5, 1.5], from CITY_HEAT's own meanC (each
    city's mean heat-island delta vs. its own surrounding open land, already
    computed by heat_build.py) ranked against every other city nationally.

    Used by heat_blobs.py to make its per-pixel colorize() reflect national
    context, not just each crop's own local pattern: a pixel that stands out
    from ITS OWN city's median (the existing per-crop-relative math) is
    additionally scaled up if that whole city runs hot nationally (a high
    percentile rank of meanC among all cities) or down if the city runs cool
    - the same local anomaly should read as a bigger deal in an
    already-hot city than in a naturally cool one. 0.5 (coldest city
    nationally) to 1.5 (hottest), 1.0 for a city missing from CITY_HEAT
    entirely (neutral - neither boosted nor dampened)."""
    city_heat = _load_js_export(SRC / "heat-cities.js", "CITY_HEAT")
    means = sorted((v["meanC"], name) for name, v in city_heat.items())
    n = len(means)
    weights = {}
    for i, (_mean, name) in enumerate(means):
        percentile = i / (n - 1) if n > 1 else 0.5
        weights[name] = 0.5 + percentile
    return weights


def load_city_boxes():
    """city name -> (xmin, ymin, xmax, ymax), from MAP_CITIES - every city
    the map draws at city level at all, regardless of OSM neighborhood
    coverage."""
    data = _load_js_export(SRC / "map-boundaries-cities.js", "MAP_CITIES")
    return {name: _bbox_of_rings(val["rings"]) for name, val in data.items()}


def load_neighborhood_boxes_by_city():
    """city -> [(xmin, ymin, xmax, ymax), ...], one per neighborhood, from
    MAP_NEIGHBORHOODS. A city with no OSM-mapped neighborhoods at all
    simply has no entry here - see city_crop_window's own fallback."""
    data = _load_js_export(SRC / "map-boundaries-neighborhoods.js", "MAP_NEIGHBORHOODS")
    by_city = {}
    for key, val in data.items():
        city, _, _name = key.partition("::")
        by_city.setdefault(city, []).append(_bbox_of_rings(val["rings"]))
    return by_city


def city_crop_window(city, neighborhood_boxes_by_city, city_boxes):
    """Padded (xmin, ymin, xmax, ymax) crop for one city, or None if its
    span is too big to be a meaningful crop (see MAX_SPAN_M). Prefers the
    union of the city's own OSM-mapped neighborhoods (the tighter, more
    relevant crop where that data exists) and falls back to the city's own
    full municipal boundary otherwise - so every city gets a window, not
    just the ones with neighborhood coverage."""
    boxes = neighborhood_boxes_by_city.get(city) or [city_boxes[city]]
    xmin = min(b[0] for b in boxes)
    ymin = min(b[1] for b in boxes)
    xmax = max(b[2] for b in boxes)
    ymax = max(b[3] for b in boxes)
    if max(xmax - xmin, ymax - ymin) > MAX_SPAN_M:
        return None
    pad = max(xmax - xmin, ymax - ymin) * PAD_FRAC
    return xmin - pad, ymin - pad, xmax + pad, ymax + pad
