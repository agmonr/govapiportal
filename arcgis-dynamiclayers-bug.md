# "The strips problem": diagonal stripes dominating the Xplan map

This was reported three times against `src/blue-lines.js` before it was
actually solved. The first two fixes were real bugs and are worth knowing
about, but neither was the actual cause of the user's complaint — read to
the end (§3) before touching code, or you'll re-fix bugs #1/#2 and still see
the stripes.

## §1. Bug: ArcGIS `dynamicLayers` silently drops `layerDefs` filters and unlisted layers

**Symptom:** A map export from an ArcGIS REST `/export` endpoint gets covered
in diagonal hatching that swallows most of the visible area, even though a
`layerDefs` filter was already in place to exclude the offending features
(large catch-all/background land-use polygons, `mavat_code` 995/996 on
iplan's Xplan land-use layer, id 4 — codes meaning "designated per another
plan" / "development restrictions"; one such polygon traced to ~29km across,
a national master plan).

**Root cause:** Once a request includes the `dynamicLayers` parameter *at
all* (here: added to suppress a layer's text labels via
`drawingInfo.showLabels`), ArcGIS Server switches to fully trusting
`dynamicLayers` as the source of truth for **every** layer's rendering:

1. Any layer not explicitly listed in `dynamicLayers` stops rendering, even
   if `layers=show:1,4,0` still lists it.
2. The *separate* top-level `layerDefs` parameter stops being applied to any
   layer that IS listed in `dynamicLayers` — its `definitionExpression` is
   simply ignored, so the excluded features come back.

Neither is documented clearly by Esri — found by testing directly against
the live service (fetch the same bbox with/without each parameter and diff
the images).

**Fix:** Never split an override across `layerDefs` + `dynamicLayers`. Once
`dynamicLayers` is used at all, put **every** active layer in it explicitly,
with each layer's own filter/style directly on its own entry:

```js
const dynamicLayers = layerIds.map((id) => {
  const layer = { id, source: { type: 'mapLayer', mapLayerId: id } };
  if (id === 4) layer.definitionExpression = 'mavat_code NOT IN (995,996)'; // was: top-level layerDefs
  if (id === 1) layer.drawingInfo = { showLabels: false };
  return layer;
});
// send dynamicLayers only — drop layerDefs entirely once dynamicLayers is used
```

This fixed two reported addresses. A third address still showed stripes.

## §2. Not a bug: reduced-opacity compositing (tried, later reverted)

Investigated the remaining stripes and found they were real, meaningful
data — e.g. Rothschild Blvd, Tel Aviv sits inside a genuine ~several-km²
heritage conservation zone (`mavat_code` 803). Not something to exclude.

First attempt: fetch land use (layer 4) as its own image, composite it under
the plan-boundary layer at `ctx.globalAlpha = 0.45` so it read as a
background tint instead of foreground noise. This looked reasonable but was
guessed, not verified against any reference — and turned out to be solving
the wrong problem (§3).

## §3. The actual fix: land use is opt-in on the real site — verified from its own network traffic, not guessed

The user pointed at `https://ags.iplan.gov.il/xplan/` (the real government
site this app mirrors) as the reference for "how it should look," and asked
to check that site's own code/behaviour rather than keep guessing.

**Method:** opened the real site in a browser, geocoded/panned to the same
area, and read its actual network requests (`mcp__claude-in-chrome__read_network_requests`,
filtered on `/export?`). Two things confirmed this directly, not by
inference:

1. The service's own schema (`.../MapServer?f=json`) lists
   `"defaultVisibility": false` for the land-use layer (and point-entities,
   and line/polygon-entities layers) — only the plan-boundary layer (id 1)
   has `"defaultVisibility": true`.
2. Watching live traffic across an extended session (663 `/export` requests
   captured), **not one** ever requested the land-use layer with real
   content. Every request for it in the panel-checked state still showed
   `layers=show:1` only — land use is never fetched until a session
   explicitly enables it, and even then only past a certain zoom threshold.

So the real site doesn't dim land use at reduced opacity — it just doesn't
show it by default. The opacity trick in §2 was a workaround for a problem
the reference implementation sidesteps entirely.

**Fix:** made land use its own checkbox, off by default (alongside the
existing labels/points/metro-zone toggles), full opacity when explicitly
checked. Default view became plan boundaries + point markers only — matching
production. This is what actually resolved the complaint.

## Lesson

When "make it look like the reference" is the ask and you're several fix
attempts in without it landing, stop guessing at rendering parameters
(opacity, blend modes, filters) and go verify the reference implementation's
*actual* behaviour directly — its own service schema and its own live
network traffic are both directly inspectable and settle the question
outright, rather than one more plausible-sounding visual tweak.
