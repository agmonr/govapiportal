#!/usr/bin/env python3
"""
Builds dist/map.html - the whole API map as one self-contained file.

Why this exists: a page opened from disk cannot load its own files. The browser
refuses ES module scripts and fetch() from origin 'null', so index.html renders
blank when double-clicked. Inlining everything sidesteps both.

What survives the trip: the live explorer. Access-Control-Allow-Origin: * accepts
origin 'null', so the browser-callable APIs answer a file:// page exactly as they
answer the hosted one (probed - data.gov.il, CBS and Open Bus all return 200 from
file://; Knesset still fails on CORS, as it should). The offline copy is the
whole thing, not a degraded preview.

The site itself is untouched and still has no build step. Only this extra
artifact is generated.

Two pages are built, each self-contained:
    index.html   -> dist/map.html       the map
    datagov.html -> dist/datagov.html   the data.gov.il explorer

Usage:
    ./tools/bundle.py           write both
    ./tools/bundle.py --check   exit non-zero if either is stale
"""

import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# One entry per page. Dependency order matters: flattening drops the imports
# that would otherwise order them. Every module reachable from the entry must be
# listed - a missing one still produces a bundle, but one that throws on load
# because the symbol it imported was never defined. verify_symbols() turns that
# silent break into a build failure, and verify_no_collisions() catches the
# opposite case of two files defining the same top-level name.
#
# `data` marks the page that needs apis.json inlined. The explorer fetches
# everything live from CKAN, so it needs none.
TARGETS = [
    {
        "html": "index.html",
        "out": "dist/map.html",
        "entry": "src/map.js",
        "sources": ["src/ui.js", "src/theme.js", "src/explorer.js", "src/portal.js", "src/apps.js", "src/map.js"],
        "data": True,
    },
    {
        "html": "apps.html",
        "out": "dist/apps.html",
        "entry": "src/apps-page.js",
        # Same apps.js grouping as index.html's "אפליקציות" section, its own
        # page - needs apis.json inlined the same way index.html does, to
        # read data.apps.
        "sources": ["src/ui.js", "src/theme.js", "src/apps.js", "src/apps-page.js"],
        "data": True,
    },
    {
        "html": "datagov.html",
        "out": "dist/datagov.html",
        "entry": "src/datagov.js",
        "sources": ["src/ui.js", "src/theme.js", "src/ckan.js", "src/datagov.js"],
        "data": False,
    },
    {
        "html": "moag.html",
        "out": "dist/moag.html",
        "entry": "src/moag.js",
        # Same shape as the datagov target above: the explorer fetches its
        # catalogue and records live, so it needs apis.json inlined for
        # neither.
        "sources": ["src/ui.js", "src/theme.js", "src/moag-explorer.js", "src/moag.js"],
        "data": False,
    },
    {
        "html": "accidents.html",
        "out": "dist/accidents.html",
        "entry": "src/accidents.js",
        # Reuses portal.js's openPortal() as-is, so it needs the same base as
        # map.js minus explorer.js - accidents.html has no per-API request
        # panel to attach. Needs apis.json inlined: it looks up the
        # "accidents" app entry the same way map.js looks up portals, and
        # apps.js's renderAppContext() reads the same data.apps for the
        # under-header category strip every app page now carries.
        "sources": ["src/ui.js", "src/theme.js", "src/portal.js", "src/city-stats.js", "src/charts.js", "src/apps.js", "src/accidents.js"],
        "data": True,
    },
    {
        "html": "committees.html",
        "out": "dist/committees.html",
        "entry": "src/committees.js",
        # Talks to handasi.complot.co.il directly, live - no shared portal.js
        # machinery (its own filter/KPI/table logic; the chart renderer
        # itself is shared - see charts.js). apis.json IS now needed, purely
        # for apps.js's under-header "other apps in this category" strip.
        "sources": ["src/ui.js", "src/theme.js", "src/committee-sites.js", "src/charts.js", "src/apps.js", "src/pdf-text.js", "src/pdf.js", "src/committees.js"],
        "data": True,
    },
    {
        "html": "local-finance.html",
        "out": "dist/local-finance.html",
        "entry": "src/local-finance.js",
        # Talks to data.gov.il's DataStore directly, live - no shared
        # portal.js machinery (its own KPI/statement logic, over a per-year
        # resource-id config in finance-data.js). Charts and the DataStore
        # query wrapper are shared - see charts.js/datastore.js. apis.json is
        # only for apps.js's under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/finance-data.js", "src/charts.js", "src/datastore.js", "src/population.js", "src/stable-authorities.js", "src/apps.js", "src/local-finance.js"],
        "data": True,
    },
    {
        "html": "companies.html",
        "out": "dist/companies.html",
        "entry": "src/companies.js",
        # Talks to data.gov.il's DataStore directly, live - no shared
        # portal.js machinery (its own KPI/search/pager logic, purpose-built
        # for one fixed resource id). Chart renderer and DataStore query
        # wrapper are shared - see charts.js/datastore.js. apis.json is only
        # for apps.js's under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js", "src/datastore.js", "src/apps.js", "src/companies.js"],
        "data": True,
    },
    {
        "html": "tree-canopy.html",
        "out": "dist/tree-canopy.html",
        "entry": "src/tree-canopy.js",
        # No live API at all for the canopy data itself - see
        # tools/canopy_build.py. Ships three locally-precomputed tables
        # (city/neighborhood/street canopy %), same "dated snapshot" shape as
        # city-stats.js for accidents.html, just three of them. No portal.js
        # machinery. apis.json IS now inlined too, purely for apps.js's
        # under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js",
                    "src/tree-canopy-cities.js", "src/tree-canopy-neighborhoods.js", "src/tree-canopy-streets.js",
                    "src/apps.js", "src/tree-canopy.js"],
        "data": True,
    },
    {
        "html": "heat-islands.html",
        "out": "dist/heat-islands.html",
        "entry": "src/heat-islands.js",
        # Same "no live API, ship precomputed tables" shape as tree-canopy.html
        # just above - see tools/heat_build.py. apis.json is only for apps.js's
        # under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js",
                    "src/heat-cities.js", "src/heat-neighborhoods.js", "src/heat-streets.js",
                    "src/apps.js", "src/heat-islands.js"],
        "data": True,
    },
    {
        "html": "canopy-map.html",
        "out": "dist/canopy-map.html",
        "entry": "src/canopy-map.js",
        # No new attribute data at all - every metric's value already ships
        # via tree-canopy/canopy-split/heat-islands' own city/neighborhood/
        # street files, reused here as-is. The only new sources are the
        # boundary shapes (tools/map_geo_build.py), the shared shape/zoom-
        # pan helpers (map-shapes.js), charts.js (the detail bars reuse
        # renderHBarChart as-is) and geo-utils.js (only for the optional
        # OSM-basemap toggle's tile fetch).
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js", "src/geo-utils.js", "src/map-shapes.js",
                    "src/map-boundaries-cities.js", "src/map-boundaries-neighborhoods.js",
                    "src/map-boundaries-neighborhoods-wgs84.js",
                    "src/tree-canopy-cities.js", "src/tree-canopy-neighborhoods.js", "src/tree-canopy-streets.js",
                    "src/canopy-split-cities.js", "src/canopy-split-neighborhoods.js",
                    "src/heat-cities.js", "src/heat-neighborhoods.js", "src/heat-streets.js", "src/heat-blobs.js",
                    "src/canopy-blobs.js",
                    "src/apps.js", "src/canopy-map.js"],
        "data": True,
    },
    {
        "html": "canopy-split.html",
        "out": "dist/canopy-split.html",
        "entry": "src/canopy-split.js",
        # Pure aggregation of tree-canopy.html's own three tables - see
        # tools/canopy_split_build.py. apis.json is only for apps.js's
        # under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js",
                    "src/canopy-split-cities.js", "src/canopy-split-neighborhoods.js",
                    "src/apps.js", "src/canopy-split.js"],
        "data": True,
    },
    {
        "html": "welfare.html",
        "out": "dist/welfare.html",
        "entry": "src/welfare.js",
        # Talks to data.gov.il's DataStore directly, live - no shared
        # portal.js machinery. Both source resources are small enough to
        # fetch whole once, so unlike local-finance.js there is no per-year
        # resource config to bring in. Chart renderer and DataStore query
        # wrapper are shared - see charts.js/datastore.js. apis.json is only
        # for apps.js's under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/welfare-data.js", "src/charts.js", "src/datastore.js", "src/population.js", "src/apps.js", "src/welfare.js"],
        "data": True,
    },
    {
        "html": "blue-lines.html",
        "out": "dist/blue-lines.html",
        "entry": "src/blue-lines.js",
        # Talks to iplan (Xplan MapServer, tma_70 MapServer, GeometryServer)
        # and OSM tiles directly, live - no shared portal.js machinery.
        # pdf.js is its own hand-rolled PDF writer, no third-party library.
        # apis.json is only for apps.js's under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/geo-utils.js", "src/pdf.js", "src/apps.js", "src/blue-lines.js"],
        "data": True,
    },
    {
        "html": "area-cleanup.html",
        "out": "dist/area-cleanup.html",
        "entry": "src/area-cleanup.js",
        # Talks to iplan's GeometryServer (coordinate reprojection, shared
        # via geo-utils.js with blue-lines.js) and GovMap's public WFS
        # directly, live - no shared portal.js machinery. pdf.js
        # (hand-rolled PDF writer, shared with blue-lines.js) powers the
        # "הורד הכל כ-PDF" download. apis.json is only for apps.js's
        # under-header category strip. tree-canopy-streets.js is tree-
        # canopy.html's own generated street/city dataset, reused here purely
        # for the address field's autocomplete roster (its canopy numbers go
        # unused) - deliberate size tradeoff, see area-cleanup.js's own
        # comment on ADDRESS_ROSTER.
        "sources": [
            "src/ui.js", "src/theme.js", "src/geo-utils.js", "src/pdf.js", "src/apps.js",
            "src/tree-canopy-streets.js", "src/area-cleanup.js",
        ],
        "data": True,
    },
    {
        "html": "trip-report.html",
        "out": "dist/trip-report.html",
        "entry": "src/trip-report.js",
        # GPS + accelerometer + OSM Overpass, all live - no shared portal.js
        # machinery. trip-map.js extends geo-utils.js's tile-stitching (WGS84
        # variant, no iplan GeometryServer round-trip - GPS is already
        # WGS84). pdf.js is the same hand-rolled writer blue-lines.js/
        # area-cleanup.js use. trip-history.js is IndexedDB, not reachable
        # from file:// at all in some browsers, but degrades to "no history"
        # rather than breaking the rest of the page. apis.json is only for
        # apps.js's under-header category strip.
        "sources": [
            "src/ui.js", "src/theme.js", "src/geo-utils.js", "src/pdf.js",
            "src/trip-score.js", "src/trip-speed-limits.js", "src/trip-history.js",
            "src/trip-map.js", "src/apps.js", "src/trip-report.js",
        ],
        "data": True,
    },
    {
        "html": "plan-timeline.html",
        "out": "dist/plan-timeline.html",
        "entry": "src/plan-timeline.js",
        # Talks to iplan's Xplan MapServer directly, live (paginated
        # resultOffset query, see plan-data.js) - no shared portal.js
        # machinery. apis.json is only for apps.js's under-header category
        # strip.
        "sources": ["src/ui.js", "src/theme.js", "src/idb-cache.js", "src/plan-data.js", "src/plan-render.js", "src/apps.js", "src/plan-timeline.js"],
        "data": True,
    },
    {
        "html": "plan-compare.html",
        "out": "dist/plan-compare.html",
        "entry": "src/plan-compare.js",
        # Same plan-data.js fetch as plan-timeline.html, this time grouped
        # into tree-canopy.js's compare-up-to-4-entities idiom. charts.js for
        # the leaderboard bar + swatch coloring. apis.json is only for
        # apps.js's under-header category strip.
        "sources": ["src/ui.js", "src/theme.js", "src/charts.js", "src/idb-cache.js", "src/plan-data.js", "src/plan-render.js", "src/apps.js", "src/plan-compare.js"],
        "data": True,
    },
]

IMPORT_RE = re.compile(r"^\s*import\s.*?;\s*$", re.M)
EXPORT_RE = re.compile(r"^export\s+", re.M)
# Anything left after stripping means an assumption above has broken.
LEFTOVER_RE = re.compile(r"^\s*(?:import\s|export\s)", re.M)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def flatten(rel: str) -> str:
    """Strip module syntax so several files can share one inline module scope."""
    src = IMPORT_RE.sub("", read(rel))
    src = EXPORT_RE.sub("", src)
    if LEFTOVER_RE.search(src):
        bad = LEFTOVER_RE.search(src).group(0).strip()
        sys.exit(f"error: {rel} still has module syntax after stripping: {bad!r}\n"
                 f"       bundle.py flattens files into one scope and cannot keep it.")
    return src


def verify_symbols(sources: list[str]) -> None:
    """Every symbol imported across a target's sources must be defined by one.

    Flattening deletes the import statements, so a module left out of SOURCES
    does not fail the build - it produces a page that throws ReferenceError on
    load. That happened once (portal.js), and the bundle looked fine. Catch it
    here instead of in a browser.
    """
    imported: set[str] = set()
    defined: set[str] = set()

    for rel in sources:
        src = read(rel)
        for names, _mod in re.findall(r"import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", src):
            for name in names.split(","):
                name = name.strip().split(" as ")[-1].strip()
                if name:
                    imported.add(name)
        for kind in ("function", "const", "let", "var", "class"):
            defined.update(re.findall(rf"^export\s+(?:async\s+)?{kind}\s+([A-Za-z_$][\w$]*)", src, re.M))
        defined.update(re.findall(r"^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", src, re.M))

    missing = imported - defined
    if missing:
        sys.exit(f"error: {', '.join(sorted(missing))} imported but not defined by any file in "
                 f"{sources}.\n       Add the module that exports it to that target in bundle.py.")


def verify_no_collisions(sources: list[str]) -> None:
    """No two sources may define the same top-level name.

    Flattening puts every file in one scope, so two modules that each declare
    `state` are a redeclaration that kills the whole inline script, and two that
    each declare `function renderList` silently resolve to whichever came last.
    Both are invisible in the unbundled site, where modules have their own
    scopes - the served page works and only the offline copy breaks.

    That is exactly how ckan.js shipped broken once: `state`, `renderList` and
    `pager` each collided with an existing module, #ckan rendered empty in
    dist/map.html, and the build reported success.
    """
    owners: dict[str, list[str]] = {}
    for rel in sources:
        src = read(rel)
        names = set(re.findall(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", src, re.M))
        names |= set(re.findall(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)", src, re.M))
        for name in names:
            owners.setdefault(name, []).append(rel)

    clashes = {n: fs for n, fs in owners.items() if len(fs) > 1}
    if clashes:
        lines = "\n".join(f"       {n}: {', '.join(fs)}" for n, fs in sorted(clashes.items()))
        sys.exit("error: top-level names defined in more than one source file.\n"
                 "       bundle.py flattens them into one scope, so these collide:\n"
                 f"{lines}\n"
                 "       Rename them, or move the shared one into src/ui.js and import it.")


# canopy-map.html's own src/heat-blobs.js and src/canopy-blobs.js reference
# their PNGs (assets/blobs/{heat,canopy}/<city>.png) by relative URL - see
# tools/heat_blobs.py's/canopy_blobs.py's own write_js() - so the live,
# hosted page fetches each city's blob lazily instead of downloading all
# 186 cities' worth of image data on every load. dist/canopy-map.html has
# to stay a single, offline-capable file though (that's the whole point of
# dist/ - see this file's own module docstring), so those same URLs get
# inlined back into base64 data: URIs here, at bundle time only.
BLOB_SRC_RE = re.compile(r'"\./assets/blobs/(heat|canopy)/([^"]+\.png)"')


def inline_blob_pngs(js: str) -> str:
    def repl(m):
        kind, fname = m.group(1), m.group(2)
        path = ROOT / "assets" / "blobs" / kind / fname
        if not path.exists():
            sys.exit(f"error: blob PNG referenced by src/{kind}-blobs.js is missing on disk: "
                     f"{path.relative_to(ROOT)}")
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        return f'"data:image/png;base64,{b64}"'
    return BLOB_SRC_RE.sub(repl, js)


def build(t: dict) -> str:
    """One self-contained page for one target."""
    verify_symbols(t["sources"])
    verify_no_collisions(t["sources"])
    html = read(t["html"])

    # Inline the stylesheet.
    css = "<style>\n" + read("src/style.css").strip() + "\n</style>"
    html, n = re.subn(r'<link rel="stylesheet" href="\./src/style\.css">', lambda _m: css, html)
    if n != 1:
        sys.exit(f"error: stylesheet <link> not found in {t['html']} - bundler is out of date")

    # The file:// notice and its guard are about *this* limitation. In the
    # bundle the limitation does not exist, so showing either would be a lie.
    html, n = re.subn(r"\n\s*<!--\n\s*(?:Opened by double-clicking|Same guard as index\.html).*?</script>\n",
                      "\n", html, flags=re.S)
    if n != 1:
        sys.exit(f"error: file:// guard block not found in {t['html']} - bundler is out of date")
    html, n = re.subn(r'\s*<div id="fileproto".*?</div>\n\n', "\n", html, flags=re.S)
    if n != 1:
        sys.exit(f"error: #fileproto notice not found in {t['html']} - bundler is out of date")

    # The map links to the explorer as ./datagov.html. Both bundles land in
    # dist/, so that relative link keeps working between the offline copies -
    # but only because the generated names match. Assert rather than assume.
    if "datagov.html" in html:
        sibling = [x["out"] for x in TARGETS if x["html"] == "datagov.html"]
        if not sibling or Path(sibling[0]).name != "datagov.html":
            sys.exit("error: a page links to ./datagov.html but no target emits that filename "
                     "into dist/ - the offline copies would link to nothing.")

    # Same check, for the moag explorer's self-referencing localhost/dist links.
    if "moag.html" in html:
        sibling = [x["out"] for x in TARGETS if x["html"] == "moag.html"]
        if not sibling or Path(sibling[0]).name != "moag.html":
            sys.exit("error: a page links to ./moag.html but no target emits that filename "
                     "into dist/ - the offline copies would link to nothing.")

    # Same check, for index.html's link to apps.html.
    if "apps.html" in html:
        sibling = [x["out"] for x in TARGETS if x["html"] == "apps.html"]
        if not sibling or Path(sibling[0]).name != "apps.html":
            sys.exit("error: a page links to ./apps.html but no target emits that filename "
                     "into dist/ - the offline copies would link to nothing.")

    data = None
    payload = ""
    if t["data"]:
        data = json.loads(read("apis.json"))  # parse to validate, not just to embed
        # </script> inside the data would close the tag early. JSON has no
        # business containing one, but the cost of being wrong is a silently
        # broken file.
        blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
        payload = f"globalThis.__API_DATA__ = {blob};\n\n"

    # Replace the module <script> with data + flattened sources. Inline modules
    # are exempt from the origin-'null' block (verified in headless Chromium),
    # so type="module" is kept and the sources need no further rewriting.
    bundled = "\n".join(flatten(s) for s in t["sources"])
    if t["html"] == "canopy-map.html":
        bundled = inline_blob_pngs(bundled)
    script = ('<script type="module">\n'
              "// Generated by tools/bundle.py - edit src/ and apis.json, then regenerate.\n"
              f"{payload}{bundled}\n"
              "</script>")
    entry = re.escape(f'<script type="module" src="./{t["entry"]}"></script>')
    html, n = re.subn(entry, lambda _m: script, html)
    if n != 1:
        sys.exit(f"error: module <script src=./{t['entry']}> not found in {t['html']} - "
                 "bundler is out of date")

    if data:
        note = ("<!--\n  Self-contained build of the Israeli government API map.\n"
                "  Generated by tools/bundle.py from apis.json + src/ - do not edit by hand.\n"
                f"  Data probed: {data['probed']} | {len(data['apis'])} APIs across "
                f"{len(data['portals'])} portals.\n-->\n")
    else:
        note = ("<!--\n  Self-contained build of the data.gov.il explorer.\n"
                "  Generated by tools/bundle.py from src/ - do not edit by hand.\n"
                "  Holds no snapshot: every record is fetched live from CKAN.\n-->\n")
    return note + html


def main() -> int:
    check = "--check" in sys.argv[1:]
    stale = 0

    for t in TARGETS:
        html = build(t)
        out = ROOT / t["out"]
        rel = out.relative_to(ROOT)

        if check:
            if not out.exists():
                print(f"STALE: {rel} does not exist. Run ./tools/bundle.py")
                stale += 1
            elif out.read_text(encoding="utf-8") != html:
                print(f"STALE: {rel} does not match src/ - run ./tools/bundle.py")
                stale += 1
            else:
                print(f"ok: {rel} is in sync")
            continue

        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
        print(f"wrote {rel} ({len(html.encode('utf-8')) / 1024:.1f} KB)")

    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
