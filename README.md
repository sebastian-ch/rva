# Isometric Richmond, Virginia

A browser-based, stylized isometric 3D model of Richmond, VA, in the style of low-poly "little worlds" city explorers. The bulk of the city is procedurally generated from open geodata; a curated list of landmarks is hand-modeled in Blender; everything renders with an orthographic camera and a warm, flat-shaded art style.

## Quick Start

Set up the Python pipeline:

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py
.venv/bin/python pipeline/build_tiles.py
```

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

## Status

Currently developing the first slice: Downtown + Shockoe Bottom + Capitol Square (~2 sq mi). Procedural geometry generation is in progress; landmarks are hand-modeled in Blender. See `PLAN.md` for the full implementation roadmap.
