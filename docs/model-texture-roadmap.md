# Better models and textures: what to do next, in order

Written 2026-09-14, after roof colour from orthoimagery landed; last reconciled 2026-09-25. Companion to
[docs/IMPROVEMENTS.md](IMPROVEMENTS.md), which surveys what other projects do; this file is the
ordered build plan for *this* repo's model and surface quality.

The framing that matters: **heights are the solved part.** OSM height → levels → 2025 LiDAR nDSM →
Overture → zoning → type default, with stale-footprint and small-footprint guards, is a better height
stack than most public 3D city projects have. What is still invented is everything *about the surface*:
colour, material, roof form beyond gable-or-flat, and any geometry below the extrusion's silhouette.
Rank accordingly — do not spend effort re-deriving heights.

## Status

| | item | state |
|---|---|---|
| 0 | Roof colour from NAIP orthoimagery | **done** — `pipeline/ortho.py`, [notes](ortho-roof-colour.md) |
| 1 | Check for a published city LoD2 / multipatch dataset | **done 2026-09-14** — found and evaluated; insufficient as a city-wide roof replacement |
| 1a | Targeted Esri footprint exception audit | **done 2026-09-14** — eight exact-ID replacements accepted after LiDAR and overlap checks |
| 2 | LoD2 roofs from the 2025 LiDAR (`roofer`) | **done 2026-09-14** — 19,927 citywide roofs imported with measured and geometric quality gates |
| 2a | Large-building setback / massing audit | **done 2026-09-14** — 1,175 candidates reviewed; seven stable multi-height cases modeled |
| 2b | Sports-field surface geometry | **done 2026-09-14** — tennis, baseball, football and soccer surfaces and tile-stable markings |
| 3 | Roof furniture from dense LiDAR | **done 2026-09-25** — 223 measured objects on 114 buildings; citywide candidates from `pipeline/roof_furniture_review.py`, 150 reviewed, 35 rejected |
| 4 | Ground cover from VGIN RGB + NAIP NIR + nDSM | **done 2026-09-14; refined 2026-09-15** — 4,000 cleaned lawn, paving and bare-ground polygons |
| 5 | Split-grammar facade geometry, lower two floors | **done 2026-09-21** — `web/src/facadeGrammar.ts`; street frontages from the tile's road centrelines, five rule sets, LOD 0 only, per-tile triangle budget |
| 6 | Wall colour and surveyed props from Mapillary | **props: streetlights and poles done 2026-09-25 from the city survey** (no Mapillary); wall colour not started |
| 7 | Landmarks from HABS drawings and own photogrammetry | not started |
| 8 | CC0 prop libraries for vehicles and street furniture | not started |

## Original ranking

| # | item | effort | payoff | why here |
|---|---|---|---|---|
| 1 | City LoD2 dataset check | XS | possibly huge | Half an hour that might make #2 unnecessary. Never build what a source already publishes. |
| 2 | LoD2 roofs from LiDAR | L | highest geometry win | Data is already on disk; `roofs.py`'s two-plane fit uses a fraction of a 0.35 m-spacing cloud. |
| 3 | Roof furniture from dense LiDAR | M | high per unit of work | The existing 0.35 m classified point cloud resolves real HVAC, penthouses and water towers at real positions. |
| 4 | Ground cover from VGIN RGB + NAIP NIR + nDSM | M | high | The flat ground is weak spot #2 in IMPROVEMENTS.md. The three sources separate sharp boundaries, vegetation and elevated objects. |
| 5 | Facade grammar | M–L | high, city-wide | Applies to every building, not just landmarks. Gives the AO/outline pass in `postfx.ts` something to bite into. |
| 6 | Mapillary walls and props | M | medium | The only legal source that sees a facade — but CC BY-SA is share-alike, so settle that before building on it. |
| 7 | Landmark modelling | L | high but narrow | 12 landmarks out of thousands of buildings. Art time, not pipeline time. Do it when the ordinary buildings stop being the weak link. |
| 8 | CC0 prop libraries | S | medium | Cheap, but props are not what a viewer notices first. |

The remaining items 3 and 5 are independent, although the order above still reflects expected visual payoff.
Item 6 depends on a licensing decision, not on code.

## Immediate next step

Items 1–5 are done. Streetlights and utility poles in item 6 came from the City of Richmond luminaire and pole
surveys instead of Mapillary (see §6). Wall colour still depends on the CC BY-SA decision. Cheaper steps first: an
assessor-based era and type prior (the city's assessor layer has year built and building type for about 69,000 parcels), then
per-address materials from the National Register district inventories. Item 8 (CC0 vehicles and street furniture) is the cheapest
code-only step. Item 7 is art time.

A by-product of item 3 worth following up: flat roofs whose LiDAR roof plane sits more than
`ALIGN_TOL_M` (1.5 m) from the modeled wall top, such as The Edge at ATC (+2.4 m), are probably wrong heights or unmodeled
tiers. They are candidates for `overrides.json` or `richmond-massing.geojson` rather than roof furniture.

---

## 1. Check for a published city LoD2 dataset

**Do this first.** Some Virginia localities publish 3D building models (multipatch / CityGML) through
ArcGIS. If Richmond does, item 2 collapses from weeks to an import.

Where to look: the ArcGIS REST service directory behind
`https://richmond-geo-hub-cor.hub.arcgis.com`, for a SceneServer or a multipatch FeatureServer, and
VGIN's statewide catalogue for the same. `pipeline/fetch_richmond.py` already knows how to talk to
that portal.

**Result, checked 2026-09-14:** Richmond publishes a public
[`urban_BuildingMultipatch` SceneServer](https://tiles.arcgis.com/tiles/k3vhq11XkBNeeOfM/arcgis/rest/services/urban_BuildingMultipatch_2/SceneServer)
and includes it in the public
[`Citywide Scene`](https://www.arcgis.com/home/webscene/viewer.html?webscene=e582ac1e3d8a48e39c87b81e151ab4b6).
The item covers the city, was created in May 2022, and says its roof polygons were segmented from
LiDAR. It exposes building/eave/base height, roof form, roof direction and RMSE attributes. It is
unlisted in the Richmond GeoHub search, which is why the first portal/service-directory searches
missed it; an ArcGIS Online search scoped to organization `k3vhq11XkBNeeOfM` found it. VGIN's public
catalogue did not expose another Richmond 3D-building source.

This is not a substitute for item 2. Deduplicating the leaf-node attributes produced 128,454 unique
objects: 127,246 `Flat`, 817 `Gable`, 390 `Hip`, and one blank. Our much smaller current map slice
already has 6,626 non-flat roofs, so importing the City layer wholesale would erase useful roof
shape rather than improve it. Keep the service as a comparison source and consider its 1,207 pitched
objects as selective candidates after spatial/date validation.

An Upper Fan geometry comparison found a narrower use for the city layer. Its 405 subtype-1 objects
preserved individual attached buildings that the default pipeline reduced to 323 rows, including 53
merged rows representing 405 source members. Against classified 2025 LiDAR points, the city footprint
union had a slightly better proxy F1 (0.824 versus 0.798). That does not make its mostly-flat roof mesh
better. It does support preserving source-footprint segmentation for Roofer rather than reconstructing
one roof across a merged rowhouse block.

The city outlines are not generally more complex. Among 126 high-confidence one-to-one Upper Fan
matches, the city outline retained at least two additional corners after 0.15 m simplification in 16
cases, our outline did so in 24, and 86 were within one corner. Median simplified complexity was five
corners for the city versus six for ours. Adopt a city outline only when its added bay, wing or setback
has independent LiDAR support; the measured general win is segmentation, not vertex count.

A follow-up large-building exception audit found five useful outline replacements. Classified 2025
LiDAR building-point proxy F1 improved from 0.902 to 0.918 for the grouped VCU College of Engineering,
0.906 to 0.926 for Main Street Parking Garage, 0.657 to 0.673 for Richmond Dairy Apartments, 0.899 to
0.917 at 1113 Moore Street, and 0.847 to 0.865 at 1 West Jackson Street. These exact-ID corrections live
in `assets/supplements/richmond-esri-outlines.geojson`; current metadata, heights and styles remain in
place. VMFA's city and OSM outlines were effectively tied (0.972 versus 0.971), so its visible deficit
was height massing rather than its perimeter.

A focused Shockoe riverfront review added three more exact-ID replacements: Terrace at The Masonry,
Canal Lofts Phase V and Trinity Methodist Church. Their classified-2025-LiDAR proxy F1 scores improve
from 0.927 to 0.970, 0.869 to 0.897 and 0.892 to 0.920. Candidates were rejected when the city outline
merged separately modeled buildings, filled a courtyard, overlapped a neighbor, or would mismatch an
accepted Roofer shell. These checks matter more than the raw score: the largest apparent gains in the
area were mostly segmentation differences rather than missing architecture.

A citywide audit of 1,175 large, tall or named buildings then reviewed broad nDSM height clusters against
the current footprint overlaps and OSM parts. Seven stable massing cases are now explicit base and upper
parts in `assets/supplements/richmond-massing.geojson`: VMFA, Delta Hotels, the Greater Richmond Convention
Center Annex, The Virginia Home, the Trani Center for Life Sciences, BioTech 6 and the Pocahontas Building.
VMFA uses ordinary procedural parts rather than a landmark glTF so its façade treatment stays consistent
and its silhouette does not change after an asynchronous model load.
The Marriott and RMA garage/tower blocks already contain separate overlapping tower footprints; CoStar's
second band is rooftop equipment, and the Coliseum's band is a curved roof rather than a setback.

There is also a public 2020
[`Building_multipatch.lpkx`](https://www.arcgis.com/home/item.html?id=ca6b4ff707fc47a3b3715d3cc9e673c3)
(140 MB). It contains 162,691 GDAL-readable 3D TIN features in a FileGDB, but inspection showed an
older flat-topped extrusion product with feature edits through July 2020, not the 2022 segmented-roof
source behind the SceneServer. It is useful for archaeology and coverage checks, not the production
geometry path.

**Detailed-object follow-up, 2026-09-14:** the citywide SceneServer contains one `BIM=Yes` object and 20
`CustomMultipatch=Yes` records. The BIM object is Richmond City Hall (`OBJECTID 68275`, `Building_71606`);
its 152-triangle scene leaf and 24-triangle source multipatch proved too coarse for the visible landmark. The
authored `richmond-city-hall` model instead uses the city object's reviewed base dimensions, the OSM tower part,
and recognizable architectural framing, replacing the overlapping OSM masses together. The 20 custom records form five sites rather than 20 independent
buildings: Children’s Hospital of Richmond at VCU, the VCU Health Outpatient Facility, the VCU College of
Health Professions area, Gateway Plaza, and Dominion Energy HQ. Review those groups individually before
import because several records are separate massing pieces and their `CustomMultipatch` flag does not by
itself establish that they beat the current 2025-LiDAR/OSM model.

The Richmond ArcGIS organization also exposes a small `Manchester Test 2` project. Its Existing Buildings
scene contains 1,142 features with about 64,000 vertices, while the `Objects Paste` scene is a highly detailed,
textured design-model layer over roughly one block. The latter is project content, not an authoritative
citywide building source. Both scenes were mirrored on 2026-09-14 under
`data/raw/manchester_test_2/` (about 2.94 GiB total), including node pages, geometry, shared materials,
textures and item/service metadata. Raw caches remain gitignored.

The public [Manchester ArcGIS Urban and CityEngine](https://www.arcgis.com/home/item.html?id=1712ec210fb94a3eb4e5471818ad3a23)
Web Scene also contains a hidden group named
`Rendering Example (geometry not fully correct)`. It combines the already-cached `Objects Paste` layer with
`Random` (two texture-test features, 20 triangles total) and `Spaces` (833 low-detail planning masses and
5,771 triangles across four meshes). The scene definition itself is cached under
`data/raw/manchester_test_2/rendering_example/`.
`Random` is a material demonstration and `Spaces` is scenario massing; neither improves the current building
geometry. Keep `Objects Paste` as a reference for selective streetscape assets, and do not substitute the
three-layer rendering example for surveyed footprints or LiDAR roofs.

The related [Manchester Urban Design Database](https://www.arcgis.com/home/item.html?id=494a43abc50d4e30a8426dbfb4fcfd2d)
is planning data rather than another detailed building source. Its `Models` table (layer 19) contains only three
nonspatial analysis configurations: shadow cast, elevation profile and viewshed. The useful geometry is 928
parcels, 22 scenario zone polygons and 1,646 proposed floor/use `Spaces`; `LOD1Buildings` is empty. The parcel
rule columns are mostly blank because ArcGIS Urban stores defaults on the related zone type. The canonical
adapter in `pipeline/planning.py` selects one branch, inherits those zone-type rules, preserves parcel overrides,
and records field-level provenance. For `Scenario 1` this produces 845 parcel height/floor caps and 922 coverage
and tiered-setback definitions; this scenario supplies no FAR or skyplane values. Use these layers for a future
proposed-buildout or setback mode, not to replace present-day footprints or LiDAR roofs. Cached source files live
under `data/raw/manchester_test_2/urban_design_database/`; the normalized output is
`data/raw/canonical_planning_constraints.parquet`.

## 2. LoD2 roofs from the 2025 LiDAR

**Why:** `pipeline/roofs.py` fits two planes and reports flat / gable / hip / skillion. The 2025 City
of Richmond cloud is 0.35 m pulse spacing (~10 pts/m²) — enough for dormers, split levels, cross
gables and real hip geometry.

**Inputs, all present:** `data/raw/lidar_<slug>.npz` (already reduced to a top-surface cloud by
`lidar.surface_cache`), plus the footprints.

**Pilot, 2026-09-14:** Roofer 1.0.0 ran against a 56 MB depth-9 subset of the 2025 NOAA LAZ and 355
actual processed footprints in the Upper Fan (316 OSM, 39 Richmond gap fills). It emitted LoD2.2
solids for 345 footprints (97.2%); 314 were classified as slanted, with a median of 37 vertices per
CityJSON feature and a 1.3 MB result. The 10 fallbacks had unusable/insufficient point coverage.
Reconstruction took about seven seconds, so packaging and conversion are now the work, not model
fitting. A first attempt also proved that one degenerate ring aborts a whole Roofer tile: validate
each footprint, remove zero-area fragments and isolate rejected buildings before invoking it.

The corrected unmerged run submitted 440 individual footprints and produced 427 usable roof shells:
384 slanted, 28 horizontal and 15 multiple-horizontal. Thirteen `unknown` results had no usable roof
surface and retained the fallback. All 427 matched current source IDs and rendered across eight tiles.
The Fan browser QA passed without roof/wall seams or console errors; full-tile worker build stayed at
27 ms p95 in the Upper Fan view.

**Citywide run, 2026-09-14:** depth-8 EPT was too sparse for broad adoption: median density 7.0
points/m², median no-data 32% and median LoD2.2 RMSE 1.04 m. Fetching depth 9 raised density to 22.6
points/m², reduced no-data to 3% and reduced RMSE to 0.55 m. Of 25,486 reconstruction units, 22,238
clear the attribute gate: recognized/usable roof, density ≥5 points/m², no-data ≤45%, and RMSE ≤1.25 m.
After geometry validation and source-ID joining, 19,927 of the map's 25,533 building records use the
measured roof; the remaining 5,606 retain the existing roof. The geometry gate rejects 87 shells over
20 m tall, 106 shells containing roof planes over 70°, 369 shells covering less than half of their footprint,
and 1,675 small-building shells with more than three fitted ridgelines. These cases expose unsupported
walls, triangular spikes, over-segmented houses, or large flat gaps in the hybrid renderer. Detailed meshes are rendered only in the
near tile level, while distant tiles use the procedural shape to cap geometry and worker cost. Browser
QA passed across the Fan, Monroe Park, Capitol Square, all styles, and mobile layout. Upper Fan tile
worker p95 remained 28 ms. These gates live in `pipeline/lod2.py` and should be recalibrated for new data.

**VMFA exception:** its otherwise strong Roofer result measured 22.1 points/m², 1.1% no-data and 0.69 m
RMSE, but correctly spanned more than 20 m of roof relief. That is unsafe for the roof-only hybrid because
its upper tiers would lack walls. A five-part landmark model instead uses nested 2025 LiDAR height masks:
a 6 m low perimeter, 15.8 m main mass, 19.5 m north wing and 21.5 m upper volume. This is the right scope for
setbacks: large recognizable buildings with clear, stable height zones. Applying the same segmentation
to ordinary buildings would add noise, excess geometry and false architectural detail.

**Import/render, 2026-09-14:** `pipeline/lod2.py` reads Roofer CityJSONSeq, reprojects its source CRS,
keeps LoD2.2 roof surfaces and short internal closure faces, and joins each compact indexed mesh by
source ID. `layer_steps.py` caches that enrichment separately. `buildings.ts` projects and triangulates
each 3D face on its dominant plane, retaining the existing walls, facade shader, roof colour and picking
ranges. Buildings without a valid reconstruction retain the procedural roof. The presence of Roofer
output disables rowhouse merging because those meshes are keyed to individual source footprints.

**Approach:** [`roofer`](https://github.com/3DBAG/roofer) (TU Delft, the engine behind 3D BAG) takes
exactly a point cloud plus a footprint and emits a watertight LoD1.2/1.3/2.2 model. City3D is the
alternative with a similar contract.

**Implementation sketch:**
- New `pipeline/lod2.py` wrapping the roofer CLI. The CLI requires classified LAS/LAZ, so it cannot
  consume `lidar.PointCloud.within(geom)` or the reduced NPZ directly. Reuse/download the EPT LAZ
  nodes that intersect the run extent; the successful pilot confirms class 2/6 data and CRS 3748 are
  accepted without conversion when the footprints are written in the same CRS.
- Output is a mesh, not a shape enum — this is the first pipeline layer whose payload is geometry.
  Roofer's CityJSONSeq gives each source `OBJECTID` back as `source_id` and labels `RoofSurface`,
  `WallSurface`, and `GroundSurface` boundaries. Convert its LoD2.2 roof surfaces to compact
  per-building local vertices/faces that `buildings.ts` can render above the existing walls. Do not
  emit a glTF per tile: that would bypass the style system and complicate streaming.
- `roof_source` gains `"lod2"`; `DATA_FORMAT.md` and `schema.py` follow.
- Cache as its own `Step` in `layer_steps.py` reading `buildings`.

**Risks:** roofer is a C++ build with its own dependency tree; budget time for packaging before any
geometry appears. Keep the two-plane fit as the fallback for footprints it declines.

**Done when:** QA report shows a `roof_source` histogram with `lod2` as the plurality, and a Fan
rowhouse block renders with distinguishable dormers.

## 3. Roof furniture from dense LiDAR

**Why:** `web/src/roofDetails.ts` scatters HVAC boxes procedurally. The existing 0.35 m classified
2025 point cloud sees actual boxes, penthouses, elevator overruns and water towers. The previously noted
0.3 m DSM archive is not present locally; the pilot used the denser and already cached point source directly.

**Approach:** normalize the dense top surface against the roof plane fitted in #2 (or against the current
`roof_height`), threshold residuals above ~1 m, connected-component the blobs, and emit each as an
oriented bounding box in building-local coordinates.

**Implementation sketch:**
- `pipeline/roof_furniture.py`, run inside the buildings step after roofs resolve.
- New tile field: a small array of `{dx, dz, w, d, h, az}` per building, or a separate `roof_props`
  layer if the arrays get large. Cap the count per building — this is set dressing, not a survey.
- `roofDetails.ts` draws the surveyed boxes where present and keeps the procedural scatter otherwise.

**Risk:** it is easy to produce noise. Require a minimum footprint area (~4 m²) and height (~1 m) per
blob, and remember these are seen from an isometric camera — anything under a metre will never read.

**Pilot result, 2026-09-14:** 30 named flat roofs between 800 and 7,500 m² were screened. Model-alignment,
edge-inset, size, compactness and height gates accepted 20 objects on SunTrust Mortgage, University Student
Commons, Maggie L. Walker High School, The Edge at ATC and Richmond Public Library. A Federal Building
candidate was rejected because an existing higher building part covers it.
The renderer accepts both compact serialized records and decoded GeoJSON arrays, emits each object only in
the tile fragment containing its center, and disables procedural HVAC for every fragment of an accepted
building. Tests: `pipeline/tests/test_roof_furniture.py` and `web/src/roofDetails.test.ts`.

**Citywide result, 2026-09-25:** `pipeline/roof_furniture_review.py` ran the detector over all 2,265
visible flat roofs ≥ 300 m² (after skipping 87 under mapped parking polygons) in about 30 s. It dropped 238 objects
the accepted Roofer shell already models, and wrote contact sheets (LiDAR residual beside the NAIP crop)
for the 150 buildings left with candidates. Review rejected 35: construction sites in NAIP that the 2025
LiDAR already shows built, a treatment basin, a storage tank, parking decks the parking gate missed, boxes that are
fragments of a large raised block, strips along parapets and roof edges, roofs mis-typed as flat, and the
hand-modeled massing plinths and tiers. `attach` dropped two more because a taller `building:part` covers them.
The supplement now holds 223 objects on 114 buildings. Full-detail tile builds for the 85 affected tiles take
882 ms in total, against 877 ms with procedural HVAC; the worst tile costs 1 ms more. LOD1 omits roof details,
so the baked LOD1 geometry does not change.

Two gate changes came out of the rerun. Heights have moved since the pilot, so three of its five buildings failed
the 0.75 m alignment gate between the LiDAR roof plane and the modeled wall top. The tolerance is now
`ALIGN_TOL_M` = 1.5 m, and objects still sit on the modeled roof. On an accepted Roofer shell, the review
driver seats each object on the mesh surface under its centre instead of using the plane offset.

## 4. Ground cover from imagery and LiDAR

**Why:** IMPROVEMENTS.md weak spot #2 — "the ground is one flat colour with contours". No texture
fixes this well; **resist draping a photograph**, which would destroy the flat-shaded look in one
commit. Derive polygons instead and colour them from `palette.json`.

**Inputs:** `data/raw/vbmp_<slug>.tif` for sharper leaf-off RGB boundaries, the NIR band in
`data/raw/ortho_<slug>.tif`, and the LiDAR nDSM.

**Approach:**
- NDVI from the NIR band separates vegetation from paving with no classifier at all.
- nDSM removes canopy and other elevated objects already handled by buildings or vegetation.
- Low NDVI plus low nDSM identifies impervious and bare surfaces such as parking aprons, plazas and
  rail yards; VGIN RGB separates brown bare ground from paving.
- Polygonize with `rasterio.features.shapes`, simplify hard, and append to `landuse` as new kinds.

**Implementation:** `pipeline/groundcover.py` plus a cached `groundcover` step reading buildings, roads,
landuse and water;
extend `schema.LANDUSE_KINDS`; add palette keys and area colours in `web/src/areas.ts`.

**Risk:** over-fragmentation. Simplify aggressively and drop polygons under 90–120 m² — this is a
stylized map, not a land-cover product.

**Result, 2026-09-14:** the Richmond pass uses a 3 m classification grid, morphological cleanup,
1.5 m polygon simplification and 90–120 m² minimum areas. It emitted 4,369 lawn, 3,083 paved and 195
bare-ground polygons covering 6.42 km². Existing mapped landuse, buildings, roads and surveyed water
mask the derived classes. A holdout check against mapped areas classified 91.6% of answered parking/plaza
pixels as paving and 73.9% of answered park/grass/cemetery pixels as lawn; parks also contain paths,
trees and structures, so their remaining answered pixels are not all errors. Browser QA across VCU,
Shockoe, the riverfront and the Fan kept tile-worker p95 below 50 ms with no console errors.

## 5. Split-grammar facade geometry

**Why:** `web/src/facade.ts` already does windows, sills, cornice and storefront in the shader, which
is one level of a CGA-style grammar. What no shader can add is silhouette: entrances, bays, recessed
storefronts, balconies, projecting cornices — the things the AO and outline passes in `postfx.ts`
respond to. And this applies to *every* building, which is why it outranks landmark modelling.

**Approach:** a small rule set keyed on `type`, `height`, floor height and frontage length, run on the
lower two floors only (which is all an isometric camera sees in detail). Split each street-facing wall
into bays, then emit geometry per bay: recessed glazing, a door bay at the widest gap, a cornice band
at the floor line.

**Implementation sketch:** extend `web/src/buildings.ts` in the tile worker (`tileBuild.ts`), next to
the existing `addSevenElevenFacade` special case — which is the prototype for this, and should
collapse into the general rule set once it exists. Reduced-detail tiles skip it, exactly as the
7-Eleven facade already does.

**Risk:** polygon budget. Measure against the streaming worker pool before rolling it out city-wide;
gate on tile detail level from the start rather than retrofitting.

**Which wall faces the street?** Use the road ribbon geometry already in the tile, not a guess.

### Built 2026-09-21

`web/src/facadeGrammar.ts` runs inside `extrudeBuilding`, after the walls and before the roof details.

- **Frontage.** `buildStreetIndex` puts the tile's road centrelines (no tunnels, no bridge decks) in a
  22 m grid in local coordinates. A footprint edge at least 6 m long is a frontage when the nearest
  street point lies on its outward side (direction cosine ≥ 0.35). The two longest qualify; the
  entrance and the awnings go on the longer one. Roads are clipped to the tile while buildings are
  owned by centroid, so a building at a tile edge can lose its street and fall back to shader-only.
- **Rules**, keyed on the existing `facadeParams` style, with the ground-floor height from OSM levels
  where they agree with the height: retail (5 m bays, shopfront glazing, seeded awnings, recessed
  entrance), office (4 m bays, deeper plinth, no awnings), residential (4.4 m bays, punched window
  sills and heads, stoop and door canopy), industrial (7 m bays, roll-up door), parking (5.5 m open
  bays between piers, no glazing or entrance). Every frontage gets a plinth, bay piers, a lintel band
  at the ground-floor line, and a cornice at the second-floor line where a third floor rises above it.
- **Cost.** Each element is four faces, never a box: an isometric camera sees no underside and no
  back, and the top is dropped where another band sits on it. A frontage is ~90–130 triangles. On a
  synthetic 250 m tile of 104 street-fronting buildings the grammar added 9,848 triangles and 12.8 ms
  of worker build time (node, warm median, against a 3,032-triangle / 5.4 ms baseline). In the viewer
  on a pathological all-corner grid (64 buildings per tile, two frontages each) resident triangles went
  from 37.1 k to 70.2 k over four tiles and tile build time from ~107 ms to ~168 ms p50 — but that is
  headless SwiftShader, where the no-grammar baseline is already ~15× slower than node, so treat it as
  a ratio, not a budget. `FACADE_TRI_BUDGET` caps the grammar at 20,000 triangles per tile; past the
  cap the remaining buildings keep the shader-only facade.
- **Gating.** `tileBuild.ts` passes roads only at LOD 0, so reduced-detail tiles are untouched. Parts
  whose `min_height` is above the pavement, buildings under ~2.6 m of ground floor and style `NONE`
  are skipped, as are the two hand-modelled branded storefronts.

Not done: balconies, bay windows, and collapsing `addSevenElevenFacade` / `addCaryMcDonaldsFacade`
into the rule set. Those two are brand-specific models (stripe bands, arches, pole signs); folding
them in would lose the branding for no triangle saving.

## 6. Wall colour and props from Mapillary

**Settle the licence first.** Mapillary imagery is CC BY-SA 4.0. Share-alike propagates to a derived
dataset, so publishing per-building wall colours derived from it carries the licence with them.
Decide whether that is acceptable for this project *before* writing code — it is a project decision,
not an engineering one, and `ATTRIBUTION.md` now says plainly that nothing automated uses Mapillary
yet.

If yes, two uses, in order of value:

1. **Map-feature detections** (`/map_features` API): surveyed positions for traffic signs, street
   lamps, benches, hydrants, poles. This replaces scattered props in `scatter.ts` with correct ones
   and is far easier than the colour work — no image processing, just a point fetch and a join.
2. **Facade colour**: sample images by camera pose, project the building's street-facing wall, take a
   robust median. Much harder than the roof equivalent — occlusion by parked cars, trees, and other
   buildings; wildly varying exposure; oblique geometry. Expect worse coverage than the ortho roof
   work, and keep the same discipline: return nothing rather than a confident wrong colour.

**Done without Mapillary, 2026-09-25:** the City of Richmond publishes GNSS surveys of streetlight fixtures (12,653
in the bbox) and poles (15,742, with material, height and owner). `pipeline/streetlights.py` snaps each luminaire
to its pole and emits 8,417 arm-mounted `streetlight`s, 3,934 decorative `lamp_post`s and 10,191 wooden
`utility_pole`s. Points on the rendered asphalt move to the curb, and the 147 more than 4 m in are dropped. It drops 285 OSM lamps the survey duplicates. The survey skips most of Southside, so procedural
lamps are suppressed per road (`lamps_surveyed`, 69% of major-road length) rather than region-wide. Signs,
hydrants and benches remain Mapillary-only. Checked for facade sources on the same pass: VBMP imagery at
0.15 m is corrected nearly straight down, so an 81 m tower shows only a sliver of wall and rowhouses show none.
Aerial imagery does not replace street-level photos for wall colour.

## 7. Landmarks from HABS drawings and own photogrammetry

The 12 files in `assets/landmarks/` are massing generated by `blender/build_landmark.py`, not models.
Best inputs, in order:

- **HABS measured drawings** (Historic American Buildings Survey, loc.gov, public domain). Dimensioned
  elevations are far better modelling input than photographs. Richmond's historic core is well covered
  in general; per-landmark coverage is unverified — check before budgeting the time.
- **Own photogrammetry.** Meshroom or RealityCapture, decimate hard, retopologise to a few thousand
  triangles, bake AO into vertex colour so the result survives the style registry in `web/src/styles/`.
  The only route to detail nobody has published.
- **Wikimedia Commons** via the `wikidata` field already in `landmarks.json` — automate pulling
  CC-licensed reference photos per landmark.

**Do not** use Google Photorealistic 3D Tiles or Street View, or Mapbox imagery, for anything but
looking at. Their terms forbid derived datasets, and photogrammetric mush would fight the palette
anyway. `README.md` already states this; keep it true.

## 8. CC0 prop libraries

Quaternius, Kenney and Poly Haven ship CC0 low-poly glTF. Cheaper than modelling cars and benches.
Override their materials against `assets/palette.json` rather than shipping their textures, so the
style registry keeps working.

---

## Two standing rules

**Prefer polygons and geometry over photographic texture.** Every item above that could be done with
a photo drape is instead specified as derived polygons or rule-driven geometry. The project's
identity is flat-shaded low-poly; a photo texture anywhere on the ground or the walls reads as a
different map, and it would defeat the style registry in `web/src/styles/`.

**A source that is documented but unused is a bug.** Before this round, `ATTRIBUTION.md` claimed NAIP
was used "for roof color sampling and land cover" and Mapillary for "machine extraction", and neither
appeared anywhere in `pipeline/` or `web/src/`. Attribution is a compliance record; keep it matched to
the code, including the honest "not used yet" entries it now carries.
