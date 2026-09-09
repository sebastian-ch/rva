# Richmond trees, riverfront, search, and styles

This pass uses the City of Richmond live tree inventory and NOAA's 2025 classified point cloud,
hydro breakline package, and one-foot bare-earth DEM. The terrain is resampled to 1 m. The first restored
build used 7,215 active inventory trees and detected 18,589 approximate LiDAR crowns before spatial
deduplication and exclusion of buildings/water. Final counts are printed by the pipeline.

## Rebuild

```sh
.venv/bin/python pipeline/fetch.py
.venv/bin/python pipeline/fetch_richmond.py
.venv/bin/python pipeline/fetch_hydro.py
.venv/bin/python pipeline/dem_noaa.py --download
.venv/bin/python pipeline/fetch_lidar.py
.venv/bin/python pipeline/build_tiles.py --no-merge
```

For an already-restored NOAA DEM, use `--force` when deliberately rebuilding it. DEM downloads are
selected by the published STAC footprint and cached under `data/raw/noaa_dem_2025/`. The previous 3DEP
terrain is retained as `dem_<bbox>.3dep.tif`. If the default OSM server is unavailable, `fetch.py` accepts
`--overpass-url https://overpass.private.coffee/api`; existing layer caches are reused.

## Trees and water

- Inventory filtering excludes retired/out-of-service records, vacant planting sites and stumps.
- Surveyed stems take priority. Nearby LiDAR crown peaks supply independent height and crown-radius
  estimates. Additional peaks fill parks and wooded river islands. The five tree meshes share the
  existing instancing system; species selects broad, oval, small deciduous, round or conifer forms.
- Canopy peaks are inferred from medium/high vegetation returns, not building surfaces. Winter canopy
  extent is incomplete. Unmatched inventory stems use a clearly tagged estimated size, not a claim of
  measured height. Species is never inferred from LiDAR.
- Once the full region has canopy processing, synthetic park/street trees are suppressed. Tree stems
  inside buildings/water are excluded, and overlapping OSM/inventory/crown points are deduplicated.
- NOAA Rivers and Waterbodies polygons replace coarse intersecting OSM river outlines while retaining
  smaller canals. Island holes are preserved. The source's horizontal coordinates and vertical survey
  feet are explicitly converted to metres. River surfaces interpolate shoreline elevations, shared
  globally across tiles. This is a stylized survey-date water surface, not hydrodynamic modeling.
- The Tredegar–Brown's Island–Canal Walk corridor receives shoreline/vegetation improvements and narrow
  masonry bands along mapped Haxall/Kanawha canal edges. Coping height is illustrative; it is not a
  surveyed wall dataset. Bands are constructed before tile clipping to avoid walls across tile seams.
- Water polygons explicitly labeled as a dry canal bed are excluded.

## Landmark models

The Capitol, Main Street Station and Old City Hall have reusable window surrounds, glazing and mullions.
The Capitol pediment now faces across the portico correctly. Main Street Station gains arched windows,
shed glazing and vertical clock faces with hands; Old City Hall gains arched bays and tower dials.
The models remain stylized approximations. Tredegar is treated as a riverfront site rather than one
replacement building model.

All parts of a landmark are combined for export with vertex colors and one material. This keeps added
architectural detail from multiplying draw calls. Export with the installed Blender executable:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python blender/build_landmark.py -- \
  --slug virginia-state-capitol --slug main-street-station --slug old-city-hall
```

## Navigation and style

The search index covers the entire built region, not just currently visible tiles. Search supports names,
addresses, keyboard result navigation, and canonical landmark names. Selecting a result flies to the
place and selects its building when available. Camera motion stops when the user interacts; reduced-motion
preference shortens automatic movement.

**Share view** copies a URL containing region, projected camera target, target height, zoom, azimuth,
camera distance, map/day/night state, selected building and style. Malformed or out-of-region views are
ignored. A selectable URL field is provided when clipboard access is unavailable.

**Style dropdown** changes the existing postprocessing pass. Risograph uses the supplied
reference's warm paper, red and blue inks, black outlines, a four-CSS-pixel dot screen and approximately
1.25-CSS-pixel opposing ink offsets. Face orientation drives the ink choice. Heights mode switches back
to Classic so its legend continues to match the displayed colors.

After Midnight adds near-black violet volumes, cyan/magenta emissive windows and streetlamps,
restrained bloom, and world-space traffic trails spanning 1.5 seconds. Trails follow vehicle paths,
clear on respawn/despawn/style changes, and freeze with Pause. Roads use roughness 0.15; reflected neon
is a lightweight screen-space approximation, not ray-traced reflections. Night lighting is inherent to
this style; leaving it restores the user's separate Day/Night choice. Labels render after postprocessing
so their text stays legible in all styles.

Cross-stitch snaps the scene to a five-CSS-pixel grid and renders red, gold and blue thread on linen,
with crossing strands, weave and stepped silhouettes. All styles now live in a shared registry;
see [the reusable style template](map-styles.md).

The final local data rebuild contains 240 tiles, 4,667 building features before tile clipping,
and 22,613 point features before tile clipping. The recovered OSM source includes 6,593 POI records.

## Verification

```sh
.venv/bin/python -m pytest -q
cd web
npm test
npm run build
node tools/review-richmond.mjs
```

The browser review requires Richmond's Vite server at `http://127.0.0.1:5173/` (or `SMOKE_URL`). It exercises
search, copying/reopening a shared risograph, midnight and cross-stitch views, landmark and river views, and a 390 px mobile viewport.
Screenshots are written under `web/snapshots/richmond/`. Graphics errors fail the review.

Sources: [City tree inventory](https://www.rva.gov/public-works/urban-forestry),
[NOAA LiDAR and hydro breaklines](https://www.fisheries.noaa.gov/inport/item/80312),
[NOAA terrain](https://www.fisheries.noaa.gov/inport/item/80311),
[Main Street Station architectural description](https://www.dhr.virginia.gov/historic-registers/127-0172/).
Attribution and source caveats are recorded in `ATTRIBUTION.md`.

## Geometry corrections

Pitched gable/skillion roofs now follow triangulated footprints instead of rotated bounding boxes,
preserving concave corners and courtyard holes. Terrain lookups match the visible triangle diagonal;
road/land overlays refine adaptively where they would intersect the terrain. Bridge paths follow their
deck profile instead of being raised by terrain beneath the span. For bridge endpoints over an underpass,
the pipeline can extrapolate a consistent grade from the connected same-class approach 20–28 m away,
with slope, residual and height-change guards. This remains an estimated bridge profile.


## Station shed proportions and road follow-up (2026-09-09)

Main Street Station's shed uses the documented 123 × 517 ft dimensions (37.49 × 157.58 m),
from [Amtrak's station history](https://www.greatamericanstations.com/stations/richmond-main-street-station-va-rvm/).
The length is bounded by the matched footprint. The simplified headhouse overlaps the connecting end.
Local 2025 LiDAR shed samples gave upper roof returns around 32.4 m absolute, versus ground about
8.25 m (tile ground 8.62 m + DEM base −0.366 m). The existing 24.1 m total model height was close;
the correction raises eaves from 14 to 17 m, widens the shed from 30 to 37.49 m, keeps the main ridge
at 22.3 m and clerestory top at 24.1 m, and enlarges its glazing. These are approximate proportions,
not an as-built reconstruction. The Amtrak account also describes the 2017 glass-wall renovation.

Ground-supported Downtown Expressway approaches now drape over intermediate terrain while maintaining
the bridge landing profile; actual spans remain profile-controlled. Broad Street/I-95 bridge nodes no
longer produce ground-level sidewalk corner fills. See the reusable playbook for cause, limits and tests.

The remaining freeway patches were the full-width concrete underlay projecting above the narrower
asphalt as both draped differently across the cut. Grounded approaches now have only narrow concrete
edge strips. A separate synthetic regression guards against sparse drape probes missing narrow cuts;
it does not establish that those probes caused this screenshot's remaining artifact.

The user's street-level station reference clarified that glazing starts at track/platform level.
Because railway elevations are exaggerated 1.6× while architecture is not, the neighboring rendered
railway sits ~17.5 m above the landmark base. The shed now has a dark lower support level, visible
columns, and an upper glazed storey beginning there. Its roof is translated upward 10 m with that upper
storey (display eave 27 m, clerestory 34.1 m above model base). This is an explicit presentation
compensation for the exaggerated railway datum, not a revised LiDAR height measurement. For another
city or elevation scale, derive this placement from the platform datum rather than copying the offset.
