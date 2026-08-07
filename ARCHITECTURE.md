# Architecture

A map of the whole project, organized by **where data comes from**, not by
which page you happen to open. `README.md` explains the API map itself in
depth; `SESSION.md` is a chronological build log. This document is the
cross-cutting index those two don't provide: for every page, is its data
live, batch-precomputed, or both — and for every batch pipeline, what script
produces it and which pages consume it.

Three layers, always in this order:

```
government / external source  →  batch pipeline (offline, local)  →  committed src/*-data.js
                                                                              │
government / external source  ───────────── live fetch() ───────────────────┼──→  page (src/*.js + *.html)
                                                                              │
                                                                     dist/*.html (self-contained bundle)
```

A page is one of three shapes: **live** (every number comes from a `fetch()`
at view time), **batch** (every number comes from a committed, precomputed
`src/*-data.js` file, refreshed by hand-running a `tools/*.py` script), or
**hybrid** (both — typically a batch-computed roster or boundary set, joined
against a live per-row lookup).

---

## 1. Data sources

### Live, called directly from the browser (`apis.json` — the API map's own subject)

| Source | Used by | Notes |
|---|---|---|
| data.gov.il CKAN (`package_search`, `datastore_search`) | `datagov.html`, `companies.html`, `welfare.html`, `local-finance.html` | The only source exposing row-level records, not just a file catalogue. |
| CBS (`api.cbs.gov.il`) | `local-finance.html`, `welfare.html` (population), price-index chapters on the map | Also the CPI series (`120010`) used *inside* the real-estate batch pipeline (§2). |
| Ministry of Agriculture ArcGIS Hub / FeatureServer | `moag.html` | DCAT feed fetched whole (93 datasets), rows paged live. |
| GovMap WFS (`PARCEL_ALL` cadastre) | map's own portal drill-in | EPSG:3857 only — see README's "Notable specifics". |
| iplan Xplan (MapServer + FeatureServer) | map's own portal drill-in, `plan-timeline.html`/`plan-compare.html` (via `plan-data.js`, IndexedDB-cached) | Also the source `tools/iplan_snapshot.py` snapshots offline for one-off address images. |
| Open Bus Stride (Hasadna, NGO) | map's own portal drill-in | Bus GPS/stop data; not government but included for CORS comparison. |
| Knesset OData, Bank of Israel SDMX | map's own portal drill-in only | No CORS — server-only, shown as an unreachable-from-browser example, not consumed by any other page. |
| OSM Overpass API | `trip-report.html` (`trip-speed-limits.js`) | Live posted-speed lookup per trip point, session-cached only. |
| OSM Nominatim | `trip-report.html`, `arnona-compare.html` | Reverse/forward geocoding. |
| OSM tiles / Esri World Imagery / World Topo tiles | `area-cleanup.html`, `blue-lines.html`, `real-estate-map.html`, `canopy-map.html` (optional overlay) | Basemap imagery only (`geo-utils.js`), not data. |
| `handasi.complot.co.il` (Complot council-meeting engine) | `committees.html` | Live per-council meeting-listing search, against the committee/site roster below. |

### Offline sources, pulled once into a batch pipeline (never called from the browser)

| Source | Pulled by | Feeds |
|---|---|---|
| Survey of Israel national tree-canopy shapefile (358 MB, 2.89M polygons, Government Decision 1022) | `tools/canopy_build.py` (manual download into gitignored `zip/`) | `canopy-map.html`, `canopy-heat-compare.html` |
| Ministry of Environmental Protection climate-risk map (`UHI_Ta_9pm.tif`, Tomorrow.io + IMS) | `tools/heat_build.py` | `canopy-heat-compare.html`, `canopy-map.html` |
| GovMap real-estate/"nadlan" deals API (rolling window, accumulated over repeated runs) | `tools/real_estate_fetch.py` → `tools/real_estate_build.py` | `real-estate-map.html`, `real-estate-compare.html` |
| CBS CPI series (`120010`) | `tools/real_estate_build.py` | Same two real-estate pages (deal price normalization) |
| CBS road-accident DataStore resources (2020–2024) | `tools/compute_cities.py` | `accidents.html` |
| Local-authority audited financial reports (CKAN `local-authorities` / `local-council-1`) | roster logic lives in `src/finance-data.js`; actual figures fetched live per authority | `local-finance.html`, `tools/arnona_authorities.py`'s own roster |
| Each authority's צו ארנונה (property-tax order) PDF, scraped per-authority site | `tools/arnona_authorities.py` (roster) → `tools/arnona_fetch.py` (PDFs) → hand-extraction into `arnona_rates.json`/overrides | `arnona-compare.html` |
| Ministry of Interior "רשויות איתנות" (financially-stable authorities) list, behind Cloudflare | `tools/fetch_stable_authorities.mjs` (Playwright, to pass the challenge) | `local-finance.html` (`STABLE_AUTHORITIES`) |
| OpenStreetMap neighborhood polygons/points, municipal boundaries (`muni_il` WFS) | `tools/map_geo_build.py`, `canopy_build.py`'s boundary loaders (reused by every other batch script) | Every batch pipeline below that needs a boundary — canopy, heat, canopy-split, real estate, the map's own rendering |

---

## 2. Batch pipelines

Every one of these is a **local, one-time (re-run-when-source-updates) Python
job** — never a build step, never run in CI, never run in the browser. Output
is a committed `src/*.js` (or, for real estate, per-city JSON under
`dist/assets/deals/`) — small enough to ship, derived from a large local
input that itself is gitignored.

| Script | Reads (gitignored, local only) | Writes (committed) | Regenerate with |
|---|---|---|---|
| `canopy_build.py` | tree-canopy shapefile + `muni_il`/OSM boundaries | `tree-canopy-{cities,neighborhoods,streets}.js` | `python3 tools/canopy_build.py all` |
| `canopy_split_build.py` | canopy GeoPackage + street-buffer union | `canopy-split-{cities,neighborhoods}.js` | `python3 tools/canopy_split_build.py` |
| `heat_build.py` | `UHI_Ta_9pm.tif` + boundaries | `heat-{cities,neighborhoods,streets}.js` | `python3 tools/heat_build.py` |
| `canopy_blobs.py` / `heat_blobs.py` (+ shared `blob_geo.py`) | canopy GeoPackage / heat raster + `map-boundaries-*.js` | `canopy-blobs.js` / `heat-blobs.js` (per-city high-res raster overlays) | `python3 tools/canopy_blobs.py`, `python3 tools/heat_blobs.py` |
| `map_geo_build.py` | `muni_il` + OSM boundaries | `map-boundaries-{cities,neighborhoods}[-wgs84].js` | `python3 tools/map_geo_build.py` |
| `real_estate_fetch.py` **(scheduled — see below)** | GovMap nadlan API, run repeatedly over time and accumulated | `zip/real_estate_deals_raw.jsonl`, `zip/cpi_table.json` (both gitignored) | `python3 tools/real_estate_fetch.py`, or `./tools/real_estate_refresh.sh` for the full chain |
| `real_estate_build.py` **(scheduled — see below)** | the two files above + reused canopy boundaries | `real-estate-{cities,neighborhoods}.js`, `real-estate-streets.js`, per-city `dist/assets/deals/*.json` | `python3 tools/real_estate_build.py` |
| `compute_cities.py` | CBS accident DataStore resources (paged, aggregated locally — `datastore_search_sql` is WAF-blocked) | `city-stats.js` | `python3 tools/compute_cities.py` |
| `arnona_authorities.py` | CKAN `local-authorities` roster | `tools/arnona_authorities.json` | `python3 tools/arnona_authorities.py` |
| `arnona_fetch.py` | each authority's own site, using the roster above | `tools/arnona_output/*.pdf` (gitignored) | `python3 tools/arnona_fetch.py` |
| — (hand extraction from the PDFs) | `tools/arnona_output/` | `arnona-rates-data.js` (`arnona_rates.json` + `arnona_overrides.json`) | manual |
| `fetch_stable_authorities.mjs` | gov.il "רשויות איתנות" page (Cloudflare-gated, Playwright) | `tools/stable_authorities.json` → `stable-authorities.js` | `node tools/fetch_stable_authorities.mjs` |
| `iplan_snapshot.py` | iplan Xplan MapServer, one address at a time | one-off PNG snapshots (not wired into any page — a standalone utility) | `python3 tools/iplan_snapshot.py <address>` |

**Refresh discipline**: batch data is a claim about the source *as of the day
it was pulled* — same honesty principle as the live API map (§ README
"Keeping the map honest"), just on a manual cadence instead of a weekly
GitHub Action. Nothing re-runs these automatically; a stale page is stale
until someone re-runs the script and commits the new `src/*-data.js`.

**One exception, and why only this one**: `real_estate_fetch.py` is on a
**monthly cron job**, not a manual re-run. Every other pipeline just goes
stale if you skip a run — re-run it later and you're caught back up, nothing
lost. Real estate is structurally different: GovMap's nadlan API only ever
exposes a **rolling window** per settlement (measured at ~4 months deep for
Tel Aviv, not assumed), so a deal that ages out of that window before it's
ever fetched is **gone permanently**, not just outdated. Multi-year coverage
is a property of *running this every month for years and merging by
`dealId`* — never of any single run, however recent. That's a fundamentally
different failure mode from "the canopy shapefile is a year old," which is
why it's the one pipeline worth the automation cost.

- **Installed via**: `./install.sh` (its final section, separate from the
  site-serving check above it) — registers the job in `crontab` if not
  already present, idempotently.
- **Schedule**: 1st of every month, 03:00 local time —
  `0 3 1 * * /storage01/govapiportal/tools/real_estate_refresh.sh`.
- **What it runs**: `tools/real_estate_refresh.sh`, which chains fetch →
  build → `bundle.py` → `git commit` → `git push`, unattended, logging to
  `zip/real_estate_refresh.cron.log`. It skips the commit (but still logs)
  on a month with zero new deals.
- **Why cron and not GitHub Actions**, unlike the weekly API probe: the raw
  deal dump (`zip/real_estate_deals_raw.jsonl`) is gitignored and grows
  multi-GB over years of accumulation — a fresh CI checkout has no prior
  history to accumulate onto. This has to run on one persistent machine that
  keeps that file between runs, not an ephemeral runner.
- **Prerequisite the installer does not check**: `real_estate_build.py`
  needs GDAL's Python bindings (`osgeo`), `shapely`, `pyproj` and `numpy` on
  whatever machine runs the cron job — installed here via
  `sudo apt install python3-gdal python3-shapely python3-pyproj
  python3-numpy` (GDAL 3.10.3, from the standard repo). `install.sh` itself
  does not check for these, so a fresh machine running the cron job for the
  first time needs this done once, by hand, before the 1st-of-the-month
  trigger — otherwise the run fails silently into the cron log.

---

## 3. Pages, classified

| Page | Shape | Data flow |
|---|---|---|
| `index.html` | static + live probe | `apis.json`, re-verified weekly by `.github/workflows/probe.yml` (§4) |
| `datagov.html` | **live** | CKAN catalogue → dataset → `datastore_search` records, all server-side filter/sort/page |
| `moag.html` | **live** | DCAT feed (fetched whole) → FeatureServer `/query`, client-composed SQL-like filter |
| `plan-timeline.html`, `plan-compare.html` | **live** | `plan-data.js` → iplan Xplan, ~20–27k rows, IndexedDB-cached across reloads |
| `companies.html` | **live** | `dsQuery` → CKAN DataStore, direct |
| `welfare.html` | **live** | `dsQuery` (national + per-authority resources) + live CBS population |
| `local-finance.html` | **hybrid** | Batch: authority roster (`finance-data.js`) + `STABLE_AUTHORITIES` batch file. Live: per-year DataStore figures fetched per authority, plus live CBS population and a `package_show` metadata call |
| `committees.html` | **hybrid** | Batch: `COMMITTEE_SITES` roster (`committee-sites.js`, hand-maintained). Live: per-council meeting search against `handasi.complot.co.il` |
| `accidents.html` | **batch** | `city-stats.js` (`compute_cities.py`) + hand-verified `YEAR_STATS` national totals. No fetch. |
| `arnona-compare.html` | **batch**, + live geocoding | `arnona-rates-data.js` (arnona pipeline above). Live Nominatim only for address lookup, not for the rates themselves |
| `canopy-map.html` | **batch** | Canopy + heat + boundary + blob `src/*-data.js` files (5 separate pipelines feed one page). No fetch except optional OSM/aerial tile imagery |
| `canopy-heat-compare.html` | **batch** | Same canopy/heat/canopy-split data files as above, unioned/compared. No fetch at all |
| `real-estate-map.html`, `real-estate-compare.html` | **batch**, lazily loaded | `real-estate-{cities,neighborhoods,streets}.js` for aggregates; per-city deal detail lazily `fetch()`ed from a **static, committed** `dist/assets/deals/<city>.json` — not a live API call, just deferred loading |
| `area-cleanup.html`, `blue-lines.html` | **batch** data + **live** imagery | `STREET_CANOPY` (batch) for tree data; live OSM/aerial basemap tiles + live iplan Xplan geometry service for the map itself |
| `trip-report.html` | **live**, local-only | Live OSM Overpass (speed limits) + Nominatim; trip history persisted client-side only (no server) |
| `apps.html` | static index | Renders entirely from `apis.json`'s app entries (§ this session's earlier fix to `להציל עץ` / `עצים בתוכניות בניין`) |
| `help-*.html` (10 pages) | static content | Hand-authored guides, no data at all — not part of `dist/` |

---

## 4. Build & distribution layer

This sits **above** all three data shapes — it doesn't produce data, it packages pages.

- **`tools/bundle.py`** inlines each page's own `src/*.js`/`src/*-data.js` into one
  self-contained `dist/<page>.html`, plus (for `apps.html`) a snapshot of
  `apis.json` as `globalThis.__API_DATA__` — which is why a `dist/` page needs
  re-bundling after any `apis.json` or `src/` edit (`./tools/bundle.py`, or
  `--check` to fail CI on staleness). Batch-data pages become **fully static
  single files** this way; live-API pages (`datagov.html`, `moag.html`) stay
  live even offline — `file://` origin `null` still passes CORS on the sources
  that send `*`.
- **`tools/wp_embed.py`** generates `dist/wordpress-embed.html`, a hand-ported
  fragment mirroring `apps.html`'s tile grid for pasting into WordPress.
- **`.github/workflows/probe.yml`** re-probes every `apis.json` endpoint weekly
  and opens an issue on drift — the only thing here that runs on a schedule
  rather than by hand. It never rewrites `apis.json` itself (§ README
  "Keeping the map honest").
- **`tools/verify.sh`** / **`tools/smoke.mjs`** drive a real (Playwright)
  browser against both the served and `file://` copies and fail on any
  console error — the only check that a page's live fetches actually work,
  not just that its JS parses.
