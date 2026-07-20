# Session log

Running record of what was built, what was verified, and what turned out wrong.
Newest section last.

---

## 2026-07-20

### Scope, as it changed

1. Started as "a complete portal for the Israel gov API, static, GitHub-hosted"
   → built a data.gov.il CKAN portal (search, dataset detail, record explorer,
   nightly indexer).
2. Repo `govapiportal` introduced; everything moved in, scrapers alongside.
3. Scrapers removed by the user as irrelevant.
4. Narrowed to **"only the api map"** → a cross-source reference map of Israeli
   government APIs. The CKAN portal was set aside, not deleted (see below).
5. Extended with a **top-level portal map** and an **in-browser API explorer**.

### Verified API facts (probed 2026-07-20, not recalled)

25 endpoints probed across two rounds. 13 recorded in `apis.json`, 5 browser-callable.

| Source | Result |
|---|---|
| data.gov.il `package_search`, `datastore_search` | 200, CORS `*`, JSON |
| data.gov.il `datastore_search_sql` | **403 — WAF-blocked**, HTML error page, even with no params |
| CBS `api.cbs.gov.il` (index data + catalog) | 200, CORS `*`, JSON |
| Open Bus Stride (Hasadna, NGO) | 200, CORS `*`, full OpenAPI spec |
| Knesset OData (ParliamentInfo, Votes) | 200 but **no CORS header** — server-side only |
| Bank of Israel edge SDMX | 200, XML, **no CORS** — server-side only |
| GovMap | CORS `*` but `{"error":"access denied"}` — undocumented auth |
| Nadlan | Returns SPA HTML shell for a plain POST — contract unverified |
| gov.il, Israel Post | All probed paths 404 — endpoints **not identified** |

Catalog scale, measured: 1197 datasets, 3775 resources, **55% `datastore_active`**
(the rest are download-only files). Snapshot was 1.05 MB raw / ~250 KB gzipped.

### Corrections made mid-session

- **Claimed `datastore_search_sql` would "unlock a real portal". Wrong** — it is
  WAF-blocked. Retracted after probing. There is no server-side aggregation;
  aggregate client-side or at build time. This is why every field in
  `apis.json` is probed rather than recalled.
- Assumed CORS was universal across gov sources. **Wrong** — Knesset and BOI
  both serve data fine but send no CORS header, which is the single most
  decision-relevant fact in the map.
- The Pages workflow used `path: .`, which would have published 82 MB of scraped
  PDFs publicly once the scrapers moved into the repo. Changed to stage only
  site files. (Moot after the scrapers were removed, but the staging habit stayed
  until the map became fully static.)

### Decisions

- **Zero-build**: plain ES modules, no bundler, no npm. GitHub Pages serves the
  directory as-is. Node now exists here, but only under `tools/` for verification —
  the published site still has no build step and no dependencies.
- **Multi-state verdicts** (usable / server-only / limited / blocked / not-identified)
  rather than a boolean. Collapsing "actively blocked" into "couldn't find it" would
  misstate what is known. Grew from three to five when the top view exposed a
  double-count (below).
- **Failed probes are recorded, not omitted** — so the dead ends aren't re-derived.
- Live explorer reports CORS failures precisely: a cross-origin block surfaces as
  an opaque `TypeError` with no status, which is deliberately distinguished from
  a genuine network error.

### State

- Repo: `agmonr/govapiportal`, branch `main`.
- First commit `17a2e7e` pushed successfully.
- **GitHub Pages is not enabled** — `deploy-pages` fails, `/repos/.../pages`
  returns 404. Needs a one-time manual setting:
  Settings → Pages → Source: **GitHub Actions**. Upload step already succeeds.

### Not verified

~~**No JavaScript in this repo has ever been executed.**~~ Superseded — see
"The JS finally ran" below. `map.js` and the top view are now exercised in
headless Chromium on every `./tools/verify.sh`. `explorer.js` still has no
coverage beyond opening its panel: no live request is asserted, because the
assertions would then depend on nine government servers being up.

### Added later that day: top view

A `מבט־על` section above the portal grid — a total plus five verdict tiles over a compact
matrix of all 13 APIs grouped by portal (domain / format / auth / HTTP / CORS /
verdict). Tiles filter the detail list; matrix rows clear the filters and scroll
to the matching card.

- Verdict counts are derived from the same `verdict()` the cards use, so the top
  view cannot drift from the list below it.
- Row → card linking uses a `_id` assigned after the sort, because endpoints
  repeat across entries and the list re-renders on every filter change.

### The JS finally ran

Node 22.17 (prebuilt tarball → `~/.local/node`) and Playwright Chromium
(`~/.cache/ms-playwright`) installed without root; no sudo password is available
here, and neither needed one. `tools/setup.sh` reproduces it, `tools/verify.sh`
serves the site and drives it.

**This retires the standing "no JavaScript in this repo has ever been executed"
caveat.** `map.js` and the top view load clean — no console errors, no failed
requests. `explorer.js` is still only exercised as far as its toggle.

Running it caught a bug the static check could not: the `שרת בלבד` tile counted
**5**, but only 3 entries are genuinely 200-without-CORS. GovMap and Nadlan
returned the `מוגבל` label while sharing the `warn` class, so the top view
double-counted them under a cause that wasn't theirs — the same conflation the
three-state verdict was introduced to avoid. `מוגבל` is now its own state
(`limited`, violet), and the split is 5 / 3 / 2 / 1 / 2 = 13.

`tools/smoke.mjs` derives its expectations from `apis.json` rather than
hardcoding counts, and asserts tile == cards == rows for every state, so adding a
source cannot silently desync the three views. It also asserts no element carries
two verdicts, and no horizontal body scroll at 380/768/1280 px.

### Filesystem support: the origin-`null` finding

Asked whether the map should work from the filesystem. Probed rather than
assumed, and the answer split cleanly in two:

- **Loading its own files: blocked.** `index.html` opened from disk renders
  blank — ES module scripts are refused from origin `null`, and `fetch` of
  `apis.json` would be refused for the same reason. It was failing *silently*,
  which was the worse half of the bug.
- **Calling the government APIs: works.** `Access-Control-Allow-Origin: *`
  accepts origin `null`. Probed from a real `file://` page: data.gov.il 200,
  CBS 200, Open Bus 200, Knesset `TypeError` (correctly). The live explorer
  needs no server.

So the offline copy is not a degraded preview — it is the whole thing. That is
what made a single-file build worth building rather than just documenting the
limitation.

`tools/bundle.py` inlines CSS, the three modules and `apis.json` into
`dist/map.html` (36 KB). Verified by hand from `file://`: a live CKAN call
returns HTTP 200 with a 31 KB JSON body, and Knesset still reports the CORS
message.

Design points worth keeping:

- **`index.html`, `apis.json` and `src/` are untouched.** The site still has no
  build step; only the extra artifact is generated. `apis.json` stays real JSON
  that `curl`/`jq` can consume — the alternative (a `window.API_MAP = {...}` .js
  file) would have made the whole site file-openable but ended that.
- **The bundler never rewrites control flow.** `map.js` checks
  `globalThis.__API_DATA__` and falls back to fetching; the bundler only
  prepends data. Regex-rewriting a fetch call would have rotted.
- Every anchor the bundler matches is asserted to hit exactly once, so an edit
  to `index.html` breaks the build loudly instead of emitting a half-inlined file.
- The `file://` notice is stripped from the bundle — that limitation does not
  apply there, and showing it would be actively wrong.
- Inline `<script type="module">` on `file://` was the one load-bearing
  assumption, so it was tested in Chromium before anything was built on it.
  It runs; the origin-`null` block is on *fetching* module scripts, not inline ones.

Staleness is the real risk of a committed generated file. `bundle.py --check`
regenerates in memory and diffs; `verify.sh` runs it first. The guard itself was
tested by tampering with `dist/map.html` and confirming a non-zero exit.

### Drift detection

`apis.json` had no way to notice it had gone stale. `tools/probe.py` + a Monday
`probe.yml` re-probe all 11 identified endpoints and open (or update, or close)
a single `api-drift` issue.

Two decisions worth keeping:

- **It never rewrites `apis.json`.** A GitHub runner is a different client than a
  person's browser — datacentre IPs get WAF-blocked and geo-filtered — so
  auto-committing would let one bad run overwrite curated verdicts with an
  artefact of where the probe ran from.
- **It probes `example`, not `endpoint`.** The first run reported two drifts:
  `datastore_search` 200→409 and CBS price 200→500. Both were the prober's fault
  — those endpoints need parameters, and the recorded 200s describe the
  parameterised call. Probing the bare endpoint asked a different question.
  Left unfixed it would have opened a false-positive issue every week, and worse,
  would have "shown" that datastore_search stopped being browser-callable.

Baseline as of this run: **all 13 entries still match** — the map is accurate
today, re-confirmed rather than assumed. Drift reporting was verified by flipping
a CORS value in a copy of `apis.json` and watching the report name it.

### Two new sources found, and a lookup page that was then removed

A request to find building plans for addresses led to probing well beyond
`data.gov.il` (which has none — `q=היתרי בנייה` returns 0; the 22 `רישוי` hits
are vehicle licensing). Two government APIs turned up that were **not in the
map**, both verified browser-callable:

| Source | CORS |
|---|---|
| `open.govmap.gov.il/geoserver/opendata/wfs` — cadastre, 7 layers | `*` |
| `ags.iplan.gov.il/arcgisiplan/…/Xplan/MapServer/1` — plan boundaries | echoes Origin |

**These stay in `apis.json`** — they are exactly what this map exists to
catalogue, and the weekly prober now watches them. 13 entries → 15,
5 browser-callable → 7.

A `plans.html` lookup page (address → גוש/חלקה → plans) was built on top of them
and then **deleted at the user's request** — the repo is the API map, nothing
else. It is recoverable from commit `a022d6a` if ever wanted.

Findings kept because they are about the APIs, not the page:

- **`PARCEL_ALL` is EPSG:3857.** lon/lat degrees in a CQL filter return zero
  features with no error — a silent wrong answer, not a failure.
- **The service root is `/arcgisiplan/`, not `/arcgis/`**; the latter 302s to an
  error page.
- **Xplan echoes the requesting Origin** rather than sending `*`, hence the
  `cors: "origin"` sentinel in `apis.json` and the normalisation in `probe.py` —
  without it the prober would report drift every single week.
- A parcel is typically covered by ~10 plans, most of them national-scale
  (תמא/70 alone covers 117,696 dunam).
- **מבא"ת was down** throughout (redirects to `maintenance.gov.il`).

The prober also caught a genuine outage mid-session: Bank of Israel went from 200
to connection-refused between two runs. Drift reports now separate *contract
changed* (edit the map) from *unreachable* (probably wait) — the remedies differ.

### Portal drill-in

Clicking a portal now fires its API and renders the response as a table. Five
renderers, one per browser-callable portal, because the shapes have nothing in
common — CKAN packages, nested CBS chapter objects, flat GTFS rows, GeoJSON
features, ArcGIS attribute records. A generic renderer was considered and
rejected: it would produce a technically-correct table that reads as noise for
four of the five.

Portals with no callable API get an explanation, not a failed request. Conflating
"nothing to show" with "it broke" would undo the three-state verdict work.

**A silent bug this surfaced, worth keeping in mind:** `bundle.py` flattens a
hardcoded `SOURCES` list. Adding `portal.js` to `map.js`'s imports without adding
it to that list still produced a bundle — one that threw `ReferenceError` on load
because `hasPreview` was imported and never defined. The build reported success.
`verify_symbols()` now cross-checks every imported name against what the listed
files export and fails the build instead. Verified by removing `portal.js` from
`SOURCES` and confirming a non-zero exit.

Scale figures the previews surfaced, both live: data.gov.il **1,197 datasets**,
GovMap cadastre **1,097,502 parcels**.

**Filtering**, added after: four of the five filter server-side (`q=`,
`city=`, CQL `LIKE`, ArcGIS `where`), verified against each API before wiring.
Only CBS filters locally — 14 chapters arrive in one response, so filtering them
client-side is the whole collection rather than a subset pretending to be one,
and re-filtering reuses the cached response instead of re-hitting the server.

The scope badge is load-bearing, not decoration: with a client-side filter over
GovMap, "no results" would mean "not among the 15 rows fetched" while looking
exactly like "not among 1,097,502 parcels". Server-side inputs are debounced at
450 ms so a keystroke does not become a request to a government host.

### Set aside, not deleted

~~The original CKAN portal lives in the session scratchpad.~~ **Gone.** The
previous session's scratchpad no longer exists, and none of it was ever in git
history — `ckan.js`, the dataset detail page, the record explorer,
`build_index.py` and the catalog snapshot are unrecoverable. Recorded here so
nobody goes looking for them. Anything wanted from that work must be rebuilt.
