#!/usr/bin/env python3
"""
Builds a per-city high-resolution tree-canopy raster "stain" overlay for
canopy-map.html's neighborhood view - the canopy-side counterpart to
heat_build.py's build_heat_blobs().

Why this exists: the three canopy levels (city/neighborhood/street, all in
tree-canopy.html/canopy_build.py) all answer "what % of this AREA is
covered" - useful for "is Holon leafy", useless for "which exact patch of
Holon has trees, and does that patch respect neighborhood lines or bleed
across them". The source data actually has that resolution already - the
National Canopy Trees layer is ~2.89M individual tree-crown polygons, each
one only a few square meters - a per-neighborhood % was always going to
throw that away. This rasterizes the real crown polygons themselves,
cropped per city, so the output is the actual physical shape of the
canopy - individual crowns at the small end, dense clusters as solid
blocks - not neighborhood-shaped averages. Same idea as heat_build.py's
per-pixel raster stain, just from vector crowns instead of a raster
source.

Deliberately does NOT reuse canopy_build.py's own geometry-loading code
(load_muni_geoms/city_index/neighborhood_geoms) even though the logic
overlaps a lot - that module hard-imports `from osgeo import ogr` at file
scope, and osgeo isn't installed here (no GDAL Python bindings, no network
to add them) even though rasterio's own bundled GDAL works fine. Importing
canopy_build.py would fail before a single line of this script's own logic
ran. Instead this reads city/neighborhood boundary geometry that already
exists as plain ITM-meter ring coordinates in src/map-boundaries-*.js
(built once by tools/map_geo_build.py for the map's own rendering), via
blob_geo.py - already exactly the same city/neighborhood grouping and
already reprojected, so no OSM parsing or WGS84->ITM transform of its own
is needed at all. Covers every city in MAP_CITIES, not just the ~96 with
OSM-mapped neighborhoods - see blob_geo.city_crop_window's own municipal-
boundary fallback.

Needs pyogrio, rasterio, shapely, Pillow - same geo venv as heat_build.py/
canopy_build.py (./tools/setup.sh --geo), except it does NOT need osgeo.
Run with:
    ~/.local/govapiportal-geo-venv/bin/python3 tools/canopy_blobs.py

Usage:
    python3 tools/canopy_blobs.py           # build src/canopy-blobs.js
    python3 tools/canopy_blobs.py <city>     # build+save one city's PNG to
                                              # /tmp for a quick visual check,
                                              # print instead of writing js
"""
import base64
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from pyogrio.raw import read as ogr_read
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blob_geo  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "zip"
SRC = ROOT / "src"

CANOPY_GPKG = ZIP / "canopy.gpkg"
CANOPY_LAYER = "canopy"

MAX_DIM_PX = 2400  # longer side of the output raster, in pixels - tested against
# 1600 (blurs individual crowns into faint single pixels) and 4000 (visibly
# crisper - court yards/building footprints resolvable - but ~5x the file
# size for a gain past what's legible at normal zoom); 2400 keeps most
# crowns 2+ pixels wide without the size blowup
MIN_RES_M = 1.0  # never go finer than 1m/pixel even for a tiny crop - a single tree crown is a few m^2 already

CANOPY_RGB = (46, 125, 70)  # site's --accent (light theme), src/style.css
ALPHA = 230  # 90% of 255 - user asked for red (heat) and green (canopy) both at 90% strong


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def render_city_canopy(x0, y0, x1, y1):
    """(png_bytes, x, y, w, h) - w/h are the raster's own actual covered
    span (pixel count * resolution, not the raw x1-x0/y1-y0 - a whole
    number of pixels rarely divides the crop exactly), x/y is the top-left
    corner in the same Y-negated ITM convention heat-blobs.js/map-shapes.js
    already use. None if this crop has no canopy at all."""
    meta, fields, wkb, fids = ogr_read(str(CANOPY_GPKG), layer=CANOPY_LAYER, bbox=(x0, y0, x1, y1))
    if len(wkb) == 0:
        return None

    span = max(x1 - x0, y1 - y0)
    res = max(MIN_RES_M, span / MAX_DIM_PX)
    w_px = max(1, round((x1 - x0) / res))
    h_px = max(1, round((y1 - y0) / res))
    transform = rasterio.transform.from_origin(x0, y1, res, res)

    geoms = shapely.from_wkb(wkb)
    mask = rasterize(
        ((g, 1) for g in geoms),
        out_shape=(h_px, w_px),
        transform=transform,
        fill=0,
        dtype="uint8",
    )
    if not mask.any():
        return None

    rgba = np.zeros((h_px, w_px, 4), dtype=np.uint8)
    rgba[..., 0] = CANOPY_RGB[0]
    rgba[..., 1] = CANOPY_RGB[1]
    rgba[..., 2] = CANOPY_RGB[2]
    rgba[..., 3] = mask * ALPHA

    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)

    w_m, h_m = w_px * res, h_px * res
    return buf.getvalue(), x0, -y1, w_m, h_m


def build_all():
    log("loading city/neighborhood boundaries...")
    city_boxes = blob_geo.load_city_boxes()
    nb_boxes_by_city = blob_geo.load_neighborhood_boxes_by_city()
    cities = sorted(city_boxes.keys())
    log(f"{len(cities)} cities total ({len(nb_boxes_by_city)} with OSM-mapped neighborhoods, "
        f"{len(cities) - len(nb_boxes_by_city)} falling back to their own municipal boundary) - building a canopy blob for each")

    out = {}
    skipped_span = 0
    skipped_empty = 0
    t0 = time.time()
    for i, city in enumerate(cities):
        window = blob_geo.city_crop_window(city, nb_boxes_by_city, city_boxes)
        if window is None:
            skipped_span += 1
            continue
        result = render_city_canopy(*window)
        if result is None:
            skipped_empty += 1
            continue
        png_bytes, x, y, w, h = result
        b64 = base64.b64encode(png_bytes).decode("ascii")
        out[city] = {"src": f"data:image/png;base64,{b64}", "x": round(x, 1), "y": round(y, 1), "w": round(w, 1), "h": round(h, 1)}
        if (i + 1) % 20 == 0:
            elapsed = time.time() - t0
            log(f"  {i+1}/{len(cities)} cities, {elapsed:.0f}s elapsed, ~{elapsed/(i+1)*len(cities):.0f}s total est.")
    log(f"done - {len(out)} canopy blobs built ({skipped_span} skipped: span > {blob_geo.MAX_SPAN_M}m, {skipped_empty} skipped: no canopy in crop)")
    return out


def write_js(data):
    # Same lazy-fetch split as heat_blobs.py's own write_js - see its
    # comment for why: real PNG files under assets/blobs/canopy/, not
    # inlined base64, so a page load only pays for whichever city's canopy
    # dots are actually on screen. dist/canopy-map.html re-inlines them at
    # bundle time to stay a single offline-capable file.
    out_dir = ROOT / "assets" / "blobs" / "canopy"
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {}
    for city, d in data.items():
        b64 = d["src"].split(",", 1)[1]
        png_bytes = base64.b64decode(b64)
        # Literal city name, not percent-encoded - see heat_blobs.py's own
        # write_js() for why (an encoded filename on disk 404s once the
        # browser fetches it, since the server decodes the URL first).
        fname = f"{city}.png"
        (out_dir / fname).write_bytes(png_bytes)
        meta[city] = {"src": f"./assets/blobs/canopy/{fname}", "x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"]}

    stamp = time.strftime("%Y-%m-%dT%H:%M%z") or time.strftime("%Y-%m-%dT%H:%M")
    out_path = SRC / "canopy-blobs.js"
    out_path.write_text(
        f"// Per-city tree-canopy dot overlay metadata (real crown polygons, not per-neighborhood %), computed {stamp} - "
        f"the actual PNGs live under assets/blobs/canopy/, fetched lazily by the browser only for the city on screen, not bundled here.\n"
        f"// Generated by tools/canopy_blobs.py - do not edit by hand.\n"
        f"export const CANOPY_BLOBS = {json.dumps(meta, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    kb = out_path.stat().st_size / 1024
    png_mb = sum(f.stat().st_size for f in out_dir.glob("*.png")) / 1024 / 1024
    log(f"wrote {out_path.relative_to(ROOT)} ({kb:.1f} KB) + {len(meta)} PNGs under {out_dir.relative_to(ROOT)} ({png_mb:.1f} MB total)")


def main():
    if len(sys.argv) > 1:
        city = sys.argv[1]
        city_boxes = blob_geo.load_city_boxes()
        if city not in city_boxes:
            sys.exit(f"no such city {city!r} - known cities include: {sorted(city_boxes)[:10]}")
        nb_boxes_by_city = blob_geo.load_neighborhood_boxes_by_city()
        window = blob_geo.city_crop_window(city, nb_boxes_by_city, city_boxes)
        if window is None:
            sys.exit(f"{city}'s own span exceeds {blob_geo.MAX_SPAN_M}m - skipped in the real build too")
        result = render_city_canopy(*window)
        if result is None:
            sys.exit(f"no canopy polygons found in {city}'s crop")
        png_bytes, x, y, w, h = result
        out_path = Path(f"/tmp/canopy-blob-{city}.png")
        out_path.write_bytes(png_bytes)
        print(f"wrote {out_path} ({len(png_bytes)/1024:.1f} KB), x={x:.1f} y={y:.1f} w={w:.1f} h={h:.1f}")
        return

    write_js(build_all())


if __name__ == "__main__":
    main()
