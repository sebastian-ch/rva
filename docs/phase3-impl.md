# Phase 3 technical implementation — landmarks (ROADMAP 3.1–3.3)

Goal: prove the Blender → glTF → viewer path end to end, put recognisable first-pass models on the most
distinctive landmarks, and make landmarks discoverable in the viewer.

## Constraint and adjustment

3.2 as written is hand modelling, 1–3 days per building in a Blender viewport. That is art time, not something
this pass can do. Instead, the first pass is **procedural massing in Python**: each landmark gets a script that
reads its matched OSM footprint and ground height from the tiles, builds a stylised model from primitives with
`bpy`/`bmesh` (extruded footprint, hipped or pyramidal roofs, towers, porticoes, domes), assigns palette
materials, bakes the palette colour into a vertex colour attribute, and exports through the existing
`export_landmark.py`. Procedural models are a floor, not a ceiling: anyone with the desktop app can open the
saved `.blend`, refine by hand, and re-export with the same script.

Blender runs headless through the pip `bpy` module (installed in `.venv`), so the whole loop is a command.

## 3.1 Pipeline proof — `blender/landmark_lib.py`, `blender/build_landmark.py`

- `landmark_lib.footprint(slug)`: scans `data/tiles/*/buildings.geojson` for the feature with `landmark == slug`,
  returns the exterior ring in metres relative to the footprint centroid (Blender X = east, Y = north),
  `ground_z`, `height`, and the OBB (centre, long axis, half extents) for orienting elements.
- Primitives: `extrude(ring, h, mat)`, `box(cx, cy, z0, sx, sy, sz, rot, mat)`, `cylinder`, `cone`,
  `pyramid_roof(ring_or_box, h)`, `hip_roof(obb, h)`, `dome(cx, cy, z0, r, h)`, `colonnade(...)`,
  `pediment(...)`. Every object gets a material from `assets/palette.json` and a `Col` colour attribute filled
  with that colour so the glTF carries `COLOR_0` (the viewer's facade material is vertex-coloured).
- `build_landmark.py -- --slug <slug> [--save file.blend] [--export]` clears the scene, builds the model into a
  collection named `<slug>`, optionally saves, and exports via `export_landmark.export_glb`, which also sets
  `landmarks.json[model]`. Origin at the footprint centroid on the ground, +Z up in Blender → +Y up in glTF
  (`export_yup=True`), which matches the viewer's local frame (glTF −Z = north).
- Viewer side is already in place: `landmarkModels.ts` loads `/assets/<model>` at the footprint centroid and
  ground height and rebuilds the tile's building mesh without the placeholder.

## 3.2 First-pass models

| Landmark | Massing |
|---|---|
| Virginia State Capitol | cream body from the footprint, hipped slate roof, south portico of 8 columns with entablature and pediment, wings kept from the footprint |
| Main Street Station | brick head house with a hipped red roof, square clock tower with clock faces and a steep pyramidal cap, long gabled train shed along the footprint's long axis |
| Old City Hall | sand stone body, four corner turrets with pyramidal caps, central tower with a steep pyramidal roof, cornice band |

Others stay procedural extrusions from the pipeline until modelled.

## 3.3 Viewer polish — `labels.ts`, `wiki.ts`, `main.ts`, `ui.ts` (delegable)

Landmark name pills as sprites above the building at zoom ≥ 2, hover accent shell on landmark buildings, and
info cards enriched from Wikidata → Wikipedia REST summary (extract, thumbnail, link) with CC BY-SA attribution.

## Tests

- `pipeline/tests/test_landmark_lib.py` is not possible without `bpy` at test time; instead `landmark_lib`
  keeps the footprint/OBB maths in a `bpy`-free module (`blender/footprint.py`) with a pytest covering OBB
  orientation and the centroid-relative ring.
- `wiki.test.ts`, `labels.test.ts` in the web suite.
- Manual: `build_landmark.py` for the three slugs exports GLBs, the viewer swaps them in (tour screenshot).

## Acceptance

| Check | Target |
|---|---|
| `landmarks.json` entries with `model` | 3 |
| Viewer | tour stop shows the glTF, no placeholder extrusion underneath, correct position and ground height |
| Labels | visible at zoom ≥ 2, hidden below |
| Info card | Capitol shows a Wikipedia summary and thumbnail |

## Status (2026-09-09)

Done. All ten in-slice building landmarks have procedural first-pass models built with `bpy` against their
matched OSM footprints and exported to Draco-compressed glTF with `COLOR_0` vertex colours
(`assets/landmarks/*.glb`, 4–42 kB each). `landmarks.json` carries `model` for each. The viewer swaps them in at
the footprint centroid and ground height and rebuilds the tile mesh without the placeholder; models detach when
their tile unloads or changes LOD. Labels, hover and Wikipedia summaries (3.3) are in.

| Check | Target | Result |
|---|---|---|
| `landmarks.json` entries with `model` | 3 | 10 |
| Viewer swap | correct position/ground, placeholder gone | yes (see screenshots in the session log) |
| Labels | visible at zoom ≥ 2 | yes |
| Info card | Wikipedia summary + thumbnail | yes, for entries with a verified Wikidata id (9 of 18) |
| Tests | green | 107 vitest, 59 pytest |

Caveats:
- Massing is from memory of the buildings plus the footprint; orientations (portico side, tower corner) use the
  footprint's oriented box and a north-ish heuristic and may be wrong for some. Refine with Google 3D / Street
  View as reference in the desktop app: `build_landmark.py -- --slug <slug> --save blender/<slug>.blend --no-export`,
  edit, then `export_landmark.py`.
- Bridges, Tredegar / canal walk and the Maggie Walker memorial are not buildings and still need the 1.5
  matching work before they can carry models.
