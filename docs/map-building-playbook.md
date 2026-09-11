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

OSM may split one sloping elevated route where a ground-supported ramp meets a bridge and change the way name
at that boundary. Treat two deck-bearing segments with the same road class, nearly opposed directions and a
shared endpoint as one elevated join even across that bridge/ramp or name transition. Stitch both pavement and
the narrow pavement cap at the supplied endpoint height; separately mapped walkable edges remain independent.
South 2nd Street and the I-95 northbound transition are
Richmond regressions; this does not join nearby endpoints or roads at different elevations.

Apply grade separation before surface-class shortcuts. An OSM pedestrian bridge can be tagged
`highway=path`, `bridge=yes`, `layer=1` with a valid deck profile. Treating every path as a ground trail before
checking `bridge` leaves the crossing visually at grade and omits its railings. Render paved bridge paths from
their deck profile, stitch clipped deck segments, and add pedestrian-width bridge furniture. This preserves the
recorded structure; it does not infer accessibility, stairs, or a surveyed railing design. The Parkwood Avenue
footbridge over the Downtown Expressway is the Richmond regression, covered by [roads.test.ts](../web/src/roads.test.ts).

### Preserve road access and pedestrian subtypes

Broad Street/I-95 still had duplicate beige edges because `sidewalk:left=no` and
`sidewalk:right=separate` were discarded. Preserve per-side values and normalize them for the selected render
style: explicit `no` disables the curb strip, while `separate` enables the single curb-aligned visual strip and
keeps its mapped centerline for navigation without drawing another surface. Null retains the fallback for
incomplete data.
`footway=crossing` describes a pedestrian connection across pavement, not a solid sidewalk across
traffic lanes. Keep its walking path and crossing markings, but omit a solid fill. Service drives
and living streets use asphalt instead of pedestrian paving.

Crossing point tags may sit at either curb instead of the road centerline, and a mapped crossing can
contain one point per curb. Painting directly at those source points produces offset or doubled zebra
bars; accepting any road within a broad fixed radius can also attach paint to the wrong street. Match
within the candidate road's half-width plus a small curb allowance, project the marking onto that road's
centerline, and deduplicate projected curb pairs with compatible headings. Do that match in the processing
pipeline and store the road id, center, direction and width with the crossing; when a mapped
`footway=crossing` is present, prefer the road perpendicular to its direction. This removes tile-loading
order and runtime nearest-road ambiguity. `crossing=unmarked` remains pedestrian connectivity without paint.
Complex plazas, divided carriageways and crossings without a nearby motor road can still require explicit
way-node relationships; unmatched crossings retain the runtime fallback for older tile sets.
Preserve `crossing:markings`: render zebra bars only for explicit `zebra`, honor explicit `no`, and use a
neutral transverse pair for an explicit `crossing=marked` without a stated pattern. Signal/control values such
as `traffic_signals` and `uncontrolled` do not prove that paint exists; leave them unpainted when markings are
absent. Invented bars produce dense, misleading fans at Floyd/Harvie and divided Broad Street approaches.
Do not infer stop lines from a crossing node: those markings need their own source evidence, and adding
two full-width bars to every crossing creates dense false markings at ordinary intersections.
Render refuge islands only from `crossing:island=yes`; lane count alone does not prove that a median exists.

Square sidewalk corner fills hide gaps but produce blocky intersections and can cover crosswalk ends.
At nodes with at least three distinct walkable road arms, use terrain-draped rounded polygons: a low sidewalk
apron for the curb-radius silhouette and a smaller asphalt polygon joining the road ribbons. Keep the apron
below road pavement and the asphalt below markings. This is a visual junction surface, not a full geometric
union: explicit curb walls, turn pockets and mapped median polygons still need source-aware construction.
Paved minor roads need the same asphalt topology even when they do not carry sidewalks or simulated traffic.
If `service` and `living_street` ways are drawn as asphalt but omitted from junction registration and endpoint
extension, alleys and parking aisles stop at their centerline node and leave a notch at the receiving road.
Register those paved classes, extend their ribbons by the other road's half-width, and emit the asphalt fill
from all paved arms; keep the sidewalk apron conditional on three walkable arms. Do not apply this rule to
footways, paths, tracks or grade-separated ways.
An untagged paved service road is still an asphalt arm, but it is not a generated-sidewalk arm: the renderer
does not emit sidewalk strips for `service`, so counting its absent sidewalk tags as walkable creates a detached
pale apron at an alley T junction. Use the same sidewalk-eligibility predicate for strips and junction arms.
North Belmont Avenue's service junctions are the Richmond regression area. This rule does not remove mapped
pedestrian connectivity or the asphalt junction fill.
OSM can attach a side street or alley to an interior vertex of one continuous through-road way. Shortening
sidewalks only at feature endpoints leaves the through road's raised sidewalk ribbon painted across that arm,
even when the junction apron is correct. Split the visual sidewalk at every interior paved junction vertex and
retract each resulting end by the intersecting road width; retain the unsplit source line for pedestrian motion.
This applies to topology vertices shared by paved at-grade roads, not ordinary shape points or grade-separated
crossings. North Belmont Avenue exposes both endpoint and interior-vertex forms in the same review area.
At oblique intersections, divide the intersecting half-width by the sine of the arm angle to find the trim or
extension distance along an arm. A perpendicular-only half-width leaves triangular overlaps. A full circular
sidewalk underlay also works poorly because its exposed sectors resemble islands or a roundabout. Do not emit
one until real curb polygons are available. Cary/Dooley and Floyd/Harvie are Richmond regressions for these
limits. Nearly duplicated source arms can inflate a raw arm count, so classify junctions from distinct directions
rather than count alone.
Do not render a citywide paved-surface dataset as an unconditional terrain underlay without classifying and
simplifying it first. Richmond's Roads polygons roughly tripled dense-tile triangles and painted highway-adjacent
land because the source's paved extent and the viewer's semantic surface classes do not align one-for-one. Use
the polygons to derive targeted junction masks or a canonical classified surface, with OSM retained for access,
grade and pedestrian semantics.
Separately mapped `footway=sidewalk` lines can exist beside roads whose sidewalk tags are absent rather than
`sidewalk=separate`. Drawing both the generated curb strip and offset mapped ribbon produces a real duplicate;
suppressing every mapped surface loses exact corners at fully mapped intersections. Measure parallel overlap on
each road side: where a mapped sidewalk covers that side, suppress only the generated strip and render the mapped
line; keep the generated strip on uncovered sides. A nearby `footway=crossing` remains a distinct pedestrian
connection and must not count as roadside coverage. South Meadow Street and Floyd/Harvie are Richmond regressions.
Keep those per-side flags as a nullable Boolean dtype through GeoJSON export. Mixing Python booleans and nulls in
an object column caused Fiona to serialize `False` as the truthy string `"False"`; strict renderer comparisons then
silently re-enabled every suppressed strip. Normalize to nullable booleans before writing and assert the processed
schema, rather than teaching each consumer to recognize malformed strings.

Lane-center dashes must stop at the same topology-derived junction boundary as sidewalks. Continuing two dashed
centerlines through an oblique crossing creates a pale star that resembles a traffic island or roundabout even
when the asphalt is correct. Floyd/Harvie is the regression location; this rule does not suppress explicit
crosswalk or stop-line markings.
At a four-arm crossing the trimmed road ribbons already cover the center. Adding the same circular cap used to
close a three-arm T junction makes an ordinary intersection resemble a roundabout. Emit the cap only for the
topology that needs it; true roundabouts remain mapped ways rather than inferred discs.
Regressions: `pipeline/tests/test_process_helpers.py` covers topology matching;
`pipeline/tests/test_build_tiles.py` covers reusable tile clipping; `web/src/roads.test.ts` covers topology
placement, islands, rounded fills, centering, curb-pair deduplication, unmarked crossings, paved service-road T
junctions and navigation-only mapped-sidewalk rendering.

Retain bus access and bus-lane count separately. Bus-only ways have distinct muted-red paving;
partial bus lanes require a known side. Richmond's downtown Broad Street uses curbside lanes, per
[the city's red-lane project description](https://www.rva.gov/press-releases-and-announcements-public-works/news/pulse-brt-red-lane-painting-broad-street).
This region-specific placement is assigned in the pipeline, not inferred globally by the renderer.
These tags do not model operating hours or enforce bus restrictions in simulated traffic.
Bus-lane color partitions the same road mesh rather than using a separately draped overlay, which
otherwise develops gaps on slopes. Bridge railings are omitted where a neighboring road occupies the
same height and horizontal space; crossings on a different level do not suppress railings. Branching
bridge decks also use exposed concrete edge strips rather than overlapping full-width underlays;
otherwise different branch grades can expose large concrete wedges over the asphalt.
OSM may divide one straight bridge into separate tagged ways at each carriageway below. Rendering every way
as an independent mitered ribbon leaves thin wedges at their shared deck nodes. At a degree-two join, stitch
the pieces with a small pavement cap only when their name, road class, width and direction agree;
place the caps at the supplied deck elevation. Do not cap branches, sharp turns, mismatched roads or untagged
ground-level joins. South Meadow Street over the Downtown Expressway is the Richmond regression case.
Regressions: `pipeline/tests/test_road_attributes.py`, `web/src/roads.test.ts`.

Sunken freeway cuts expose every bend in a coarsely sampled road edge and retaining face. Resample freeway and
link centerlines at 4 m before building pavement, markings and cut walls while ordinary streets retain the wider
8 m step. Smooth the retaining crest over a broad longitudinal window and close isolated threshold gaps; using
each adjacent DEM sample directly produces a sawtooth wall even with dense sampling. This smooths renderer
geometry without inventing a surveyed retaining-wall outline, modifying the DEM, or changing the rail lines that
may run beside the road. Cumberland Street and the Beltline Expressway below Monument Avenue are Richmond
regressions, protected by spacing/profile checks in [roads.test.ts](../web/src/roads.test.ts).

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

### Trees must survive detail transitions and capacity limits

Reduced-detail tiles formerly omitted all POIs and placements, so their trees vanished. They now fetch
POIs and retain tree placements while omitting small props. `treesOnly` filtering preserves the random
sequence so trees keep the same locations across detail changes. Regression: `scatter.test.ts`.

Fixed tree instance pools silently dropped placements beyond their limit (8,000 round trees). Tree
buffers now grow geometrically, retaining matrices and tile ownership; removing a tile still compacts
the grown buffer correctly. Regression: `propPool.test.ts`. Check expected placement counts against
rendered instances at a wide zoom; `tools/review-tree-loading.mjs` does this and verifies model URLs.
This fixes rendering omissions, not missing source observations or the intentional building/water filters.

## 7. Downloads and caches: missing is not empty

A failed Overpass request does not mean there are no benches, lamps or fountains. Preserve completed
layers, identify the failed layer, and retry it with a working public endpoint/transport. In this
session, cached main layers were available while the remaining request stalled; a successful later
request recovered the small-feature records. Do not turn a timeout into an empty successful cache.

Record source URLs, dates, attribution and known limitations. A live service's update timestamp does
not mean every observation was surveyed on that date. Check counts and coverage after fetching, then
rebuild: obtaining raw data alone does not update the viewer.

When a city footprint layer gap-fills OSM, an `intersects` join alone is too aggressive: attached
buildings often share a boundary with an OSM footprint and have zero overlap area. Treat a candidate as
a duplicate only when their intersection covers a meaningful fraction of the smaller polygon. Preserve
the source subtype and edit timestamp. Render accessory polygons according to their source semantics;
Richmond Structures subtype 3 combines decks and patios but supplies neither elevation nor material, so
it becomes a low terrain-draped surface rather than a building extrusion or an invented elevated deck.
Regression: `pipeline/tests/test_richmond_structures.py` covers overlap filtering and subtype separation;
`web/src/areas.test.ts` covers the rendered surface lift. Recheck subtype codes, units and edit fields for
every new city because these are Richmond service conventions.

Treat `index.json` as the manifest for active tiles. Old unreferenced tile files can survive an
incremental rebuild; globbing every directory can produce misleading counts or stale feature values.
Only clean generated caches deliberately, and do not delete another region's data.
`pipeline/tiles_inspect.py` now reads only manifest-listed tiles and layers; its previous directory
glob included stale layers left after an extent change. Regression: `test_tiles_inspect.py`.

The Fan expansion's multi-tag OSM landuse query repeatedly returned HTTP 504. Union matching
nodes/ways/relations first and expand geometry dependencies once, rather than once per tag/type.
`pipeline/fetch.py` retains OSMnx caching and relation assembly, offers `--verbose` retry logging,
and rejects responses with an Overpass error remark before writing a layer. Regression:
`test_fetch_osm.py`. This reduces redundant work for rectangular region requests; large regions may
still need subdivision, and an endpoint failure must never be treated as an empty successful layer.

Expanding Richmond west into the Fan exposed a hard-coded downtown origin in the geometry review
script. Its projected coordinates would visit the wrong location after the tile origin moved.
Resolve the active manifest origin before converting projected coordinates to scene coordinates;
wait for camera animation as well as tile loading. `web/tools/lib/browser.mjs` (`visitProjected`)
is shared by `review-geometry.mjs` and `review-fan.mjs`. This corrects diagnostic positioning;
raw local-coordinate bookmarks still belong to the extent that created them. See `richmond-fan.md`.

Landmark GLBs copied to stable public paths can remain in browser caches after a deployment, even
when a fresh server download is correct. Compare local/live file hashes before blaming geometry.
`vite.config.ts` now fingerprints each region's GLB bytes and embeds a version map; `landmarkModels.ts`
appends the fingerprint to model requests. A changed model therefore also changes the application
bundle. Existing open sessions still need a refresh. This covers landmark assets, not tile-cache invalidation.

## 8. Landmarks: correctness and draw calls both matter

Inspect the exported model in the actual map, not just Blender. Check portico/pediment orientation,
vertical clock faces, footprint placement, ground datum, scale and overlap with procedural outlines.
Join compatible parts/materials and preserve vertex colors so window trim does not add hundreds of
draw calls. Keep the scripts and exported assets together.

An expanded extent can expose stale landmark anchors: The Diamond's incorrect registry coordinate
made the nearest-footprint fallback label a Richmond police precinct as a stadium. Check a newly
resolved feature's actual source name and position, not just a non-null match count. Correct the
registry against an identified source, and allow out-of-extent landmarks to remain unmatched.
See `assets/landmarks/landmarks.json` and `docs/richmond-fan.md`. Coordinate corrections are
site-specific; a nearby large footprint alone does not establish landmark identity.

Small branded storefronts are better represented by a procedural facade attached to the mapped
footprint than by a generic marketplace building. Preserve the source footprint and height, add only
the high-signal massing and color cues visible at map scale, keep the treatment out of reduced-detail
tiles, and avoid bundling reference photos as textures. The 3301 West Cary Street 7-Eleven uses this
pattern in `web/src/buildings.ts`; its user-provided photo is documented in `docs/7-eleven-facade.md`.
The 3410 West Cary Street McDonald's uses the same approach, with the short south end treated as the Cary
storefront and the long east wall handled separately; assuming the OBB long edge was the front initially put the
entrance treatment on the wrong face. Its references and limits are in `docs/mcdonalds-cary-facade.md`.
This is suitable for one-off low commercial buildings; repeated chains should eventually use a
shared asset definition rather than more address-specific branches.

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

Review mobile controls with a building selected. The Fan address-search review exposed a bottom
selection card covering the style picker and attribution, despite the picker still having an
in-viewport bounding box. Keep the card above the wrapped controls and constrain its scrollable
height (`web/src/style.css`); `web/tools/review-fan.mjs` checks card/toolbar separation and actual
style selection. OSM `building=yes` is an unspecified building, so display “Building”, not the raw
tag value (`web/src/ui.ts`). The layout is checked at 390 × 844; reassess with new toolbar rows.

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

Future architecture work: see [shared asset definitions](IMPROVEMENTS.md#deferred-shared-asset-definitions-requested-2026-09-09)
for the requested registry linking appearance, placement, detail levels and data requirements.
