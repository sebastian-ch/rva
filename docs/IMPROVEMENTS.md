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
4. Roads are visually right at a distance but have no lane arrows, no median islands, no bus lanes, and
   junction geometry is squared rather than curbed with radii.
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
| 3 | Junction areas as polygons (OSM2World style) with curb radii | M | Fixes the last road artefacts and enables medians and turn lanes |
| 4 | roofer-based LoD2 roofs replacing the two-plane fit | L | Real roof forms on every building; inputs already exist |
| 5 | Facade grammar (geometry) for the ground floor: doors, storefront frames, awnings, steps | M | The plan's kit-of-parts, done where the camera sees it |
| 6 | Ground detail: sidewalk paving tint, lawn vs bed, parking stripes, rail ballast | S | **Partly done:** world-space mottle on land/terrain (`groundDetail.ts`), painted stall lines on surface parking; paving tint and ballast open |
| 7 | Pedestrians on sidewalk paths, trains on rails | M | **Half done:** walkers ping-pong along sidewalk strips and footpaths (`addWalkers`); trains open |
| 8 | Search, deep links, minimap, time-of-day (ROADMAP Phase 5) | M | Shareability |
| 9 | Widen to The Fan / Church Hill with per-district palettes (Phase 6) | M | Content |
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


## Deferred: faster local rendering and iteration (requested 2026-09-09)

Investigate ways to shorten the edit → rebuild → render → inspect loop. Profile before choosing changes:
measure cold startup, data fetch/cache time, worker geometry construction, GPU upload, frame time,
landmark loading, and automated screenshot time separately. Distinguish software-rendered browser QA
from the interactive GPU-backed viewer; improvements to one may not improve the other.

Candidates to evaluate:
- Rebuild only changed layers/tiles instead of rerunning unrelated building/LiDAR processing.
- Cache derived geometry using input and implementation fingerprints, with correct invalidation.
- Add saved focused preview views and a small local tile set for a single asset/intersection.
- Offer an explicit draft preview quality preset for shadows, postprocessing and distant detail;
  keep full-quality verification before shipping.
- Reuse browser sessions and loaded assets during visual iteration; measure hot-reload behavior.
- Track representative timing/memory baselines so faster iteration does not hide missing assets or
  change the final rendering semantics.

This is a future investigation, not an implemented performance feature.
