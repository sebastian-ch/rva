# Better models and textures: what to do next, in order

Written 2026-09-14, after roof colour from orthoimagery landed. Companion to
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
| 2 | LoD2 roofs from the 2025 LiDAR (`roofer`) | **Upper Fan import/render passed** — 427/440 individual footprints reconstructed; city-wide batch next |
| 3 | Roof furniture from the 0.3 m DSM | not started |
| 4 | Ground cover from NAIP NDVI + nDSM | not started |
| 5 | Split-grammar facade geometry, lower two floors | not started |
| 6 | Wall colour and surveyed props from Mapillary | not started |
| 7 | Landmarks from HABS drawings and own photogrammetry | not started |
| 8 | CC0 prop libraries for vehicles and street furniture | not started |

## Ranking

| # | item | effort | payoff | why here |
|---|---|---|---|---|
| 1 | City LoD2 dataset check | XS | possibly huge | Half an hour that might make #2 unnecessary. Never build what a source already publishes. |
| 2 | LoD2 roofs from LiDAR | L | highest geometry win | Data is already on disk; `roofs.py`'s two-plane fit uses a fraction of a 0.35 m-spacing cloud. |
| 3 | Roof furniture from the DSM | M | high per unit of work | The 0.3 m DSM zip is already downloaded and used only for ad-hoc checks. Real HVAC, penthouses, water towers at real positions. |
| 4 | Ground cover from NAIP | M | high | The flat ground is weak spot #2 in IMPROVEMENTS.md. NAIP is already fetched for #0, NIR band included; NDVI is then free. |
| 5 | Facade grammar | M–L | high, city-wide | Applies to every building, not just landmarks. Gives the AO/outline pass in `postfx.ts` something to bite into. |
| 6 | Mapillary walls and props | M | medium | The only legal source that sees a facade — but CC BY-SA is share-alike, so settle that before building on it. |
| 7 | Landmark modelling | L | high but narrow | 12 landmarks out of thousands of buildings. Art time, not pipeline time. Do it when the ordinary buildings stop being the weak link. |
| 8 | CC0 prop libraries | S | medium | Cheap, but props are not what a viewer notices first. |

Items 2–5 are independent and can proceed in any order or in parallel; 6 depends on a licensing
decision, not on code.

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

There is also a public 2020
[`Building_multipatch.lpkx`](https://www.arcgis.com/home/item.html?id=ca6b4ff707fc47a3b3715d3cc9e673c3)
(140 MB). It contains 162,691 GDAL-readable 3D TIN features in a FileGDB, but inspection showed an
older flat-topped extrusion product with feature edits through July 2020, not the 2022 segmented-roof
source behind the SceneServer. It is useful for archaeology and coverage checks, not the production
geometry path.

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

## 3. Roof furniture from the 0.3 m DSM

**Why:** `web/src/roofDetails.ts` scatters HVAC boxes procedurally. The 0.3 m DSM
(`va2025_richmond_J1448889.zip`, already downloaded, currently used only for ad-hoc checks via
`/vsizip/`) sees the actual boxes, penthouses, elevator overruns and water towers.

**Approach:** normalize the DSM against the roof plane fitted in #2 (or against the current
`roof_height`), threshold residuals above ~1 m, connected-component the blobs, and emit each as an
oriented bounding box in building-local coordinates.

**Implementation sketch:**
- `pipeline/roof_furniture.py`, run inside the buildings step after roofs resolve.
- New tile field: a small array of `{dx, dz, w, d, h, az}` per building, or a separate `roof_props`
  layer if the arrays get large. Cap the count per building — this is set dressing, not a survey.
- `roofDetails.ts` draws the surveyed boxes where present and keeps the procedural scatter otherwise.

**Risk:** it is easy to produce noise. Require a minimum footprint area (~4 m²) and height (~1 m) per
blob, and remember these are seen from an isometric camera — anything under a metre will never read.

## 4. Ground cover from NAIP

**Why:** IMPROVEMENTS.md weak spot #2 — "the ground is one flat colour with contours". No texture
fixes this well; **resist draping a photograph**, which would destroy the flat-shaded look in one
commit. Derive polygons instead and colour them from `palette.json`.

**Inputs:** `data/raw/ortho_<slug>.tif` (already fetched for roof colour, NIR band included) and the
LiDAR nDSM.

**Approach:**
- NDVI from the NIR band separates vegetation from paving with no classifier at all.
- nDSM height splits vegetation into canopy (already handled by `vegetation.lidar_canopies`) and
  ground-level growth: lawn versus bed versus rough grass.
- Low NDVI plus low nDSM is impervious: parking aprons, plazas, rail yards. Intersect with city
  parcels to find parking lots that OSM has not mapped.
- Polygonize with `rasterio.features.shapes`, simplify hard, and append to `landuse` as new kinds.

**Implementation sketch:** `pipeline/groundcover.py` plus a `Step` reading `landuse` and `water`;
extend `schema.LANDUSE_KINDS`; add palette keys and area colours in `web/src/areas.ts`.

**Risk:** over-fragmentation. Simplify aggressively and drop polygons under ~20 m² — this is a
stylized map, not a land-cover product.

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
