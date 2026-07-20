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

### File downloads

Dataset rows expand into their resources, with format and size up front. Two
findings, both from probing rather than assumption, and both of which changed
the implementation:

- **The `download` attribute is ignored for cross-origin URLs.** The first
  version used it on every link; every link here is cross-origin, so it did
  nothing. Links now open in a new tab, which is also where a WAF interstitial
  has somewhere to run.
- **data.gov.il serves PDFs but WAF-challenges CSV/XLSX.** Reproducible across a
  sample: PDF ×2 → `200 application/pdf`; CSV ×2 and XLSX ×2 → `200 text/html`
  with 42 KB of obfuscated challenge JS. Same WAF that 403s
  `datastore_search_sql`. Headless Chromium cannot pass it — the challenge is
  designed to block exactly that — so **whether a real user's browser completes
  the CSV download is unverified**. It very likely does; the UI warns instead of
  claiming either way.

The initial claim in the commit-in-progress was that downloads "just work"
because CORS does not apply to navigations. Half right: CORS genuinely does not
apply, but the WAF does, and the two are easy to conflate.

### Explorer: dead badge became the useful control

The method badge was a `<span>` styled like a button and wired to nothing —
it looked interactive and was not. It is now an `<a target="_blank">` whose href
tracks the URL input, and the send button reads **בקשה** rather than שלח.

This turned out to matter more than a relabel. A new tab is a plain navigation,
so **it reaches what `fetch` cannot**: Knesset OData answers `fetch` with an
opaque CORS `TypeError` and answers a tab with `200 application/json` — verified
both ways in one run. For the three server-only APIs this is the only way to see
a response at all, which is exactly the gap the map has been documenting since
the first probe round.

The badge stays a plain `<span>` for the POST endpoint (Nadlan). A browser tab
can only issue GET, so offering one there would send a different request than
the one on screen and label it the same — the same class of quiet mismatch as
the earlier verdict double-count.

### Probe stamp gained an hour — and exposed two bugs

`נבדק:` now shows date and time (`20.07.2026 16:46`), from an ISO value with a
UTC offset in `apis.json`, exact string on hover.

An hour implies freshness a bare date did not, so it needed something to keep it
true: `probe.py --stamp` refreshes it, **but only on a clean run**. Stamping a
drifted probe would assert the map was confirmed at the moment it was
contradicted.

Re-probing to get a real timestamp rather than inventing one surfaced two things:

- **Bank of Israel is back up** and matches its recorded values again. It had
  gone connection-refused mid-session; the "unreachable, probably wait" reading
  was right.
- **GovMap WFS attribute filters are unindexed.** Measured: unfiltered 0.7s,
  `LOCALITY_N LIKE` 11.6s, `GUSH_NUM AND PARCEL` **39.7s** — past the prober's
  25s ceiling, so it reported a healthy endpoint as unreachable. Two runs minutes
  apart disagreed, which is what gave it away. `apis.json` now carries a per-API
  `timeout` and `probe.py` honours it.

That slowness also revealed a genuine UI bug: **the portal preview's `fetch` had
no timeout at all**, so a slow host left it spinning indefinitely. It now aborts
(75s for the slow source, 25s otherwise), says so distinctly from a CORS failure,
and warns before a filtered GovMap query that the wait is expected rather than
broken.

### Layout: portals moved above the matrix

`מבט־על` had grown to a 15-row table sitting between the verdict tiles and the
portal grid, so the portals — the thing you actually click — were below the fold.
The grid now follows the tiles directly and the matrix moved down under its own
`כל הממשקים` heading. `#drill` stays adjacent to the grid rather than following
the matrix: it renders in response to a portal click, and a section between the
card and its result would read as unrelated.

Safe to reorder because every bundler anchor and smoke selector is ID-based,
not positional — confirmed before touching it, not after.

### README reconciled with apis.json

The README still described the pre-expansion map: 9 portals / 13 APIs /
5 browser-callable, and "11 identified endpoints" for the prober. `apis.json` had
been at 10 / 15 / 7 since GovMap WFS and iplan Xplan landed in `a022d6a`;
SESSION.md recorded the change and the README never got it.

Corrected against a live re-probe rather than by copying numbers across — 13
probed, 0 drifted, so the counts describe confirmed behaviour. Two things needed
more than arithmetic:

- **GovMap now spans two verdict rows** (WFS cadastre `ok`, layers catalog
  `limited`). The "Notable specifics" bullet said only that GovMap returns
  `access denied`, which directly contradicted the table above it. Both entries
  are named now, with a note that the entry is the API, not the organisation.
- The EPSG:3857 trap, the unindexed-filter timings and the Xplan Origin echo were
  all in this log but never in the README, where a caller would look.

### Bus locations: a new entry, and a trap in it

Asked whether bus positions are open data. They are —
`/siri_vehicle_locations/list` on Stride, CORS `*`, browser-callable. Added as a
second `openbus` entry (16 APIs, 8 browser-callable), the same way `datagov`
carries three CKAN entries.

It is **not** a live feed, and calling it one would be the kind of claim this map
exists to prevent: measured ~12 minutes behind wall clock, minute-resolution
snapshots, 3,927,063 rows in 24h. A near-real-time archive of the MOT SIRI feed.

Three things probing caught, the first serious:

- **`order_by=recorded_at_time desc` alone returns garbage.** The top rows come
  back stamped `2038-01-14T17:22:21` — a Y2038-shaped sentinel — on records whose
  own snapshot id reads `2026/03/19`. So the obvious query for "latest bus
  positions" silently yields four-month-old rows wearing a future timestamp.
  Bounding with `recorded_at_time_to` fixes it. Same class as the EPSG:3857
  finding: a wrong answer, not a failure, which is the only kind worth writing
  down.
- `get_count=true` over an unbounded range 500s on a Postgres statement timeout
  and returns a full SQLAlchemy traceback with generated SQL and server paths.
- `/siri_snapshots/list` is broken outright — 500 on a pydantic validation error
  (`snapshot_id: none is not an allowed value`). Not usable as a freshness check.

The `example` is a **fixed** 10-minute window rather than a relative one, since
the prober needs a static URL; the archive retains months, so it stays 200. It
returns in 0.15s, so no per-API `timeout` was needed.

**A stored count had drifted.** Portal cards carry `api_count` / `browser_count`
in `apis.json` rather than deriving them, so adding the entry left `openbus`
reading `1/1` while showing two APIs. Audited all ten — only that one was wrong,
now `2/2`. Worth noting that `smoke.mjs` would not have caught this: it checks
tile == matrix == card, all three of which derive from `verdict()`, while the
portal badge is the one number nothing cross-checks.

Re-probed clean (14 probed, 2 skipped, 0 drifted) and stamped.

### data.gov.il: column sort, column filters, scrolling

Asked for sort and filter by column on the CKAN preview, plus scrolling. The
whole question was whether CKAN could do it *server-side* — a client-side sort
over the fetched page is precisely the dishonesty the `drill-scope` badge exists
to prevent. Probed before writing anything:

| Capability | Result |
|---|---|
| `sort=title_string asc\|desc` | works |
| `sort=organization asc\|desc` | works, verified it actually orders |
| `fq=organization:<slug>` | works — 61 orgs |
| `fq=res_format:CSV` | works — 626 of 1,197 |
| `facet.field=[...]` | returns options **in the same response** |
| sort by format / by file count | **not possible** — multivalued, and unindexed |

So two of the four columns get sort controls and two do not. The two dashes are
the design, not an omission: sorting those client-side would reorder 50 rows
while being visually identical to the controls that reorder all 1,197 — the same
mismatch as offering a GET tab for a POST endpoint, which this log already
argued once.

Facet options come from `search_facets` on the response already being made, so
the dropdowns cost zero extra requests. They are captured **once**, from the
unfiltered load: CKAN narrows facets to match the active `fq`, so refreshing them
after a pick would leave the chosen org as the only option and trap the user
there. Found by reasoning about the contract, then confirmed in the browser.

Page size 15 → 50 (measured 169 KB/0.18s → 445 KB/0.35s) with the table in a
`max-block-size` scroll box. The existing sticky `thead` meant the sort controls
stay reachable while scrolled, for free.

**A vacuous assertion, found while adding coverage.** `smoke.mjs` checked that no
file link carries a cross-origin `download` attribute — but it never opened
data.gov.il, the only portal with file links, so it ran against an empty `#drill`
and passed against nothing. It would have stayed green if the attribute came
back. The datagov drill-in is now opened first, which gives that check something
to look at and covers the new controls at the same time. All of it soft-skips if
data.gov.il does not answer, so the suite still never fails over someone else's
downtime.

Verified in Chromium beyond the committed suite: sort round-trips to the server
and flips direction, the active column is marked, the dropdown fills with 62
options, and **sort survives a filter change** — they compose into one request
rather than resetting each other.

### Paging the CKAN preview

Asked for page links over the large collections. CKAN takes `start` as a plain
offset; probed at 0 / 100 / 1150 / 1190 / 5000 before building on it, and it
behaves: a short final page (47 of 1,197) and an empty list past the end rather
than an error.

Rendered as first / last / current's neighbours rather than 24 buttons, and the
status line became a range (`51–100 מתוך 1,197`) instead of a bare count.

**The load-bearing part is the reset.** Search, column filter and sort all send
you back to page 1, because `start` is an offset into a result set those controls
redefine: filtering while on page 20 would request offset 950 of an 84-row result
and render an empty table that looks exactly like "nothing matches". Paging
itself preserves query, filters and sort, so the four compose rather than
clobbering each other — asserted in the browser both ways, including that a
filter applied from the last page lands on a populated page 1.

Only data.gov.il is paged (`paged: true`), for the same reason only it is sorted:
the other four previews either arrive whole or have no offset contract worth
claiming.

### A section of its own for data.gov.il

Asked for a dedicated section with "all the tools to look around". The useful
answer was not more catalogue browsing - the drill-in already does that - but
going into the **records**, which CKAN is the only API here to expose.

Three levels: `package_search` catalogue (faceted, sorted, paged) -> dataset
detail (licence, tags, dates, resources) -> `datastore_search` over one
resource's rows, with per-column filters, column sort and paging. Every control
probed before it was wired: `q`, per-field `q`, `filters`, `sort`, `offset`,
`fields` all work server-side.

Judgement calls worth keeping:

- **Per-field `q` rather than `filters` for column boxes.** `filters` is exact
  match; someone typing a partial value would get an empty table that reads as
  "no such record" instead of "not an exact match".
- **`≈` on estimated record counts.** `datastore_search` returns
  `total_was_estimated`; large tables get an estimate. Noticed because a test run
  printed 12,000 and then 12,500 for the same resource seconds apart. Printing
  that as exact would be a precision claim the API never made.
- **No statistics anywhere.** `datastore_search_sql` is still WAF-blocked, so any
  aggregate would be computed over the fetched page while looking like it covered
  the resource. The one feature not offered is the one that would have to lie.

**Two bugs, both of which shipped a "successful" build:**

The bundler flattens every source into one scope, and `ckan.js` declared
`state`, `renderList` and `pager` - each already defined by `map.js` or
`portal.js`. Unbundled the site was fine, because ES modules have their own
scopes; the bundle was silently dead, `#ckan` rendered empty, and `bundle.py`
reported success. This is the second time flattening has produced a working build
of a broken page (the first was `portal.js` missing from `SOURCES`), so
`verify_no_collisions()` now fails the build on any top-level name defined twice
and names the files. Verified by reintroducing the collision and watching it exit
non-zero.

The card grid then blew the page out sideways by 85px at 380px. A `1fr` track
floors at min-content, so one long unbroken string in a dataset title widened the
track past the viewport. Fixed with `minmax(min(17rem, 100%), 1fr)` plus
`min-inline-size: 0` and `overflow-wrap: anywhere` on the card. Only reproducible
by resizing *down* from a wide viewport, which is exactly what smoke.mjs does and
what a hand check at 380px did not.

### The explorer became its own page

Moved out of `index.html` into `datagov.html`, with `src/datagov.js` as a
three-line entry point. The reasoning: the map answers "what exists and can I
call it", the explorer answers "what is actually in there" - two questions, and
the second one deserves a URL that can be linked to rather than a section
someone has to scroll past. The map page dropped from 93 KB to 77 KB as a result.

`bundle.py` grew a `TARGETS` list instead of a single `SOURCES`, so both pages
get a self-contained offline copy. `verify_symbols()` and
`verify_no_collisions()` now run per target - which also means `ckan.js` and
`map.js` no longer share a scope, though the `ck`-prefixed names stay: relying
on the split would make the collision guard's job depend on how the pages
happen to be divided today.

Two things the split made worth asserting rather than assuming:

- **The map links to `./datagov.html` relatively**, which resolves to
  `/datagov.html` served and to `dist/datagov.html` from the offline bundle -
  correct in both, but only because both bundles land in `dist/` under matching
  names. `bundle.py` now fails the build if a page links to `./datagov.html`
  and no target emits that filename.
- **The explorer embeds no snapshot.** Only the map target inlines `apis.json`;
  every row on the explorer is fetched live, so a stale bundle cannot serve
  stale data there the way it could on the map. Asserted by checking the page
  contains no `__API_DATA__`.

`smoke.mjs` went from two passes to four - map and explorer, each over HTTP and
from disk. The explorer's `file://` pass is the one worth having: it makes live
CKAN calls from origin `null` and they answer, which is the whole premise of
shipping offline copies at all.

### The advertised download does not download

Reported: the CSV shown for a dataset cannot be downloaded. Probed the exact
resource from the report (שמות פרטיים בישראל, 1.4 MB CSV) and the complaint was
exactly right - the resource URL returns `200 text/html` with 42 KB of
obfuscated WAF challenge script instead of the file. `datastore/dump` behaves
identically. The failure mode is the nastiest kind: HTTP 200, so anything
automated saves a challenge page under a `.csv` name.

The earlier note hedged that "a real browser probably passes it". That was too
generous - it does not reliably, which is what the report demonstrates.

`datastore_search` is not challenged, being the same call that renders the
table, so for DataStore resources the CSV is now assembled in the browser and
handed over as a blob. Measured before committing to the approach: `limit=100000`
returns 100,000 records in 0.71s, so a full export is a handful of requests.

Details that matter:

- **`download` works here** because a `blob:` URL is same-origin - the exact
  opposite of the earlier finding that the attribute is ignored cross-origin.
  Same attribute, opposite outcome, for a reason worth remembering.
- **UTF-8 BOM**, or Excel renders Hebrew as mojibake.
- **`_id` dropped**, so the file matches the source rather than CKAN's internals.
- **The records view exports the query, not the page** - filters and sort are
  carried through, so what downloads is what the filter matched.
- **The origin link stays**, relabelled `⭳ מקור` and described honestly. For the
  ~45% of resources not in the DataStore it is still the only route.

Verified end to end in Chromium: 116,673 rows, 1.44 MB, header `שם פרטי`, no
`<html` anywhere in it, against an original file of 1,505,120 bytes. smoke.mjs
asserts the control exists and that the raw link no longer poses as a working
download; the multi-megabyte download itself stays a manual check rather than
something every verify run pulls from a government server.

### Set aside, not deleted

~~The original CKAN portal lives in the session scratchpad.~~ **Gone.** The
previous session's scratchpad no longer exists, and none of it was ever in git
history — `ckan.js`, the dataset detail page, the record explorer,
`build_index.py` and the catalog snapshot are unrecoverable. Recorded here so
nobody goes looking for them. Anything wanted from that work must be rebuilt.
