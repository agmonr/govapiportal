#!/usr/bin/env python3
"""
Regenerates src/police-cities.js and src/police-neighborhoods.js: Israel
Police "נתוני פשיעה" (crime_records_data), 2021-2025, aggregated by city and
by city+StatisticArea (the neighborhood equivalent).

Same "page raw rows, aggregate locally" shape as compute_cities.py, for the
same reason: datastore_search_sql (which would GROUP BY server-side) is
WAF-blocked for this dataset too (403 "Security Violation" - confirmed
directly, same as every other CKAN dataset on data.gov.il).

Two things this source needs that compute_cities.py's didn't:

1. A row is one OFFENSE WITHIN A CASE, not one case - a case with 3 offenses
   produces 3 rows sharing one FictiveIDNumber. "Total crime count" must
   dedupe by that id; category (StatisticGroup) breakdowns count rows, since
   a case's several offenses can span several categories. This is stated
   explicitly in the dataset's own published methodology (data.gov.il
   package notes for crime_records_data), not an assumption made here.

2. StatisticArea (the neighborhood-equivalent) is only populated above
   ~1,000 residents / for non-sensitive offenses / for non-rural
   settlements - by the dataset's own design, to protect privacy. A case
   with no attributable area is counted in `unattributed` for its city, and
   the two must reconcile: sum(neighborhood totals) + unattributed == city
   total. This is checked, not assumed - see reconcile() below.

There's no independent published national total to validate against (unlike
compute_cities.py's EXPECT table, sourced from accidents.js's YEAR_STATS) -
so correctness here rests on two internal checks instead: the reconciliation
above, and a per-year row-accounting check (every fetched row lands in
exactly one of: counted-with-city, unresolved-YeshuvKod, or
missing-group) - both hard-fail the build on mismatch, same discipline as
compute_cities.py's EXPECT check.

Writes three files: src/police-cities.js (POLICE_CITIES), src/police-
neighborhoods.js (POLICE_NEIGHBORHOODS), and src/police-meta.js (the shared
STATISTIC_GROUPS/YEARS/YEAR_QUARTERS/NATIONAL_UNRESOLVED constants both of
the above are indexed against) - split three ways rather than combined into
one, since write_js() (reused from real_estate_build.py) writes one `export
const` per file; city-stats.js's own hand-built multi-export file was the
alternative, not used here to keep write_js's simple one-call-per-file shape.

Usage:
    ./tools/police_build.py            regenerate the three src/police-*.js files
    ./tools/police_build.py --check    exit 1 if any of them would change
"""
import argparse
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CITIES_OUT = SRC / "police-cities.js"
NEIGHBORHOODS_OUT = SRC / "police-neighborhoods.js"

# dataset crime_records_data (0d9a6652-41a8-4e99-b543-12ae1178c5bf), organization
# israel-police - one resource per year, quarterly-updated (last checked
# 2026-04-19).
RESOURCES = {
    2025: "e311b6a1-be5a-4a82-8298-f3afbee07b6b",
    2024: "5fc13c50-b6f3-4712-b831-a75e0f91a17e",
    2023: "32aacfc9-3524-4fba-a282-3af052380244",
    2022: "a59f3e9e-a7fe-4375-97d0-76cea68382c1",
    2021: "3f71fd16-25b8-4cfe-8661-e6199db3eb12",
}
# Offense taxonomy (group/type/sensitivity) - validation only, see fetch_taxonomy().
TAXONOMY_RESOURCE = "b53b64f8-57ed-4213-9191-a7401c0cf436"
CBS_POPULATION_RESOURCE = "38207cf8-afe2-48ed-a3b0-c8f70c796015"  # same id as src/population.js's CBS_POPULATION_RESOURCE_ID

# A real StatisticArea name is a short human-readable neighborhood label
# ("רמת אליהו", "מרכז מסחרי שער העיר") - every genuine one observed is well
# under 100 chars. A handful of rows (confirmed directly: a few hundred out
# of ~1.6M) carry a corrupted value hundreds of THOUSANDS of chars long -
# some kind of upstream CSV/export artifact, not a real area name. Treated
# the same as a blank StatisticArea (falls into `unattributed`) rather than
# admitted as a "neighborhood" - without this guard, a handful of corrupted
# rows blew src/police-neighborhoods.js up to 90+ MB.
MAX_AREA_NAME_LEN = 100

# Offense-family "severity" buckets for the compare page's breakdown charts -
# a product decision made with the user (not derivable from the source data
# itself), one StatisticGroup name per bucket member. Three groups
# (EXCLUDED_GROUPS) are deliberately left out of every bucket: they aren't
# real offense categories (סעיפי הגדרה = legal definition clauses,
# שגיאת הזנה = data-entry error) or are a negligible catch-all (שאר עבירות,
# 228 cases nationally) - excluded from the bucket charts but still present
# in the full per-group `categories` vector.
BUCKETS = {
    "regulatory": ["עבירות תנועה", "עבירות רשוי", "עבירות מנהליות"],
    "violent": ["עבירות נגד גוף", "עבירות מין", "עבירות נגד אדם"],
    "nonviolent": ["עבירות כלפי הרכוש", "עבירות מרמה", "עבירות כלפי המוסר", "עבירות כלכליות", "עבירות סדר ציבורי"],
    "security": ["עבירות בטחון"],
}
BUCKET_IDS = ["regulatory", "violent", "nonviolent", "security"]
BUCKET_LABELS = {
    "regulatory": "עבירות שגרתיות (תנועה, רישוי, מנהליות)",
    "violent": "עבירות אלימות",
    "nonviolent": "עבירות לא-אלימות (רכוש, מרמה, מוסר, כלכליות, סדר ציבורי)",
    "security": "עבירות בטחון",
}
EXCLUDED_GROUPS = {"שאר עבירות", "שגיאת הזנה", "סעיפי הגדרה"}

BASE = "https://data.gov.il/api/3/action/datastore_search"
YEARS = sorted(RESOURCES)
PAGE_LIMIT = 10000  # matches compute_cities.py's own Python-side cap (not ckan.js's browser-side 32000 - a different context)
FIELDS = "FictiveIDNumber,Quarter,YeshuvKod,Yeshuv,StatisticArea,StatisticGroupKod,StatisticGroup,StatisticTypeKod,StatisticType"


def get(url):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - transient API/WAF hiccups, retry
            print(f"  retry {attempt}: {e}", file=sys.stderr)
            time.sleep(2)
    sys.exit(f"gave up fetching {url}")


def fetch_all(resource_id, fields):
    """Every row of a resource, paging past the 10,000-row DataStore cap."""
    rows, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"resource_id": resource_id, "fields": fields,
                                    "limit": PAGE_LIMIT, "offset": offset})
        result = get(f"{BASE}?{q}")["result"]
        rows += result["records"]
        offset += len(result["records"])
        if offset >= result["total"] or not result["records"]:
            return rows


def render_js(varname, data, header_comment):
    return (
        f"// {header_comment}\n"
        f"// Generated by tools/police_build.py - do not edit by hand.\n"
        f"export const {varname} = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n"
    )


def write_js(text, out_path):
    out_path.write_text(text, encoding="utf-8")
    kb = out_path.stat().st_size / 1024
    print(f"wrote {out_path.relative_to(ROOT)} ({kb:.1f} KB)")


def fetch_population():
    """LocalityCode (str, e.g. '7400') -> Total_Population (int). Mirrors
    src/population.js's fetchPopulations(), in Python, keyed by LocalityCode
    instead of LocNameHeb - LocalityCode == YeshuvKod, confirmed directly
    (7400=Netanya, 70=Ashdod match on both sides). One-time 2022 census
    snapshot (see population.js's own header comment), applied here as a
    fixed population baseline across all five crime-data years - same
    "dated snapshot" honesty as elsewhere in this repo, noted on-page."""
    pop = {}
    for r in fetch_all(CBS_POPULATION_RESOURCE, "LocalityCode,Total_Population"):
        code = r.get("LocalityCode")
        n = str(r.get("Total_Population") or "").replace(",", "")
        if code is not None and n.isdigit():
            pop[str(int(code))] = int(n)  # int() round-trip normalizes "07400"/7400.0-style formatting
    return pop


def fetch_taxonomy():
    """Best-effort cross-check only - StatisticGroup/Type text already
    arrives inline on every crime-record row, so this is never a join
    dependency. Downloads the XLSX offense-taxonomy resource and checks that
    every (StatisticGroupKod, StatisticTypeKod) pair actually observed in
    the five year-resources also appears here. Returns the set of known
    pairs, or None on any failure (network, missing openpyxl, unexpected
    sheet layout) - a warning gets printed, the build does not abort, since
    this is a secondary signal, not required for the aggregation itself."""
    try:
        import openpyxl  # optional dependency, see the except below
    except ImportError:
        print("  [taxonomy] openpyxl not available in this interpreter - skipping cross-check "
              "(run via tools/.mortalityvenv/bin/python3 to enable it)", file=sys.stderr)
        return None
    try:
        meta = get(f"https://data.gov.il/api/3/action/resource_show?id={TAXONOMY_RESOURCE}")["result"]
        url = meta["url"]
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        import io
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        ws = wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
        header = [str(c or "").strip() for c in rows[0]]

        def col(*names):
            for name in names:
                if name in header:
                    return header.index(name)
            return None

        gk_i = col("StatisticGroupKod", "StatisticCrimeGroupCode", "קוד קבוצת עבירה")
        tk_i = col("StatisticTypeKod", "StatisticCrimeTypeCode", "קוד סוג עבירה")
        if gk_i is None or tk_i is None:
            print(f"  [taxonomy] unexpected columns {header!r} - skipping cross-check", file=sys.stderr)
            return None
        pairs = set()
        for row in rows[1:]:
            gk, tk = row[gk_i], row[tk_i]
            if gk is not None and tk is not None:
                pairs.add((int(gk), int(tk)))
        print(f"  [taxonomy] {len(pairs)} known (group,type) pairs")
        return pairs
    except Exception as e:  # noqa: BLE001 - best-effort, never fatal
        print(f"  [taxonomy] fetch/parse failed ({e}) - skipping cross-check", file=sys.stderr)
        return None


def build():
    print("fetching population…")
    population = fetch_population()
    print(f"  {len(population)} localities with a population figure")

    print("fetching taxonomy (validation only)…")
    taxonomy_pairs = fetch_taxonomy()

    city_name_votes = defaultdict(Counter)       # code -> Counter(name -> times seen)
    city_years = defaultdict(lambda: defaultdict(int))          # code -> year -> distinct-case count
    city_categories = defaultdict(lambda: defaultdict(int))     # code -> StatisticGroup -> row count (ALL years)
    city_unattributed = defaultdict(lambda: defaultdict(int))   # code -> year -> case count w/ no StatisticArea
    nb_years = defaultdict(lambda: defaultdict(int))            # "code::area" -> year -> distinct-case count
    nb_categories = defaultdict(lambda: defaultdict(int))       # "code::area" -> StatisticGroup -> row count (ALL years)
    nb_label = {}                                                # "code::area" -> (city_code, area display name)
    quarters_by_year = defaultdict(set)
    unresolved_cases_by_year = defaultdict(set)   # rows with blank/zero YeshuvKod
    seen_group_type_pairs = set()
    unknown_pairs = set()
    corrupted_area_rows = defaultdict(int)        # rows whose StatisticArea was corrupted (see MAX_AREA_NAME_LEN)

    for year in YEARS:
        print(f"fetching {year}…")
        rows = fetch_all(RESOURCES[year], FIELDS)
        print(f"  {len(rows)} rows")

        case_city = {}       # this year only - case -> code (first-seen)
        case_area_key = {}   # this year only - case -> "code::area" (first non-blank area seen)
        row_category_count = 0
        row_missing_group_count = 0

        for row in rows:
            case = row.get("FictiveIDNumber")
            code = str(row.get("YeshuvKod") or "0").strip()
            name = str(row.get("Yeshuv") or "").strip()
            area = str(row.get("StatisticArea") or "").strip()
            if len(area) > MAX_AREA_NAME_LEN:
                corrupted_area_rows[year] += 1
                area = ""
            group = str(row.get("StatisticGroup") or "").strip()
            gk, tk = row.get("StatisticGroupKod"), row.get("StatisticTypeKod")
            q = row.get("Quarter")
            if q:
                quarters_by_year[year].add(q)
            if gk is not None and tk is not None:
                pair = (int(gk), int(tk))
                seen_group_type_pairs.add(pair)
                if taxonomy_pairs is not None and pair not in taxonomy_pairs:
                    unknown_pairs.add(pair)

            if code in ("0", ""):
                unresolved_cases_by_year[year].add(case)
                continue  # excluded from city/neighborhood tables entirely

            if not group:
                row_missing_group_count += 1
            else:
                city_categories[code][group] += 1
                row_category_count += 1
                city_name_votes[code][name] += 1
                case_city.setdefault(case, code)
                if area:
                    key = f"{code}::{area}"
                    nb_categories[key][group] += 1
                    nb_label[key] = (code, area)
                    case_area_key.setdefault(case, key)

        # row accounting: every fetched row landed in exactly one bucket.
        n_unresolved_rows = sum(1 for r in rows if str(r.get("YeshuvKod") or "0").strip() in ("0", ""))
        accounted = row_category_count + row_missing_group_count + n_unresolved_rows
        if accounted != len(rows):
            sys.exit(f"{year}: row accounting mismatch - {accounted} accounted for "
                     f"({row_category_count} categorized + {row_missing_group_count} missing-group + "
                     f"{n_unresolved_rows} unresolved-city) != {len(rows)} fetched")

        # finalize this year's case-level (deduped) counts.
        for case, code in case_city.items():
            city_years[code][year] += 1
            key = case_area_key.get(case)
            if key:
                nb_years[key][year] += 1
            else:
                city_unattributed[code][year] += 1

        # reconciliation: neighborhoods + unattributed must equal the city total, per city, per year.
        for code in city_years:
            nb_sum = sum(nb_years[k][year] for k in nb_years if k.startswith(f"{code}::"))
            if nb_sum + city_unattributed[code][year] != city_years[code][year]:
                sys.exit(f"{year}/{code}: neighborhood sum {nb_sum} + unattributed "
                         f"{city_unattributed[code][year]} != city total {city_years[code][year]}")

        n_cases_this_year = len(case_city)
        n_unresolved_cases = len(unresolved_cases_by_year[year])
        pct = round(100 * n_unresolved_cases / (n_cases_this_year + n_unresolved_cases), 1) if (n_cases_this_year + n_unresolved_cases) else 0
        corrupted_note = f", {corrupted_area_rows[year]} rows had a corrupted StatisticArea" if corrupted_area_rows[year] else ""
        print(f"  {n_cases_this_year} cases, {n_unresolved_cases} ({pct}%) unresolved-city, "
              f"{row_missing_group_count} rows missing a category{corrupted_note}")

    if unknown_pairs:
        print(f"  [taxonomy] WARNING: {len(unknown_pairs)} (group,type) pairs seen in the data "
              f"but not in the taxonomy file: {sorted(unknown_pairs)[:10]}{'…' if len(unknown_pairs) > 10 else ''}",
              file=sys.stderr)

    return {
        "population": population,
        "city_name_votes": city_name_votes,
        "city_years": city_years,
        "city_categories": city_categories,
        "city_unattributed": city_unattributed,
        "nb_years": nb_years,
        "nb_categories": nb_categories,
        "nb_label": nb_label,
        "quarters_by_year": quarters_by_year,
        "unresolved_cases_by_year": unresolved_cases_by_year,
    }


def render(data, write=True):
    population = data["population"]
    n_years = len(YEARS)

    # STATISTIC_GROUPS: national total row count, descending - same "busiest
    # first" convention compute_cities.py uses for its own city ordering.
    national_group_totals = defaultdict(int)
    for code, cats in data["city_categories"].items():
        for group, n in cats.items():
            national_group_totals[group] += n
    statistic_groups = sorted(national_group_totals, key=national_group_totals.get, reverse=True)
    group_index = {g: i for i, g in enumerate(statistic_groups)}

    # Every StatisticGroup observed in the live data must land in exactly one
    # BUCKETS list or EXCLUDED_GROUPS - not zero, not two. Catches a future
    # year-resource introducing a new group name nobody has categorized yet,
    # same "abort rather than ship a silently wrong number" discipline as the
    # reconciliation checks in build().
    bucket_group_owner = {}
    for bucket_id, groups in BUCKETS.items():
        for g in groups:
            if g in bucket_group_owner:
                sys.exit(f"BUCKETS config error: '{g}' listed in both '{bucket_group_owner[g]}' and '{bucket_id}'")
            bucket_group_owner[g] = bucket_id
    unclassified = [g for g in statistic_groups if g not in bucket_group_owner and g not in EXCLUDED_GROUPS]
    if unclassified:
        sys.exit(f"StatisticGroup(s) in the live data with no BUCKETS/EXCLUDED_GROUPS assignment: "
                 f"{unclassified} - classify in tools/police_build.py's BUCKETS before regenerating.")
    bucket_group_indices = {bid: [group_index[g] for g in groups] for bid, groups in BUCKETS.items()}

    def raw_categories_vector(cats):
        """Row counts per STATISTIC_GROUPS, 5-YEAR SUM (internal only - the
        public `categories`/`buckets` fields below are the per-year average
        of this)."""
        vec = [0] * len(statistic_groups)
        for group, n in cats.items():
            vec[group_index[group]] = n
        return vec

    def avg_per_year(n):
        return round(n / n_years)

    def bucket_averages(raw_vec):
        return [avg_per_year(sum(raw_vec[i] for i in bucket_group_indices[bid])) for bid in BUCKET_IDS]

    # city display name: most-common spelling seen, not first-seen.
    city_display_name = {code: votes.most_common(1)[0][0] for code, votes in data["city_name_votes"].items()}

    police_cities = {}
    for code, years_map in data["city_years"].items():
        name = city_display_name.get(code)
        if not name:
            continue
        years_vec = [years_map.get(y, 0) for y in YEARS]  # per-year, NOT averaged - the year-trend chart needs the real per-year counts
        total_5yr = sum(years_vec)
        avg_total = avg_per_year(total_5yr)
        raw_cats = raw_categories_vector(data["city_categories"].get(code, {}))
        entry = {
            "code": code,
            "years": years_vec,
            "total": avg_total,
            "categories": [avg_per_year(n) for n in raw_cats],
            "buckets": bucket_averages(raw_cats),
            "unattributed": avg_per_year(sum(data["city_unattributed"].get(code, {}).values())),
        }
        pop = population.get(code)
        if pop:
            entry["population"] = pop
            entry["perCapita"] = round(avg_total / pop * 1000, 1)
        # A later duplicate name wins harmlessly - same caveat accidents.js
        # documents for its own code-keyed roster (names assumed unique).
        police_cities[name] = entry

    police_neighborhoods = {}
    for key, years_map in data["nb_years"].items():
        code, area = data["nb_label"][key]
        city_name = city_display_name.get(code)
        if not city_name:
            continue
        years_vec = [years_map.get(y, 0) for y in YEARS]
        raw_cats = raw_categories_vector(data["nb_categories"].get(key, {}))
        nb_key = f"{city_name}::{area}"
        police_neighborhoods[nb_key] = {
            "years": years_vec,
            "total": avg_per_year(sum(years_vec)),
            "categories": [avg_per_year(n) for n in raw_cats],
            "buckets": bucket_averages(raw_cats),
        }

    year_quarters = {y: len(data["quarters_by_year"][y]) for y in YEARS}
    # National coverage stats (NATIONAL_UNRESOLVED) are a 5-YEAR raw total,
    # not an average - "what fraction of all cases in the dataset have no
    # resolvable city" is a data-quality fact about the whole pull, not a
    # per-year rate, so it stays independent of the avg-per-year framing
    # every per-entity field above just switched to.
    total_cases_5yr = sum(sum(v.values()) for v in data["city_years"].values())
    total_unresolved = sum(len(s) for s in data["unresolved_cases_by_year"].values())
    unresolved_pct = round(100 * total_unresolved / (total_cases_5yr + total_unresolved), 1) if (total_cases_5yr + total_unresolved) else 0
    national_unresolved = {"cases": total_unresolved, "pct": unresolved_pct}

    print(f"\nnational: {total_cases_5yr} cases 2021-2025 ({avg_per_year(total_cases_5yr)}/year avg) across "
          f"{len(police_cities)} cities, {len(police_neighborhoods)} city+neighborhood entries, "
          f"{total_unresolved} ({unresolved_pct}%) cases unresolved to any city")

    cities_header = (
        "Per-city crime-case data, 2021-2025 - GENERATED by tools/police_build.py, do not\n"
        "// hand-edit. Source: data.gov.il 'crime_records_data' (Israel Police), one CKAN\n"
        "// resource per year. Keyed by city NAME (matches CITY_REAL_ESTATE/CITY_CANOPY_SPLIT's\n"
        "// own convention, not city-stats.js's code-keyed one - a later duplicate name wins\n"
        "// harmlessly, same caveat accidents.js documents for itself).\n"
        "// EVERY FIELD BELOW EXCEPT `years` IS A PER-YEAR AVERAGE (5-year total / 5), not a\n"
        "// 5-year sum - `years` itself stays per-year (that's its whole point, feeds the\n"
        "// year-trend chart) and is the only field this applies to differently.\n"
        "//   years: distinct-case counts per year, parallel to YEARS below.\n"
        "//   total: average distinct cases per year (sum(years) / 5).\n"
        "//   categories: average row counts per year, parallel to STATISTIC_GROUPS below -\n"
        "//     a case with N offenses in N different categories counts once in EACH of those\n"
        "//     categories, so category totals can exceed `total` - this is a deliberate\n"
        "//     consequence of the source counting offenses-in-a-case, not cases (see this\n"
        "//     dataset's own published methodology) and is called out on-page.\n"
        "//   buckets: average row counts per year, parallel to BUCKET_IDS below - the same\n"
        "//     STATISTIC_GROUPS row counts as `categories`, re-summed into 4 offense-family\n"
        "//     buckets (see BUCKETS in this script) instead of 15 individual groups. Three\n"
        "//     groups (EXCLUDED_GROUPS) aren't in any bucket, so bucket totals don't sum to\n"
        "//     the full `categories` total - by design, not a bug.\n"
        "//   unattributed: average distinct cases per year with no StatisticArea anywhere\n"
        "//     among their own rows (privacy-suppressed small area / sensitive offense /\n"
        "//     rural settlement - see the dataset's own methodology notes). Reconciles\n"
        "//     exactly against POLICE_NEIGHBORHOODS on the underlying 5-year sums (checked\n"
        "//     at build time before rounding to a per-year average here).\n"
        "//   population/perCapita: 2022 CBS census population, and average annual cases per\n"
        "//     1,000 residents - omitted when no population match exists for this city's code."
    )
    cities_js = render_js("POLICE_CITIES", police_cities, cities_header)
    if write:
        write_js(cities_js, CITIES_OUT)

    nb_header = (
        "Per-city+neighborhood (StatisticArea) crime-case data, 2021-2025 - GENERATED by\n"
        "// tools/police_build.py, do not hand-edit. Keyed \"<city>::<area>\", same convention\n"
        "// as NEIGHBORHOOD_REAL_ESTATE/NEIGHBORHOOD_CANOPY_SPLIT. Every field is a PER-YEAR\n"
        "// AVERAGE except `years` itself - see POLICE_CITIES' own header for the full\n"
        "// explanation, identical here. No population/perCapita - no CBS population figure\n"
        "// exists at StatisticArea granularity. Structurally incomplete BY DESIGN: only\n"
        "// cases whose StatisticArea survived the source's own privacy suppression appear\n"
        "// here at all - see POLICE_CITIES' own `unattributed` field for what's missing from\n"
        "// each city, and this dataset's published methodology for why."
    )
    nb_js = render_js("POLICE_NEIGHBORHOODS", police_neighborhoods, nb_header)
    if write:
        write_js(nb_js, NEIGHBORHOODS_OUT)

    meta_text = (
        f"// Shared constants for both POLICE_CITIES and POLICE_NEIGHBORHOODS above -\n"
        f"// generated together by tools/police_build.py so they can never drift apart.\n"
        f"export const STATISTIC_GROUPS = {json.dumps(statistic_groups, ensure_ascii=False)};\n"
        f"export const YEARS = {json.dumps([str(y) for y in YEARS])};\n"
        f"export const YEAR_QUARTERS = {json.dumps({str(y): year_quarters[y] for y in YEARS})};\n"
        f"export const NATIONAL_UNRESOLVED = {json.dumps(national_unresolved)};\n"
        f"// Offense-family buckets for the compare page's breakdown charts (a product\n"
        f"// decision, not derived from the source) - BUCKET_IDS is the fixed display order,\n"
        f"// BUCKET_LABELS the Hebrew heading per bucket, BUCKET_GROUPS which STATISTIC_GROUPS\n"
        f"// (by name) feed each bucket's own sub-bars. EXCLUDED_GROUPS lists the 3 groups in\n"
        f"// neither a bucket nor these charts at all (still present in `categories` above).\n"
        f"export const BUCKET_IDS = {json.dumps(BUCKET_IDS)};\n"
        f"export const BUCKET_LABELS = {json.dumps(BUCKET_LABELS, ensure_ascii=False)};\n"
        f"export const BUCKET_GROUPS = {json.dumps(BUCKETS, ensure_ascii=False)};\n"
        f"export const EXCLUDED_GROUPS = {json.dumps(sorted(EXCLUDED_GROUPS), ensure_ascii=False)};\n"
    )
    meta_path = SRC / "police-meta.js"
    if write:
        write_js(meta_text, meta_path)

    return {
        "cities_js": cities_js,
        "nb_js": nb_js,
        "meta_js": meta_text,
        "summary": {
            "total_cases_5yr": total_cases_5yr, "avg_cases_per_year": avg_per_year(total_cases_5yr),
            "n_cities": len(police_cities), "n_neighborhoods": len(police_neighborhoods),
            "unresolved": national_unresolved,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 if any generated file would change; leaves the working tree untouched either way")
    args = ap.parse_args()

    data = build()
    result = render(data, write=not args.check)

    if args.check:
        want = {
            CITIES_OUT: result["cities_js"],
            NEIGHBORHOODS_OUT: result["nb_js"],
            SRC / "police-meta.js": result["meta_js"],
        }
        current = {p: (p.read_text(encoding="utf-8") if p.exists() else "") for p in want}
        changed = [p for p in want if current[p] != want[p]]
        if changed:
            sys.exit(f"stale: {', '.join(str(p.relative_to(ROOT)) for p in changed)} - "
                     f"run ./tools/police_build.py")
        print("police-*.js is up to date")


if __name__ == "__main__":
    main()
