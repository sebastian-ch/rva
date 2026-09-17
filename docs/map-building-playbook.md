# Map-building playbook: lessons to carry to the next city

Traffic density must be conserved across the loaded road graph. Seed each new edge only once, admit ongoing
traffic at degree-one entry boundaries using a flow rate derived from density and free-flow speed, and despawn
vehicles at degree-one exits. Re-filling every interior edge from its current occupancy double-counts vehicles
as they move between edges; stochastic fractional per-edge targets also turn every short clipped segment into a
one-vehicle minimum. `web/src/traffic/sim.test.ts` includes a 100-segment ring regression for this failure mode.

Sports pitches need to retain their source `sport` and `surface` tags through processing. Mapping every
`leisure=pitch` polygon to anonymous grass discards the information needed for recognizable courts and fields
and can also make non-surveyed regions scatter park trees onto playing surfaces. Keep a distinct `pitch` kind.
Compute the marking frame from the full source feature before tile clipping, then clip the decoration into each
fragment; deriving orientation from each fragment produces seams and half-fields. Segment long paint strips so
they follow terrain rather than sinking through it. Fall back to an unmarked sports surface for unsupported
sports. Tennis complexes may contain several courts inside one outline. For baseball, find home where the two
long foul-line boundary runs meet; the sharpest vertex may just be a short chord on the outfield arc. Regressions live in
`pipeline/tests/test_sports_fields.py` and `web/src/areas.test.ts`.
An anonymous enclosing pitch may overlap a separately mapped typed court. Cut the specific court geometry out of
the generic surface; rendering both coplanar fills produces triangular z-fighting shards.

An enclosing park polygon can still show through a correctly preserved pitch when the park's vertical lift is
higher. Give pitch surfaces explicit priority above parks, then put paint above the pitch. Treat a surface tag as
a material unless it actually includes a color: `tartan` and `rubber` do not imply red. Richmond's blue Cary
court IDs are a reviewed VGIN exception in `web/src/areas.ts`; recheck imagery rather than carrying those IDs or
colors to another region. A baseball dirt fill should follow a rounded arc between the two foul directions. A
four-corner home/first/second/third polygon reads as an artificial square and leaves turf wedges around second.

Ground-cover extraction needs complementary imagery rather than the sharpest image alone. VGIN's Richmond
RGB is sharper and leaf-off, so it supplies clean lot and material boundaries; NAIP's coarser four-band image
supplies NIR, which separates vegetation more reliably; LiDAR nDSM removes roofs and tree crowns. Classify on
a coarse grid, clean it morphologically, simplify at the grid resolution and reject small components before
polygonizing. Subtract buildings, road widths, water and preserved semantic landuse with their source vector
geometry afterward. Rasterizing those exclusions first leaves one-cell stair steps around every object.
Vector subtraction can split one large classified region into many small wedges; reapply the minimum-area
gate to each resulting polygon, since checking only the combined MultiPolygon lets blocky courtyard remnants survive.
Complementary imagery may have different acquisition dates. Strong bare-soil evidence in the newer RGB must
override vegetation in older NIR imagery, or recently cleared construction sites render as blocky lawns. Keep
that veto narrow enough that ordinary dormant grass is not relabeled from weak colour evidence alone, and follow
the newer RGB boundary rather than repainting the entire stale NIR component with its blocky outline.
Raster cleanup and simplification alone can still leave conspicuous orthogonal corners at overview zooms. Apply
bounded vector smoothing before subtracting surveyed exclusions, so inferred outer edges soften while roads,
buildings, semantic landuse and water keep their exact source boundaries.
Treat confident imagery classes as a local partition: extend the nearest class across only short, low-height
NDVI-deadband or shadow gaps. Leaving those cells unknown separates related patches with conspicuous base-ground seams;
broad uncertain regions must remain unclassified.
The 3 m classifier is also too coarse for narrow driveways and side yards: exclude inferred paving within 5 m of
building footprints and keep its palette close to the base ground. Broad unmapped lots still survive that clearance.
Imagery-derived classes fill gaps and may refine generic industrial land. Run the surveyed shoreline difference
after extraction because the base OSM water polygon may not cover the full river. The Richmond settings use a
3 m grid, 3 m simplification and 90–120 m² minimum areas. They produce 4,000 polygons and keep tile-worker p95
under 50 ms. Implementation:
`pipeline/groundcover.py`, `pipeline/fetch_vbmp.py` and `web/src/areas.ts`. Regressions:
`pipeline/tests/test_groundcover.py` and `web/src/areas.test.ts`. Thresholds depend on flight season, band order,
image tone and LiDAR date; recalibrate them for every region.

Live moving objects belong in a persistent scene group rather than streamed map tiles. Treat the feed timestamp,
expiry, coordinates, heading, speed and altitude as one contract; do not invent altitude for incomplete records.
Predict motion only for a short bounded interval, blend the next received correction, and keep reported positions
for reduced-motion users. Convert coordinates into the region projection. At city scale, literal cruising altitude
can put valid aircraft above the camera far plane: preserve the source altitude for information, but map it through
a documented monotonic display-height compression into the visible air band. Use an intentionally enlarged map symbol
when a true-scale vehicle would be unreadable. Pause must freeze both translation and model animation. The Richmond implementation
uses the cached `rva-live` aircraft endpoint in `web/src/aircraft.ts`; its current text-only altitude is handled by
a strict compatibility parser until the backend publishes numeric altitude and reference fields. A September 2026
regression rendered a valid 19,000-foot report about 9,200 scene units high, beyond the 6,000-unit camera far plane;
`displayAltitude` restores the 160–290 scene-unit band. Regressions live in `web/src/aircraft.test.ts`. Other live
feeds may use different time, altitude and coordinate semantics, and their display band must be recalibrated.

This is the reusable record of fixes learned while building Richmond and extending the regional map
viewer. Read it before adding a region, replacing elevation sources, or changing geometry/rendering.
Keep the general rules; recheck source-specific thresholds and assumptions for each place.

Planning controls and observed buildings need separate contracts. Height limits, floor caps, coverage, FAR,
setback tiers and skyplanes describe what a plan permits or proposes; they do not measure the structure currently
on the parcel. Normalize source-specific fields into a parcel constraints companion, retain the scenario/branch,
planning horizon and proposal status, and record provenance per populated field. When a system such as ArcGIS
Urban stores parcel overrides separately from zone-type defaults, resolve each field independently with the parcel
value first. Select one scenario branch before spatial joins: overlapping copies from multiple branches otherwise
look like conflicting rules. Missing FAR or skyplane values stay missing. Implementation and regressions:
`pipeline/planning.py` and `pipeline/tests/test_planning.py`. These constraints can drive QA or an explicit
buildout view, but must never silently replace observed footprint, LiDAR height or roof attributes.

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

### Procedural parapets require convex outlines

**Symptom:** a flat, concave building part gets an implausible diagonal or folded roof edge.
**Cause:** the procedural parapet's simple centroid-directed inset crosses a re-entrant corner.
**Rule:** emit that lightweight parapet only for convex rings. Keep the ordinary flat roof for concave
footprints until it has a topology-safe polygon offset implementation.
**Implementation / regression:** `web/src/roofDetails.ts`, `web/src/roofDetails.test.ts`.

Dedicated busways should likewise retain their surveyed centerline: do not expand their endpoints into
ordinary road junctions or admit them to generic traffic. The generic simulator has no route-aware transit
contract, so arbitrary cars on a short bus-only connector create visibly wrong turns. This applies to
`busway` / `bus_only` features, not marked bus lanes within an ordinary roadway. Implementation / regression:
`web/src/roads.ts`, `web/src/roads.test.ts`.

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

Do not apply island-connector or approach-ramp inference to pedestrian classes. A running trail can contain
several short, explicitly tagged wooden footbridges with ordinary ground path between them. Treating the full same-class path
as a connector lifts hundreds of metres of trail onto one artificial deck. Keep `path`, `footway`, `steps`,
`cycleway`, `pedestrian`, `track` and `bridleway` segments grounded unless the segment itself is tagged as a
bridge or boardwalk. Richmond's North Bank Trail exposed this; `test_bridge_decks.py` covers both the sequence
bridge → ground path → bridge and a ground trail touching a footbridge.

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

Large point layers should not pay GeoJSON's repeated geometry and property-key overhead. Store fixed-schema
points as a versioned binary table with quantized coordinates relative to the tile, a compact type code and a
deduplicated string table; decode it at the tile-worker boundary into the renderer's ordinary point-feature
contract. Keep the quantization precision at least as fine as the replaced output, reject points outside the
declared tile, and test both encoder and decoder. Treat the filename as part of the incremental tile contract:
the output fingerprint must force a rewrite and the new writer must remove the legacy file, or a deployment can
silently retain both payloads. Richmond uses `pipeline/poi_table.py` and `web/src/poiTable.ts`, with regressions
in `pipeline/tests/test_poi_table.py`, `pipeline/tests/test_build_tiles.py`, and `web/src/poiTable.test.ts`.

Fixed tree instance pools silently dropped placements beyond their limit (8,000 round trees). Tree
buffers now grow geometrically, retaining matrices and tile ownership; removing a tile still compacts
the grown buffer correctly. Regression: `propPool.test.ts`. Check expected placement counts against
rendered instances at a wide zoom; `tools/review-tree-loading.mjs` does this and verifies model URLs.
This fixes rendering omissions, not missing source observations or the intentional building/water filters.

## 6b. Imagery: a classifier that always answers is worse than one that abstains

Nadir orthoimagery is the only automated source that sees a roof, and it is the right source for roof
colour — but three things corrupt the reading, and each needs an explicit answer rather than a hope.
Orthorectification is against bare earth, so a roof leans off its own footprint by roughly
`height × tan(off-nadir)`; shrink the footprint inward by that estimate before sampling, and accept
that footprints too small to survive the shrink return nothing. A tree crown is greener than any roof;
reject vegetation pixels by NDVI when a NIR band exists, excess green otherwise, and abstain entirely
when most of the footprint is canopy. A neighbour's shadow drags the median dark; drop pixels far
below the footprint's *own* median luminance, never an absolute threshold, or every genuinely dark
roof gets rejected as shadow.

Classify by rule in a perceptual space rather than snapping to the nearest stylized swatch. A
photograph is nowhere near a stylized palette's saturation, so swatch distances are all large and
their ranking is noise — and nearest-neighbour has no way to say "I cannot tell", which is the most
valuable output when the pixel is a tree. Record the provenance in its own field so the QA histogram
shows coverage moving back to the guess when something regresses, and keep surveyed tags (OSM
`roof:colour`) ranked above the photograph.

Do not extend this to ground or wall *texture*. Derive polygons and colour them from the palette; a
photo drape reads as a different map and defeats the style registry.

**Implementation:** [ortho.py](../pipeline/ortho.py), [fetch_naip.py](../pipeline/fetch_naip.py),
[notes](ortho-roof-colour.md).
**Regression:** [test_ortho.py](../pipeline/tests/test_ortho.py).

## 7. Downloads and caches: missing is not empty

A failed Overpass request does not mean there are no benches, lamps or fountains. Preserve completed
layers, identify the failed layer, and retry it with a working public endpoint/transport. In this
session, cached main layers were available while the remaining request stalled; a successful later
request recovered the small-feature records. Do not turn a timeout into an empty successful cache.

Record source URLs, dates, attribution and known limitations. A live service's update timestamp does
not mean every observation was surveyed on that date. Check counts and coverage after fetching, then
rebuild: obtaining raw data alone does not update the viewer.

ArcGIS Hub search and an Enterprise REST directory are not complete inventories of an organization.
Richmond's public 3D building SceneServer was unlisted in GeoHub and absent from the city Enterprise
directory, but an ArcGIS Online search scoped to the city's organization id found it. For 3D-source
intake, search the organization directly by item type (`Scene Service`, `Layer Package`) and inspect
related items as well as Hub datasets. Then profile the actual attributes before adopting the source:
Richmond's model covered the city but labelled 127,246 of 128,454 unique objects as flat, so the
existence of a multipatch layer did not make it a useful city-wide LoD2 replacement. The source's
viewer appearance and item modification date are not substitutes for a roof-form histogram and data
vintage check. See [model-texture-roadmap.md](model-texture-roadmap.md) for the Richmond results.

Batch reconstruction tools can fail at tile scope even when one input feature is bad. Roofer rejected
an entire pilot tile because a valid-looking processed multipolygon contained a three-coordinate,
zero-area fragment after CRS conversion. Before handing footprints to an external reconstructor,
make them valid, retain polygonal components above a small area floor, verify each exterior has at
least three distinct vertices, and keep a source-id map for any split components. Run failures must
fall back per building rather than erase the whole tile. The cleaned Upper Fan pilot reconstructed
345 of 355 production footprints; the other ten retained the existing roof path because their point
coverage was insufficient.

Do not reconstruct one roof over a rowhouse merge made for rendering efficiency. In an Upper Fan
sample, 53 merged output rows represented 405 individual source footprints; Richmond's city scene
also retained 405 subtype-1 building objects there. A Roofer mesh belongs to its original source ID,
so preserve individual footprints whenever reconstruction output is present. Combine evidence by
surface: retain current footprint walls, styling and metadata; replace only the roof shell; fall back
per building. The city multipatch is a segmentation/check source here, not the roof source, because
nearly all of its citywide objects are labelled flat. Implementation: [lod2.py](../pipeline/lod2.py)
and [buildings.ts](../web/src/buildings.ts). Regression: `test_lod2.py` and `buildings.test.ts`.

Do not equate Roofer's `rf_success` with production quality. Richmond depth-8 output serialized most
buildings while flagging 24,212 of 25,486 units as insufficient coverage; its median RMSE was 1.04 m.
Depth 9 improved median density/no-data/RMSE from 7.0 points/m², 32%, and 1.04 m to 22.6 points/m²,
3%, and 0.55 m. Gate each mesh using the reconstruction attributes, retain the previous roof when it
fails, and recalibrate thresholds for a new survey. Richmond currently requires a recognized roof
type, usable cloud, density ≥5 points/m², no-data ≤45%, and LoD2.2 RMSE ≤1.25 m.
Render measured roof meshes only at the near tile level. The same building should use its procedural
roof in distant tiles so citywide LoD2 coverage does not inflate geometry that cannot be seen.

A low-RMSE roof can still be unusable in a hybrid wall/roof renderer. The first Richmond citywide import
accepted 87 mixed-height shells with more than 20 m of vertical relief, including a 49.25 m shell on a
6.4 m wall, and 369 partial shells covering less than half of their source footprint. These produced
unsupported upper walls or a small measured patch surrounded by a flat cap. Require projected roof
coverage of at least 50% and relief no greater than 20 m when retaining procedural exterior walls.
This rule applies to the hybrid importer; a renderer that keeps Roofer's complete exterior walls can
reassess it. Regressions: `test_implausibly_tall_roof_is_ignored` and
`test_partial_roof_keeps_existing_procedural_roof` in `pipeline/tests/test_lod2.py`.

Emit an attached roof mesh once per building feature, outside the per-polygon roof loop. Roofer can emit
multiple records for one multipart source and the viewer can receive a MultiPolygon. Keeping only the
last record loses components; drawing the combined mesh per polygon duplicates every component. Merge
same-source records within one CityJSONSeq batch, let later files replace older batches, and render the
result once. Regressions: `test_multipart_records_in_one_batch_are_combined` and the multipart case in
`web/src/buildings.test.ts`.

Normalizing every Roofer shell to its lowest roof vertex can lift the main ridge by several metres when
a porch or rear addition supplies that lowest point. The symptom is a rowhouse roof stretched into a tall
triangular wedge even though its RMSE is low. Preserve Roofer's lowest-roof height above its ground datum;
when that eave is below the procedural wall top, lower the whole shell by the difference and clamp the
buried portion at the wall top. Never raise a shell above the wall, because that opens a visible gap.
Reject corrections beyond 5 m: they collapse most vertices into triangular fragments and indicate incompatible
wall and roof datums. The 2218 and 2220 Monument Avenue shells exposed this limit. Regressions:
`test_low_addition_does_not_lift_the_main_roof` and `test_large_wall_alignment_keeps_procedural_roof` in
`pipeline/tests/test_lod2.py`.

RMSE also does not prevent over-segmentation. In the Richmond residential output, repeated odd triangles
came from examples such as `osm:way/369321554`, where Roofer fit 15 planes and 6 ridgelines to a 139 m²
house. Reject roof-labelled planes over 70° and let footprints below 300 m² fall back when Roofer reports
more than three ridgelines. Also reject a small shell when more than 5 m of relief is split across at least
nine planes plus a ridge. Medium footprints below 600 m² fall back when they exceed six ridges and nineteen
planes; `osm:way/369024988` exposed that second scale of fragmentation. These limits apply to the current
stylized hybrid; reassess them for a viewer that renders Roofer's full solid. Regressions:
`test_near_vertical_roof_plane_is_ignored`, `test_oversegmented_small_roof_keeps_procedural_fallback`,
`test_tall_complex_small_roof_keeps_procedural_fallback`, and
`test_oversegmented_medium_roof_keeps_procedural_fallback`.

An aggregate footprint comparison can hide the few buildings where an alternate source is materially
better. Rank large-building exceptions separately, but do not treat extra corners as accuracy: Richmond's
older multipatch often adds sub-metre edge serrations. Require exact source-ID matching and independent
newer evidence before replacing an outline. A classified-LiDAR building-point proxy found five Richmond
exceptions with 0.016–0.020 F1 gains; `apply_footprint_replacements` changes only their geometry and
preserves current metadata and heights. Regression: `test_verified_footprint_replacement_keeps_source_row_metadata`.
Before accepting a candidate, intersect the alternate-only area with every other current building and part.
A strong score can mean that the alternate source merged several correctly separated buildings. Also reject
an outline that fills a real courtyard or materially changes the footprint under an already accepted roof-only
mesh. Shockoe's focused review accepted three procedural-roof cases and rejected the larger numerical gains for
these reasons; its source IDs and measured scores are recorded in `assets/supplements/richmond-esri-outlines.geojson`.

Model setbacks only when the height evidence contains broad, stable tiers. VMFA's perimeter was already
as accurate as the city outline, while its single 9.6 m extrusion hid measured 6, 15.8, 19.5 and 21.5 m masses.
Nested polygons derived from classified 2025 LiDAR now drive normal building parts. Keep this treatment to
large campuses, podium towers and recognizable civic buildings; a citywide threshold pass would turn
roof equipment, trees and reconstruction noise into invented architecture. Implementation:
`assets/supplements/richmond-massing.geojson` and `apply_massing_parts` in `pipeline/process.py`. Prefer
these procedural parts when the correction is massing alone: an asynchronous landmark glTF swap made the
highly concave VMFA outline look like a dark blank slab and temporarily displayed the wrong silhouette.

A Richmond-wide follow-up demonstrates the required review step. A two-band scan flagged 158 of 1,175
large, tall or named footprints, but many signals were courtyards, a separate overlapping tower, sloped
roofs, garage ramps or mechanical penthouses. Add general-purpose parts only after checking the spatial
height mask, current overlaps and existing OSM parts. Seven verified cases now use exact-ID base and upper
parts in `assets/supplements/richmond-massing.geojson`: VMFA, Delta Hotels, the Greater Richmond Convention
Center Annex, The Virginia Home, the Trani Center for Life Sciences, BioTech 6 and the Pocahontas Building.
`apply_massing_parts` keeps the parent as a selectable plinth and renders each tier over its recorded
height interval. Regression: `test_verified_massing_hides_outline_and_adds_tiers`.

Dense roof residuals can turn cars, trees, parapets, roof edges and setback tiers into fake rooftop
equipment. The symptom is large or floating boxes that disagree with the visible roof. Fit the dominant
roof plane, inset the footprint before component labeling, gate component area, height, compactness and
aspect ratio, then compare its absolute base with the modeled wall or accepted Roofer shell. Emit only
reviewed exact-ID records and leave uncertain buildings unchanged. GeoJSON writers may decode a serialized
record array, so the renderer must accept both a JSON string and an array; otherwise measured objects vanish
and procedural HVAC silently returns. Implementation: `pipeline/roof_furniture.py`,
`assets/supplements/richmond-roof-furniture.json` and `web/src/roofDetails.ts`. Regressions:
`pipeline/tests/test_roof_furniture.py` and `web/src/roofDetails.test.ts`. The current thresholds were tuned
for Richmond's 0.35 m 2025 classified cloud and mostly flat roofs; remeasure them for other resolutions,
roof types or cities.

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

**Symptom:** a newly exported landmark GLB appears to make no visual difference. **Cause:** the
generated `data/tiles/landmarks.json` still has `model: null`, so the viewer retains the procedural
building and never requests the GLB. **Rule:** after adding or changing a landmark model entry, run
the tile build and confirm the resolved manifest contains the expected model path before judging the
geometry in the browser. Then refresh the viewer; a GLB fingerprint only invalidates the asset URL,
not a stale resolved-landmark manifest. The six-storey Foundry Park South at CoStar's Richmond campus
exposed this. At normal oblique distance, judge public high-signal cues such as its stepped planted
terraces separately from visibility lost behind a taller neighboring tower. This is a landmark-build
dependency rule, not evidence that an occluded facade is inaccurate.

## 7b. Build caches and partial rebuilds: a fingerprint is part of the contract

Reducing a large source once and caching the result is usually the cheapest available speed-up, but the
cache key has to name everything the result depends on. `lidar.py` reduces the 310 M point cloud to the
top point per 1 m cell inside the padded footprints (~8 M points) and stores it beside the source npz;
the key covers the npz, `lidar.py` itself, the cell size and a fingerprint of the footprint set, because
a footprint added later needs cells that the previous reduction never kept. Do the reduction on the
*whole* cloud before masking by cell, not on points pre-filtered by polygon: masking by cell keeps every
point of a kept cell, so the per-cell winner is the same one a whole-cloud pass would choose. Break ties
in that reduction deterministically (x, then y) or the cached answer depends on input order and roof
classifications wobble between runs. Regression: `pipeline/tests/test_lidar_index.py`.

`layer_cache.py` and `layer_steps.py` apply the same rule to the processed layers, one step at a time. Each
processor and each augmentation (city decks, the surveyed shoreline, canal banks, the tree merge, the Honolulu
coast) is a `Step` cached on its own key: the raw sources it declares, the code it runs, its options, and the keys
of the steps that produced the layers it reads. `deps.py` resolves the code part statically: for the functions a
step names it hashes the top-level definitions they reach in their own module (so `process_roads` and
`process_buildings` do not share a key even though both live in `process.py`) and whole files for every other
local module they import. The import fingerprint includes the imported symbol as well as its module, so changing
an alias from one helper to another cannot preserve a stale key. Content hashes, not mtimes, mean a checkout that
restores identical code keeps the cache warm. Two things keep the analysis honest: `test_deps.py` rejects
`import *`, `globals()`, `eval` and `importlib` in layer modules, and a step's glue fingerprint follows the
top-level helpers it calls in `layer_steps.py`. When a step starts reading a new raw file, add it
to that step's `sources`; when it reads another layer, add it to `reads`, or its key will not move when the
upstream changes. Verify a new step by building twice, once with `--no-cache`, and diffing every tile file; the
first version of the old single-key cache silently dropped bridge `deck` lists, because parquet returns a list
column as an ndarray and `_write_layer` only serialized `list`.

Partial rebuilds are no longer a special case. Because the augmentations are steps, every layer that reaches the
tiling loop is complete, and the loop itself is incremental: each tile's layer file is keyed by an
order-independent digest of the features that intersect it (`layer_cache.row_digests`, normalised so a parquet
round-trip hashes the same as a fresh processor result), and only tiles whose digest moved are rewritten,
files whose layer left the tile are removed, and `index.json` counts are carried over for the rest. The old
`--layers` flag, which rewrote one layer's files everywhere and had to reject `pois`/`landuse`/`water`/`buildings`
by name (rewriting `pois` alone once cut its features from 81,854 to 9,682, every tree gone, with no error), is
gone. Regressions: `pipeline/tests/test_layer_cache.py`, `test_layer_steps.py`, `test_deps.py`, and the
incremental cases in `test_build_tiles.py`.

The rows are only half of a tile file's contract: clipping, ownership and GeoJSON serialization code determine
the bytes too. Include the `write_tiles` code fingerprint in every layer and terrain state key. Otherwise a
precision or clipping fix can report every tile as unchanged and silently leave the old files in place.
`STATE_VERSION` remains the escape hatch for a state-schema change, not the routine way to invalidate output
after code edits. Regression: `test_tile_code_change_rewrites_files_with_unchanged_rows`.

In the viewer, `__iso.refresh()` re-reads `index.json` and rebuilds the resident tiles (or one id) after a
pipeline run, keeping the old mesh until the new one lands; the URL hash tracks the camera every half second, so
the full page reload that every source edit costs (the tile workers are outside Vite's HMR graph) lands where you
were looking.

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

Large identity signs can use the same exact-ID procedural approach when text and silhouette matter more
than facade detail. Attach them to the actual visible upper building part, derive known dimensions from the
source, and render double-faced text with the back face mirrored. Verify at the roof's world elevation;
terrain exaggeration can make a camera aimed at the raw source elevation inspect the wrong roof. The John
Marshall marquee is implemented in `web/src/buildings.ts`, documented in `docs/richmond-fan.md`, and covered
in `web/src/buildings.test.ts`.

Thin open-frame lettering can exist in the mesh yet disappear at normal map scale. Keep skyline identifiers in
reduced-detail tiles, reduce internal scaffolding, and use a shallow contrasting panel when exact open steelwork
turns into visual noise. Test both geometry presence and a representative browser view. The Richmond sign uses
large `JMB` initials as a legibility-first approximation; this treatment is for distant identifiers, not signs
whose exact typography or transparency must survive a close architectural view.

Scene-layer flags can expose the few architectural exceptions hidden inside a mostly procedural city model.
Count and locate `BIM` and `CustomMultipatch` values before crawling meshes. Treat a BIM record as one import
candidate; group custom records by their source building because one site may be split into several masses.
When the current map has an outline plus inherited building parts, assign the landmark identity to the parent
before processing so the model swap removes every overlapping procedural mass. Normalize the imported mesh
to the current ground datum and center it on the matched parent footprint. Richmond City Hall also shows why a
source flag is insufficient: its BIM-flagged leaf is only 152 triangles and needed authored architectural detail
to read correctly. Other custom objects are not automatically newer or more accurate than current LiDAR.

Use the selective I3S importer for exact public SceneServer nodes. It delegates schema, vertex-layout and geometry
decoding to loaders.gl for directly addressable resources, then applies the layer's declared source CRS explicitly before anchoring the GLB to the
current footprint. Do not use loaders.gl's default lon/lat transform blindly: Richmond's building service stores
node centers in EPSG:3857, which makes that default transform invalid. Preserve an imported material only when
the texture contains useful architectural information and has been reviewed in the app; the normal landmark
path deliberately replaces materials so models participate in the shared map styles.

Treat publisher-labeled rendering examples as demonstrations until their component layers are measured.
Inspect scene visibility, source-layer extents, feature counts, vertex counts, textures and any accuracy note
in the scene itself. Richmond's Manchester example mixes a detailed streetscape layer with texture swatches
and low-detail planning masses, and explicitly says its geometry is not fully correct. That makes it useful as
a style/reference inventory, not a wholesale geometry source. Record the layer-level decision in the region
notes so a polished screenshot does not later override better surveyed inputs.

New construction can be absent from every routine footprint source even when its height is already
visible in LiDAR. In that case, retain a hand-reviewed footprint/height override, attach the landmark
identity directly to that override, and make the landmark registry target its exact generated ID.
Do not let a nearest-building fallback select an adjacent older structure on a tight campus. Model
only the confirmed footprint and public high-signal facade/crown cues; a polished rendering does not
establish every mullion or an adjoining building envelope. Richmond's CoStar Tower uses this pattern
in `assets/supplements/overrides.json`, `assets/landmarks/landmarks.json`, and
`blender/build_landmark.py`; `test_match_landmarks_explicit_id_does_not_fall_back_to_nearby_building`
guards the identity rule. This applies to override-created buildings, not ordinary mapped landmarks
whose stable source IDs are already available.

When a landmark looks too short, compare eaves, ridge, width and adjacent elevated infrastructure
separately. A correct peak with low eaves and an undersized footprint can still read too small.
Compare LiDAR absolute elevations against the model's ground datum before changing height; account
for terrain exaggeration without stretching architectural dimensions. Main Street Station exposed this.

**Symptom:** a hand-modeled building's stepped terraces face its service side after its footprint is
replaced. **Cause:** a local OBB axis was treated as a universal river/front direction. **Rule:**
project the named public street or frontage into the new local frame before placing setbacks, planted
terraces or a forecourt; verify the result in the map. Foundry Park South's Tredegar Street plaza is
the Richmond regression. This establishes frontage orientation for the reviewed site only, not a
survey of paving, planting, or outdoor furniture.

**Symptom:** multistorey garages render as generic offices or industrial blocks even when their source
names identify them. **Cause:** OSM often records a generic `building=yes` while storing “Parking Deck”
or “Garage” only in the name. **Rule:** normalize an explicit parking building value and generic named
parking/deck/garage structures to one semantic `parking` type in the processing pipeline; the renderer
then owns one open-bay concrete-deck style. Preserve a specific building type such as `apartments` even
when its name contains “garage.” Richmond implementation: `building_type` in `pipeline/process.py`,
with regressions in `pipeline/tests/test_process_helpers.py` and `web/src/facade.test.ts`.

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
