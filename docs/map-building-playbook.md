# Map-building playbook: lessons to carry to the next city

This is the reusable record of fixes learned while building Richmond and extending the regional map
viewer. Read it before adding a region, replacing elevation sources, or changing geometry/rendering.
Keep the general rules; recheck source-specific thresholds and assumptions for each place.

For Richmond's source URLs and rebuild commands, see [the Richmond implementation notes](richmond-trees-riverfront.md).
For rendering variants, see [the style template](map-styles.md). This document records **why** the fixes
exist and how to recognize the same failure elsewhere. It does not claim that every bridge, roof, or
interior is surveyed accurately.

## 1. Roofs: use the footprint for shape, the bounding box only for orientation

**Symptom:** sloping roof planes overhang adjacent buildings, fill courtyards, or bridge the empty
corner of an L-shaped building. Shockoe's pitched roofs exposed this.

**Cause:** a rotated bounding box was used as the roof outline. Even a correctly fitted LiDAR ridge
cannot make that rectangle fit an irregular building.

**Rule:** triangulate the actual outer ring and its holes. For gables, split triangles at the ridge
before assigning heights; for skillions, evaluate the sloping plane on footprint vertices. Close the
roof perimeter with wall faces. Preserve multipolygons and `building:part` relationships. A hidden
parent outline must not become a second full building.

**Implementation:** [buildings.ts](../web/src/buildings.ts), `extrudeBuilding` and `addRoof`.
**Regression:** [buildings.test.ts](../web/src/buildings.test.ts), concave gable/skillion roof containment.

This correction covers gable/skillion construction; do not assume every other roof generator is
footprint-safe. Review hip/pyramidal fallbacks and domes when importing unfamiliar building forms.
Also distinguish a bad roof *mesh* from a bad roof *estimate*: check roof source, eave/ridge heights,
azimuth, classification quality, and footprint alignment before changing the classifier.

## 2. Terrain: all consumers must agree on the surface

**Symptom:** beige triangles poke through grass, road edges disappear into slopes, and surfaces look
jagged despite apparently correct elevations.

**Cause:** the renderer drew two planar triangles per terrain cell, while the height lookup used
bilinear interpolation. Those are different surfaces when the four corner heights are not coplanar.
An overlay with its own triangulation can still cross the ground even when its vertices are correct.

**Rule:** match the height lookup to the terrain mesh's exact diagonal and interpolation. Refine
road and land triangles where their interpolated surface disagrees with the terrain. A small vertical
lift handles surface ordering; it cannot repair incompatible geometry. Avoid hiding the issue by
raising an entire park or widening every road.

**Implementation:** [terrain.ts](../web/src/terrain.ts), [drape.ts](../web/src/drape.ts),
[areas.ts](../web/src/areas.ts), [roads.ts](../web/src/roads.ts).
**Regression:** [terrain.test.ts](../web/src/terrain.test.ts), non-planar embankment cell.

Useful diagnostic: a cell with heights `[0, 0, 0, 10]` has a center height of **0** on the current
mesh diagonal; bilinear interpolation incorrectly gives **2.5**. Check the actual winding/diagonal
before reusing that formula in another renderer. Adaptive draping has a finite tolerance and recursion
limit; inspect steep cuts visually and measure triangle counts and worker build times.

A related regression guard covers midpoint/centroid probes that all miss a narrow
road cut inside a large land triangle. This was tested synthetically; it was not the final cause
of the remaining Federal Reserve patches. Require horizontal
triangle edges ≤ 8 m before accepting the error estimate (current terrain cells are 10 m); refinement
is capped at depth 9. [drape.test.ts](../web/src/drape.test.ts) reproduces the missed-cut case.
Adjust the spacing to the terrain resolution when reusing the renderer.

## 3. Bridges: bare-earth elevation is not deck elevation

**Symptom:** a bridge dives into an underpass, develops a hump, or meets its approach with a sudden step.
Near the tower in Richmond, endpoint samples read roughly 10 m below the connected approach.

**Two separate causes and fixes:**

- The runtime used `max(deckHeight, terrainHeight - 1)`. Terrain underneath a span pulled the bridge
  upward. A supplied deck profile now controls the span; it is not redraped onto underlying terrain.
- The pipeline sometimes anchored a bridge to the underpass floor. It now checks a physically connected,
  same-class approach beyond the cut and can extrapolate its consistent grade to the endpoint. This
  also handles an approach joining multiple bridge branches, not just degree-one endpoints.

Current guards sample the approach at **20, 24, and 28 m**, require at least 28 m of approach, limit
absolute grade to **0.15 m/m** and fit residual to **0.6 m**, and accept an upward correction only
between **1 and 12 m**. These are guarded estimates tuned to the observed failure, not universal
engineering standards. Reassess them against local data. Preserve source provenance if measured deck
profiles are added later.

Do not merge bridge chains through a perpendicular cross street just because it joins their ends.
Connectors must continue the same road class and direction. Keep deck thickness separate from deck
height; the existing 0.6 m lift is a rendering thickness, not a generic clearance above terrain.

**Implementation:** [process.py](../pipeline/process.py), `_deck_endpoints` / `_ramp_decks`;
[roads.ts](../web/src/roads.ts), `toPath` / `bridgeLift`.
**Regression:** [test_bridge_decks.py](../pipeline/tests/test_bridge_decks.py), including underpass and
branch-junction cases; [roads.test.ts](../web/src/roads.test.ts), supplied deck over noisy terrain.

### Ground-supported approaches are not spans

**Symptom:** the Downtown Expressway beside the Federal Reserve disappears beneath beige terrain patches.
**Cause:** a non-bridge approach received a linear endpoint profile to meet a bridge, then was rendered
as an unsupported span. Intermediate terrain and embankment edges rose above that profile.
**Rule:** actual bridges retain their supplied profile; non-bridge approaches use the higher of their
landing profile and terrain, with adaptive draping across their width. Apply the same rule to pavement,
concrete edges, markings and traffic paths. Use narrow concrete edge strips on grounded approaches:
a full-width underlay drapes differently from the narrower asphalt and can poke above it even with a
small vertical offset. A raycast through the remaining Federal Reserve patches identified overlapping
road surfaces, not terrain. This fixes surface visibility; it does not excavate a surveyed
road cut or recover a missing bridge tag. Review inconsistent source tags separately.

**Symptom:** short bridge segments at Broad Street/I-95 acquire ground-level sidewalk squares and
asphalt extensions at their shared nodes. **Rule:** exclude bridges, inferred ramps and freeway classes
from at-grade sidewalk junction registration; do not extend supplied deck strips into ground junctions.
Both cases have focused regressions in [roads.test.ts](../web/src/roads.test.ts) and saved diagnostic
locations in [review-geometry.mjs](../web/tools/review-geometry.mjs).

## 4. Elevation sources must be replaced as a dependency chain

A finer DEM is not a drop-in cosmetic asset. LiDAR normalization, building ground elevations, canopy
heights, water surfaces, bridge anchors, and tile grids depend on it.

- Confirm horizontal CRS, horizontal units, vertical units, vertical datum, coverage, nodata and date.
  Never perform distance/area geometry in longitude/latitude.
- Choose and build the terrain first, then recalibrate/rebuild the normalized point cloud products,
  then rebuild dependent tiles. Do not reuse an nDSM calculated against a different DEM.
- Keep a fallback DEM separately. Download only intersecting raster footprints through an available
  catalog/STAC index, and retain a cache so transient failures do not restart the entire acquisition.
- Keep a place's raw/derived data isolated through region configuration. Do not silently point a new
  city at Richmond's bbox, CRS, `ndsm.tif`, source services or cached canopy products.
- Pipeline heights are metres. The viewer's local axes are east / up / negative north. Terrain and
  absolute/base elevations are exaggerated at the rendering boundary; building dimensions remain
  unexaggerated. Include new fields such as hydro elevations in that conversion exactly once.

**Implementation:** [regions.json](../regions.json), [config.py](../pipeline/config.py),
[dem_noaa.py](../pipeline/dem_noaa.py), [fetch_lidar.py](../pipeline/fetch_lidar.py),
[elevation.ts](../web/src/elevation.ts). Check source-specific adapters before reuse.

## 5. Water: preserve shorelines, islands and vertical units

Coarse OSM water outlines can flood islands or miss narrow riverfront detail. A hydro package can
improve this, but importing its geometry without its units/elevations creates a different failure.

- Inspect each layer separately. Richmond's hydro package used State Plane XY and NAVD88 Z in US
  survey feet. Transform XY explicitly and convert Z explicitly; a horizontal reprojection is not
  proof that vertical values were converted.
- Retain polygon holes and small canals when replacing the coarse main river. Exclude features
  explicitly labeled as dry canal beds.
- Use globally shared shoreline samples for sloping rivers so tile borders meet. Keep ponds/canals
  flat where that is the chosen representation. Lower the underlying terrain slightly beneath water.
- Construct decorative canal banks before tile clipping, so clipping does not create walls across
  tile seams. Label their dimensions as artistic, not surveyed.
- Test nearby disconnected water bodies and confluences when reusing interpolation. A nearest-sample
  method is not a hydraulic model and needs review in a different river network.

**Implementation:** [hydro.py](../pipeline/hydro.py), [riverfront.py](../pipeline/riverfront.py).
**Regression:** [test_hydro.py](../pipeline/tests/test_hydro.py): unit conversion, sloping surface,
island holes, tile agreement and retained canals.

## 6. Trees: inventory positions and inferred crowns are different evidence

Prefer an active municipal tree inventory for known stems, with classified LiDAR vegetation filling
wooded areas and estimating canopy dimensions. Filter stumps, vacant planting sites, retired records
and duplicates before rendering. Paginate live GIS services using stable object IDs.

Surveyed stems take precedence over inferred crowns and OSM duplicates. Exclude buildings and water.
Use species only when provided by a source; do not infer species from crown shape alone. Separate
height from crown radius in instance scaling. Winter LiDAR can miss canopy extent, and local maxima
are approximate crowns, not a verified tree census. Unmatched stems need tagged size estimates.

Once coverage is sufficient, disable synthetic street/park tree scatter rather than drawing it on top
of the inventory. Keep deterministic placement, bounded mesh complexity and instancing. Recompute
canopy products when their DEM/point-cloud inputs change.

**Implementation:** [vegetation.py](../pipeline/vegetation.py), [scatter.ts](../web/src/scatter.ts),
[props.ts](../web/src/props.ts), [propPool.ts](../web/src/propPool.ts).
**Regression:** [test_vegetation.py](../pipeline/tests/test_vegetation.py).

## 7. Downloads and caches: missing is not empty

A failed Overpass request does not mean there are no benches, lamps or fountains. Preserve completed
layers, identify the failed layer, and retry it with a working public endpoint/transport. In this
session, cached main layers were available while the remaining request stalled; a successful later
request recovered the small-feature records. Do not turn a timeout into an empty successful cache.

Record source URLs, dates, attribution and known limitations. A live service's update timestamp does
not mean every observation was surveyed on that date. Check counts and coverage after fetching, then
rebuild: obtaining raw data alone does not update the viewer.

Treat `index.json` as the manifest for active tiles. Old unreferenced tile files can survive an
incremental rebuild; globbing every directory can produce misleading counts or stale feature values.
Only clean generated caches deliberately, and do not delete another region's data.

## 8. Landmarks: correctness and draw calls both matter

Inspect the exported model in the actual map, not just Blender. Check portico/pediment orientation,
vertical clock faces, footprint placement, ground datum, scale and overlap with procedural outlines.
Join compatible parts/materials and preserve vertex colors so window trim does not add hundreds of
draw calls. Keep the scripts and exported assets together.

When a landmark looks too short, compare eaves, ridge, width and adjacent elevated infrastructure
separately. A correct peak with low eaves and an undersized footprint can still read too small.
Compare LiDAR absolute elevations against the model's ground datum before changing height; account
for terrain exaggeration without stretching architectural dimensions. Main Street Station exposed this.

Blender's background CLI worked for this project; an MCP connection is not required for scripted
exports. Test a minimal headless invocation first. A sandbox launch failure is not proof that Blender
is broken. Follow the environment's permission mechanism rather than bypassing it.

**Implementation:** [landmark_lib.py](../blender/landmark_lib.py),
[build_landmark.py](../blender/build_landmark.py), [landmarkModels.ts](../web/src/landmarkModels.ts).

## 9. Style changes need lifecycle and usability checks

Use the [style registry/template](map-styles.md), not scattered style-name branches. Stable keys are
stored in shared links; renaming Terrarium to Overgrown kept the `terrarium` key.

Keep label text outside artistic postprocessing. Apply linear/output color conversion once. Verify
UI contrast when switching light/dark styles, mobile control width, keyboard input and shared-view
restoration. Global shortcuts must ignore the style dropdown and other editable controls.

Geometry effects need bounded allocation and cleanup on tile unload/style changes. X-ray floor plates
preserve courtyard holes and use plausible reported levels or explicitly illustrative estimates;
cores are not surveyed elevator locations. Traffic trails use world-space vehicle history, reset on
respawn, and freeze with Pause. They should not smear the whole scene when the camera moves.

**Regression:** [buildingEffects.test.ts](../web/src/buildingEffects.test.ts),
[trafficTrails.test.ts](../web/src/trafficTrails.test.ts), [navigation.test.ts](../web/src/navigation.test.ts).

## New-place intake and acceptance checklist

Copy this section into the next region's notes and fill in actual sources and results.

- Region/bbox/projected CRS, local origin, vertical datum/units, acquisition dates and data directories:
- Footprints/building parts; height and roof source precedence; known exceptions/overrides:
- Terrain/LiDAR coverage and normalization; tree inventory status/species fields and canopy limitations:
- Water/hydro layers, island holes, ponds/canals, bridge approaches and steep road cuts:
- Named landmarks, exported models, full-region search index, attribution:
- Diagnostic views: concave/courtyard building, steep embankment, bridge/underpass, tile boundary,
  river island/canal, wooded park and dense downtown; include coordinates and before/after captures:
- Validation results and remaining approximations:

Run the relevant existing regression tests when changing an algorithm. Add a focused reproducer for
a newly discovered failure. Validate active tile data, then review actual desktop/mobile renders.
Use `npm run typecheck`, `npm test`, `npm run build`, and the pipeline tests as appropriate to the change.
The current browser tools are [review-richmond.mjs](../web/tools/review-richmond.mjs) for styles/search
and [review-geometry.mjs](../web/tools/review-geometry.mjs) for the Richmond problem areas; their locations
must be adapted to a new city. Wait for **both camera animation and tile loading** to settle before
capturing a diagnostic view. A passing shader test cannot establish geographic accuracy.

For each future fix, append: **symptom → root cause → reusable rule → code/test links → applicability
and limits**. Update region-specific notes separately. Preserve this knowledge with the implementation
so the next map starts with the fixes, not just the final screenshots.
