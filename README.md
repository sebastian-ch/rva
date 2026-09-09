# Isometric Richmond, Virginia

A browser-based, stylized isometric 3D model of Richmond, VA, in the style of low-poly "little worlds" city explorers. The bulk of the city is procedurally generated from open geodata; a curated list of landmarks is hand-modeled in Blender; everything renders with an orthographic camera and a warm, flat-shaded art style.

## Quick Start

Set up the Python pipeline:

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py              # OSM + fallback 3DEP DEM
.venv/bin/python pipeline/fetch_overture.py     # Overture buildings
.venv/bin/python pipeline/fetch_richmond.py     # City addresses + zoning
.venv/bin/python pipeline/dem_noaa.py           # 1 m terrain from the NOAA 2025 DEM zip (optional, better)
.venv/bin/python pipeline/fetch_lidar.py        # 2025 City of Richmond LiDAR -> heights + roofs
.venv/bin/python pipeline/build_tiles.py
```

The full command list, data conventions and layout notes live in `CLAUDE.md`.

Set up and run the web viewer:

```bash
cd web
npm install
npm run dev
```

## Repository Layout

| Directory | Purpose |
|-----------|---------|
| `data/raw/` | Downloaded sources (gitignored) |
| `data/tiles/` | Processed per-tile GeoParquet / GeoJSON |
| `pipeline/` | Python processing scripts |
| `blender/` | .blend files and generation scripts |
| `assets/` | Exported glTF, textures, palette |
| `web/` | TypeScript + three.js viewer app |
| `DATA_FORMAT.md` | Tile data format specification |
| `ATTRIBUTION.md` | Data source licenses and attribution |

## Data and Licensing

See `ATTRIBUTION.md` for full attribution details and license terms for all data sources.

**Licensing rule:** Automated data extraction occurs only from OpenStreetMap, Overture Maps, VGIN, USGS/USDA NAIP, and Mapillary. Google Photorealistic 3D Tiles, Street View, and Mapbox Satellite imagery are used only as visual reference for hand-modeling — their terms prohibit deriving datasets.

## Deploying

The viewer is a static site: `cd web && npm run deploy` builds it with the `/rva/` base path, copies the tiles and
landmark models in, and force-pushes `dist/` to the `gh-pages` branch (see `web/tools/README.md`). Live at
https://sebastian-ch.github.io/rva/.

## Status

First slice (Downtown, Shockoe Bottom, Capitol Square, the riverfront and the foot of Church Hill, ~4.7 sq mi)
is built end to end: procedural buildings with 2025 LiDAR heights and roofs, bridges and ramps, still water, a
graph-based traffic simulation in a worker, and ten hand-modeled landmarks. `ROADMAP.md` records what each pass
changed and what is still open; `PLAN.md` is the original plan.
