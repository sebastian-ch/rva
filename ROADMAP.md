# Roadmap — improvements after the first slice

Companion to `PLAN.md`. The first slice (Downtown + Shockoe Bottom + Capitol Square) renders end to end:
130 tiles, 2,234 buildings, roads, rail, parks, water, terrain, props, picking, tour, day/night.
This document lists what to improve, in priority order, with acceptance criteria so each item is testable.

Baseline numbers (2026-09-09):

| Metric | Value | Problem |
|---|---|---|
| Buildings with a real height (OSM `height` or `levels`) | 446 / 2,234 (20%) | 80% are type defaults. **Phase 1 done:** now 2,200 / 2,266 (97%) via Overture + LiDAR |
| Roof shapes not flat | 227 / 2,234 | most rowhouses show flat when they are gable. **Phase 1 done:** 417 non-flat, 722 LiDAR-fitted |
| Named buildings | 547 | info cards are mostly empty. **1.6 done:** 80% of buildings now carry an address |
| Landmarks matched to footprints | 9 / 12 in slice | bridges, canal walk, memorial unmatched. **1.5 done:** 12 / 12 resolved |
| Triangles on screen | ~1.24 M, ~135 draw calls | **Streaming done; scale target open:** the expanded Richmond geometry QA view is now about 3.6 M resident triangles |
| Tile payload | 6.8 MB GeoJSON | geometry is built on the main thread at load. **Phase 4 done:** built in 4 workers, main thread wraps in 0.2 ms per tile |

Effort key: S = under a day, M = 1–3 days, L = a week or more. "Delegable" marks tasks a smaller model
can do from a fixed spec.

---

## Phase 1 — Data quality (the plan's stated top risk)

### 1.1 LiDAR nDSM heights (L) — done, see `docs/phase1-impl.md`
The hook exists (`pipeline/lidar.py` reads `data/raw/ndsm.tif`). Fill it.
- Add `pipeline/fetch_lidar.py`: download VGIN LiDAR tiles (LAZ) intersecting the bbox, build DSM and DTM
  with PDAL (`pdal pipeline` JSON, or `laspy` + `numpy` binning at 1 m), write `ndsm.tif = DSM - DTM`.
- Use nDSM median for `default` buildings; also add `lidar_p90` so tall parapets do not skew the median.
- Acceptance: `default` share drops below 15%; a spot check of 20 buildings against street-level imagery is within 1 floor.
- Delegable: the DSM/DTM binning function and its tests once the LAZ download is working.

### 1.2 Overture buildings as a second height source (M) — done
- `pipeline/fetch_overture.py` using the `overturemaps` CLI or DuckDB over the S3 release; join to OSM footprints by
  centroid-in-polygon; take `height` / `num_floors` when OSM lacks them. Insert between `osm_levels` and `lidar`.
- Update `ATTRIBUTION.md` and `DATA_FORMAT.md` (`height_source: "overture"`).
- Acceptance: at least 300 additional buildings gain a non-default height.

### 1.3 LiDAR roof classification (M) — done (two-plane fit; straight-skeleton rendering still 2.2)
- Fit a plane and a two-plane gable to nDSM points inside each footprint; classify flat / gable / hip / skillion by
  residuals; record ridge azimuth so the viewer aligns the roof prism to the real ridge instead of the footprint OBB.
- Acceptance: rowhouse blocks in Shockoe Bottom show gables where imagery shows gables.

### 1.4 Data QA report (S, delegable) — done (`data/tiles/qa.md`)
- `pipeline/qa_report.py` writes `data/tiles/qa.md`: height-source histogram per tile, unmatched landmarks,
  buildings over 150 m, footprints under 15 m², roads with no width, tiles with no terrain.
- Run it at the end of `build_tiles.py`. Acceptance: the report is generated and linked from the README.

### 1.6 City of Richmond open data (S, delegable) — done
- `pipeline/fetch_richmond.py` pulls the city's address points (fill `addr` on unnamed buildings), street-tree
  inventory (replace scattered trees with surveyed positions and species), and zoning (better type defaults)
  from ArcGIS feature services. The Esri basemap tiles themselves stay reference-only.
- Bbox-clipped queries to Richmond's live `Structures` FeatureServer preserve edit dates and subtypes. Buildings
  gap-fill OSM; decks/patios render as separate low surfaces. The manual VGIN import remains an offline fallback.
- Acceptance: named/addressed buildings above 60%; surveyed trees replace scatter in the first slice.

### 1.5 Fix the three unmatched landmarks (S) — done (`pipeline/landmarks.py` → `data/tiles/landmarks.json`)
- Bridges and the canal walk are `kind != building`; add `way` matching against `roads`/`rail` lines and a
  `kind: "site"` polygon match for Tredegar. Maggie Walker memorial: match `pois` `historic=memorial` by name.
- Acceptance: all 12 in-slice landmarks resolve to a target the tour can fly to.

---

## Phase 2 — Look: from "extruded" to "designed"

### 2.1 Facade kit of parts (L) — done (procedural shader, see `docs/phase2-impl.md`)
The plan's key visual step. Recommended approach: a procedural facade shader, not geometry.
- Add a UV channel to walls in `buildings.ts` (u = meters along the wall, v = meters up) and per-vertex attributes
  for `levels` and `type`.
- Custom `ShaderMaterial` (or `onBeforeCompile` on `MeshStandardMaterial`) draws window grids in the fragment
  shader: window pitch by building type, ground-floor storefronts for `retail`/`commercial`, a cornice band at the
  top, no windows on party walls (walls shorter than 2 m or touching a merged neighbour).
- Night mode: randomly lit windows using `window_lit` from the palette, seeded per building.
- Acceptance: a screenshot of Broad Street reads as storefronts and offices, not boxes; frame time unchanged.

### 2.2 True roof geometry (M) — done (inset-ring hips, parapets, HVAC, chimneys, flat-with-clutter fits)
- Replace the OBB prism with a straight-skeleton roof (port a small skeleton implementation or use
  `straight-skeleton` from npm) for gable/hip on footprints with 4–8 vertices; keep the OBB fallback.
- Roof details: parapet lip on flat roofs over 12 m, 1–3 HVAC boxes on large flat roofs, chimneys on gables.
- Acceptance: L-shaped houses render a continuous ridge; no roof pokes through a wall.

### 2.3 Lighting and post (M) — done except the outline pass
- Directional shadow map fitted to the orthographic frustum (`camera.shadow.camera` sized to the visible tiles),
  soft PCF; cheap because there is no perspective.
- Optional outline pass (edge detection on normals/depth) for the "little worlds" look; toggle in UI.
- Water: animated stylized rapids on `river` polygons near the fall line (scrolling noise in a shader).
- Acceptance: buildings cast shadows on streets at the default view; 60 fps on an M-series laptop.

### 2.4 Road network fidelity (M) — in progress (rounded junction polygons and topology-linked crossings added 2026-09-10)
- Rounded junction polygons now replace square corner fills. Full buffered-centerline unions, explicit curb walls,
  turn pockets and source-backed median areas remain open.
- Replace per-tile ribbon inference with a canonical surface-topology build before tiling: node the at-grade road
  graph, buffer carriageway centerlines by their normalized widths, union compatible arms into one junction
  polygon, and derive curb/sidewalk rings from that surface. Generate tiles with a geometry buffer and assign
  one owner to seam geometry so clipping cannot change junction topology or double-render tile edges.
- Dashed lane markings are done. Crossings now carry their matched road centre, direction and width from the
  processing pipeline instead of relying on a runtime nearest-path guess. The canonical pass should clip each
  marking to its matched carriageway polygon and use `crossing:markings`, `crossing:island` and separately mapped
  islands when present. Turn arrows remain open; stop lines will render only when a source explicitly identifies them.
- Bridge decks with piers and railings for Mayo Bridge, the I-95 viaduct and the rail trestles; skip tunnels but
  draw portals.
- Acceptance: no z-fighting or seams at the Broad / 9th intersection; bridges are recognisable in the tour.

### 2.5 Props (S, delegable) — done
- Car body colour variants (per-instance colour attribute), buses on `bus_stop` routes, traffic lights at
  `highway=traffic_signals`, street trees along residential streets where OSM has none, Capitol Square fountains.
- Acceptance: prop counts per kind logged; no props inside buildings or on water.

---

## Phase 3 — Landmarks

### 3.1 Modeling pipeline proof (M) — done (headless `bpy`, see `docs/phase3-impl.md`)
- Model one landmark (Old City Hall or Main Street Station) in Blender using `blender/import_tile.py`, export with
  `blender/export_landmark.py`, verify the glTF swap in the viewer. Fix whatever the scripts get wrong; they have
  never run because Blender is not installed on the dev machine.
- Acceptance: `landmarks.json` has one `model` set and the viewer hides the placeholder extrusion for it.

### 3.2 Remaining in-slice landmarks (L, art time: 1–3 days each) — procedural first pass done for all 10 buildings; hand refinement open
Capitol, Jefferson, Federal Reserve, Monroe Building, Dominion tower, Carpenter Theatre, Main Street Station,
Old City Hall, Tredegar, Mayo Bridge, Belle Isle footbridge, Maggie Walker memorial.

### 3.3 Landmark polish in the viewer (S) — done
- Landmark label sprites at zoom ≥ 2, accent outline on hover, richer info card (Wikipedia summary + thumbnail via
  the REST API, CC BY-SA attribution shown).

---

## Phase 4 — Performance and scale

### 4.1 Precomputed geometry tiles (L) — deferred: payload math in `docs/phase4-impl.md`; revisit for LOD1 meshes only
Today the client parses GeoJSON and builds ~1.2 M triangles on the main thread. Move geometry to build time.
- `web/tools/bake-tiles.ts` (Node) reuses `buildings.ts`, `roads.ts`, `areas.ts`, `terrain.ts` to emit one
  `.glb` per tile with meshopt compression; keep `buildings.geojson` properties as a small JSON side-car for picking.
- Client loads GLBs with `GLTFLoader` + `MeshoptDecoder`; fallback to the runtime builder in dev.
- Acceptance: time-to-first-tile under 300 ms on a cold load; total payload for the slice under 12 MB.

### 4.2 Streaming and LOD (M) — done
- Load tiles by distance from the camera target, unload beyond a radius, cap concurrent fetches.
- LOD1 per tile: simplified buildings and roads, no facade/roof details or markings, and trees-only props past a
  zoom threshold.
- The original six-district acceptance target of 2 M visible triangles is not met; current expanded-region QA is
  about 3.6 M and is tracked in 4.4.

### 4.3 Web worker geometry (M) — done
- Run the tile builder in a worker, transfer `Float32Array`s. Acceptance: no frame over 50 ms during load.

### 4.4 Compact payloads and measured runtime budgets (M) — next
- Replace the 24.5 MB POI GeoJSON layer with a quantized binary point table; trees dominate the expanded-region
  payload and need only a small fixed set of placement fields.
- Bake meshopt-compressed LOD1 geometry offline before considering full-detail baked tiles. Preserve the current
  worker builder for development and fallback.
- Carry indexed terrain through worker transfer instead of expanding the regular grid to triangle soup.
- Report renderer memory/draw statistics, frame-time percentiles, parse time and transferred bytes in debug QA.
- Acceptance: document cold/hot load and mobile-class frame baselines; reduce expanded-region transferred tile
  bytes and resident vertex memory by at least 40% without changing the saved geometry views.

---

## Phase 5 — Interaction and product

- URL state: camera target, zoom, azimuth, selected building, night flag in the hash; deep links work. (S)
- Search box over building names, addresses and landmarks; fly-to on select. (S, delegable)
- Tour: ordered stops with per-stop camera azimuth and a timed autoplay; pause on user input. (S)
- Minimap: 2D canvas of the tile grid with the camera footprint; click to jump. (M)
- Touch: two-finger rotate is on; add pinch zoom sensitivity tuning and a mobile layout pass. (S)
- Accessibility: keyboard focus ring on buildings via tab order of landmarks; reduced-motion honours `prefers-reduced-motion`. (S)
- Data sources page (the attribution page from PLAN §8) rendered from `ATTRIBUTION.md`. (S, delegable)

---

## Phase 6 — Widen the area

- Multi-bbox builds: `build_tiles.py --slice fan|carytown|church-hill|scotts-addition|manchester` with per-slice
  bboxes in `config.py`, writing into the same grid so tiles line up. (S)
- Incremental builds: `--roads-only` is done (8–13 seconds versus about 130 seconds full); add fingerprinted
  processed-layer caches and other selective layers only with explicit dependency invalidation. (S)
- **Fan / VCU coverage done 2026-09-10** through the expanded Richmond build extent. Next: Carytown, Church Hill,
  Scott's Addition, and Manchester. Per-slice builds and input-hash incremental rebuilds remain open.

---

## Phase 7 — Engineering hygiene

- CI (GitHub Actions): `pytest`, `vitest`, `tsc`, `vite build`, plus a Playwright smoke test that loads the viewer
  against a committed 4-tile fixture and asserts tile count and a screenshot diff. The headless script from this
  session (`playwright-core` + Chrome with SwiftShader) is the starting point. (M, delegable)
- Lint: `ruff` for `pipeline/`, `eslint` + `prettier` for `web/`; pre-commit hooks. (S, delegable)
- Pipeline integration test on a tiny bbox (one block) with raw parquet committed as a fixture; asserts tile
  schema against `DATA_FORMAT.md`. (M)
- Static deploy (GitHub Pages or Cloudflare Pages) of `web/dist` with tiles, gzip/brotli on. (S)
- Fix the `THREE.Clock` deprecation (use `THREE.Timer`) and the `toNonIndexed()` warning in `props.ts`. (S, delegable)

---

## Suggested order

1. Phase 1.4 QA report and 1.5 landmark matching (cheap, unblock measurement).
2. Phase 1.1 LiDAR heights, then 1.3 roofs. Validate before investing in art, as PLAN.md says.
3. Phase 2.1 facade shader and 2.3 shadows: the two changes with the biggest visual return.
4. Phase 3.1 modeling proof, so landmark art can start in parallel with engineering.
5. Phase 4.1 baked tiles before widening the area in Phase 6.
6. Phases 5 and 7 throughout, as filler and as delegable work.

---

## Firming-up pass (2026-09-09, after Phases 1–4)

Fixed from a close-up review:
- Vehicles drove broadside: the car/bus body is modelled along +X but headings mapped travel onto +Z. Headings
  in `propPool.ts` and `scatter.ts` now use `atan2(-dz, dx)`; streetlight arms follow the same convention.
- Road edges bulged at every shared endpoint because junction discs were drawn on plain continuations. The
  interim conditional discs were later replaced by rounded, terrain-draped polygons at three-arm junctions.
- Crosswalks spanned a fixed 5 m; they now take the nearest road's width and orientation.
- Elevation is hard to read on the flat-shaded ground: faint contour lines every 5 m on terrain and land, a
  Heights view (hypsometric tint by absolute height on every layer, legend with the live range, `h` key), and a
  cursor readout of ground elevation and building height.

Second pass (same day):
- Bridges dipped to the water: decks were lifted a fixed height above the terrain under each vertex. Bridges are
  chains of OSM ways whose joints sit over the water, so the pipeline groups connected bridge ways, anchors the
  chain on its land ends (degree-1 nodes above the water level) and assigns every joint an inverse-distance
  weighted deck elevation (`deck` on roads/rail). The viewer runs each way straight between its deck ends
  (`bridgeLift`: 3.5 m, +3 m per extra `layer`); piers still drop to the terrain.
- "Curved crosswalks" were the sidewalk junction discs bulging past side streets. The first fix used square
  corner fills; the topology pass later replaced those with rounded sidewalk aprons and asphalt junction polygons.
- Sidewalks are raised strips with a 15 cm curb face instead of a wide ribbon under the road.
- The first pass inferred stop lines from crosswalks; these were later removed because crossing nodes do not
  establish a stop-controlled approach. Stop lines now require explicit source data.
- Sawtooth edges where parks met roads on slopes: land drapes are now subdivided at 8 m (roads resample at 8 m
  too) and roads sit 0.28 m above terrain vs 0.08 m for land, so the road always wins.

Third pass: OSM `building:part` polygons are kept as their own extrusions (parts inherit name/addr/landmark
from the outline that contains them; an outline covered ≥ 60% by its parts is drawn as a 0.6 m plinth so it
stays pickable). Bridge decks are computed per connected chain with island connectors absorbed. Landmark models
are placed once per slug even when parts share the slug.

Fourth pass: VGIN building footprints gap-fill OSM (+492 buildings, mostly garages and alley buildings, heights
from LiDAR/zoning). Ramps and approaches: non-bridge ways ending on an elevated deck get their own `deck` and
climb to it; chain nodes at grade become deck anchors; the bridge lift is a 0.6 m deck thickness instead of
3.5 m, so bridges meet their approach roads at grade. Shared-node height mismatches on the road network fell
from 882 to 78, the remainder being real level differences (footbridge under the Lee Bridge, stairs).

Fifth pass (cars and new buildings):
- Vehicles: four low-poly bodies (sedan, SUV, pickup, van) with glass, lights and wheels; a real-traffic colour
  mix (`car_*` palette keys); traffic in the right-hand lane at a quarter of the roadway width, both directions on
  two-way roads and one direction on one-way roads; spawned evenly along each lane and car-following so they no
  longer pass through each other; parked cars only at the curb of roads 9 m or wider and in painted parking-lot
  stalls, never in traffic lanes.
- `assets/supplements/overrides.json`: hand-maintained corrections applied after every source (a point or a
  name match, optional footprint). First entries: the 26-storey CoStar tower at 600 Tredegar (footprint from the
  VGIN 2026 layer, 155 m) and the Allianz Amphitheater (22 m canopy). Both are newer than the 2014 LiDAR.

Sixth pass (2025 LiDAR, terrain, traffic, publishing; 2026-09-09):
- Data: the 2025 City of Richmond LiDAR (NOAA Digital Coast EPT, flown Feb 2025) replaces the 2014 USGS cloud
  for heights and roof fits; the nDSM excludes vegetation; the terrain DEM is the NOAA 1 ft bare earth resampled
  to 1 m (`dem_noaa.py`). LiDAR now outranks Overture heights (Overture ran ~1.5x low on houses); footprints
  whose LiDAR surface is at ground are dropped as stale (130); shed-sized footprints are capped; roof fits use
  the top surface per 1 m cell. CoStar Tower moved to its real site (footprint from the 2025 DSM); the Allianz
  Amphitheater bowl was traced from VGIN Spring 2025 imagery.
- Roads: cross-street sag over sunken freeways fixed (connectors must be collinear and same class; abutments
  sampled a few metres up the approach); sidewalks/corner fills only on walkable classes; junctions recognise
  interior vertices, so T-junction sidewalks stop at the kerb; ribbon edges never sink under cross-sloping
  ground; `track`/`path` are dirt trails; a mainline never ramps up to a touching lower-class link bridge.
- Water: canals and ponds carry `water_z` and the terrain grid is flattened beneath them, so the canal reads as
  a filled basin. Terrain is vertically exaggerated 1.6x in the viewer (`web/src/elevation.ts`).
- Traffic: replaced the per-polyline car loops with a road graph + IDM simulation in a dedicated worker
  (`docs/traffic-idm-plan.md`): cars route across tiles and junctions, yield by priority, slow for turns, merge
  on ramps, and spawn to per-class density targets. Buses ride along as a kind.
- Publishing: base-relative assets and `npm run deploy` to GitHub Pages (https://sebastian-ch.github.io/rva/).

Still to look at: prop placement on steep banks, tunnel portals (the Downtown Expressway just ends where it
goes under 9th/10th Street), sidewalk strips overlapping where two walkable streets run within ~5 m, lane
changes (MOBIL) and signals in the traffic sim, the odd clipped pond piece at tile edges, junction areas as
polygons with curb radii, lane arrows, medians on divided roads, bus lanes.
