# How to improve this, and what others are doing

A field guide for the next rounds of work. Written 2026-09-09 after Phases 1–4 and two firming-up passes.
Where a claim is about someone else's project it comes from public docs or a search on the day; check
before relying on it.

## 1. Where this project stands

Strengths: real heights and roofs for 97% of buildings (LiDAR + Overture + OSM + zoning), the whole river with
correct bridge decks, a facade shader that reads as storefronts and offices, streamed tiles built in workers,
ten procedural landmark models, and a measurable pipeline (QA report, schema validation, fixture tests).

Weak spots, roughly in the order a viewer notices them:
1. Everything is still an extrusion. Landmarks are massing, not models; ordinary buildings have no entrances,
   bays, balconies or roof furniture beyond HVAC boxes.
2. The ground is one flat colour with contours. No sidewalk texture, no lawns vs beds, no plazas, no parking
   stripes, no rail yards.
3. Trees are two shapes, props are sparse, there are no people at street level in numbers.
4. Roads now include bus lanes, topology-trimmed ribbons, evidence-based crossings and rounded junction fills,
   but still lack lane arrows and source-derived median/curb polygons.
5. Lighting is one sun; no ambient occlusion pass, no colour grading, no outline.
6. Interaction is basic: no search, no deep links, no minimap, no time-of-day.

## 2. Techniques worth borrowing

### Building reconstruction (data side)
- **LoD2 roofs from LiDAR + footprints, done properly.** TU Delft's `roofer` (the engine behind 3D BAG, all
  10 M Dutch buildings) reconstructs LoD1.2/1.3/2.2 roofs from a point cloud and a footprint: plane detection,
  roof-part graph, then a watertight model. It is open source and takes exactly the inputs we already have
  (USGS EPT cloud + OSM/Overture footprints). Replacing `roofs.py`'s two-plane fit with roofer output would
  give real hips, dormers and split-level roofs, and City3D is an alternative with a similar contract.
  A 2025 ISPRS benchmark on LoD2 reconstruction from aerial LiDAR + footprints (IGN LiDAR HD) is the place to
  compare methods. Sources: [roofer](https://github.com/3DBAG/roofer),
  [3D BAG overview](https://www.eurosdr.net/sites/default/files/images/inline/12-3dbag-nl.pdf),
  [benchmark](https://isprs-archives.copernicus.org/articles/XLVIII-1-W6-2025/83/2025/).
- **Height sources are converging.** Overture now carries heights from several providers; Google's Open
  Buildings 2.5D adds height for footprints outside OSM coverage. Keep the resolution order but add sources
  as they appear; the QA report tells you when a source stops mattering.
- **OSM `Simple 3D Buildings` tags** (`building:part`, `roof:*`, `min_height`) are honoured only partly here
  (parts are dropped). Rendering parts as separate extrusions is the cheapest big win for downtown towers with
  setbacks. Reference: [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings).

### Rendering (what the good-looking OSM renderers do)
- **F4 Map, OSM2World, OSM Buildings** are the long-running OSM 3D renderers; OSM2World in particular has a
  mature model of roads (lanes, kerbs, junction areas as polygons, crossings, tram tracks) and of building
  parts. Its approach to junctions — build the junction as an area polygon from the incoming road widths,
  then trim the roads to it — is what our squared-off ends approximate. Reference:
  [OSM 3D development](https://wiki.openstreetmap.org/wiki/3D_development).
- **Vector-tile stylised maps** (PMTiles + three.js, with volumetric clouds and raymarched lighting, updated
  June 2026) show the atmospheric direction: fog gradients, soft clouds, colour grading, a fixed sun with
  long shadows. Cheap to add here: a post pass with vignette/grade, screen-space AO, and an outline pass.
- **MapLibre / Mapbox fill-extrusion** is the mainstream baseline for 3D buildings; our pipeline already
  exceeds it on height quality, so it is a data-export target rather than a rendering model.
- **osm2threejs (2026)** is a pure-Python OSM → three.js generator with six roof topologies; useful to
  compare its roof code and export format with ours. Sources:
  [osm2threejs](https://pypi.org/project/osm2threejs/0.12.0/),
  [3d-maps topic on GitHub](https://github.com/topics/3d-maps).
- **CityEngine** (Esri, proprietary) remains the reference for procedural facades: CGA grammars split a
  facade into floors, bays, windows and ornaments. Our shader does one level of that; a grammar-driven
  geometry facade for landmarks and for the first two floors of everything is the "designed" look the plan
  asks for. Reference: [CityEngine](https://en.wikipedia.org/wiki/CityEngine).

### Art direction (the "little worlds" look)
- Hand-placed detail beats procedural everywhere the camera lingers: tour stops, the riverfront, Capitol
  Square. Put art time there first.
- Colour: limit palettes per district (Fan = brick and slate, Downtown = concrete and glass, Manchester =
  brick and steel) so neighbourhoods read at a glance. `palette.json` already supports this by adding keys.
- Motion: cars and buses exist; add pedestrians walking on sidewalks, trains on the rail lines, a river with
  visible flow near the rapids, flags, and a day/night cycle rather than a toggle.
- Sound and micro-interaction are what people remember in these maps: a soft click on selection, a camera
  ease that overshoots slightly, a label that fades in.

## 3. Concrete next steps, ranked by return on effort

| # | Item | Effort | Why now |
|---|---|---|---|
| 1 | Render OSM `building:part` and `min_height` as separate extrusions | S | **Done 2026-09-09:** 126 parts, 42 covered outlines drawn as plinths; James Center's three towers now rise from their shared podium |
| 2 | Screen-space AO + outline + colour grade post pass | M | **Done:** `postfx.ts` — depth-difference contact AO, depth-edge outline, warm/cool grade, vignette; `o` toggles it |
| 3 | Prebuilt road and junction surface topology with curb radii | M | **In progress:** topology-aware trimming/fills and crossing attachment are live; canonical source-derived curb polygons, medians and turn lanes remain |
| 4 | roofer-based LoD2 roofs replacing the two-plane fit | L | Real roof forms on every building; inputs already exist |
| 5 | Facade grammar (geometry) for the ground floor: doors, storefront frames, awnings, steps | M | The plan's kit-of-parts, done where the camera sees it |
| 6 | Ground detail: sidewalk paving tint, lawn vs bed, parking stripes, rail ballast | S | **Partly done:** world-space mottle on land/terrain (`groundDetail.ts`), painted stall lines on surface parking; paving tint and ballast open |
| 7 | Pedestrians on sidewalk paths, trains on rails | M | **Half done:** walkers ping-pong along sidewalk strips and footpaths (`addWalkers`); trains open |
| 8 | Search, deep links, minimap, time-of-day (ROADMAP Phase 5) | M | Shareability |
| 9 | Widen to The Fan / Church Hill with per-district palettes (Phase 6) | M | **Fan done 2026-09-10:** expanded data and QA coverage are live; Church Hill-specific palette/content pass remains |
| 10 | CI with the smoke test and snapshot diffs (Phase 7) | S | Keeps the polish from regressing |

### Deferred street-level data additions

After the streetlight pass, consider these additions in roughly this order:

- Fire hydrants from `emergency=fire_hydrant`, preferring a Richmond municipal inventory when it is
  more complete than OSM.
- GRTC stop poles and shelters using `highway=bus_stop`, `public_transport=platform`, `shelter=*`,
  `bench=*`, and `covered=*`; replace the current generic person marker.
- Bicycle racks from `amenity=bicycle_parking`, including rack type and capacity where available.
- Traffic-calming geometry from `traffic_calming=*`, especially raised tables, humps, and islands.
- Bollards, waste baskets, parking meters, utility poles, and overhead lines at close detail only.
- Murals, public art, memorials, and historic markers with distinct low-poly treatments.

Treat OSM street-furniture coverage as opportunistic rather than complete. Compare counts and spatial
coverage with Richmond open data before using absence as evidence, and keep dense small props out of
reduced-detail tiles.

## 4. Measuring "better"

- Keep `pipeline/tiles_inspect.py validate` and `data/tiles/qa.md` green after every data change.
- Keep three reference snapshots (default, capitol, river) and diff them in CI; a visual regression is a
  failed build.
- For each art change, screenshot the same four views (`tools/snap.mjs`) before and after and keep the pair
  in the PR.


## Deferred: shared asset definitions (requested 2026-09-09)

Add one reusable asset definition that connects **appearance, placement, detail levels, and data
requirements**. Build it on top of the existing systems rather than replacing them.

Current pieces to connect:
- `web/src/props.ts`: reusable meshes and asset kinds.
- `web/src/scatter.ts`: deterministic placement and exclusion rules.
- `web/src/propPool.ts`: instancing, capacity and tile ownership.
- Building/road/land geometry builders and the landmark model registry.
- `web/src/styles/`: the existing visual-style definition and registry.

A definition should identify its geometry/model provider, supported style/material behavior, placement
rules, required/optional source fields and fallback policy, visibility/geometry at each detail level,
and resource ownership/capacity/cleanup. Keep source provenance and measured versus illustrative
properties explicit. This should coordinate these systems through adapters, not force every kind of
asset into the same mesh or placement algorithm.

Motivating regression: reduced-detail tiles omitted all props, accidentally removing trees; fixed
instance limits also silently dropped trees. An asset's detail policy and capacity behavior should be
explicit and testable rather than consequences of unrelated tile-level branches.

Start incrementally with trees and one contrasting asset such as a bench or aircraft. Verify stable
placement across detail transitions, no missing instances, correct unload/reload cleanup and style
switching. This is a **future task, not implemented** as part of the current road/bus-lane fixes.


## Faster local rendering and iteration (reviewed 2026-09-10)

Profile before choosing changes:
measure cold startup, data fetch/cache time, worker geometry construction, GPU upload, frame time,
landmark loading, and automated screenshot time separately. Distinguish software-rendered browser QA
from the interactive GPU-backed viewer; improvements to one may not improve the other.

Completed:
- `build_tiles.py --layers roads,crossings,rail` (with `--roads-only` kept as an alias) rewrites only those tile
  files while preserving all other tile layers: about 12 seconds. Every other layer is augmented after its
  processor runs and is rejected by name rather than written half-finished.
- The LiDAR roof surface is reduced once and cached (`lidar.py`): 310 M raw points become ~8 M top-of-cell points
  inside the padded footprints, queried through a sorted cell-key index instead of a KD-tree over the whole cloud.
  `process_buildings` fell from 90 s to 16 s; the cKDTree build alone had been 51 s of every run.
- nDSM footprint statistics run in a process pool with a serial fallback: 5.3 s to 1.8 s, identical output.
- `layer_cache.py` caches the processed layers as GeoParquet, fingerprinted on every raw source, every
  layer-implementing module and the build options. A full Richmond build is 63 s cold and **20 s** when only the
  tiling/QA/viewer side changed, against about 130 s before this work. Verified byte-identical against
  `--no-cache` across all 3,683 tile files.

Measured (2026-09-11, expanded Richmond, 24.4 k footprints):

| stage | before | after |
|---|---|---|
| `process_buildings` | 90.2 s | 15.9 s |
| all layers | 103.7 s | 29.1 s |
| full build, layers unchanged | ~130 s | 20.0 s |
- The viewer already builds tile geometry in four workers, transfers typed arrays without copying, streams two
  detail levels, merges each tile layer into one mesh, instances repeated props, and disposes unloaded geometry.

Measured expanded-Richmond payload (625 tiles, 2026-09-10): 69.0 MB GeoJSON plus 5.8 MB JSON. POIs are
24.5 MB, buildings 21.0 MB, roads 14.7 MB, land use 6.4 MB, terrain 3.4 MB, and crossings 1.8 MB. All ten
landmark GLBs together are only 0.18 MB, so landmark compression is not a useful near-term target.

Viewer startup (2026-09-11): the wire cost is not the problem -- the whole map is 8.3 MB gzipped (75.7 MB
raw), and GitHub Pages does serve `.geojson` with `content-encoding: gzip`. The startup path was:
- `boot()` awaited `index.json` and then `landmarks.json`, two serialized round trips before the first tile
  could be requested, and `landmarks.json` was fetched a second time by `loadLandmarkTargets`. Both now come
  from one in-flight request started before the index, and a region with a configured `initialTarget`
  (Honolulu) never waits on it at all.
- `landmarkModels.ts` pointed the Draco decoder at `gstatic.com`: a third-party DNS + TLS handshake for about
  101 kB gzipped, while Vite was already bundling a decoder that nothing fetched. Dropping `setDecoderPath`
  uses three's defaults, which resolve to our own base-relative `/rva/assets/` copies (~79 kB gzipped).
- `index.html` preloads `tiles/index.json` and `tiles/landmarks.json`, so they overlap the 223 kB gzipped
  bundle download instead of waiting for it to parse.
Still unmeasured: frame time, worker geometry build time and the request waterfall, which need a browser
profile rather than static analysis.

Next candidates, in order:
- Encode POIs/trees as a compact binary point table (quantized tile-local x/y, kind, height and crown fields).
  This attacks the largest payload and avoids parsing tens of thousands of repeated GeoJSON property names.
- Bake reduced-detail tile meshes offline and apply meshopt compression plus quantized attributes. Keep the
  current worker builder as the development/fallback path and retain small feature sidecars for picking.
- Preserve indexed terrain geometry through the worker payload instead of expanding it to triangle soup. The
  regular 26×26 grid has substantial vertex reuse; flat-shaded building and road meshes have less.
- Generalize selective rebuilding only where dependencies are explicit. A fingerprinted processed-layer cache
  should include source files, region/options and implementation files so stale LiDAR, hydro or city data cannot
  silently survive a rebuild.
- Add `renderer.info.render`/`renderer.info.memory`, frame-time percentiles, transferred bytes and JSON parse time
  to the existing debug statistics before changing worker count, shadow quality or resident-tile limits.
- Add saved focused preview views and a small local tile set for a single asset/intersection.
- Offer an explicit draft preview quality preset for shadows, postprocessing and distant detail;
  keep full-quality verification before shipping.
- Reuse browser sessions and loaded assets during visual iteration; measure hot-reload behavior.
- Track representative timing/memory baselines so faster iteration does not hide missing assets or
  change the final rendering semantics.

References: Three.js recommends `InstancedMesh` to reduce draw calls and explicit disposal for streamed resources;
its `BufferGeometry` supports indexed vertices. Three.js recommends glTF/GLB for runtime delivery and supports
Draco, KTX2 and meshopt through `GLTFLoader`. Khronos recommends vertex/index reordering, quantization, mesh
instancing and GPU-compressed textures for real-time glTF. Apply those techniques where the measurements justify
their decoder and pipeline complexity.

- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Three.js BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)
- [Three.js cleanup guide](https://threejs.org/manual/en/cleanup.html)
- [Three.js glTF loading workflow](https://threejs.org/manual/en/loading-3d-models.html)
- [Three.js GLTFLoader compression hooks](https://threejs.org/docs/pages/GLTFLoader.html)
- [Khronos real-time asset creation guidelines](https://github.com/KhronosGroup/3DC-Asset-Creation/blob/main/asset-creation-guidelines/RealtimeAssetCreationGuidelines.md)
- [Khronos meshopt compression guidance](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_meshopt_compression/README.md)
- [Khronos mesh quantization](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
