# iso-rva

Stylized isometric 3D model of Richmond, VA. Procedurally generated from open geodata, hand-modeled landmarks, rendered in the browser. See `PLAN.md` for the full implementation plan and data inventory.

## Tech stack

- Data pipeline: Python 3.10+ — `osmnx`, `geopandas`, `shapely`, `rasterio`, `pyproj`, `osmium`
- Authoring: Blender (Blosm / BlenderGIS import), glTF export with Draco or meshopt
- Runtime: TypeScript + three.js, `OrthographicCamera`, Vite
- CRS: EPSG:2284 (VA State Plane South) or EPSG:32618 (UTM 18N). Never do geometry math in EPSG:4326.

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

- Height resolution order: OSM `height` → `building:levels` × 3.2 m → LiDAR nDSM median → zoning default.
- Tiles are ~250 m squares, named by tile index (`x_y`).
- Palette lives in one file (`assets/palette.json`); every material references it.
- Automated extraction only from OSM, Overture, VGIN, NAIP, Mapillary. Google and Mapbox imagery are visual reference only — their terms forbid derived datasets.
- Keep `ATTRIBUTION.md` current whenever a new data source is added.

## Commands

```
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py [--bbox W S E N] [--force] [--skip-dem]   # OSM via Overpass + USGS 3DEP DEM -> data/raw/
.venv/bin/python pipeline/build_tiles.py [--clean] [--no-merge]              # -> data/tiles/<x>_<y>/*.geojson + index.json
.venv/bin/python -m pytest                                                  # pipeline unit tests
cd web && npm install && npm run dev                                        # viewer at http://localhost:5173 (serves ../data/tiles at /tiles)
cd web && npm test && npm run typecheck                                     # vitest + tsc
blender --background --python blender/import_tile.py -- --tile 11_3        # load a tile into Blender for landmark modeling
```

Default bbox is the first slice (Downtown + Shockoe Bottom + Capitol Square); see `pipeline/config.py`.
Tile schema contract: `DATA_FORMAT.md`. Landmark registry: `assets/landmarks/landmarks.json` (set `model` after export).

## Layout notes

- `pipeline/heights.py` is pure functions (height/roof/color); `process.py` normalizes layers; `build_tiles.py` clips and writes.
- LiDAR nDSM is optional: drop a normalized DSM at `data/raw/ndsm.tif` and heights without OSM data use it.
- `web/src/`: `tiles.ts` loads a tile, `buildings.ts` extrudes, `roads.ts` ribbons, `areas.ts` drapes, `scatter.ts` + `propPool.ts` instance props, `landmarkModels.ts` swaps hand-modeled glTFs in.

## Token usage

Keep Claude sessions cheap. Geodata and 3D assets are large and easy to blow context on.

- Never `cat` or Read files in `data/`, `assets/`, or `*.glb`, `*.geojson`, `*.parquet`, `*.laz`, `*.tif`. Use `head -c`, `ogrinfo`, `python -c` summaries, or `ls -la` instead.
- Inspect GeoJSON / Parquet with a one-line summary (row count, columns, bbox), not by dumping rows.
- Prefer `grep`/`sed -n` on specific line ranges over reading whole scripts.
- Do not re-read `PLAN.md` every session; it is a reference, only open the section you need.
- Summarize tool output before reasoning over it; do not paste long logs back into the conversation.
- Batch independent file edits and shell commands into one call where possible.
