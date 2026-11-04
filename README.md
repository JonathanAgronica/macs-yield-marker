# Mac's Yield Marker (Agronica)

Mobile web app (PWA) for estimating macadamia yield block by block, part of the **AgronicaWorld** toolbox by
Agronica Pty Ltd (Bundaberg / Alloway QLD).

**Live:** https://jonathanagronica.github.io/macs-yield-marker/

Built for **driving down the rows**: huge one-tap rating buttons with beep / vibration / colour-flash confirmation,
a GPS tree counter that prompts for a 1-5 estimate every 10 trees, and a heat map of each block. Data is exported as
KML / CSV, and uploads to AgronicaWorld for block heat mapping (queued offline, with matched/unmatched feedback).

## Features

- **Session start/stop** with GPS (`watchPosition`, track point every 2 s), block name, variety
  (A4, A16, A38, 741, 344, 246, 816, 842, 660, A203, MCT1, P, G, J, R, 47, Other), screen wake lock.
- **Primary screen = yield estimate.** Five full-width buttons: VERY HIGH / HIGH / MEDIUM / LOW / NIL (ratings 5..1),
  ~366 x 65 px each on a 390 x 844 phone. One tap saves a mark at the current GPS point with row, tree, heading.
- **Rows:** big - / + row control; *Auto row* (Menu) adds 1 when GPS sees a U-turn at the row end. Changing row resets the tree count.
- **Tree counting + 10-tree prompts:** trees = distance travelled along the row / tree spacing (default 4 m, set per
  block in Menu). Every N trees (default 10, Menu, 0 = off) the phone beeps + vibrates and shows five huge 1-5 buttons.
  One tap saves a mark with `treeFrom`, `treeTo`, `row`, `estimate`. **SKIP** (or ignore it: it closes after 25 s). GPS never stops.
  **TREE +1** is the manual override.
- **Skipped / missed segments** are saved with `interpolated: true`; their value is the inverse-distance-weighted
  average of real marks within ~80 m and is recomputed as new marks arrive, so the heat map has no gaps. Shown faded/dashed.
- **Count / bin weight** (secondary screen, built to grow): nut count or bin/bag weight in kg on a big one-hand keypad, saved at the GPS point.
- **Photo Count** (Photo tab): take/choose a photo (tagged with GPS, row, tree); on-device canvas pipeline counts nuts.
  Filters: *Green husk* (HSV + ExG thresholds: yellow-green, lighter, less blue than leaves), *Brown nut* (mature/fallen),
  *Edge / circle* (bright-blob top-hat detector). Optional CLAHE-style contrast enhancement. Sliders: threshold, min/max
  nut size, roundness. Touching nuts are separated with a distance transform + non-maximum suppression.
  Tap a circle to remove it, tap a nut to add one. Yield **estimate**: nuts in photo / (% of canopy in photo) = nuts per
  tree; x trees/ha (10 000 / (row spacing x tree spacing)) x nut-in-shell weight (default 7.5 g - calibrate by weighing
  100 nuts from the block) = kg/ha and t/ha. Saved as a mark with `photoCount`, `estNutsPerTree`, `estKgHa`, rating from
  t/ha (<0.5 = 1, 0.5-2 = 2, 2-3.5 = 3, 3.5-5 = 4, >=5 = 5). **AI count** button is a placeholder for a server-side model
  (`AI_COUNT_URL` in `config.js`, disabled while blank; no API keys in this static app).
- **Undo** last mark; **edit / delete** any mark (Summary list, or tap a dot on the map -> Edit).
- **Yield map:** Esri World Imagery satellite tiles (vendored Leaflet), smooth IDW heat layer on a canvas + dots.
  Views: *Rating* (red low -> amber -> green high), *Weight kg*, *Estimate*, *Count* (colour ramp with min/max legend).
  Follow me, Fit, and *Save area offline*; viewed tiles are cached by the service worker.
- **Export** KML (per-placemark aabbggrr colours + full ExtendedData round-trip + GPS track) and CSV; Web Share API
  where available, otherwise a download. **Import / merge** KML or CSV from another person with de-duplication (by id,
  or same time/place/value).
- **Summary:** counts per rating, average rating, estimates (+ interpolated), counts, total and average weight; per session or all.
- About Agronica page, **Macca the Yield Marker Helper** (offline FAQ), discreet cycling ad strip (`ads.json`, no pop-ups).
- Offline PWA: versioned cache, network-first app shell, auto-reload on update (deferred while GPS is running).

## CSV columns

`time, lat, lon, accuracy_m, block, variety, row, tree, tree_from, tree_to, rating, rating_1to5, estimate, count,
weight_kg, heading, interpolated, photo_count, est_nuts_per_tree, est_kg_ha, session, id`

## AgronicaWorld upload payload

`upload.js` keeps a localStorage queue (survives offline/reloads), retries with exponential backoff (30 s doubling to
30 min, honouring `Retry-After`), and uses a random UUID `deviceId`. Upload is switched on by setting `INGEST_URL` and
`INGEST_KEY` in `config.js` (live: `https://170-64-148-102.sslip.io/api/yield/submit`).

`POST {INGEST_URL}` with header `X-Ingest-Key: <key>`, `Content-Type: application/json`. The body is **flat** - one
session per request, no nested `session` object:

```json
{
  "deviceId": "6f1c...-uuid", "appVersion": "v2", "sessionId": "s-lzx3k2", "submittedAt": "2026-11-04T00:30:00.000Z",
  "farm": "optional", "block": "optional", "variety": "optional", "contact": { "name": "optional", "email": "optional" },
  "marks": [
    { "id": "y...", "t": "2026-11-04T00:12:03.000Z", "lat": -24.98, "lon": 152.38, "acc": 3.2, "row": "12",
      "rating": 4, "binWeightKg": 412.5, "heading": 91,
      "treeFrom": 11, "treeTo": 20, "estimate": 4, "interpolated": true,
      "photoCount": 37, "estNutsPerTree": 370, "estKgHa": 868 }
  ],
  "track": [ { "lat": -24.98, "lon": 152.38, "t": "2026-11-04T00:12:00.000Z" } ]
}
```

- `sessionId` is sanitised to `[A-Za-z0-9._:-]`, max 64 chars (`s lzx3k2` -> `s-lzx3k2`). `appVersion` max 32.
- `t` is ISO 8601 UTC. `rating` is an integer 1-5 (1 Nil, 2 Low, 3 Medium, 4 High, 5 Very high). A 10-tree estimate is
  itself 1-5, so `rating = estimate`; interpolated values are rounded to the nearest rating and `estimate` keeps the decimal.
- Required: `id, t, lat, lon, rating`. Optional: `acc, row (string), binWeightKg, heading, treeFrom, treeTo, estimate,
  interpolated, photoCount, estNutsPerTree, estKgHa`, plus the session `track` (lat/lon/t, max 20 000 points; sent once
  per new stretch of GPS track and downsample-capped).
- The app's internal `tree` and `count` fields are **not** sent (the server does not list them); they stay on the phone
  and in the KML / CSV export.
- Marks are re-sent with the same `id` when edited or when an interpolated value is filled in, so the server **upserts
  by `id`**. A no-op resend answers `received: 0`, which counts as success.
- Marks with no rating (count/weight only, or interpolated with no neighbours yet) stay in the app and in CSV/KML but are
  not sent as rating marks; they upload separately as bin weights (`/api/yield/bins`) and are re-queued if you later give
  them a rating. If you want a rating for a count-only mark, edit it and pick one.
- Batches respect the server caps: **5000 marks and 1 MB per request** (`upload.js` splits larger queues, keeping the
  JSON body under ~950 kB). Up to 20 bins per flush (server: 300 bins/hour per device).
- Response: `{ ok, received, matched: {"<block>": count}, unmatched: k }`. The Summary tab and the Menu sheet show the
  last response: received count, matched block counts and how many marks fell outside a block (`unmatched`).
- Errors: 400 names the offending field (shown in the status line, queue kept), 401 = wrong `X-Ingest-Key`, 429 and 5xx
  back off (honouring `Retry-After`) without dropping anything. Rate limits: 120 requests / 10 min per IP, 60 submits /
  hour per device.

Bin weights go to `POST /api/yield/bins` (derived from `INGEST_URL`, or `BINS_URL`):
`{ deviceId, sessionId?, block?, binId?, weightKg, t, lat?, lon? }` (lat and lon together). The app has no bin UI yet;
the queue code is in place for when it does.

CORS on the ingest allows only `Origin: https://jonathanagronica.github.io`, so a real fetch test has to run from the
live site (`tests/e2e-live.test.js`), not localhost.

## Files

`index.html`, `style.css` (shared Agronica style) + `yield.css`, `yield.js` (ratings, colours, KML/CSV, merge, interpolation, summary),
`ymap.js` (Leaflet map + IDW heat layer), `app.js` (session, GPS, rows/trees, prompts, pad, export/import), `photocount.js`
(nut detector + yield maths), `photo.js` (Photo tab), `upload.js`, `config.js`, `extras.js` (About, Macca, ads), `sw.js`, `manifest.json`, `ads.json`.

`tools/build-icons.py` rebuilds `icons/` from the CC0 photo (`tools/macadamia-nut-912598.jpg`) and the Agronica mark
(`tools/mark.png`), the same treatment as the mistletoe app's icon; `tools/icon-preview.png` shows the result.

## Tests

```
python3 -m http.server 8231 &
NODE_PATH=/path/to/node_modules(puppeteer-core, @xmldom/xmldom) node tests/logic.test.js
NODE_PATH=... node tests/ui.test.js [baseUrl] [screenshotDir]
NODE_PATH=... node tests/upload.test.js [baseUrl]      # stub AgronicaWorld endpoint: flat schema, 1 MB/5000 caps, 400/401/429/503, bins, matched/unmatched
NODE_PATH=... node tests/e2e-live.test.js [liveUrl] [--reuse]
                                                       # LIVE end-to-end: ONE test mark through the real queue against the real
                                                       # ingest (saved in tests/.e2e-last.json; --reuse resends it, received:0)
NODE_PATH=... node tests/shots-map.js [baseUrl] [outDir]  # map screenshots over real Esri imagery (needs internet)
NODE_PATH=... node tests/offline.test.js [baseUrl]     # service worker serves the shell with the network off
```

`tests/ui.test.js` drives a 390 x 844 headless Chrome with simulated GPS along a row: layout overlap check, ratings,
10-tree prompts (tap / skip / interpolation), Tree +1, rows, keypad, undo/edit/delete, map colours + heat layer,
KML/CSV export and re-import de-dup, upload-off status, About/Macca, ads, Photo Count on CC photos (`tests/photos/CREDITS.md`).
`tests/ui.test.js` and `tests/upload.test.js` stub `config.js` so a test run never posts to the live ingest.
Satellite tiles are stubbed locally (`tests/tile-stub.js`).

## Photo Count accuracy (test photos)

Filters tested on four CC photos of nuts on the tree (`tests/photos/`, credits there), all resized to 720 px:

| photo | scene | Green husk (default) | Edge / circle | tuned (12-30 px, roundness 70) |
|---|---|---|---|---|
| p1 | one sparse cluster, bright bokeh background | 34 | 35 | 16 (about 8-10 nuts visible: **over-counts**) |
| p2 | hanging racemes against dark foliage | 182 | 82 | 67 (dense: many missed / merged) |
| p3 | dense canopy, nuts among bright leaves | 211 | 102 | 108 (**over-counts** on leaf highlights) |
| p4 | close-up of one big cluster | 17 | 98 | 26 (about 15-20 nuts: **close**) |

So: the colour filter is reliable on a close-up cluster filling the frame (p4: within roughly ±30 % after a couple of
slider tweaks) and over-counts on busy backgrounds and dense canopy shots, where bokeh and shiny leaves look like nuts.
The tap-to-remove / tap-to-add correction is therefore essential, and each block should be calibrated with a few known
clusters. A server-side AI model (the placeholder **AI count** button) is the planned fix for the hard scenes. Because
every photo estimate is scaled up by the canopy % and NIS weight, treat the saved kg/ha as **indicative only**.

## Credits

- **App icon photo:** "Macadamia-nut-912598.jpg" (macadamia nuts on drying racks) by **Joseph Hill**, Wikimedia Commons,
  **CC0 1.0** - https://commons.wikimedia.org/wiki/File:Macadamia-nut-912598.jpg - cropped, recoloured and overlaid with the Agronica mark.
- Satellite imagery © Esri and partners. Leaflet (BSD-2). Test photos: see `tests/photos/CREDITS.md`.

© Agronica Pty Ltd · 4468 Goodwood Road, Alloway QLD 4670 · (+61) 475 570 872 · jonathan@agronicaag.com
