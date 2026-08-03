#!/usr/bin/env python3
"""
Builds the heat-island comparison data: city / neighborhood / street max
temperature delta, from the Ministry of Environmental Protection's national
climate-risk map (with Tomorrow.io + the Israel Meteorological Service) -
specifically its "UHI_Ta_9pm.tif" layer: August 21:00 air temperature,
compared to the open land surrounding each settlement, at ~43m resolution.

Like canopy_build.py, this is a local, one-time (re-run-when-the-source-
updates) batch job, not something that runs in the browser. Unlike the tree
canopy shapefile, this source genuinely has no bulk-download option at all -
its ArcGIS ImageServer reports capabilities "Image,TilesOnly" and access
"SECURE", so the normal query operations (identify/exportImage) and even
GetCapabilities all fall through to the site's own SPA shell instead of real
data. What DOES work, confirmed directly: the raw tile endpoint
(/tile/{level}/{row}/{col}) over plain HTTP, no auth - each tile is a
Lerc2-encoded (Limited Error Raster Compression) float32 block, decodable
with Esri's own small `lerc` package. So the real per-pixel values ARE
reachable, just one 256x256 tile at a time rather than as one file.

Source: https://tiledimageservices5.arcgis.com/wnMTbUuVF6Bam1r4/arcgis/rest/services/UHI_Ta_9pm.tif/ImageServer
Found via the Ministry's public climate-risk webmap (ArcGIS item
ee8e19d6e44d4c11b4d0676f5921529f, layer group "איי חום עירוניים").

Reuses canopy_build.py's own city/neighborhood/street boundary geometries
as-is (same OSM/GovMap zip/ inputs) rather than re-deriving them - the two
scripts' outputs are meant to sit side by side, keyed the same way.

Usage:
    python3 tools/heat_build.py fetch    # tiles -> zip/uhi_itm.tif (slow, ~850 tiles)
    python3 tools/heat_build.py cities
    python3 tools/heat_build.py neighborhoods
    python3 tools/heat_build.py streets
    python3 tools/heat_build.py all      # fetch (if needed) + all three levels
    python3 tools/heat_build.py blobs    # per-city raster "stain" overlay (canopy-map.html only, needs Pillow) - not part of "all"
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import requests
import lerc
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterstats import zonal_stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canopy_build import load_muni_geoms, city_index, neighborhood_geoms, street_geoms  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "zip"
SRC = ROOT / "src"

SERVICE = "https://tiledimageservices5.arcgis.com/wnMTbUuVF6Bam1r4/arcgis/rest/services/UHI_Ta_9pm.tif/ImageServer"
LEVEL = 5  # finest LOD this service offers - ~43.13m/pixel, matches its own meanPixelSize
TILE_PX = 256
RESOLUTION = 43.1297398294719  # m/pixel at LEVEL - from the service's own tileInfo.lods
ORIGIN_X = 3802413.83367615  # tileInfo.origin - top-left corner, EPSG:3857
ORIGIN_Y = 3949980.01182384
EXTENT = {  # service's own fullExtent, EPSG:3857
    "xmin": 3802413.83367615, "ymin": 3437641.832389543,
    "xmax": 3998352.241721441, "ymax": 3949980.0118238395,
}
TILE_SIZE_M = TILE_PX * RESOLUTION

RAW_TIF = ZIP / "uhi_raw_3857.tif"
ITM_TIF = ZIP / "uhi_itm.tif"

FETCH_ATTEMPTS = 3
RETRY_PAUSE_S = 1.5


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_tile(row, col):
    """One tile's decoded (256,256) float32 array, or None if this cell has
    no data (outside Israel's actual landmass - the bounding box is much
    bigger than the country's own irregular shape) or the request fails
    after retries. Matches plan-data.js's own "a couple of retries, then
    give up" convention for a live government endpoint that occasionally
    hiccups with no clean error signal."""
    url = f"{SERVICE}/tile/{LEVEL}/{row}/{col}"
    last_err = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            res = requests.get(url, timeout=30)
            if res.status_code == 404:
                return None  # genuinely no tile here - not an error worth retrying
            res.raise_for_status()
            status, arr, _mask = lerc.decode(res.content)
            if status != 0:
                raise ValueError(f"lerc decode status {status}")
            return arr
        except Exception as e:  # noqa: BLE001 - deliberately broad, see plan-data.js's fetchPage for the same reasoning
            last_err = e
            if attempt < FETCH_ATTEMPTS:
                time.sleep(RETRY_PAUSE_S * attempt)
    log(f"  tile {row},{col} failed after {FETCH_ATTEMPTS} attempts: {last_err}")
    return None


def fetch_mosaic():
    """Fetches every tile covering EXTENT at LEVEL, decodes each, and writes
    the assembled raster straight to a GeoTIFF (EPSG:3857) - one fetch+decode
    pass, not held as one giant array any longer than a single tile's worth
    at a time, since the assembled mosaic (~206MB per the service's own
    reported uncompressedSize) is comfortably small enough to write
    incrementally via rasterio's own windowed I/O."""
    n_cols = int(np.ceil((EXTENT["xmax"] - EXTENT["xmin"]) / TILE_SIZE_M))
    n_rows = int(np.ceil((EXTENT["ymax"] - EXTENT["ymin"]) / TILE_SIZE_M))
    width, height = n_cols * TILE_PX, n_rows * TILE_PX
    log(f"{n_cols}x{n_rows} tiles ({width}x{height} px) to cover the service's full extent")

    transform = rasterio.transform.from_origin(ORIGIN_X, ORIGIN_Y, RESOLUTION, RESOLUTION)
    profile = {
        "driver": "GTiff", "dtype": "float32", "count": 1, "nodata": np.nan,
        "width": width, "height": height, "crs": "EPSG:3857", "transform": transform,
        "compress": "deflate", "tiled": True, "blockxsize": TILE_PX, "blockysize": TILE_PX,
    }
    t0 = time.time()
    fetched = 0
    empty = 0
    with rasterio.open(RAW_TIF, "w", **profile) as dst:
        for row in range(n_rows):
            for col in range(n_cols):
                arr = fetch_tile(row, col)
                if arr is None:
                    empty += 1
                    continue
                window = rasterio.windows.Window(col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX)
                dst.write(arr, 1, window=window)
                fetched += 1
            if (row + 1) % 5 == 0:
                elapsed = time.time() - t0
                log(f"  row {row+1}/{n_rows} - {fetched} tiles fetched, {empty} empty, {elapsed:.0f}s elapsed")
    log(f"done: {fetched} tiles with data, {empty} empty, wrote {RAW_TIF.relative_to(ROOT)} in {time.time()-t0:.0f}s")


def warp_to_itm():
    """Reprojects the fetched EPSG:3857 mosaic to EPSG:2039 (ITM) - matching
    canopy_build.py's own boundary geometries, so zonal_stats() below can run
    directly against those same city/neighborhood/street shapes with no
    per-geometry reprojection of its own."""
    log("reprojecting to EPSG:2039 (ITM)...")
    with rasterio.open(RAW_TIF) as src:
        transform, width, height = calculate_default_transform(
            src.crs, "EPSG:2039", src.width, src.height, *src.bounds)
        profile = src.profile.copy()
        profile.update(crs="EPSG:2039", transform=transform, width=width, height=height)
        with rasterio.open(ITM_TIF, "w", **profile) as dst:
            reproject(
                source=rasterio.band(src, 1), destination=rasterio.band(dst, 1),
                src_transform=src.transform, src_crs=src.crs,
                dst_transform=transform, dst_crs="EPSG:2039",
                resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan,
            )
    log(f"wrote {ITM_TIF.relative_to(ROOT)}")


def ensure_raster():
    if not ITM_TIF.exists():
        if not RAW_TIF.exists():
            fetch_mosaic()
        warp_to_itm()


def stats_for(geoms_wkt):
    """[{max, mean, count}] (or None per-entry if the shape has no covered
    pixels at all - e.g. a tiny street buffer that happens to land entirely
    in a no-data gap) for a list of WKT geometries, one zonal_stats() call
    for the whole batch rather than one GDAL raster open per shape."""
    results = zonal_stats(geoms_wkt, str(ITM_TIF), stats=["max", "mean", "count"], nodata=np.nan)
    return results


def build_cities():
    ensure_raster()
    log("loading city boundaries...")
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    munis = {k: v for k, v in munis.items() if v[2] != "מועצה אזורית"}  # see canopy_build.py's own build_cities() for why
    log(f"{len(munis)} cities (regional councils excluded)")

    names = list(munis.keys())
    wkts = [munis[n][0].ExportToWkt() for n in names]
    log("computing zonal stats...")
    stats = stats_for(wkts)

    out = {}
    for name, (_, code, _sug), s in zip(names, munis.values(), stats):
        if s["count"] == 0 or s["max"] is None:
            continue  # no covered pixels - not a meaningful entry, not a false "0°C"
        out[name] = {
            "code": code,
            "maxC": round(s["max"], 2),
            "meanC": round(s["mean"], 2),
            "pixelCount": s["count"],
        }
    log(f"done - {len(out)} cities with data")
    return out


def build_neighborhoods():
    ensure_raster()
    log("loading neighborhood geometries from OSM...")
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    names, shapes, tree = city_index(munis)
    geoms = neighborhood_geoms(names, shapes, tree)

    log("computing zonal stats...")
    wkts = [g.wkt for _c, _n, g, _a in geoms]
    stats = stats_for(wkts)

    out = {}
    for (city, name, _g, approx), s in zip(geoms, stats):
        if s["count"] == 0 or s["max"] is None:
            continue
        key = f"{city or '—'}::{name}"
        entry = {"maxC": round(s["max"], 2), "meanC": round(s["mean"], 2), "pixelCount": s["count"]}
        if approx:
            entry["approx"] = True
        out[key] = entry
    log(f"done - {len(out)} neighborhoods with data")
    return out


def build_streets():
    ensure_raster()
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    names, shapes, tree = city_index(munis)
    groups = street_geoms(names, shapes, tree)

    log(f"computing zonal stats for {len(groups)} streets...")
    wkts = [buf.wkt for _c, _n, buf, _len, _nb in groups]
    stats = stats_for(wkts)

    out = {}
    for (city, name, _buf, length_m, neighborhood), s in zip(groups, stats):
        if s["count"] == 0 or s["max"] is None:
            continue
        key = f"{city}::{name}"
        out[key] = {
            "maxC": round(s["max"], 2),
            "meanC": round(s["mean"], 2),
            "pixelCount": s["count"],
            "lengthM": round(length_m, 1),
            **({"nb": neighborhood} if neighborhood else {}),
        }
    log(f"done - {len(out)} streets with data")
    return out


def colorize(t):
    """(h, w) float array (deviation from a crop's own median, in units of
    its own span - see build_heat_blobs) -> (h, w, 4) uint8 RGBA. Diverging
    cool/neutral/hot ramp; alpha scales with |t| so pixels near this crop's
    own median fade toward fully transparent - the result reads as actual
    hot/cool "stains" floating over the map, not a flat tinted rectangle
    covering the whole city. NaN (no data) is always fully transparent."""
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


def build_heat_blobs():
    """One base64 PNG "stain" overlay per city with OSM-mapped
    neighborhoods (~96 of them) - for canopy-map.html's neighborhood view.

    The three levels above (city/neighborhood/street) all answer "how hot
    is this AREA overall" - useful for "is Tiberias hot", useless for
    "which street in Tiberias is hotter than the one next to it, and does
    that hot patch actually respect neighborhood boundaries or bleed across
    them". Only the raw raster behind all three (ITM_TIF, ~37m/pixel here)
    has that resolution, and a polygon-average was always going to throw it
    away. This renders the raster itself, cropped per city, colored by each
    PIXEL's own deviation from THAT CROP's own median (not the national/
    per-city scale the choropleth uses - a hot street only means something
    relative to its own city) - so the output is one continuous shape that
    can straddle neighborhood lines, not neighborhood-shaped averages.

    The crop is the union of that city's own NEIGHBORHOODS' bounds, not the
    municipality's full jurisdiction - several municipalities here are
    small built-up areas inside a huge administrative area (desert towns
    with vast surrounding land, regional councils grouping scattered
    villages), and cropping to the full muni bbox once produced 30-60km-wide
    rasters that were almost entirely empty land no one would ever look at
    (measured directly: a first pass at this made a 26MB output file, worse
    than useless - see this function's own git history). The union of real
    neighborhoods is exactly the area the map actually draws shapes for
    anyway. A generous crop margin (25% of that extent) is still added on
    top, so a hot cluster near the edge visibly continues past it rather
    than cutting off exactly at the outermost neighborhood's own boundary.
    """
    try:
        from PIL import Image
    except ImportError:
        sys.exit("build_heat_blobs requires Pillow: pip install pillow")
    import base64
    import io
    from collections import defaultdict

    ensure_raster()
    log("loading city/neighborhood boundaries...")
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    # Same "not a real single city" exclusion build_cities()/build_streets()
    # already apply - a regional council is a grouping of scattered
    # villages, not one urban area a hot-spot "stain" reading makes sense
    # for. Cuts most of the worst offenders (several regional councils'
    # named-point neighborhoods are tens of km apart).
    munis = {k: v for k, v in munis.items() if v[2] != "מועצה אזורית"}
    names, shapes, tree = city_index(munis)
    geoms = neighborhood_geoms(names, shapes, tree)
    nb_by_city = defaultdict(list)
    for city, _n, g, _a in geoms:
        if city and city in munis:
            nb_by_city[city].append(g)
    cities_with_nb = sorted(nb_by_city.keys())
    log(f"{len(cities_with_nb)} cities have OSM-mapped neighborhoods - building a blob for each")

    # A handful of real towns (desert municipalities especially) still have
    # a legitimate but enormous jurisdiction, or one outlying named point
    # dragging the bbox out for tens of km past the actual built-up area -
    # a raster crop that size is almost entirely empty land, not a useful
    # "which street is hotter" visual. Skipped rather than shipped huge.
    MAX_SPAN_M = 30_000

    out = {}
    with rasterio.open(ITM_TIF) as src:
        for i, city in enumerate(cities_with_nb):
            nb_shapes = nb_by_city[city]
            xmin = min(g.bounds[0] for g in nb_shapes)
            ymin = min(g.bounds[1] for g in nb_shapes)
            xmax = max(g.bounds[2] for g in nb_shapes)
            ymax = max(g.bounds[3] for g in nb_shapes)
            if max(xmax - xmin, ymax - ymin) > MAX_SPAN_M:
                continue
            pad = max(xmax - xmin, ymax - ymin) * 0.25
            window = rasterio.windows.from_bounds(
                xmin - pad, ymin - pad, xmax + pad, ymax + pad, transform=src.transform)
            arr = src.read(1, window=window, boundless=True, fill_value=np.nan)
            if arr.size == 0:
                continue
            valid = arr[~np.isnan(arr)]
            if valid.size < 16:
                continue  # too small/sparse a crop for a "which street is hotter" reading to mean anything
            median = float(np.median(valid))
            lo, hi = float(valid.min()), float(valid.max())
            span = max(hi - median, median - lo, 0.3)  # avoid a near-zero divisor on a near-flat crop
            rgba = colorize((arr - median) / span)
            buf = io.BytesIO()
            Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            # Same Y-flipped-ITM convention as itmViewBox()/cityBBoxes() in
            # map-shapes.js/canopy-map.js - x/y/w/h here can be dropped
            # straight into an SVG <image> alongside the neighborhood paths
            # with no further conversion.
            left, bottom, right, top = rasterio.windows.bounds(window, src.transform)
            out[city] = {
                "src": f"data:image/png;base64,{b64}",
                "x": round(left, 1),
                "y": round(-top, 1),
                "w": round(right - left, 1),
                "h": round(top - bottom, 1),
            }
            if (i + 1) % 20 == 0:
                log(f"  {i + 1}/{len(cities_with_nb)} blobs built")
    log(f"done - {len(out)} heat blobs built")
    return out


def write_js(varname, data, out_path, header_comment):
    out_path.write_text(
        f"// {header_comment}\n"
        f"// Generated by tools/heat_build.py - do not edit by hand.\n"
        f"export const {varname} = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    kb = out_path.stat().st_size / 1024
    log(f"wrote {out_path.relative_to(ROOT)} ({kb:.1f} KB)")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    stamp = time.strftime("%Y-%m-%dT%H:%M%z") or time.strftime("%Y-%m-%dT%H:%M")

    if which == "fetch":
        fetch_mosaic()
        warp_to_itm()
        return

    if which in ("cities", "all"):
        write_js("CITY_HEAT", build_cities(), SRC / "heat-cities.js",
                  f"City-level max heat-island delta (°C, Aug 21:00 vs. open land), computed {stamp}")

    if which in ("neighborhoods", "all"):
        write_js("NEIGHBORHOOD_HEAT", build_neighborhoods(), SRC / "heat-neighborhoods.js",
                  f"Neighborhood-level max heat-island delta (OSM-mapped areas only), computed {stamp}")

    if which in ("streets", "all"):
        write_js("STREET_HEAT", build_streets(), SRC / "heat-streets.js",
                  f"Street-level max heat-island delta (7.5m buffer per street), computed {stamp}")

    if which == "blobs":
        # Deliberately not part of "all" - a heavier, separate asset (base64
        # PNG per city) only canopy-map.html uses, not the three base
        # city/neighborhood/street tables every page here ships.
        write_js("HEAT_BLOBS", build_heat_blobs(), SRC / "heat-blobs.js",
                  f"Per-city heat-island raster overlay (relative to each crop's own median), computed {stamp}")


if __name__ == "__main__":
    main()
