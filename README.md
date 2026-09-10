# Isometric Richmond, Virginia

A browser-based, stylized isometric 3D model of Richmond, VA, in the style of low-poly "little worlds" city explorers. The bulk of the city is procedurally generated from open geodata; a curated list of landmarks is hand-modeled in Blender; everything renders with an orthographic camera and a warm, flat-shaded art style.

## Building the next map

Read the [map-building playbook](docs/map-building-playbook.md) before adding a new place. It records
the roof, terrain, bridge, hydro, tree, caching and rendering lessons, with regression-test references
and a checklist to copy into each region’s notes.

## Quick Start

Set up the Python pipeline:

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py              # OSM + fallback 3DEP DEM
.venv/bin/python pipeline/fetch_overture.py     # Overture buildings
.venv/bin/python pipeline/fetch_richmond.py     # City addresses + zoning + live tree inventory
.venv/bin/python pipeline/fetch_hydro.py        # NOAA river/pond boundaries and shoreline elevations
.venv/bin/python pipeline/dem_noaa.py --download # Download NOAA 2025 DEM tiles and build 1 m terrain
.venv/bin/python pipeline/fetch_lidar.py        # 2025 City of Richmond LiDAR -> heights + roofs
.venv/bin/python pipeline/build_tiles.py --no-merge # Preserve individual rowhouses
```

The full command list, data conventions and layout notes live in `CLAUDE.md`.

Richmond coverage extends from the Fan District through downtown and Shockoe Bottom, retaining
the James River corridor. See [the Fan expansion notes](docs/richmond-fan.md) for data and visual QA.

See [the style template](docs/map-styles.md) to add another rendering style.

The Richmond viewer includes place/address search, shareable camera links, and a style dropdown with Classic, Risograph, After Midnight, Cross-stitch, Overgrown, X-ray, and Folded Paper.
Surveyed tree stems are enriched with approximate canopy measurements from the winter 2025 LiDAR;
NOAA hydro polygons preserve river islands and the river's changing elevation. See
[the trees and riverfront pass](docs/richmond-trees-riverfront.md) for source limitations and validation.

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

**Data sources:** OpenStreetMap, Overture Maps, VGIN, USGS/USDA NAIP, NOAA, city open GIS data, and Mapillary; preserve the source terms and attribution documented in `ATTRIBUTION.md`. Google Photorealistic 3D Tiles, Street View, and Mapbox Satellite imagery are used only as visual reference for hand-modeling — their terms prohibit deriving datasets.

## Honolulu prototype (local)

Region profiles in `regions.json` select projection, bounding box, data directories, and terrain scale.
The default remains Richmond. Honolulu uses the requested Diamond Head box, UTM 4N, and
isolated `data/honolulu/` output. The palette, geometry, traffic, and helper-layer processing are shared.

```bash
ISO_REGION=honolulu .venv/bin/python pipeline/fetch_honolulu.py
ISO_REGION=honolulu .venv/bin/python pipeline/fetch.py
ISO_REGION=honolulu .venv/bin/python pipeline/fetch_overture.py  # optional: pip install overturemaps
ISO_REGION=honolulu .venv/bin/python pipeline/build_tiles.py --no-merge
cd web
ISO_REGION=honolulu npm run dev -- --port 5174
# In another terminal, from web/:
ISO_REGION=honolulu SMOKE_URL=http://localhost:5174/ npm run smoke
```

City footprints are enriched with strongly matching OSM names, building types, addresses, height/roof
tags, plus non-overlapping OSM gap-fill buildings. CCH `maxht_m` fills missing OSM heights;
the existing Overture matcher supplies remaining height/roof fallbacks. The city's coastal polygon
defines a flat ocean surface. See [the assessment](docs/honolulu-feasibility.md) for source limitations.
Do not use Richmond-specific `fetch_richmond.py`, `dem_noaa.py`, or `fetch_lidar.py` for Honolulu.
The deployment command below publishes the Richmond site; this prototype is for local preview.

## Deploying Richmond

The viewer is a static site: `cd web && npm run deploy` builds it with the `/rva/` base path, copies the tiles and
landmark models in, and force-pushes `dist/` to the `gh-pages` branch (see `web/tools/README.md`). Live at
https://sebastian-ch.github.io/rva/.

## Status

First slice (Downtown, Shockoe Bottom, Capitol Square, the riverfront and the foot of Church Hill, ~4.7 sq mi)
is built end to end: procedural buildings with 2025 LiDAR heights and roofs, bridges and ramps, still water, a
graph-based traffic simulation in a worker, and ten hand-modeled landmarks. `ROADMAP.md` records what each pass
changed and what is still open; `PLAN.md` is the original plan.
