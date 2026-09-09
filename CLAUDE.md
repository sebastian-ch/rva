# iso-rva

Stylized isometric 3D model of Richmond, VA. Procedurally generated from open geodata, hand-modeled landmarks, rendered in the browser. See `PLAN.md` for the full implementation plan and data inventory.

## Reusable map-building knowledge

Read [docs/map-building-playbook.md](docs/map-building-playbook.md) when adding a region or changing
map geometry/data/rendering. Record new failure modes and fixes there with code/test references.
Richmond source details live in [docs/richmond-trees-riverfront.md](docs/richmond-trees-riverfront.md);
styles use [docs/map-styles.md](docs/map-styles.md).

## Tech stack

- Data pipeline: Python 3.10+ — `osmnx`, `geopandas`, `shapely`, `rasterio`, `pyproj`, `osmium`
- Authoring: Blender (Blosm / BlenderGIS import), glTF export with Draco or meshopt
- Runtime: TypeScript + three.js, `OrthographicCamera`, Vite
- CRS: `regions.json` selects EPSG:32618 (Richmond, UTM 18N) or EPSG:32604 (Honolulu, UTM 4N). Never do geometry math in EPSG:4326.

## Layout

```
data/raw/        downloaded sources (gitignored)
data/tiles/      processed per-tile GeoParquet / GeoJSON
pipeline/        Python processing scripts
blender/         .blend files and generation scripts
assets/          exported glTF, textures, palette
web/             three.js app
```

## Conventions

- Height resolution order: OSM `height` → `building:levels` × 3.2 m → LiDAR nDSM median (eave for pitched roofs) when ≥ 10 nDSM cells → Overture `height` → Overture `num_floors` × 3.2 m → LiDAR (sparse) → City zoning default → type default. Footprints whose LiDAR surface is at ground (p90 < 1.2 m, ≥ 8 cells) with no OSM height are dropped as stale. LiDAR heights on footprints < 80 m² are capped at 4·√area unless the type is church/tower-like.
- Hand corrections live in `assets/supplements/overrides.json` (applied last; see its README). Use it for buildings newer than the sources.
- `building:part` polygons are separate buildings (`is_part`, `parent`, `hidden` on the outline); see DATA_FORMAT.md.
- Roof resolution order: OSM `roof:shape` → Overture `roof_shape` → LiDAR two-plane fit (`pipeline/roofs.py`) → type heuristic.
- Tiles are ~250 m squares, named by tile index (`x_y`).
- The base scene palette lives in `assets/palette.json`; artistic style palettes and settings live in `web/src/styles/`. Add styles through its registry.
- Automated sources include OSM, Overture, VGIN, USGS/NAIP, NOAA, city open GIS data, and Mapillary; preserve their terms and attribution. Google and Mapbox imagery are visual reference only — their terms forbid derived datasets.
- Keep `ATTRIBUTION.md` current whenever a new data source is added.

## Commands

```
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py [--bbox W S E N] [--force] [--skip-dem]   # OSM via Overpass + USGS 3DEP DEM -> data/raw/
.venv/bin/python pipeline/fetch_overture.py                                 # Overture buildings (2nd height source) -> data/raw/
.venv/bin/python pipeline/fetch_richmond.py                                 # City of Richmond addresses + zoning -> data/raw/
.venv/bin/python pipeline/fetch_vgin_footprints.py --shp <path.shp>         # VGIN building footprints (gap-fill) -> data/raw/
.venv/bin/python pipeline/dem_noaa.py [--zip data/raw/J1448888.zip]              # NOAA 2025 1 ft DEM tiles -> dem_<slug>.tif (1 m); run before fetch_lidar/build_tiles
.venv/bin/python pipeline/fetch_lidar.py [--source noaa2025|usgs2014] [--dry-run]  # LiDAR EPT (2025 City of Richmond by default) -> ndsm.tif + point npz
.venv/bin/python pipeline/build_tiles.py [--clean] [--no-merge]              # -> data/tiles/<x>_<y>/*.geojson + index.json + qa.md
.venv/bin/python -m pytest                                                  # pipeline unit tests
cd web && npm install && npm run dev                                        # viewer at http://localhost:5173 (serves ../data/tiles at /tiles)
cd web && npm test && npm run typecheck                                     # vitest + tsc
cd web && npm run deploy -- --remote https://github.com/sebastian-ch/rva.git  # build with base /rva/ + force-push dist to gh-pages (tools/deploy.mjs)
.venv/bin/python blender/import_tile.py -- --tile 13_8 --save x.blend         # tile into Blender (pip `bpy` module, headless)
.venv/bin/python blender/build_landmark.py -- --all                         # procedural landmark models -> assets/landmarks/*.glb
```

Default bbox is the first slice (Downtown + Shockoe Bottom + Capitol Square); see `pipeline/config.py`.
Tile schema contract: `DATA_FORMAT.md`. Landmark registry: `assets/landmarks/landmarks.json` (set `model` after export).

## Layout notes

- `pipeline/heights.py` is pure functions (height/roof/color); `process.py` normalizes layers; `build_tiles.py` clips and writes.
- LiDAR is optional: `fetch_lidar.py` writes `data/raw/ndsm.tif` and `lidar_<slug>.npz`; `lidar.py` + `roofs.py` consume them.
  Default source is the 2025 City of Richmond cloud (NOAA Digital Coast EPT, flown Feb 2025, depth 8 ≈ 10 pts/m²); `--source usgs2014` is the old 3DEP cloud.
- Terrain: `dem_noaa.py` builds `data/raw/dem_<slug>.tif` (1 m, EPSG:32618) from the NOAA Digital Coast 2025 1 ft DEM zip (`data/raw/J1448888.zip`, VA State Plane South ft); the 3DEP export from `fetch.py` is the fallback and is kept as `dem_<slug>.3dep.tif`. The 0.3 m DSM zip (`va2025_richmond_J1448889.zip`) is only for ad-hoc checks via `/vsizip/` + rasterio (mosaic the tiles, they split at lon -77.447).
- `web/src/`: `tileManager.ts` streams tiles from the camera footprint (`streaming.ts`) through a worker pool (`workerPool.ts` → `tileWorker.ts` → `tileBuild.ts`); `buildings.ts` extrudes (+ `facade.ts` shader, `roofDetails.ts`), `roads.ts` ribbons, `areas.ts` drapes, `scatter.ts` + `propPool.ts` instance props, `landmarkModels.ts` swaps hand-modeled glTFs in. `tiles.ts` only wraps worker payloads into meshes. Moving traffic runs in a dedicated worker (`trafficWorker.ts` → `traffic/sim.ts` IDM car-following + `traffic/graph.ts` road graph stitched from tile car paths, nodes keyed by snapped local x/z, ways split at shared vertices); `trafficClient.ts` streams 20 Hz pose buffers to `propPool.applyPoses`, which only draws them. Walkers still animate in `propPool.ts`. Car paths are the un-extended centrelines (before `adjustEnds`) so junction endpoints coincide. See `docs/traffic-idm-plan.md`. `heightsMode.ts` injects contours + the Heights tint into every material; `groundDetail.ts` adds world-space mottle; `postfx.ts` is the AO/outline/grade pass (`o` toggles it; shader injections must declare `vIsoWorld` only once).
- Local frame: x = east, z = -north, y = up. Prop geometry is modelled along +X; heading = `atan2(-dz, dx)`.
- Vertical exaggeration: `web/src/elevation.ts` scales every pipeline elevation (terrain grid, `ground_z`, bridge `deck` z, `water_z`) by `Z_SCALE` (1.6) when tile layers are fetched; building heights are not scaled. Anything shown in metres goes through `realElev`; contour spacing is `5 * Z_SCALE` world units.
- Water: canals/ponds use `water_z` and terrain beneath is lowered slightly. Richmond NOAA rivers use shared shoreline elevations and the aligned `water_elev` grid; retain island holes and vertical-unit conversion. See the playbook before substituting hydro sources.
- `track` and `path` ways are trails: MINOR (no cars, no sidewalks), drawn in the `sand` palette colour; `track` width 2.5 m in `config.ROAD_WIDTH`.
- Road junctions in `roads.ts` register interior vertices too, so a side street ending on a through road's interior node is trimmed/extended like an endpoint junction; corner fills need ≥ 3 walkable arms.
- Asset URLs are base-relative (`import.meta.env.BASE_URL`); `vite.config.ts` reads `BASE_PATH` for GitHub Pages.
- Bridges meet approaches at grade: deck anchors are abutment tops from the DEM (max of the node and 2–8 m back up the approach, capped +3 m, since the DEM cell under the end node is often on the cut slope); non-bridge "connectors" between two chains must be collinear and the same highway class (Mayo's Island), otherwise cross streets between overpasses merge chains; `bridgeLift` is only a 0.6 m deck thickness; ramps (`ramp`) climb to decks via their own `deck`.
- Bridge endpoints over underpasses can use a guarded same-class connected-approach fit at 20/24/28 m, including branch junctions. These remain estimated profiles. Runtime bridge paths must follow the deck, not `max(deck, terrain)`; see `test_bridge_decks.py` and `roads.test.ts`.
- Terrain sampling must use the rendered triangle diagonal; road/land drapes adaptively refine where they disagree. Gable/skillion roofs must stay within actual footprints and preserve courtyards. See the playbook for regressions.
- Layer heights above terrain (`roads.ts`): land 0.08, road 0.28 (`ROAD_Y`), sidewalk strips ROAD_Y + 0.15 curb, markings ROAD_Y + 0.02. Bridges use the pipeline `deck` bank elevations, not the terrain under the span.
- Default bbox now includes the whole James River (south edge 37.517°).

## Token usage

Keep Claude sessions cheap. Geodata and 3D assets are large and easy to blow context on.

- Never `cat` or Read files in `data/`, `assets/`, or `*.glb`, `*.geojson`, `*.parquet`, `*.laz`, `*.tif`. Use `head -c`, `ogrinfo`, `python -c` summaries, or `ls -la` instead.
- Inspect GeoJSON / Parquet with a one-line summary (row count, columns, bbox), not by dumping rows.
- Prefer `rg`/`sed -n` on specific line ranges over reading whole scripts.
- Do not re-read `PLAN.md` every session; it is a reference, only open the section you need.
- Summarize tool output before reasoning over it; do not paste long logs back into the conversation.
- Batch independent file edits and shell commands into one call where possible.
