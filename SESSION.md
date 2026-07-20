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

- **Zero-build**: plain ES modules, no bundler, no npm. No Node in the
  environment, and GitHub Pages serves the directory as-is.
- **Three-state verdicts** (usable / server-only / not-identified) rather than a
  boolean. Collapsing "actively blocked" into "couldn't find it" would misstate
  what is known.
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

**No JavaScript in this repo has ever been executed.** There is no Node and no
browser in the environment. `apis.json` parses and file references resolve, but
`map.js` and `explorer.js` are unrun. Check the console on first load.

### Set aside, not deleted

The original CKAN portal — `ckan.js` (with WAF-aware retry), dataset detail page,
record explorer, `build_index.py`, and the 1 MB catalog snapshot — lives in the
session scratchpad, outside the repo. It is not in git history.
