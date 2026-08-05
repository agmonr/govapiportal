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
tools/heat_build.py fetch`), same per-crop-too-small skip. The only real
difference in coverage: every city in MAP_CITIES gets a blob now (falling
back to its own full municipal boundary when it has no OSM-mapped
neighborhoods), not just the ~96 with neighborhood coverage - see
blob_geo.city_crop_window.

colorize() is no longer PURELY per-crop-median-relative, though: a pixel's
deviation from its own crop's median still decides WHERE the hot spots are
drawn within a city (a per-city-normalized scale can't be a fixed national
one - each crop's own min/max differ too much for that to read as anything
but noise), but that deviation is then scaled by blob_geo.
load_city_heat_weights() before colorizing - a heat island inside a city
that runs hot nationally (a high percentile of CITY_HEAT's own meanC) reads
more intensely than the identical local anomaly in a naturally cool city, so
the picture isn't purely "hot relative to THIS city's own surroundings"
anymore, it also reflects how hot the city itself is in the national
picture.

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


def colorize(t_color, t_alpha=None):
    """(h, w) float arrays -> (h, w, 4) uint8 RGBA. t_color (deviation from
    a crop's own median, in units of its own span, then weighted by how hot
    that city runs nationally - see render_city_heat) picks the diverging
    cool/neutral/hot color itself. t_alpha (defaults to t_color) picks how
    opaque each pixel is - deliberately kept UNweighted (the raw local
    deviation, before the national multiplier) rather than reusing t_color:
    weighting alpha too made a real local heat island in a nationally-cool
    city fade to almost nothing (that city's own weight can be as low as
    0.5x) - invisible reads as "no heat here" to someone looking at the map,
    not "this heat matters less," which isn't what a lower weight is meant
    to say. Keeping alpha on the unweighted value means a genuine local
    anomaly always shows up; only its color (how deep red vs. how pale)
    reflects the national weighting."""
    if t_alpha is None:
        t_alpha = t_color
    nan_mask = np.isnan(t_color)
    tt = np.nan_to_num(t_color, nan=0.0)
    ta = np.nan_to_num(t_alpha, nan=0.0)
    cool = np.array([59, 111, 181], dtype=np.float64)
    neutral = np.array([242, 234, 217], dtype=np.float64)
    hot = np.array([224, 83, 83], dtype=np.float64)  # matches the site's own --danger
    frac_cool = np.clip(-tt, 0, 1)
    frac_hot = np.clip(tt, 0, 1)
    frac_mid = np.clip(1 - frac_cool - frac_hot, 0, 1)
    rgb = (neutral[None, None, :] * frac_mid[..., None]
           + cool[None, None, :] * frac_cool[..., None]
           + hot[None, None, :] * frac_hot[..., None])
    # Exponent < 1 makes this curve CONCAVE (boosts low/mid |ta| towards full
    # alpha rather than suppressing them) - was 1.2 (convex, suppresses
    # low/mid values) with a 210 ceiling, which read as "much too weak"
    # against a real basemap/page background (live user report, confirmed
    # visually: even a city's genuine hot spots stayed pale pink, barely
    # distinguishable from the page background). 0 deviation still fades to
    # fully transparent either way - only the falloff shape and the ceiling
    # changed. Ceiling is 230 (90% of 255) - user asked for red (heat) and
    # green (canopy, canopy_blobs.py's own ALPHA) both at 90% strong, so the
    # two layers read as equally strong rather than one capped higher.
    alpha = (np.clip(np.abs(ta), 0, 1) ** 0.55) * 230
    alpha = np.where(nan_mask, 0, alpha)
    rgba = np.concatenate([rgb, alpha[..., None]], axis=-1)
    return np.clip(rgba, 0, 255).astype(np.uint8)


def render_city_heat(src, x0, y0, x1, y1, city_weight=1.0):
    """(png_bytes, x, y, w, h) in the same Y-negated ITM convention as
    canopy_blobs.py's own render_city_canopy - None if the crop has too few
    valid (non-nodata) pixels to mean anything (same threshold
    heat_build.py's build_heat_blobs used: <16).

    city_weight (see blob_geo.load_city_heat_weights) scales the per-crop-
    relative deviation before picking each pixel's COLOR (see colorize's own
    docstring for why not its alpha too): a pixel that's, say, 80% of the
    way to this crop's own hottest point reads as more intense - a bigger
    slice of the color ramp, saturating at a smaller local anomaly - in a
    city that runs hot nationally than the identical 80%-of-local-span pixel
    in a naturally cool city. Local pattern still drives WHERE the hot spots
    are drawn inside a crop and whether they're visible at all; the national
    weighting only rescales how saturated/red they read."""
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
    t_local = (arr - median) / span
    rgba = colorize(t_local * city_weight, t_alpha=t_local)

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
    city_weights = blob_geo.load_city_heat_weights()
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
            result = render_city_heat(src, *window, city_weight=city_weights.get(city, 1.0))
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
    # PNGs go to assets/blobs/heat/<city>.png as real files, fetched by the
    # browser lazily (only for whichever city is actually on screen) via a
    # plain <image href> URL - NOT inlined as base64 here, which used to
    # force every page load to download all ~186 cities' worth of image
    # data (~17MB) regardless of whether any of it was ever looked at.
    # dist/canopy-map.html (the offline, single-file copy - see bundle.py)
    # re-inlines these same PNGs as data URIs at bundle time so it still
    # works standalone from file:// with no sibling assets folder needed.
    out_dir = ROOT / "assets" / "blobs" / "heat"
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {}
    for city, d in data.items():
        b64 = d["src"].split(",", 1)[1]
        png_bytes = base64.b64decode(b64)
        # Literal city name, not percent-encoded: a plain static file server
        # decodes the URL back to raw Unicode before looking the file up on
        # disk, so the file itself has to exist under that literal name (same
        # convention as this file's own /tmp/heat-blob-<city>.png debug path
        # above) - an encoded filename on disk 404s once the browser fetches it.
        fname = f"{city}.png"
        (out_dir / fname).write_bytes(png_bytes)
        meta[city] = {"src": f"./assets/blobs/heat/{fname}", "x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"]}

    stamp = time.strftime("%Y-%m-%dT%H:%M%z") or time.strftime("%Y-%m-%dT%H:%M")
    out_path = SRC / "heat-blobs.js"
    out_path.write_text(
        f"// Per-city heat-island raster overlay metadata (relative to each crop's own median, weighted by how hot that city runs nationally - see blob_geo.load_city_heat_weights), computed {stamp} - "
        f"the actual PNGs live under assets/blobs/heat/, fetched lazily by the browser only for the city on screen, not bundled here.\n"
        f"// Generated by tools/heat_blobs.py - do not edit by hand.\n"
        f"export const HEAT_BLOBS = {json.dumps(meta, ensure_ascii=False, separators=(',', ':'))};\n",
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
        city_weight = blob_geo.load_city_heat_weights().get(city, 1.0)
        with rasterio.open(ITM_TIF) as src:
            result = render_city_heat(src, *window, city_weight=city_weight)
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
