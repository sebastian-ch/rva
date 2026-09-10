# Richmond Fan District expansion

## Coverage and rebuild

The Richmond profile in `regions.json` now uses WGS84 bounds
`[-77.486, 37.517, -77.418, 37.568]`, retaining downtown, Shockoe Bottom and the James River
while extending west past Arthur Ashe Boulevard and north of Broad Street. The bounding rectangle
includes adjacent neighborhoods; it is not a legal or historic-district boundary.
The [American Planning Association's Fan description](https://www.planning.org/greatplaces/neighborhoods/2014/thefan.htm)
places the neighborhood between Monroe Park, Boulevard, Main Street Alley and Broad Street.

Use EPSG:32618 throughout processing. Terrain comes from NOAA's 2025 Richmond survey, converted
from its source vertical units to metres and resampled to 1 m. Rendering applies the existing 1.6×
terrain exaggeration. Building dimensions remain unexaggerated. The tile manifest supplies the local
origin; expanding west changes it, so do not reuse hard-coded downtown local coordinates.

Acquired 2026-09-10:

- OSM buildings/parts, roads, rail, landuse, water and POIs through the default Overpass endpoint.
  `overpass.private.coffee` timed out during the status request; the default server worked.
  Counts: 24,443 building/part records, 26,145 roads, 103 rail features, 1,369 land-cover features,
  106 water features, one coastal structure and 15,276 POIs. Compact queries resolved repeated
  landuse HTTP 504s; `fetch.py --verbose` exposes requests and rate-limit waits.
- Overture building footprints and height fallbacks: 24,483 raw records from release `2026-08-19.0`.
- Richmond live services: 62,335 addresses, 339 zoning polygons and 39,171 tree inventory records
  before active-status and duplicate filtering. The Structures extract added on 2026-09-10 contains
  30,798 building and 10,538 deck/patio records before geometry and overlap filtering.
- NOAA terrain: 272 intersecting source tiles, a 6,157 × 5,817 raster, 99.9% valid coverage.
- NOAA classified LiDAR at the established depth 8: 6,647 nodes. Existing downtown nodes were
  copied into the new bbox cache; all derived elevations and crowns are rebuilt for the new extent.
  Decoding retained 310.2 million points. Ground calibration applied scale 1.0 and a +1.34 m
  offset against this DEM; the nDSM has 96% valid coverage, including sparse/water areas.
- Existing NOAA hydro GeoPackage, clipped to the expanded region during the build.

Richmond's public [Structures FeatureServer](https://services1.arcgis.com/k3vhq11XkBNeeOfM/ArcGIS/rest/services/Structures/FeatureServer)
now supplies the city footprint gap fill and deck/patio surfaces. Although its lineage begins with 1999 orthophotography and a 2009
completeness capture, the city describes it as maintained from site plans and the service reported a
2026-09-08 data edit when checked on 2026-09-10. The pipeline queries subtype 1 buildings and subtype 3
decks/patios by bbox, saves compact service metadata beside the raw extract, uses buildings only where they
do not substantially overlap OSM, and renders decks/patios as low surfaces because no elevation or material
is supplied. The optional VGIN shapefile remains an offline building fallback when this extract is absent.
Attribution and source limitations are in `ATTRIBUTION.md` and `richmond-trees-riverfront.md`.

```sh
.venv/bin/python pipeline/fetch.py --skip-dem
.venv/bin/python pipeline/fetch_overture.py
.venv/bin/python pipeline/fetch_richmond.py
.venv/bin/python pipeline/fetch_hydro.py
.venv/bin/python pipeline/dem_noaa.py --download
.venv/bin/python pipeline/fetch_lidar.py
.venv/bin/python pipeline/build_tiles.py --no-merge
```

`--no-merge` preserves the Fan's individual attached houses. The pipeline already incorporates
footprint-contained roofs, LiDAR height/roof estimation, surveyed tree filtering and canopy enrichment,
surveyed river geometry, bridge approach corrections, and shared terrain draping. Runtime tree pools
grow as needed and preserve trees at reduced detail. Existing landmark assets remain in use.

Raw data and generated tiles are gitignored and shared by branches in this working directory.
Switching Git branches does not restore an earlier tile build. Rebuild from the matching bbox inputs
to restore another extent. `ndsm.tif` is still a single per-region derived file, so regenerate it with
the matching DEM/LiDAR before rebuilding a different extent.

## Visual review

`web/tools/review-fan.mjs` captures Stuart Circle, Scuffletown, Meadow Park, the upper Fan and Monroe
Park using projected coordinates. It exercises Hanover address search, five styles and mobile layout.
`review-geometry.mjs` retains downtown bridge/roof checks, now using the active manifest origin.
Both wait for camera animation and tile loading. Screenshots and scene counts go to
`web/snapshots/fan/` and `web/snapshots/richmond/`.

The expansion exposed an incorrect registry anchor for The Diamond: the old coordinate near
Chamberlayne Avenue assigned the stadium slug to Richmond Police Department's 4th Precinct
(`osm:way/553957352`). The registry now uses the stadium coordinates from
[Wikidata Q7730070](https://www.wikidata.org/wiki/Q7730070), 37.571806, −77.463733, north of this map.
Its absence from the built extent is intentional; nearby buildings must not stand in for it.

```sh
cd web
npm run dev -- --host 127.0.0.1 --port 5173
# In another terminal:
node tools/review-fan.mjs
node tools/review-geometry.mjs
node tools/review-tree-loading.mjs
```

## Results

The build produces 625 tiles (25 × 25), with origin `[280250, 4154750]`, 25,517 tiled building
features and approximately 75.1 MB of generated files. Richmond Structures supplies 2,820 of those
buildings plus 10,502 source deck/patio polygons (11,070 fragments after tile clipping). Individual
building footprints remain intact at tile boundaries. All three existing hand corrections applied;
LiDAR checks removed 440 stale footprints across all sources. Heights use LiDAR for 23,540 processed
buildings, OSM levels for 893, zoning estimates for 860, OSM heights for 189, Overture heights for 31,
landmark hints for 16, hand overrides for three and defaults for two. Roof classification remains
approximate: 11,138 LiDAR fits and 14,053 heuristic assignments before tile-boundary filtering.

Tree processing starts with 27,453 active inventory stems and 68,809 inferred crowns, then removes
duplicates and building/water conflicts. The wide-view browser check rendered all 26,797 expected
tree instances; the initial view also retained trees on reduced-detail tiles. This is a rendering
check, not a claim that every real tree was surveyed or detected.

Validation: 135 Python tests passed (seven fixture-dependent tests skipped), 180 frontend tests
passed, and generated-feature schema validation reported zero problems. Fan browser checks cover
five locations, Hanover address search, five styles and mobile controls. The mobile selection card
now sits above the toolbar, and unspecified `building=yes` records are labeled “Building”.
The downtown geometry review also passed; its Federal Reserve freeway and Shockoe roof captures
retain the earlier road-draping and footprint-contained roof corrections.
Screenshots show stylized rowhouse volumes and measured canopy placement; detailed historic
facades, species-specific crowns and exact roof ornamentation remain approximations.
