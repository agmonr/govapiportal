#!/usr/bin/env python3
"""
Refreshes the two raw inputs tools/real_estate_build.py consumes:
zip/real_estate_deals_raw.jsonl (individual deals) and zip/cpi_table.json
(CPI index per month).

GovMap's real-estate/"nadlan" API (see README's "What does a m^2 actually
cost" section for the endpoint shape) only ever exposes a recent ROLLING
window per settlement - probed live while building this script: Tel Aviv's
entire available history via this endpoint was ~4 months deep, not "5 years"
as the original one-time fetch's own docstrings claimed. That 5-year archive
can only have been built by fetching repeatedly over time and accumulating -
so that's what this script does: pull whatever's currently visible for every
settlement, and merge it into the existing file by dealId rather than
replacing it. Multi-year (eventually 10-year) coverage is a property of
running this every month for years, not of any single run.

Usage:
    python3 tools/real_estate_fetch.py
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canopy_build import load_muni_geoms

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "zip"
DEALS_FILE = ZIP / "real_estate_deals_raw.jsonl"
CPI_FILE = ZIP / "cpi_table.json"

DEALS_BASE = "https://www.govmap.gov.il/api/real-estate"
CPI_URL = "https://api.cbs.gov.il/index/data/price?id=120010&format=json&download=false"

PAGE_SIZE = 1000
# Growing search radius (meters, in the deals-by-point call) to resolve a
# polygon_id near each city's representative point - a plain centroid/
# PointOnSurface point sometimes lands on land with no indexed parcel nearby
# (a park, a military base, open land inside a regional council's own city
# entry), so start tight and widen rather than guessing one radius for
# every settlement from tiny to sprawling.
TOLERANCES_M = [300, 1000, 3000, 8000, 20000]
REQUEST_PAUSE_S = 0.3  # polite pacing for an unauthenticated, undocumented endpoint
MAX_FUTURE_SLACK_DAYS = 3  # a dealDate further out than this is bad source data (seen: dates in 2028), not a real future closing


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def http_json(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def resolve_polygon_id(x, y):
    for tol in TOLERANCES_M:
        try:
            data = http_json(f"{DEALS_BASE}/deals/{x},{y}/{tol}")
        except (urllib.error.URLError, TimeoutError):
            data = None
        time.sleep(REQUEST_PAUSE_S)
        if data:
            return data[0]["polygon_id"]
    return None


def fetch_settlement_deals(polygon_id):
    offset = 0
    out = []
    while True:
        data = http_json(f"{DEALS_BASE}/settlement-deals/{polygon_id}?limit={PAGE_SIZE}&offset={offset}")
        rows = data.get("data", [])
        out.extend(rows)
        total = int(data.get("totalCount") or len(rows))  # seen as both int and numeric string from this endpoint
        offset += len(rows)
        time.sleep(REQUEST_PAUSE_S)
        if not rows or offset >= total:
            break
    return out


def representative_points():
    """(settlement name, x, y) in EPSG:3857 - one point per polygon in the
    same muni_il boundaries canopy_build.py/real_estate_build.py already use,
    so this covers exactly the settlements the rest of the pipeline can ever
    assign a deal to. A point guaranteed inside the polygon (PointOnSurface,
    not a plain centroid which can fall outside an L-shaped or multi-part
    city) - reprojected from the boundaries' native ITM to the Web Mercator
    the deals-by-point endpoint expects."""
    from pyproj import Transformer

    transformer = Transformer.from_crs("EPSG:2039", "EPSG:3857", always_xy=True)
    for name, (g, _code, _sug) in load_muni_geoms().items():
        p = g.PointOnSurface()
        x, y = transformer.transform(p.GetX(), p.GetY())
        yield name, x, y


def is_plausible_date(iso_date, now):
    if not iso_date:
        return False
    try:
        dt = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt <= now + timedelta(days=MAX_FUTURE_SLACK_DAYS)


def load_existing_deals():
    by_id = {}
    if DEALS_FILE.exists():
        with open(DEALS_FILE) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                by_id[d["dealId"]] = d
    return by_id


def refresh_deals():
    by_id = load_existing_deals()
    log(f"{len(by_id)} deals already on file")

    now = datetime.now(timezone.utc)
    n_new = 0
    n_dropped_future = 0
    n_settlements_failed = 0
    points = list(representative_points())
    for i, (name, x, y) in enumerate(points):
        polygon_id = resolve_polygon_id(x, y)
        if not polygon_id:
            n_settlements_failed += 1
            log(f"  [{i + 1}/{len(points)}] {name}: no polygon_id resolved, skipped")
            continue
        try:
            rows = fetch_settlement_deals(polygon_id)
        except (urllib.error.URLError, TimeoutError) as e:
            n_settlements_failed += 1
            log(f"  [{i + 1}/{len(points)}] {name}: fetch failed ({e}), skipped")
            continue

        added = 0
        for d in rows:
            deal_id = d.get("dealId")
            if deal_id is None:
                continue
            if not is_plausible_date(d.get("dealDate"), now):
                n_dropped_future += 1
                continue
            if deal_id not in by_id:
                added += 1
            by_id[deal_id] = d
        n_new += added
        if added or (i + 1) % 25 == 0:
            log(f"  [{i + 1}/{len(points)}] {name}: {len(rows)} seen, {added} new")

    log(f"deals: {n_new} new, {n_dropped_future} dropped (implausible future date), "
        f"{n_settlements_failed} settlements failed to resolve, {len(by_id)} total on file")

    ZIP.mkdir(parents=True, exist_ok=True)
    tmp = DEALS_FILE.with_suffix(".jsonl.tmp")
    with open(tmp, "w") as f:
        for d in by_id.values():
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    tmp.replace(DEALS_FILE)
    log(f"wrote {DEALS_FILE.relative_to(ROOT)} ({DEALS_FILE.stat().st_size / 1024 / 1024:.1f} MB)")
    return n_new


def refresh_cpi():
    """Merges every (year, month) -> currBase.value pair CBS currently
    publishes for series 120010 (מדד המחירים לצרכן - כללי) into
    zip/cpi_table.json - additive, same as the deals file, since CBS
    sometimes revises recent months and older months never change."""
    cpi = {}
    if CPI_FILE.exists():
        cpi = json.loads(CPI_FILE.read_text())
    n_before = len(cpi)

    data = http_json(CPI_URL)
    for entry in data["month"][0]["date"]:
        base = entry.get("currBase") or {}
        value = base.get("value")
        if value is None:
            continue
        key = f"{entry['year']:04d}-{entry['month']:02d}"
        cpi[key] = value

    CPI_FILE.write_text(json.dumps(cpi, ensure_ascii=False, indent=None, sort_keys=True))
    log(f"CPI: {len(cpi) - n_before} new/updated months, {len(cpi)} total, "
        f"latest={max(cpi)}")


STATUS_FILE = ZIP / "real_estate_fetch_status.json"


def main():
    refresh_cpi()
    n_new = refresh_deals()
    # Read by tools/real_estate_refresh.sh - lets it write a meaningful
    # commit message (and skip committing entirely on a month with nothing
    # new) without scraping this script's log output.
    STATUS_FILE.write_text(json.dumps({
        "ranAt": datetime.now(timezone.utc).isoformat(),
        "newDeals": n_new,
    }))


if __name__ == "__main__":
    main()
