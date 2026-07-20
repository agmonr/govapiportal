# מפת ממשקי API ממשלתיים — Israeli Government API Map

A reference map of Israeli government APIs: endpoint, auth, CORS, format and
current status for each. Static site, no build step, hosted on GitHub Pages.

**Every field was probed directly against the live server on 2026-07-20** — none
of it is recalled or assumed. Where a probe failed, the entry says `unknown`
rather than guessing.

## Run locally

```bash
python3 -m http.server 8000
```

`index.html` must be served over HTTP. Opened straight from disk it renders
blank: the browser refuses ES module scripts and `fetch` from origin `null`.
It now says so instead of failing silently — but see below for the copy that
needs no server at all.

## Use it offline

**`dist/map.html` is the whole map in one file.** Download it, double-click it,
done — no server, no clone, no network needed to open it. Email it to someone.

It is not a degraded preview: **the live explorer still works**. `file://` pages
have origin `null`, and `Access-Control-Allow-Origin: *` accepts `null`, so the
browser-callable APIs answer a local file exactly as they answer the hosted site
(probed: data.gov.il, CBS and Open Bus all return 200 from `file://`; Knesset
still fails on CORS, as it should).

Regenerate it after editing `apis.json` or `src/`:

```bash
./tools/bundle.py           # rewrite dist/map.html
./tools/bundle.py --check   # exit non-zero if it is stale
```

`tools/verify.sh` runs `--check` first, so a stale copy fails the build rather
than shipping to whoever downloads it.

## Files

| Path | Purpose |
|---|---|
| `apis.json` | The map — `portals` (9) and `apis` (13). Edit this to add sources. |
| `index.html` / `src/map.js` | Top view + portal grid + API list, filterable |
| `src/portal.js` | Portal drill-in: live request per portal, rendered as a table |
| `src/explorer.js` | Live in-browser request panel |
| `src/style.css` | RTL-first styling |
| `SESSION.md` | Build log: decisions, corrections, what's unverified |
| `dist/map.html` | Generated single-file build. Works offline, opened from disk. |
| `tools/` | Bundler, API re-prober, browser verification. Not part of the site. |

## Top view

`מבט־על` sits above everything: a count of all 13 APIs, then one tile per
verdict, over a single table holding every API grouped by portal
(domain / format / auth / HTTP / CORS / verdict).

- **Tiles filter** the detail list below.
- **Rows jump** — clicking one clears active filters and scrolls to that API's card.

Tile counts come from the same `verdict()` the cards use, and `tools/smoke.mjs`
asserts tile == matrix row == card for every state, so the summary cannot drift
from what it summarises.

## Verifying it

The site needs no build and no dependencies. Verification does — a real browser,
because "it parses" and "it runs" are different claims:

```bash
./tools/setup.sh     # Node + Chromium, into $HOME, no root needed
./tools/verify.sh    # bundle freshness, then two browser passes
```

`verify.sh` drives the map twice: served over HTTP, and opened from disk as
`file://dist/map.html`. Both passes assert the same invariants, and any console
error fails the run. The bundle pass additionally asserts it references no
external asset — the claim "self-contained" is checked, not stated.

`setup.sh --check` reports what is installed without installing anything.

## Diving into a portal

Clicking a portal card fires that portal's own API and renders the result as a
readable table — not raw JSON:

| Portal | Request | Shows |
|---|---|---|
| data.gov.il | `package_search` | datasets, publisher, formats, resource count (1,197 total) |
| CBS | `index/catalog` | 14 price-index chapters |
| Open Bus | `gtfs_stops/list` | stops with city and coordinates |
| GovMap | WFS `PARCEL_ALL` | גוש/חלקה, locality, area, status (1,097,502 total) |
| iplan | Xplan layer 1 | plan number, name, area in dunam, jurisdiction |

Each returns a completely different shape, so each has its own small renderer in
`src/portal.js`. A generic "any JSON as a table" would work and would be
unreadable for most of them.

**Every preview has a filter, and says where it runs.** Four of the five filter
**server-side**, so you search the whole collection rather than the 15 rows on
screen — searching GovMap for `רעננה` queries all 1,097,502 parcels, not the
handful displayed. CBS is 14 chapters, arrives whole, and filters locally from
cache without re-hitting the server. The badge next to the box
(`סינון בשרת` / `סינון מקומי`) says which, because the difference decides whether
an empty result means "nothing matches" or "nothing matches on this page".

The five portals with no browser-callable API get an explanation instead of a
broken panel — that distinction is the point of the map, so the drill-in
respects it. The exact request URL is shown under each table so the result can
be reproduced with `curl`.

## Browsing APIs from the page

Each API with a known endpoint has a **נסה בדפדפן** panel: edit the URL, send it,
and see status, timing, content-type and a formatted JSON response — no server
involved.

For the server-only APIs the request genuinely fails, and that is the point. A
cross-origin block reaches JavaScript as an opaque `TypeError` with no status
code, so the panel names CORS as the cause rather than reporting a vague network
error. Try Knesset OData to see it.

## The finding that drives the whole thing

**CORS is the deciding field.** Several of these APIs are live and unauthenticated
but send no `Access-Control-Allow-Origin` header, so a static page cannot call
them at all. Of 13 entries, **5 are browser-callable**:

| Verdict | n | Meaning | Examples |
|---|---|---|---|
| דפדפן ✓ (browser) | 5 | 200 + CORS. Usable from a static page. | data.gov.il CKAN, CBS indices, Open Bus Stride |
| שרת בלבד (server only) | 3 | 200 but no CORS. Needs a proxy or build-time fetch. | Knesset OData ×2, Bank of Israel SDMX |
| מוגבל (limited) | 2 | Reachable, but the contract is unresolved. | GovMap (undocumented auth), Nadlan (SPA shell) |
| חסום (blocked) | 1 | Actively refused. | `datastore_search_sql` — 403 from the WAF |
| לא אותר (not identified) | 2 | Probes 404'd. Endpoint unknown, not proven absent. | gov.il content API, Israel Post |

`מוגבל` is deliberately separate from `שרת בלבד`. Both fail from a static page,
but for different reasons, and a reader deciding whether to build a proxy needs
to know which — a proxy fixes the CORS three and does nothing for the other two.

If you need Knesset or BOI data on a static page, the pattern is a scheduled
GitHub Action that fetches server-side and commits JSON — same shape as any
build-time snapshot.

## Notable specifics

- **data.gov.il** `datastore_search_sql` is WAF-blocked (403, HTML error page,
  even with no params). No server-side aggregation exists — aggregate client-side
  or at build time. `datastore_search` does support `filters`, `q`, `sort`,
  `limit`/`offset`.
- **Open Bus Stride** is NGO-run (Hasadna), not government, and is the
  best-documented API here — full OpenAPI spec at `/openapi.json`.
- **GovMap** returns CORS `*` but `{"error":"access denied"}` without
  credentials; the auth flow is undocumented and unverified.
- **Nadlan** returns the SPA HTML shell for a plain POST — the real contract
  needs headers I could not determine.

## Keeping the map honest

Every field here is a claim about live server behaviour on a particular day, and
those claims rot — a WAF rule lifts, a CORS header appears, an endpoint moves.

`.github/workflows/probe.yml` re-probes all 11 identified endpoints every Monday
and **opens an issue when reality and `apis.json` disagree**. Run it yourself:

```bash
./tools/probe.py            # probe and print a table
./tools/probe.py --check    # exit 1 if anything drifted
```

It deliberately does **not** rewrite `apis.json`. A probe from a GitHub runner is
not the same observation as one from your machine — datacentre IPs get
WAF-blocked and geo-filtered differently — so one bad run could overwrite curated
verdicts with an artefact of where the probe ran. It reports; a human confirms.

It probes each entry's `example` rather than the bare `endpoint`, because several
of these need parameters: `datastore_search` answers 409 without a `resource_id`,
CBS `index/data/price` answers 500 without an `id`.

## Adding a source

Add an object to `apis.json`. Probe it first — `status`, `cors`, `format` and
`browser` are claims about live behaviour, and a wrong one is worse than an
absent entry. Set `browser: true` only if you have seen an
`access-control-allow-origin` header come back.

```bash
curl -s -i -H "Origin: https://example.github.io" "<endpoint>" | head -20
```
