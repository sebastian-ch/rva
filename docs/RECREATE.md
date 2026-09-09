# Recreating iso-rva from a clean clone

This is a step-by-step guide to go from a fresh `git clone` to a running viewer, on macOS or Linux.
It assumes no prior familiarity with the repo. For the data schema, see `DATA_FORMAT.md`; for the
roadmap and what's already implemented, see `ROADMAP.md` and `docs/phase{1,2,3,4}-impl.md`.

## 1. What you get

A browser-based, orthographic-camera, low-poly isometric model of a ~2 sq mi slice of Richmond, VA
(Downtown, Shockoe Bottom, Capitol Square, and the James River down to Belle Isle/Manchester),
procedurally generated from open geodata and rendered with three.js. Ten landmark buildings carry
hand-refinable procedural glTF models; everything else is extruded from OSM/Overture/LiDAR-derived
footprints, heights and roof shapes. Per-tile output layers (see `DATA_FORMAT.md`):

- `buildings` — footprint, height, roof shape/azimuth, wall/roof colour, address, landmark link
- `roads`, `rail` — centerlines with width, lanes, bridge deck elevations
- `landuse`, `water` — parks, parking, cemeteries, rivers, canals, ponds
- `crossings`, `pois` — crosswalks; trees, benches, streetlights, shops, monuments, etc.
- `terrain.json` — a per-tile elevation grid
- `landmarks.json` — every registry landmark resolved to a map position

## 2. Prerequisites

- **Python 3.11 exactly.** The pip `bpy` wheel (Blender as a Python module) only ships for 3.11 on
  this stack, and the geo stack (`osmnx`/`geopandas`/`rasterio`/`pyproj`) was installed and tested
  against 3.11. A newer interpreter may work for the pure data pipeline but will not get you `bpy`.
- **Node 20+** for the web viewer (Vite 8, TypeScript 7).
- **Disk:** roughly 2 GB for raw data. Rough sizes on the default bbox: LiDAR EPT cache ~310 MB per
  bbox slice, DEM ~13 MB, processed tiles ~11 MB. Landmark glTFs are tiny (4–42 KB each).
- **Network access to:** Overpass (via `osmnx`, OSM data), `elevation.nationalmap.gov` (USGS 3DEP
  `exportImage`, DEM), the `usgs-lidar-public` S3 bucket (Entwine Point Tiles, no auth, LiDAR),
  Overture Maps' S3-backed release via the `overturemaps` CLI, the Wikidata / Wikipedia REST API at
  **viewer runtime** (info card summaries, not needed for the pipeline), and the City of Richmond
  ArcGIS Hub feature services (`services1.arcgis.com/k3vhq11XkBNeeOfM`).
- **Not needed:** PDAL (LiDAR is processed in pure Python with `laspy`), the Blender desktop app
  (headless `bpy` runs everything in `blender/`).

## 3. Setup

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/pip install "laspy[lazrs]" overturemaps certifi scipy
```

`pipeline/requirements.txt` covers `osmnx`, `geopandas`, `shapely`, `rasterio`, `pyproj`, `pyarrow`,
`requests`, `numpy`, `pytest`. The LiDAR fetcher additionally needs `laspy[lazrs]`, the Overture
fetcher needs the `overturemaps` CLI, and `certifi` backstops SSL on python.org builds (see below).
`scipy` is used by the roof-fitting code.

Optional, only if you plan to build/refine landmark models:

```bash
.venv/bin/pip install bpy
```

The `bpy` wheel is Blender packaged as a Python module, about 230 MB, and only builds/publishes for
Python 3.11 — this is the reason for the exact version pin above. Without it you still get the full
data pipeline and viewer; you just can't run `blender/build_landmark.py`.

Web viewer:

```bash
cd web
npm install
```

**SSL_CERT_FILE gotcha:** python.org's CPython build has no system CA bundle wired into `urllib`, so
plain `requests`/`urllib` calls (and the `overturemaps` CLI, which shells out) can fail TLS
verification. `pipeline/fetch_overture.py` and `pipeline/fetch_richmond.py` set `SSL_CERT_FILE` from
`certifi` automatically when it isn't already set. If you invoke the `overturemaps` CLI directly
(outside `fetch_overture.py`), export it yourself first:

```bash
export SSL_CERT_FILE=$(.venv/bin/python -m certifi)
```

## 4. Data pipeline

Run in order from the repo root, using the venv's Python. Each step is idempotent and caches by a
bbox slug (`bbox_slug()` in `pipeline/config.py`, e.g. `m77p4560_37p5170_m77p4180_37p5480`) — rerunning
without `--force`/`--clean` reuses what's on disk in `data/raw/`.

```bash
.venv/bin/python pipeline/fetch.py            # ~1 min
.venv/bin/python pipeline/fetch_overture.py   # ~5 s
.venv/bin/python pipeline/fetch_lidar.py      # ~1 min first run, seconds after (cached)
.venv/bin/python pipeline/fetch_richmond.py   # ~1 min
.venv/bin/python pipeline/build_tiles.py --clean   # ~10 s
```

All five accept `--bbox W S E N` (west south east north, decimal degrees, WGS84); default is
`DEFAULT_BBOX` in `pipeline/config.py` — currently `(-77.4560, 37.5170, -77.4180, 37.5480)`, the
Downtown/Shockoe Bottom/Capitol Square/James River slice. Pass the same `--bbox` to every fetcher and
to `build_tiles.py` when working a different area; each fetcher's output is keyed by that bbox's slug
so different areas don't collide in `data/raw/`.

What each step does:

- **`fetch.py`** — Overpass (via `osmnx`) for buildings, roads, rail, landuse, water, POIs, plus a
  USGS 3DEP DEM. Writes `data/raw/osm_<slug>/<layer>.parquet` (EPSG:4326) and
  `data/raw/dem_<slug>.tif` (EPSG:32618, float32, ~2 m). Flags: `--force`, `--skip-dem`.
- **`fetch_overture.py`** — Overture building footprints via the `overturemaps` CLI (GeoParquet from
  S3), a second height source. Writes `data/raw/overture_<slug>.parquet`. Flag: `--force`.
- **`fetch_lidar.py`** — walks the USGS 3DEP EPT octree (`USGS_LPC_VA_Sandy_2014_LAS_2015`) for
  nodes intersecting the bbox, downloads `.laz` into `data/raw/ept_<slug>/`, decodes with `laspy`,
  and rasterizes a 1 m normalized DSM. Writes `data/raw/lidar_<slug>.npz` (x, y, z, classification)
  and `data/raw/ndsm.tif`. Flags: `--max-depth` (default 13, density vs. download size), `--dry-run`,
  `--force`.
- **`fetch_richmond.py`** — pages the City of Richmond's ArcGIS Hub feature services (`Addresses`,
  `ZoningDistricts`) for the bbox. Writes `data/raw/richmond_<slug>/<layer>.parquet`. Flag: `--force`.
- **`build_tiles.py --clean`** — joins everything, resolves heights/roofs/addresses/zoning, cuts
  250 m tiles, resolves landmarks, and runs the QA report. `--clean` deletes existing tile
  directories first; `--no-merge` skips merging touching rowhouse footprints. Writes
  `data/tiles/index.json`, `data/tiles/<x>_<y>/<layer>.geojson` + `terrain.json`,
  `data/tiles/landmarks.json`, and `data/tiles/qa.md` / `qa.json`.

Expected console output to sanity-check against (numbers will vary if the bbox or upstream data
changes; the shapes below are what to look for from the last full run):

```
  height sources: {'lidar': 1372, 'overture_height': ..., 'osm_levels': ..., 'osm_height': ..., 'landmark_hint': ..., 'default': ...}
  roof sources: {...}
  landmarks matched: [...]
  landmarks resolved: 12/12; unmatched in slice: []
wrote 240 tiles, 10.5 MB, <N>s -> data/tiles
```

Check `data/tiles/qa.md` afterward for the height-source histogram, roof-shape histogram, and any
tall/tiny/width-null anomalies — see step 7.

**Vertical datum calibration:** the USGS EPT point cloud is WGS84 ellipsoidal heights, which sit
~33 m below the NAVD88-referenced DEM at Richmond's latitude. `fetch_lidar.py` calibrates a
scale/offset for the LiDAR cloud against the DEM (comparing ground-classified points) before building
the nDSM, so downstream nDSM values are meters above local bare earth, not ellipsoid height. If you
retarget to a very different location, re-verify this offset (see Troubleshooting).

## 5. Landmark models

Requires `bpy` (see Setup). Build all ten first-pass procedural landmark models:

```bash
.venv/bin/python blender/build_landmark.py -- --all
```

This reads each landmark's matched OSM footprint out of `data/tiles/*/buildings.geojson`
(`blender/footprint.py` / `landmark_lib.py`), builds stylised massing from primitives (extrusions,
boxes, domes, colonnades) with palette materials and baked `COLOR_0` vertex colours, and exports
Draco-compressed glTF to `assets/landmarks/<slug>.glb` via `blender/export_landmark.py`, which also
updates `model` in `assets/landmarks/landmarks.json`. The registry of buildable slugs is the
`BUILDERS` dict in `blender/build_landmark.py` (currently `virginia-state-capitol`,
`main-street-station`, `old-city-hall`, `the-jefferson-hotel`, `federal-reserve-bank-of-richmond`,
`james-monroe-building`, `dominion-energy-tower-600-canal-place`, `altria-theater`,
`carpenter-theatre-dominion-energy-center`, `vcu-cabell-library`).

Single landmark:

```bash
.venv/bin/python blender/build_landmark.py -- --slug virginia-state-capitol
```

**Hand refinement.** Procedural models are a floor, not a ceiling:

```bash
.venv/bin/python blender/build_landmark.py -- --slug <slug> --save blender/<slug>.blend --no-export
```

Open `blender/<slug>.blend` in the desktop Blender app, model over/replace the procedural geometry in
the `<slug>` collection (keep flat shading, palette-only materials, no photo textures — see
`blender/README.md`'s style checklist), then export:

```bash
blender --background blender/<slug>.blend --python blender/export_landmark.py -- --slug <slug>
```

This re-applies transforms, exports the `.glb` (origin at the footprint centroid on the ground, +Y up,
meters), and rewrites `landmarks.json[model]`.

## 6. Run the viewer

```bash
cd web
npm run dev
```

Open the printed local URL (Vite default `http://localhost:5173`). Toolbar / keyboard (from
`web/src/ui.ts`):

- `n` — toggle night mode (lit windows, sky change)
- `space` — pause/resume animation (water, time-of-day)
- `m` — toggle minimap
- `t` — start the landmark tour
- `h` — toggle Heights view (hypsometric elevation tint + legend)
- `Escape` — close the info panel

Click a building to open its info card (name, address, height, landmark description with a Wikipedia
summary/thumbnail where resolved); hover highlights the building under the cursor and shows a ground
elevation / building height readout.

For debugging, `window.__iso` is populated in `web/src/main.ts` with `{ scene, tiles, iso, props,
palette, night(), stats(), manager() }` — `__iso.stats()` reports resident tile/LOD counts, triangle
counts by layer, and worker build timings.

## 7. Verify

```bash
.venv/bin/python -m pytest
```

Pipeline test suite lives in `pipeline/tests/` (`test_fetch_lidar.py`, `test_heights.py`,
`test_landmarks.py`, `test_overture.py`, `test_process_helpers.py`, `test_qa_report.py`,
`test_richmond.py`, `test_roofs.py`).

```bash
cd web
npm test          # vitest run — buildings/roads/facade/roofs/streaming/workerPool/etc.
npm run typecheck # tsc --noEmit
npm run build     # tsc --noEmit && vite build
```

Also check:

- `data/tiles/qa.md` — height-source and roof-shape histograms, unmatched landmarks, buildings over
  150 m, footprints under 15 m², roads with no width, tiles with no terrain. Regenerated by
  `build_tiles.py`; treat a rising `default` height share or new unmatched landmarks as regressions.
- `node tools/snap.mjs <view> -o out.png` — a headless screenshot tool under `web/tools/` (another
  engineer is adding this; if present, run it from `web/`). Named views include `default`, `capitol`,
  `mayo-bridge`, `intersection`, `church-hill`. Useful for a quick before/after render check without
  opening a browser.

## 8. Extending

**Change the bbox / add a district.** Pass `--bbox W S E N` to all five pipeline commands in step 4
with the same bbox, or change `DEFAULT_BBOX` in `pipeline/config.py`. Each fetcher caches by bbox
slug, so switching bboxes doesn't clobber a previous area's raw data — but you must rerun every
fetcher (`fetch.py` through `fetch_richmond.py`) and then `build_tiles.py --clean` for the new area;
partial reuse across different bboxes isn't supported. ROADMAP Phase 6 sketches a `--slice` flag for
running multiple named districts into one shared tile grid; not implemented yet.

**Add a landmark.** Add an entry to `assets/landmarks/landmarks.json` (a JSON list) with at least
`slug`, `name`, `osm_name_hints` (list, used by `pipeline/landmarks.py` to resolve a footprint/POI),
`lat`, `lon`, `kind` (`"building"` etc.), `wikidata`, `website`, `description`, `district`,
`in_first_slice`, and `height_hint_m` (used as a height fallback in `process.py` when OSM/Overture/
LiDAR are missing). Rerun `build_tiles.py` so `pipeline/landmarks.py` resolves it into
`data/tiles/landmarks.json`. To give it a model, add a builder function to `blender/build_landmark.py`
(pattern: take `(b: Builder, fp)`, use `Frame(fp)` for footprint-relative placement, `b.extrude` /
`b.box` / `b.band` / etc.) and register it in the `BUILDERS` dict, then follow step 5.

**Tune constants.** `ROAD_Y` (road surface height above terrain, currently `0.28`; sidewalks and
markings are offset from it) and other layer heights live at the top of `web/src/roads.ts`. Facade
styles (window pitch, floor height, storefront vs. office vs. residential vs. industrial) are in
`web/src/facade.ts` (`STYLE_NONE/RESIDENTIAL/OFFICE/RETAIL/INDUSTRIAL`, keyed off building `type` and
height). Colours are all in `assets/palette.json` — every material in both the pipeline and the
viewer references a palette key, never a raw hex.

## 9. Troubleshooting

- **DEM fetch returns something that isn't a TIFF.** The USGS `exportImage` endpoint has been
  observed to fail silently on larger bboxes and return an error payload instead of imagery; just
  retry `fetch.py`. Not yet automated as a retry loop (see `docs/phase4-impl.md` findings).
- **Overpass timeouts / rate limits on `fetch.py`.** `osmnx` caches responses under
  `data/raw/osmnx_cache/`; rerun the same command and it resumes from cache. If Overpass is down,
  wait and retry — there's no fallback mirror configured.
- **LiDAR offset looks wrong.** Sanity-check `data/raw/ndsm.tif` (don't `cat`/Read it — use
  `python -c` with `rasterio` or `gdalinfo -stats`): median nDSM over flat ground (parking lots,
  streets) should be near 0 (± ~0.2 m), and the 99th percentile should be in the tens of meters, not
  hundreds or negative. If the median is way off (e.g. ~±33 m), the ellipsoid-to-NAVD88 calibration
  in `fetch_lidar.py` didn't apply — check that ground-class points were found for the calibration.
- **"tile failed" in the browser console.** Usually a malformed or missing per-tile GeoJSON — rerun
  `build_tiles.py --clean` and check `data/tiles/qa.md` for that tile. Also confirm the dev server is
  serving `data/tiles/` and `assets/` (`web/vite.config.ts`).
- **Missing `data/tiles/landmarks.json`.** Only written by `build_tiles.py` via
  `pipeline/landmarks.py`; if absent, the tour and non-building landmark labels have no target.
  Rerun `build_tiles.py`.
- **WebGL shadow map performance.** The directional shadow camera is refit to the visible tile
  footprint every frame (`docs/phase2-impl.md`, `web/src/main.ts`) at 4096² with PCF — the first
  thing to cut on lower-end GPUs. Headless/SwiftShader rendering is much slower with shadows on; this
  only affects screenshot tooling, not real GPUs.

## 10. Licensing

Automated extraction is limited to OpenStreetMap, Overture Maps, USGS 3DEP, USGS/USDA NAIP, VGIN, City
of Richmond open data, and Mapillary. Google Photorealistic 3D Tiles, Street View, and Mapbox Satellite
are visual reference only for hand-modeling landmarks — never traced into shipped geometry or used to
derive data. Full per-source license and attribution requirements are in `ATTRIBUTION.md`; update it
whenever a new data source is added.

## Verification against Google 3D / Street View (manual)

Google imagery is reference-only (no derived data), but it is the quickest way to sanity-check massing. For each
tour stop, open the same spot in Google Maps 3D at a similar bearing (the viewer looks from the south-west at 45°),
take `node tools/snap.mjs <slug> --zoom 4`, and compare: overall height, roof form, which side the entrance is on,
and whether neighbours exist at all. Record fixes in `assets/supplements/overrides.json` (heights, names, missing
new buildings) or in the landmark builders (`blender/build_landmark.py`) with a `note` citing what you saw.
