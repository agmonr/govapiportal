#!/usr/bin/env python3
"""
Builds the tree-canopy comparison data: city / neighborhood / street canopy
coverage, from the local (gitignored) National Canopy Trees shapefile plus
municipal boundaries (GovMap WFS) and neighborhood/street geometry (OSM).

This is a local, one-time (well, re-run-when-the-source-updates) batch job,
not something that runs in the browser - the 358 MB shapefile has no API, so
unlike every other data source on this site, there is nothing to query live.
The only things that leave this script are the small aggregated outputs
under src/ - the shapefile, the converted GeoPackage, and every OSM/GovMap
raw fetch stay in zip/, which is gitignored.

All three levels use the same method: assign each of the ~2.89M canopy
polygons to a boundary by point-in-polygon on the polygon's own centroid
(not a full geometric intersection) - the same simplification area-cleanup.js
already uses elsewhere on this site for point-in-polygon municipal lookups,
and cheap enough to be tractable at this scale. Streets additionally buffer
each OSM way 7.5m before assignment, matching the source dataset's own
stated methodology (see its data.gov.il description).

Usage:
    python3 tools/canopy_build.py cities
    python3 tools/canopy_build.py neighborhoods
    python3 tools/canopy_build.py streets
    python3 tools/canopy_build.py all
"""
import json
import sys
import time
from pathlib import Path

from osgeo import ogr
ogr.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "zip"
SRC = ROOT / "src"

CANOPY_GPKG = ZIP / "canopy.gpkg"
MUNI_JSON = ZIP / "muni_il.json"
STREETS_JSON = ZIP / "osm_streets_geom.json"
NEIGHBORHOODS_JSON = ZIP / "osm_neighborhoods_raw.json"
NEIGHBORHOOD_POINTS_JSON = ZIP / "osm_neighborhood_points.json"

STREET_BUFFER_M = 7.5  # matches the source dataset's own stated methodology


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def open_canopy():
    ds = ogr.Open(str(CANOPY_GPKG), update=0)
    return ds, ds.GetLayerByName("canopy")


def canopy_area_within(canopy_lyr, geom):
    """Sum canopy polygon area attributable to `geom`, keyed by centroid
    containment (a polygon counts here, not to a neighboring boundary, based
    on where its centroid falls - not a full "does it touch" test).

    But the AREA added for a counted polygon is the true intersection area
    with `geom`, not the polygon's own full area, whenever the polygon isn't
    entirely inside geom already. Those are almost always the same number -
    a tree canopy shape is tiny next to a city, neighborhood, or even a
    7.5m-radius street buffer - except when it isn't: found by testing this
    page's own output, a 3-polygon street buffer of 1,364 sqm reported
    501% canopy coverage, because one of the three canopy shapes was itself
    ~6,800 sqm (something closer to a forest patch than a single tree crown)
    with its centroid landing just inside the narrow buffer while most of
    the shape's area sat outside it. Using full polygon area for a fully-
    contained shape (the overwhelming majority) avoids paying for a real
    Intersection() call on every candidate, only on the ones that need it.
    """
    canopy_lyr.SetSpatialFilter(geom)
    total_area = 0.0
    n = 0
    for feat in canopy_lyr:
        g = feat.GetGeometryRef()
        c = g.Centroid()
        if not geom.Contains(c):
            continue
        total_area += g.GetArea() if geom.Contains(g) else g.Intersection(geom).GetArea()
        n += 1
    canopy_lyr.SetSpatialFilter(None)
    return total_area, n


def load_muni_geoms():
    """City name -> (unioned ogr geometry, code, Sug_Muni) - some cities are
    split into several polygon parts in muni_il, e.g. exclaves."""
    muni = json.loads(MUNI_JSON.read_text())
    by_name = {}
    for f in muni["features"]:
        name = f["properties"]["Muni_Heb"]
        code = f["properties"]["CR_LAMAS"] or f["properties"]["CR_PNIM"]
        sug = f["properties"]["Sug_Muni"]
        g = ogr.CreateGeometryFromJson(json.dumps(f["geometry"]))
        if name in by_name:
            by_name[name] = (by_name[name][0].Union(g), code, sug)
        else:
            by_name[name] = (g, code, sug)
    return by_name


def city_index(munis):
    """An STRtree over city polygons (shapely, ITM) for "which city contains
    this point" lookups - shared by build_neighborhoods() and
    build_streets(), which each do this thousands of times (once per OSM
    point/street) and would otherwise pay for a linear scan over ~200 city
    polygons on every single one."""
    from shapely.strtree import STRtree
    import shapely.wkt as swkt

    names = list(munis.keys())
    shapes = [swkt.loads(munis[n][0].ExportToWkt()) for n in names]
    return names, shapes, STRtree(shapes)


def find_city(point, names, shapes, tree):
    for i in tree.query(point):
        if shapes[i].contains(point):
            return names[i]
    return None


def build_cities():
    log("loading city boundaries...")
    munis = load_muni_geoms()
    # "ללא שיפוט *" = unincorporated regional-council land, not a city.
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    # Regional councils (מועצה אזורית) cover a huge rural/agricultural/desert
    # jurisdiction around their settlements, not a built-up area - their
    # canopy % at this level is near-zero almost by construction and not a
    # meaningful "how green is this place" figure, unlike a city or local
    # council. Dropped from the city-level roster/leaderboard entirely; a
    # neighborhood/street physically inside one is unaffected - see
    # build_neighborhoods()/build_streets(), which still attribute against
    # the full (unfiltered) municipal roster.
    munis = {k: v for k, v in munis.items() if v[2] != "מועצה אזורית"}
    log(f"{len(munis)} cities (regional councils excluded)")

    ds, canopy = open_canopy()
    out = {}
    t0 = time.time()
    for i, (name, (geom, code, _sug)) in enumerate(munis.items()):
        area, n = canopy_area_within(canopy, geom)
        city_area = geom.GetArea()
        out[name] = {
            "code": code,
            "cityAreaM2": round(city_area, 1),
            "canopyAreaM2": round(area, 1),
            "pct": round(100 * area / city_area, 2) if city_area else 0,
            "treeCount": n,
        }
        if (i + 1) % 25 == 0:
            elapsed = time.time() - t0
            log(f"  {i+1}/{len(munis)} cities, {elapsed:.0f}s elapsed, ~{elapsed/(i+1)*len(munis):.0f}s total est.")
    ds = None
    log(f"done in {time.time()-t0:.0f}s")
    return out


def parse_osm_ring(points):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for p in points:
        ring.AddPoint(p["lon"], p["lat"])
    return ring


def osm_way_to_polygon(el):
    ring = parse_osm_ring(el["geometry"])
    poly = ogr.Geometry(ogr.wkbPolygon)
    poly.AddGeometry(ring)
    return poly


def osm_relation_to_polygon(el):
    """Naive outer-ring union, inner (hole) rings subtracted. Good enough for
    neighborhood boundaries, which are simple compared to e.g. administrative
    relations with many disjoint outer parts."""
    outer = ogr.Geometry(ogr.wkbMultiPolygon)
    inner = ogr.Geometry(ogr.wkbMultiPolygon)
    for m in el.get("members", []):
        if not m.get("geometry"):
            continue
        pts = m["geometry"]
        if len(pts) < 3 or pts[0] != pts[-1]:
            continue  # not a closed ring - skip rather than guess how to close it
        ring = parse_osm_ring(pts)
        poly = ogr.Geometry(ogr.wkbPolygon)
        poly.AddGeometry(ring)
        if not poly.IsValid():
            poly = poly.Buffer(0)
        if m.get("role") == "inner":
            inner = inner.Union(poly)
        else:
            outer = outer.Union(poly)
    if outer.IsEmpty():
        return None
    return outer.Difference(inner) if not inner.IsEmpty() else outer


WGS84_TO_ITM_WKT = None  # set lazily


def to_itm(geom):
    """Reprojects a WGS84 (lon/lat) OSM geometry to EPSG:2039 to match the
    canopy data. Uses osr rather than pyproj so it stays inside the one
    already-open GDAL/OGR toolchain."""
    from osgeo import osr
    src = osr.SpatialReference()
    src.ImportFromEPSG(4326)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst = osr.SpatialReference()
    dst.ImportFromEPSG(2039)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(src, dst)
    geom.Transform(tr)
    return geom


def neighborhood_geoms(names, shapes, tree):
    """[(city, name, shapely geom, approx)] for every neighborhood - real
    OSM polygons, plus Voronoi cells (clipped to their city) around named
    points that have no real polygon. Split out from build_neighborhoods()
    so build_streets() can reuse the same geometries (to find which
    neighborhood a street falls in) without re-running canopy_area_within,
    which is the expensive part of build_neighborhoods() and irrelevant
    here - this half (OSM parsing + Voronoi) is comparatively fast.

    Most OSM neighbourhoods are tagged as a bare NAMED POINT, no boundary at
    all - Hod HaSharon, for one, has exactly 1 real polygon and 9 of these
    (verified directly - see the session that built this). A Voronoi cell
    around each point, clipped to its own city, is the closest thing to a
    boundary buildable from a point alone. Every named point in the city
    competes for territory as a Voronoi seed - including ones that already
    have a real polygon, so their neighbors' cells are shaped around real
    territory instead of overlapping into it - but only the POINT-ONLY
    cells are kept in the returned list; a seed that already has a real
    polygon is skipped, its real polygon the only geometry for that name.
    """
    from shapely.geometry import Point
    import shapely.wkt as swkt

    data = json.loads(NEIGHBORHOODS_JSON.read_text())
    result = []  # (city, name, shapely geom, approx)
    covered = {}  # city -> set of names already added from a real polygon
    skipped = 0

    for el in data["elements"]:
        name = el["tags"].get("name")
        if not name:
            continue
        if el["type"] == "way":
            poly = osm_way_to_polygon(el)
        else:
            poly = osm_relation_to_polygon(el)
        if poly is None or poly.IsEmpty():
            skipped += 1
            continue
        poly = to_itm(poly)
        if not poly.IsValid():
            poly = poly.Buffer(0)
        c = swkt.loads(poly.Centroid().ExportToWkt())
        city = find_city(c, names, shapes, tree)
        result.append((city, name, swkt.loads(poly.ExportToWkt()), False))
        covered.setdefault(city, set()).add(name)
    log(f"{len(result)} real OSM polygons, {skipped} skipped (no closed geometry)")

    from shapely import voronoi_polygons
    from shapely.geometry import MultiPoint

    pts_raw = json.loads(NEIGHBORHOOD_POINTS_JSON.read_text())["elements"]
    by_city = {}  # city -> [(shapely Point, name, has_real_polygon)]
    for el in pts_raw:
        name = el["tags"].get("name")
        if not name:
            continue
        pt_ogr = ogr.Geometry(ogr.wkbPoint)
        pt_ogr.AddPoint(el["lon"], el["lat"])
        pt_ogr = to_itm(pt_ogr)
        pt = Point(pt_ogr.GetX(), pt_ogr.GetY())
        city = find_city(pt, names, shapes, tree)
        if city is None:
            continue  # no natural boundary to clip an unmatched point's cell against
        by_city.setdefault(city, []).append((pt, name, name in covered.get(city, set())))

    seen = {(c, n) for c, n, _g, _a in result}
    approx_count = 0
    for city, seeds in by_city.items():
        if len(seeds) < 2:
            continue  # a single point can't form a Voronoi diagram
        city_shape = shapes[names.index(city)]
        cells = voronoi_polygons(MultiPoint([s[0] for s in seeds]), extend_to=city_shape)
        for cell in cells.geoms:
            clipped = cell.intersection(city_shape)
            if clipped.is_empty:
                continue
            owner = next((s for s in seeds if clipped.intersects(s[0])), None)
            if owner is None or owner[2]:  # unmatched, or already a real polygon
                continue
            _pt, name, _has_real = owner
            if (city, name) in seen:
                continue  # a second point shares this exact (city, name) - first one wins
            seen.add((city, name))
            result.append((city, name, clipped, True))
            approx_count += 1
    log(f"{approx_count} more from approximate (Voronoi) points - {len(result)} neighborhoods total")
    return result


def build_neighborhoods():
    log("loading neighborhood geometries from OSM...")
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    names, shapes, tree = city_index(munis)

    geoms = neighborhood_geoms(names, shapes, tree)
    ds, canopy = open_canopy()
    out = {}
    for city, name, geom_shp, approx in geoms:
        geom_ogr = ogr.CreateGeometryFromWkt(geom_shp.wkt)
        area, n = canopy_area_within(canopy, geom_ogr)
        nb_area = geom_ogr.GetArea()
        # name/city are not stored in the value - both are recoverable from
        # the key ("city::name") in JS, and storing them again per-row would
        # just duplicate text that already repeats a lot (see build_streets).
        key = f"{city or '—'}::{name}"
        entry = {
            "areaM2": round(nb_area, 1),
            "canopyAreaM2": round(area, 1),
            "pct": round(100 * area / nb_area, 2) if nb_area else 0,
            "treeCount": n,
        }
        if approx:
            entry["approx"] = True
        out[key] = entry
    ds = None
    log(f"done - {len(out)} neighborhoods")
    return out


def street_geoms(names, shapes, tree):
    """[(city, name, buffered shapely geom, length_m, neighborhood)] for
    every distinct (city, street-name) group - split out from
    build_streets() so heat_build.py can reuse the exact same street
    buffers without duplicating this grouping/buffering logic (mirrors why
    neighborhood_geoms() is already its own function, for the same reason)."""
    log("loading street geometries from OSM...")
    data = json.loads(STREETS_JSON.read_text())

    from shapely.strtree import STRtree
    import shapely.wkt as swkt
    from shapely.ops import unary_union

    # Reuses build_neighborhoods()'s own geometries (real polygons + Voronoi
    # cells) purely to label which neighborhood a street sits in - no canopy
    # computation happens against them here, so this only pays for the OSM
    # parsing + Voronoi construction, not a second, redundant pass of the
    # expensive canopy_area_within calls.
    log("building neighborhood boundaries for street attribution...")
    nb_geoms = neighborhood_geoms(names, shapes, tree)
    nb_shapes = [g for _c, _n, g, _a in nb_geoms]
    nb_tree = STRtree(nb_shapes)

    log(f"{len(data['elements'])} street segments; grouping by (city, name)...")
    groups = {}  # (city, name) -> list of shapely LineStrings (already in ITM)
    for el in data["elements"]:
        name = el["tags"].get("name")
        if not name or not el.get("geometry"):
            continue
        coords_wgs = [(p["lon"], p["lat"]) for p in el["geometry"]]
        line = ogr.Geometry(ogr.wkbLineString)
        for lon, lat in coords_wgs:
            line.AddPoint(lon, lat)
        line = to_itm(line)
        line_shp = swkt.loads(line.ExportToWkt())
        mid = line_shp.interpolate(0.5, normalized=True)
        city = find_city(mid, names, shapes, tree)
        if city is None:
            continue
        groups.setdefault((city, name), []).append(line_shp)

    log(f"{len(groups)} distinct (city, street) groups; buffering...")
    result = []
    for (city, name), lines in groups.items():
        merged = unary_union(lines)
        buf = merged.buffer(STREET_BUFFER_M)
        # A street's total mapped length (merged.length - a MultiLineString
        # if OSM split it into several segments, so this is their combined
        # length, not just one segment's) - lets a caller normalize by "per
        # 100m of street" instead of only a raw count/area, which two
        # streets of very different lengths cannot otherwise be compared on.
        length_m = merged.length

        # Which neighborhood the street sits in, for display only - by the
        # street's centroid, the same one-representative-point approximation
        # city attribution above already uses. A street with disjoint OSM
        # segments can have a centroid that isn't exactly on any of them,
        # same limitation.
        rep_point = merged.centroid
        neighborhood = None
        for j in nb_tree.query(rep_point):
            if nb_shapes[j].contains(rep_point):
                neighborhood = nb_geoms[j][1]
                break
        result.append((city, name, buf, length_m, neighborhood))
    log(f"{len(result)} street buffers built")
    return result


def build_streets():
    munis = load_muni_geoms()
    munis = {k: v for k, v in munis.items() if not k.startswith("ללא שיפוט")}
    names, shapes, tree = city_index(munis)

    groups = street_geoms(names, shapes, tree)
    log(f"joining canopy for {len(groups)} streets...")
    ds, canopy = open_canopy()
    out = {}
    t0 = time.time()
    for i, (city, name, buf, length_m, neighborhood) in enumerate(groups):
        buf_ogr = ogr.CreateGeometryFromWkt(buf.wkt)
        area, n = canopy_area_within(canopy, buf_ogr)
        buf_area = buf_ogr.GetArea()

        # name/city not stored per-row - see the matching note in build_neighborhoods().
        key = f"{city}::{name}"
        out[key] = {
            "bufferAreaM2": round(buf_area, 1),
            "lengthM": round(length_m, 1),
            "canopyAreaM2": round(area, 1),
            "pct": round(100 * area / buf_area, 2) if buf_area else 0,
            "treeCount": n,
            **({"nb": neighborhood} if neighborhood else {}),
        }
        if (i + 1) % 2000 == 0:
            elapsed = time.time() - t0
            log(f"  {i+1}/{len(groups)} streets, {elapsed:.0f}s elapsed, "
                f"~{elapsed/(i+1)*len(groups):.0f}s total est.")
    ds = None
    log(f"done in {time.time()-t0:.0f}s")
    return out


def write_js(varname, data, out_path, header_comment):
    out_path.write_text(
        f"// {header_comment}\n"
        f"// Generated by tools/canopy_build.py - do not edit by hand.\n"
        f"export const {varname} = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    kb = out_path.stat().st_size / 1024
    log(f"wrote {out_path.relative_to(ROOT)} ({kb:.1f} KB)")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    stamp = time.strftime("%Y-%m-%dT%H:%M%z") or time.strftime("%Y-%m-%dT%H:%M")

    if which in ("cities", "all"):
        cities = build_cities()
        write_js("CITY_CANOPY", cities, SRC / "tree-canopy-cities.js",
                  f"City-level tree canopy coverage, computed {stamp}")

    if which in ("neighborhoods", "all"):
        nbs = build_neighborhoods()
        write_js("NEIGHBORHOOD_CANOPY", nbs, SRC / "tree-canopy-neighborhoods.js",
                  f"Neighborhood-level tree canopy coverage (OSM-mapped areas only), computed {stamp}")

    if which in ("streets", "all"):
        streets = build_streets()
        write_js("STREET_CANOPY", streets, SRC / "tree-canopy-streets.js",
                  f"Street-level tree canopy coverage (7.5m buffer per street), computed {stamp}")


if __name__ == "__main__":
    main()
