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

Must be served over HTTP — `fetch` and ES modules are blocked on `file://`.

## Files

| Path | Purpose |
|---|---|
| `apis.json` | The map — `portals` (9) and `apis` (13). Edit this to add sources. |
| `index.html` / `src/map.js` | Portal grid + API list, filterable |
| `src/explorer.js` | Live in-browser request panel |
| `src/style.css` | RTL-first styling |
| `SESSION.md` | Build log: decisions, corrections, what's unverified |

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

| Verdict | Meaning | Examples |
|---|---|---|
| דפדפן ✓ (browser) | 200 + CORS. Usable from a static page. | data.gov.il CKAN, CBS indices, Open Bus Stride |
| שרת בלבד (server only) | 200 but no CORS. Needs a proxy or build-time fetch. | Knesset OData, Bank of Israel SDMX |
| חסום (blocked) | Actively refused. | `datastore_search_sql` — 403 from the WAF |
| לא אותר (not identified) | Probes 404'd. Endpoint unknown, not proven absent. | gov.il content API, Israel Post |

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

## Adding a source

Add an object to `apis.json`. Probe it first — `status`, `cors`, `format` and
`browser` are claims about live behaviour, and a wrong one is worse than an
absent entry. Set `browser: true` only if you have seen an
`access-control-allow-origin` header come back.

```bash
curl -s -i -H "Origin: https://example.github.io" "<endpoint>" | head -20
```
