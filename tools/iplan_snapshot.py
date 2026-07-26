#!/usr/bin/env python3
"""
Downloads a map image for an Israeli address from iplan's Xplan service
(the "קווים כחולים" MapServer, already catalogued in apis.json under the
"iplan" portal), showing the three layers checked by default in the site's
own layer panel, under "תוכניות מקוונות":

    - layer 1: קווים כחולים-תכניות מקוונות  (plan boundary lines - this is
      its own checked layer in the site's UI, not just the site's nickname;
      it's what draws the small labelled plan-number boxes, e.g. 416-xxxxx)
    - layer 4: יעודי קרקע                    (land use designations)
    - layer 0: ישויות נקודתיות                (point entities, under "ישויות נוספות")

Pipeline:
    1. Geocode the address with OSM Nominatim (WGS84 lon/lat).
    2. Project that point into the service's native ITM (EPSG:2039) via
       iplan's own Utilities/Geometry service - not passed through as
       bboxSR=4326 on the export call itself. That shortcut was tried first
       and measurably does NOT centre the address: letting /export reproject
       a WGS84 bbox introduces a systematic ~40-70m offset (verified against
       the Geometry service's own WGS84->ITM projection of the same point),
       so the exported point ends up south-west of image centre instead of
       in the middle. Projecting first and building the bbox directly in
       ITM metres avoids that reprojection step entirely.
    3. Build a square bounding box around the projected point (--radius
       metres, default 250) and ask the Xplan MapServer to export it as a
       PNG, requesting only the wanted layers, with bboxSR=2039 (native).
       Two land-use codes on layer 4 are excluded by default (see
       EXCLUDE_LANDUSE_CODES below) - without that, the image is dominated
       by a solid diagonal hatch that isn't a rendering bug but isn't useful
       either: codes 995/996 are catch-all "background" designations whose
       polygons can be enormous (one observed instance spanning ~29km,
       matching National Master Plan 60) and so cover the entire viewport
       at building/address scale, burying the actually-local parcels
       underneath. --include-background switches this off.
    4. Fetch a real basemap (building footprints, streets) from OSM's
       standard raster tiles, so the iplan layers land on recognisable
       context instead of blank space - iplan's own MapServer doesn't
       serve one. The bbox corners are projected ITM->WGS84 via iplan's own
       GeometryServer (the same trusted path used for centring, see step 2),
       then converted to Web Mercator with the standard spherical formula,
       so the fetched tiles line up with the iplan export to within a pixel
       or two at this extent - not reprojected through /export's own
       bboxSR, which is the reprojection already shown to drift. --no-basemap
       skips this and returns to the old plain-background behaviour.
    5. Composite the iplan layers (fetched transparent) over the basemap and
       save one flattened, always-opaque PNG - which also sidesteps the
       previous "black in dark viewers" problem entirely, since there is no
       transparency left in the output to be misinterpreted.

Requires Pillow (pip install pillow) for step 4/5's tile stitching and
compositing - image manipulation genuinely needs it, unlike the rest of the
script.

Usage:
    ./tools/iplan_snapshot.py "רוטשילד 1, תל אביב"
    ./tools/iplan_snapshot.py "הרצל 50, חיפה" -o herzl50.png --radius 400
    ./tools/iplan_snapshot.py "יפו 1, ירושלים" --layers 4,0  # land use + points only
    ./tools/iplan_snapshot.py "דיזנגוף 50, תל אביב" --no-basemap  # iplan layers only
"""

import argparse
import io
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("סקריפט זה דורש Pillow: pip install pillow")

NOMINATIM = "https://nominatim.openstreetmap.org/search"
GEOMETRY = "https://ags.iplan.gov.il/arcgisiplan/rest/services/Utilities/Geometry/GeometryServer"
MAPSERVER = "https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer"
OSM_TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
UA = "govapiportal-iplan-snapshot/1.0 (+https://github.com/agmonr/govapiportal)"
ITM_WKID = 2039
WGS84_WKID = 4326
MERCATOR_R = 6378137.0  # sphere radius used by Web Mercator (EPSG:3857)
TILE_PX = 256
MAX_ZOOM = 19  # OSM's standard raster tiles stop here
TIMEOUT = 25

# The three layers checked by default in iplan's own layer panel (see module
# docstring). Kept as the default rather than the only option - --layers lets
# a caller pick any other id this MapServer exposes.
DEFAULT_LAYERS = [1, 4, 0]

# Layer 4 (יעודי קרקע) codes that are catch-all/regional designations rather
# than a specific local land use - excluded from the fill by default so a
# building-scale export isn't buried under one giant hatch. Identified by
# directly querying the layer around a real address (ששת הימים 9, רעננה):
# 995 "יעוד עפ"י תכנית מאושרת אחרת" (designated per some other approved plan -
# used as a literal fallback, including by תמא/60, whose footprint spans
# ~29km) and 996 "מגבלות בניה ופיתוח" (development restrictions, an overlay
# constraint rather than a primary land use). Both use the same style
# (esriSFSBackwardDiagonal) and similar blue tones, which is why excluding
# only one still left the frame fully hatched by the other.
EXCLUDE_LANDUSE_CODES = (995, 996)


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def geocode(address):
    """One Nominatim request, restricted to Israel. Policy: max 1 req/s,
    identifying User-Agent - both satisfied by a single call per run."""
    params = urllib.parse.urlencode({
        "q": address,
        "format": "jsonv2",
        "limit": 1,
        "countrycodes": "il",
    })
    results = fetch_json(f"{NOMINATIM}?{params}")
    if not results:
        sys.exit(f"לא נמצאה כתובת תואמת ל: {address!r}")
    r = results[0]
    return float(r["lon"]), float(r["lat"]), r["display_name"]


def project_points(points, in_sr, out_sr):
    """Points (list of (x,y)) -> the same points in `out_sr`, via iplan's own
    GeometryServer. Doing this explicitly - rather than handing /export a
    bbox in `in_sr` and letting it reproject - is what actually centres the
    address; see the module docstring for the measured offset. Also used to
    get the export bbox's true WGS84 corners for basemap alignment."""
    geometries = json.dumps({
        "geometryType": "esriGeometryPoint",
        "geometries": [{"x": x, "y": y} for x, y in points],
    })
    params = urllib.parse.urlencode({
        "geometries": geometries,
        "inSR": in_sr,
        "outSR": out_sr,
        "f": "json",
    })
    req = urllib.request.Request(
        f"{GEOMETRY}/project", data=params.encode("utf-8"),
        headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    if "geometries" not in result:
        sys.exit(f"בקשת ה-project נכשלה: {result}")
    return [(p["x"], p["y"]) for p in result["geometries"]]


def project_to_itm(lon, lat):
    """WGS84 lon/lat -> the MapServer's native EPSG:2039 (ITM)."""
    return project_points([(lon, lat)], WGS84_WKID, ITM_WKID)[0]


def bbox_around(x, y, radius_m):
    """A square bbox `radius_m` metres out from an ITM point. Exact - ITM is
    a planar projected CRS, so this needs no spherical approximation."""
    return x - radius_m, y - radius_m, x + radius_m, y + radius_m


def lonlat_to_mercator(lon, lat):
    """WGS84 lon/lat -> Web Mercator (EPSG:3857) metres. Standard spherical
    formula - exact for what OSM's raster tiles themselves are drawn on, so
    no library/datum ambiguity here (unlike ITM<->WGS84 above)."""
    mx = math.radians(lon) * MERCATOR_R
    my = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * MERCATOR_R
    return mx, my


def mercator_to_pixel(mx, my, zoom):
    """Web Mercator metres -> pixel coordinates in the global tile grid at
    `zoom` (origin top-left, y down - matches OSM/Google/Bing tile numbering)."""
    world_px = TILE_PX * 2 ** zoom
    px = (mx + math.pi * MERCATOR_R) / (2 * math.pi * MERCATOR_R) * world_px
    py = (math.pi * MERCATOR_R - my) / (2 * math.pi * MERCATOR_R) * world_px
    return px, py


def fetch_tile(z, x, y):
    req = urllib.request.Request(OSM_TILE.format(z=z, x=x, y=y), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return Image.open(io.BytesIO(resp.read())).convert("RGB")


def fetch_basemap(itm_bbox, size_px):
    """A real basemap (buildings, streets) cropped to `itm_bbox` and resized
    to size_px x size_px, stitched from OSM's standard raster tiles - iplan's
    own MapServer has no basemap of its own, only the thematic layers.

    Alignment: the bbox's 4 corners are projected ITM->WGS84 through iplan's
    own GeometryServer (the same trusted call used to centre the address),
    then converted to Web Mercator with the exact spherical formula OSM tiles
    themselves use. That keeps this aligned with the iplan export to within a
    pixel or two at this extent, without going anywhere near /export's own
    bboxSR reprojection - which is the one already shown to drift by tens of
    metres.
    """
    xmin, ymin, xmax, ymax = itm_bbox
    corners_itm = [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]
    corners_wgs84 = project_points(corners_itm, ITM_WKID, WGS84_WKID)
    corners_merc = [lonlat_to_mercator(lon, lat) for lon, lat in corners_wgs84]

    mxs = [m[0] for m in corners_merc]
    mys = [m[1] for m in corners_merc]
    merc_width = max(mxs) - min(mxs)

    # Zoom that puts tile resolution closest to what the output image needs.
    zoom = round(math.log2((2 * math.pi * MERCATOR_R) / (TILE_PX * merc_width / size_px)))
    zoom = max(0, min(MAX_ZOOM, zoom))

    pxs, pys = zip(*(mercator_to_pixel(mx, my, zoom) for mx, my in corners_merc))
    px_min, px_max = min(pxs), max(pxs)
    py_min, py_max = min(pys), max(pys)

    tx_min, tx_max = int(px_min // TILE_PX), int(px_max // TILE_PX)
    ty_min, ty_max = int(py_min // TILE_PX), int(py_max // TILE_PX)
    n_tiles = (tx_max - tx_min + 1) * (ty_max - ty_min + 1)
    if n_tiles > 64:
        sys.exit(f"רדיוס גדול מדי לבסיס מפה ({n_tiles} אריחים) - הקטן את --radius או השתמש ב---no-basemap")

    canvas = Image.new("RGB", ((tx_max - tx_min + 1) * TILE_PX, (ty_max - ty_min + 1) * TILE_PX))
    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            canvas.paste(fetch_tile(zoom, tx, ty), ((tx - tx_min) * TILE_PX, (ty - ty_min) * TILE_PX))

    crop = canvas.crop((
        round(px_min - tx_min * TILE_PX), round(py_min - ty_min * TILE_PX),
        round(px_max - tx_min * TILE_PX), round(py_max - ty_min * TILE_PX),
    ))
    basemap = crop.resize((size_px, size_px), Image.LANCZOS)

    draw = ImageDraw.Draw(basemap)
    label = "© OpenStreetMap contributors"
    draw.rectangle((0, size_px - 16, 8 * len(label) + 6, size_px), fill=(255, 255, 255, 180))
    draw.text((4, size_px - 14), label, fill=(0, 0, 0))
    return basemap


def layer_names():
    """Layer id -> Hebrew name, fetched live rather than hardcoded so the
    script notices if iplan ever renumbers them."""
    meta = fetch_json(f"{MAPSERVER}?f=json")
    return {layer["id"]: layer["name"] for layer in meta["layers"]}


def export_png(bbox, layers, size, fmt, layer_defs, transparent):
    params = {
        "bbox": ",".join(f"{v:.3f}" for v in bbox),
        "bboxSR": ITM_WKID,
        "size": f"{size},{size}",
        "layers": "show:" + ",".join(str(i) for i in layers),
        "format": fmt,
        "transparent": "true" if transparent else "false",
        "f": "json",
    }
    if layer_defs:
        params["layerDefs"] = json.dumps(layer_defs)
    result = fetch_json(f"{MAPSERVER}/export?{urllib.parse.urlencode(params)}")
    if "href" not in result:
        sys.exit(f"בקשת ה-export נכשלה: {result}")
    return result


def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return Image.open(io.BytesIO(resp.read()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", help="כתובת בישראל, למשל 'רוטשילד 1, תל אביב'")
    ap.add_argument("-o", "--output", help="נתיב לקובץ הפלט (ברירת מחדל: לפי הכתובת)")
    ap.add_argument("--radius", type=float, default=250, help="רדיוס סביב הנקודה, במטרים (ברירת מחדל 250)")
    ap.add_argument("--size", type=int, default=1024, help="גודל התמונה בפיקסלים, ריבועית (ברירת מחדל 1024)")
    ap.add_argument("--format", default="png32", help="פורמט התמונה (ברירת מחדל png32)")
    ap.add_argument("--layers", default=",".join(str(i) for i in DEFAULT_LAYERS),
                     help="מזהי שכבות מופרדים בפסיק "
                          "(ברירת מחדל: 1=קווים כחולים-תכניות מקוונות, 4=יעודי קרקע, 0=ישויות נקודתיות)")
    ap.add_argument("--include-background", action="store_true",
                     help="אל תסנן את קודי הרקע האזוריים (995/996) משכבת יעודי הקרקע")
    ap.add_argument("--no-basemap", action="store_true",
                     help="ללא בסיס מפה מ-OSM (מבנים/רחובות) - שכבות iplan בלבד, על רקע לבן")
    ap.add_argument("--transparent", action="store_true",
                     help="עם --no-basemap בלבד: שקיפות במקום רקע לבן אטום "
                          "(עלול להיראות שבור בצופה כהה)")
    args = ap.parse_args()

    try:
        layers = [int(x) for x in args.layers.split(",") if x.strip() != ""]
    except ValueError:
        sys.exit(f"--layers לא תקין: {args.layers!r}")

    print(f"מאתר כתובת: {args.address}")
    lon, lat, display_name = geocode(args.address)
    print(f"נמצא: {display_name}  ({lat:.6f}, {lon:.6f})")

    x, y = project_to_itm(lon, lat)
    print(f"נקודה ברשת ITM (EPSG:2039): {x:.1f}, {y:.1f} - זו הנקודה שתמוקם במרכז התמונה")

    names = layer_names()
    unknown = [i for i in layers if i not in names]
    if unknown:
        sys.exit(f"שכבות לא קיימות ב-Xplan: {unknown}. הקיימות: {names}")
    print("שכבות: " + ", ".join(f"{i}={names[i]}" for i in layers))

    layer_defs = {}
    if 4 in layers and not args.include_background:
        excluded = ",".join(str(c) for c in EXCLUDE_LANDUSE_CODES)
        layer_defs["4"] = f"mavat_code NOT IN ({excluded})"
        print(f"מסנן קודי רקע אזוריים משכבת יעודי קרקע: {excluded}")

    bbox = bbox_around(x, y, args.radius)
    print(f"בקשת ייצוא, רדיוס {args.radius:.0f} מ׳...")
    # transparent=True whenever we're compositing onto our own basemap -
    # only the final, always-opaque flattened image is written to disk.
    result = export_png(bbox, layers, args.size, args.format, layer_defs,
                         transparent=(args.transparent or not args.no_basemap))
    overlay = fetch_image(result["href"]).convert("RGBA")

    if args.no_basemap:
        final = overlay
    else:
        print("שולף בסיס מפה (מבנים/רחובות) מ-OpenStreetMap...")
        basemap = fetch_basemap(bbox, args.size).convert("RGBA")
        basemap.alpha_composite(overlay)
        final = basemap.convert("RGB")

    out_path = args.output or (
        "".join(c if c.isalnum() else "_" for c in args.address).strip("_")[:60] + ".png"
    )
    final.save(out_path)
    print(f"נשמר: {out_path} ({final.width}x{final.height}, קנה מידה ~1:{result['scale']:.0f})")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        sys.exit(f"שגיאת רשת: {e}")
