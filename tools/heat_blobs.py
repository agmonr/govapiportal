#!/usr/bin/env python3
"""
Builds the per-city high-resolution heat-island raster "stain" overlay for
canopy-map.html's neighborhood view - src/heat-blobs.js.

This REPLACES heat_build.py's own build_heat_blobs() (the "blobs" CLI
argument there) as the way that file actually gets built now: build_heat_
blobs() reuses canopy_build.py's load_muni_geoms()/neighborhood_geoms() for
city/neighborhood boundary geometry, and canopy_build.py hard-imports `from
osgeo import ogr` at file scope - osgeo isn't installed here (no GDAL
Python bindings, no network to add them), so that whole import chain fails
before a single line of build_heat_blobs() itself runs. See canopy_blobs.py
(the tree-canopy counterpart, which hit the identical problem first) for
the same fix: read city/neighborhood boundary geometry from the plain
ITM-meter ring coordinates already in src/map-boundaries-*.js (built once
by tools/map_geo_build.py for the map's own rendering) via blob_geo.py,
instead of re-deriving it through osgeo.

Everything else is unchanged from heat_build.py's own build_heat_blobs():
same source raster (zip/uhi_itm.tif, already fetched+reprojected by `python3
tools/heat_build.py fetch`), same per-crop-median-relative diverging
colorize(), same crop-too-small skip. The only real difference is coverage:
every city in MAP_CITIES gets a blob now (falling back to its own full
municipal boundary when it has no OSM-mapped neighborhoods), not just the
~96 with neighborhood coverage - see blob_geo.city_crop_window.

Needs rasterio, Pillow, numpy - same geo venv as heat_build.py itself
(./tools/setup.sh --geo), but NOT osgeo/rasterstats. Run with:
    ~/.local/govapiportal-geo-venv/bin/python3 tools/heat_blobs.py

Usage:
    python3 tools/heat_blobs.py           # build src/heat-blobs.js
    python3 tools/heat_blobs.py <city>     # build+save one city's PNG to
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blob_geo  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "zip"
SRC = ROOT / "src"

ITM_TIF = ZIP / "uhi_itm.tif"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def colorize(t):
    """(h, w) float array (deviation from a crop's own median, in units of
    its own span) -> (h, w, 4) uint8 RGBA. Identical to heat_build.py's own
    colorize() - diverging cool/neutral/hot ramp, alpha scales with |t| so
    pixels near the crop's own median fade toward fully transparent."""
    nan_mask = np.isnan(t)
    tt = np.nan_to_num(t, nan=0.0)
    cool = np.array([59, 111, 181], dtype=np.float64)
    neutral = np.array([242, 234, 217], dtype=np.float64)
    hot = np.array([224, 83, 83], dtype=np.float64)  # matches the site's own --danger
    frac_cool = np.clip(-tt, 0, 1)
    frac_hot = np.clip(tt, 0, 1)
    frac_mid = np.clip(1 - frac_cool - frac_hot, 0, 1)
    rgb = (neutral[None, None, :] * frac_mid[..., None]
           + cool[None, None, :] * frac_cool[..., None]
           + hot[None, None, :] * frac_hot[..., None])
    alpha = (np.clip(np.abs(tt), 0, 1) ** 1.2) * 210
    alpha = np.where(nan_mask, 0, alpha)
    rgba = np.concatenate([rgb, alpha[..., None]], axis=-1)
    return np.clip(rgba, 0, 255).astype(np.uint8)


def render_city_heat(src, x0, y0, x1, y1):
    """(png_bytes, x, y, w, h) in the same Y-negated ITM convention as
    canopy_blobs.py's own render_city_canopy - None if the crop has too few
    valid (non-nodata) pixels to mean anything (same threshold
    heat_build.py's build_heat_blobs used: <16)."""
    window = rasterio.windows.from_bounds(x0, y0, x1, y1, transform=src.transform)
    arr = src.read(1, window=window, boundless=True, fill_value=np.nan)
    if arr.size == 0:
        return None
    valid = arr[~np.isnan(arr)]
    if valid.size < 16:
        return None
    median = float(np.median(valid))
    lo, hi = float(valid.min()), float(valid.max())
    span = max(hi - median, median - lo, 0.3)  # avoid a near-zero divisor on a near-flat crop
    rgba = colorize((arr - median) / span)

    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)

    left, bottom, right, top = rasterio.windows.bounds(window, src.transform)
    return buf.getvalue(), left, -top, right - left, top - bottom


def build_all():
    if not ITM_TIF.exists():
        sys.exit(f"{ITM_TIF.relative_to(ROOT)} missing - run "
                  "'python3 tools/heat_build.py fetch' first")
    log("loading city/neighborhood boundaries...")
    city_boxes = blob_geo.load_city_boxes()
    nb_boxes_by_city = blob_geo.load_neighborhood_boxes_by_city()
    cities = sorted(city_boxes.keys())
    log(f"{len(cities)} cities total ({len(nb_boxes_by_city)} with OSM-mapped neighborhoods, "
        f"{len(cities) - len(nb_boxes_by_city)} falling back to their own municipal boundary) - building a heat blob for each")

    out = {}
    skipped_span = 0
    skipped_empty = 0
    t0 = time.time()
    with rasterio.open(ITM_TIF) as src:
        for i, city in enumerate(cities):
            window = blob_geo.city_crop_window(city, nb_boxes_by_city, city_boxes)
            if window is None:
                skipped_span += 1
                continue
            result = render_city_heat(src, *window)
            if result is None:
                skipped_empty += 1
                continue
            png_bytes, x, y, w, h = result
            b64 = base64.b64encode(png_bytes).decode("ascii")
            out[city] = {"src": f"data:image/png;base64,{b64}", "x": round(x, 1), "y": round(y, 1), "w": round(w, 1), "h": round(h, 1)}
            if (i + 1) % 20 == 0:
                elapsed = time.time() - t0
                log(f"  {i+1}/{len(cities)} cities, {elapsed:.0f}s elapsed, ~{elapsed/(i+1)*len(cities):.0f}s total est.")
    log(f"done - {len(out)} heat blobs built ({skipped_span} skipped: span > {blob_geo.MAX_SPAN_M}m, {skipped_empty} skipped: too few valid pixels in crop)")
    return out


def write_js(data):
    stamp = time.strftime("%Y-%m-%dT%H:%M%z") or time.strftime("%Y-%m-%dT%H:%M")
    out_path = SRC / "heat-blobs.js"
    out_path.write_text(
        f"// Per-city heat-island raster overlay (relative to each crop's own median), computed {stamp}\n"
        f"// Generated by tools/heat_blobs.py - do not edit by hand.\n"
        f"export const HEAT_BLOBS = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    kb = out_path.stat().st_size / 1024
    log(f"wrote {out_path.relative_to(ROOT)} ({kb:.1f} KB)")


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
        with rasterio.open(ITM_TIF) as src:
            result = render_city_heat(src, *window)
        if result is None:
            sys.exit(f"too few valid pixels in {city}'s crop")
        png_bytes, x, y, w, h = result
        out_path = Path(f"/tmp/heat-blob-{city}.png")
        out_path.write_bytes(png_bytes)
        print(f"wrote {out_path} ({len(png_bytes)/1024:.1f} KB), x={x:.1f} y={y:.1f} w={w:.1f} h={h:.1f}")
        return

    write_js(build_all())


if __name__ == "__main__":
    main()
