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


if __name__ == "__main__":
    main()
