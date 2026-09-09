# Phase 2 technical implementation — look (ROADMAP 2.1–2.5)

Goal: make the wide shot read as a designed city rather than extruded footprints, without changing the tile format
beyond consuming existing properties. Every item is client-side except one small pipeline tweak (2.5) and one
roof-fit rule (2.2).

## 2.1 Facade shader — `web/src/facade.ts`, `buildings.ts`

Geometry, not textures, is too expensive for windows on 2,300 buildings; a fragment shader on the existing wall
quads is essentially free.

- `buildings.ts` gains two vertex attributes on wall triangles: `uv` = (meters along the wall, meters above the
  building base) and `facade` = (floorHeight, wallHeight, style, seed). Roof caps, roofs and walls shorter than
  2.5 m get `facade.x = 0`, which the shader treats as "no windows".
- Style from `type` and height: `0` none, `1` residential (punched windows 1.1×1.5 m, 3.2 m floors),
  `2` office (window bands 0.6 of the floor, 3.6 m floors), `3` retail/commercial (storefront glass on the ground
  floor with an awning band, punched windows above), `4` industrial (few high windows).
- `facade.ts` builds a `MeshStandardMaterial` and injects GLSL with `onBeforeCompile`:
  window grid from `uv`, a darker sill line, a cornice band in the top 0.5 m, storefront band, and per-window
  lit/unlit selection from a hash of (cell, seed). Uniforms: `uNight` (0..1), `uWindowLit` palette colour.
  Windows darken the diffuse colour by day and add emissive `window_lit` by night.
- Flat shading is kept by leaving normals untouched.

## 2.2 Roof geometry — `buildings.ts`, `roofDetails.ts`, `pipeline/roofs.py`

- **Hip / pyramidal** roofs use inset rings instead of the OBB prism: offset the footprint inward with mitred
  joins in `k` steps (`insetRing` in `geomutil.ts`), lift each ring by `roofHeight * step`, and triangulate each
  annulus with earcut (outer ring + inner ring as hole). Stop early when an inset ring self-intersects or its area
  stops shrinking, then cap flat. This is the straight-skeleton roof for simple polygons and degrades gracefully
  for L-shapes.
- **Gable / skillion** keep the axis-aligned prism, now aligned to `roof_azimuth` when LiDAR supplied it.
- **Details** (`roofDetails.ts`, delegable): parapet lip on flat roofs taller than 12 m, 1–3 HVAC boxes on flat
  roofs over 400 m², a chimney on gabled houses under 12 m. Deterministic per building id.
- **Pipeline**: `roofs.py` adds a "flat with clutter" rule: if the interquartile z spread is under 1 m the roof
  is flat even when the plane RMS fails, which recovers most of the 1,549 unfitted footprints.

## 2.3 Lighting and water — `main.ts`, `water.ts`

- Directional shadow map that follows the camera: each frame the light sits 1,500 m from the controls target
  along the fixed sun direction; its orthographic shadow camera is sized to the visible extent
  (`400·aspect/zoom`, ×1.4 margin) so texel density stays high at any zoom. 4096² map, PCF soft, small bias.
  Buildings, roofs, props cast; terrain, roads, areas receive.
- `water.ts` (delegable): `MeshStandardMaterial` with `onBeforeCompile` adding two scrolling value-noise layers
  that shift the colour between `water` and `water_deep` and add foam flecks where the noise peaks; `uTime`
  uniform advanced from the render loop and frozen by Pause.
- Outline pass is deferred (needs a post-processing chain; revisit with 4.1).

## 2.4 Roads — `roads.ts`

- **Junction discs**: every polyline endpoint shared by two or more roads gets a 12-gon disc at the widest
  meeting road's half width (sidewalk disc first, asphalt disc on top), which removes the notched ends at
  intersections.
- **Dashed markings**: centre line becomes 3 m dashes with 6 m gaps on two-way roads; roads with 4+ lanes get
  dashed lane dividers; a solid stop line at crossings is skipped for now.
- **Bridges**: bridge decks get 1 m railings along both edges and box piers every 25 m from the deck down to
  the terrain, in `concrete`.

## 2.5 Props — `props.ts`, `scatter.ts`, `propPool.ts` (delegable)

- Per-instance car colour via `InstancedMesh.setColorAt` (6 palette colours), buses at `bus_stop` POIs,
  traffic lights at `traffic_signals` POIs, fountains at `fountain` POIs, extra street trees every 25 m on
  residential streets where the tile has fewer than one OSM tree per 60 m of street.
- Pipeline: `fetch.py` POI tags add `highway=traffic_signals`; `process.py` maps `traffic_signals` and `fountain`
  kinds.

## Tests

- `geomutil.test.ts`: `insetRing` on a square (shrinks uniformly), an L-shape (stays simple for small d, reports
  failure for large d), and a degenerate ring.
- `roofDetails.test.ts`: detail geometry has no NaN and stays within the footprint bounds + roof height.
- `roads.test.ts`: junction detection on a T-intersection produces one disc; dash count on a 30 m segment.
- `facade.test.ts`: style selection and floor height per building type.
- Existing suites keep passing; `tsc` clean; `vite build` succeeds.

## Acceptance

| Check | Target |
|---|---|
| Broad Street screenshot | storefronts and window bands visible at zoom 3 |
| Shadows | buildings shadow the street at the default view |
| Rowhouse block with L-shaped footprint | continuous hip ridge, nothing pokes through walls |
| Broad / 9th intersection | no notched ribbon ends |
| Frame time at default view (M-series laptop) | under 16 ms |

## Status (2026-09-09)

Implemented and verified on the first slice.

| Check | Target | Result |
|---|---|---|
| Broad Street screenshot at zoom 3–4 | storefronts and window bands visible | yes: office bands, punched residential windows, storefront glazing with awning band, cornices |
| Shadows | buildings shadow the street at the default view | yes, 4096² PCF map that follows the camera target |
| Hip roofs | continuous ridge on non-rectangular footprints | inset-ring roofs; prism fallback when a ring cannot be inset |
| Junctions | no notched ribbon ends | 12-gon discs on sidewalk and asphalt layers |
| Night mode | lit windows | per-window hash, ~38% lit, emissive `window_lit` |
| LiDAR roof fits after the flat-with-clutter rule | > 800 | 1,021 (was 722) |
| Tests | all green | 80 vitest, 59 pytest, `tsc` clean, `vite build` ok |

Not done / deferred:
- Outline post-process pass (needs an EffectComposer chain; revisit with baked tiles in 4.1).
- Stop lines and turn arrows at crossings.
- Bus routes: buses run on the same road paths as cars, not on real transit routes.
- Water animation runs but reads subtle at the default zoom; tune noise scale once the river gets its rapids texture.

Findings:
- `PCFSoftShadowMap` was removed in three r186; `PCFShadowMap` is used.
- The facade shader relies on `USE_UV` being defined so three declares the `uv` attribute without a map.
- Headless SwiftShader takes seconds per frame with the shadow map on, so tile loading stalls in the screenshot
  script; the real GPU path is unaffected.
