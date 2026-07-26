#!/usr/bin/env python3
"""
Downloads a map image for an Israeli address from iplan's Xplan service
(the "קווים כחולים" MapServer, already catalogued in apis.json under the
"iplan" portal), showing the two layers requested:

    - layer 4: יעודי קרקע            (land use designations)
    - layer 0: ישויות נקודתיות        (point entities, under "ישויות נוספות")

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
    4. Download the rendered PNG.

Stdlib only, no dependencies - same convention as tools/probe.py.

Usage:
    ./tools/iplan_snapshot.py "רוטשילד 1, תל אביב"
    ./tools/iplan_snapshot.py "הרצל 50, חיפה" -o herzl50.png --radius 400
    ./tools/iplan_snapshot.py "יפו 1, ירושלים" --layers 0,1,4  # add plan boundary
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

NOMINATIM = "https://nominatim.openstreetmap.org/search"
GEOMETRY = "https://ags.iplan.gov.il/arcgisiplan/rest/services/Utilities/Geometry/GeometryServer"
MAPSERVER = "https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer"
UA = "govapiportal-iplan-snapshot/1.0 (+https://github.com/agmonr/govapiportal)"
ITM_WKID = 2039
TIMEOUT = 25

# The two layers named in the request. Kept as the default rather than the
# only option - --layers lets a caller add layer 1 (plan boundary lines) or
# any other id this MapServer exposes.
DEFAULT_LAYERS = [4, 0]


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


def project_to_itm(lon, lat):
    """WGS84 lon/lat -> the MapServer's native EPSG:2039 (ITM), via iplan's
    own GeometryServer. Doing this explicitly - rather than handing /export
    a WGS84 bbox with bboxSR=4326 and letting it reproject - is what actually
    centres the address; see the module docstring for the measured offset."""
    geometries = json.dumps({
        "geometryType": "esriGeometryPoint",
        "geometries": [{"x": lon, "y": lat}],
    })
    params = urllib.parse.urlencode({
        "geometries": geometries,
        "inSR": 4326,
        "outSR": ITM_WKID,
        "f": "json",
    })
    req = urllib.request.Request(
        f"{GEOMETRY}/project", data=params.encode("utf-8"),
        headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    if "geometries" not in result:
        sys.exit(f"בקשת ה-project נכשלה: {result}")
    p = result["geometries"][0]
    return p["x"], p["y"]


def bbox_around(x, y, radius_m):
    """A square bbox `radius_m` metres out from an ITM point. Exact - ITM is
    a planar projected CRS, so this needs no spherical approximation."""
    return x - radius_m, y - radius_m, x + radius_m, y + radius_m


def layer_names():
    """Layer id -> Hebrew name, fetched live rather than hardcoded so the
    script notices if iplan ever renumbers them."""
    meta = fetch_json(f"{MAPSERVER}?f=json")
    return {layer["id"]: layer["name"] for layer in meta["layers"]}


def export_png(bbox, layers, size, fmt):
    params = urllib.parse.urlencode({
        "bbox": ",".join(f"{v:.3f}" for v in bbox),
        "bboxSR": ITM_WKID,
        "size": f"{size},{size}",
        "layers": "show:" + ",".join(str(i) for i in layers),
        "format": fmt,
        "transparent": "true",
        "f": "json",
    })
    result = fetch_json(f"{MAPSERVER}/export?{params}")
    if "href" not in result:
        sys.exit(f"בקשת ה-export נכשלה: {result}")
    return result


def download(url, out_path):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = resp.read()
    with open(out_path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", help="כתובת בישראל, למשל 'רוטשילד 1, תל אביב'")
    ap.add_argument("-o", "--output", help="נתיב לקובץ הפלט (ברירת מחדל: לפי הכתובת)")
    ap.add_argument("--radius", type=float, default=250, help="רדיוס סביב הנקודה, במטרים (ברירת מחדל 250)")
    ap.add_argument("--size", type=int, default=1024, help="גודל התמונה בפיקסלים, ריבועית (ברירת מחדל 1024)")
    ap.add_argument("--format", default="png32", help="פורמט התמונה (ברירת מחדל png32)")
    ap.add_argument("--layers", default=",".join(str(i) for i in DEFAULT_LAYERS),
                     help="מזהי שכבות מופרדים בפסיק (ברירת מחדל: 4=יעודי קרקע, 0=ישויות נקודתיות)")
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

    bbox = bbox_around(x, y, args.radius)
    print(f"בקשת ייצוא, רדיוס {args.radius:.0f} מ׳...")
    result = export_png(bbox, layers, args.size, args.format)

    out_path = args.output or (
        "".join(c if c.isalnum() else "_" for c in args.address).strip("_")[:60] + ".png"
    )
    size_bytes = download(result["href"], out_path)
    print(f"נשמר: {out_path} ({size_bytes:,} בייטים, קנה מידה ~1:{result['scale']:.0f})")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        sys.exit(f"שגיאת רשת: {e}")
