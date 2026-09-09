# Blender workflow

Scripts here are plain `bpy`/`bmesh` Python, run headless. No addons required
for the core loop; Blosm/BlenderGIS are optional aids (see below).

## 1. Run the pipeline first

```
python pipeline/fetch.py --bbox <...>
python pipeline/build_tiles.py
```

This produces `data/tiles/index.json` and per-tile `buildings.geojson`,
`roads.geojson`, `terrain.json` — see `DATA_FORMAT.md`.

## 2. Import a tile for context

```
blender --background --python blender/import_tile.py -- --tile 11_3
```

Builds terrain + extruded buildings + roads into a `tile_11_3` collection, in
local meters with the tile's SW corner at the origin. Landmark-matched
buildings land in a `Landmarks` sub-collection, everything else in
`Buildings`. Materials come from `assets/palette.json`. Run this without
`--background` (drop it, keep `--python`) to open the Blender UI and see it.

This is a *reference/placement guide*, not the final asset — model over it,
then hide/delete the procedural extrusion before export.

## 3. Model the landmark

Match the style bible (`PLAN.md` §1):

- [ ] Flat shading (no smooth shading, no subdivision-surface smoothing)
- [ ] Palette materials only — every material is one of `assets/palette.json`'s
      Principled BSDF materials (created for you by `import_tile.py`, or
      create your own the same way: hex → base color, roughness 0.95)
- [ ] No photo textures
- [ ] Ambient occlusion baked (to a texture or vertex color), not real-time GI
- [ ] Chunky, simplified geometry — read as the building from isometric
      distance, not a literal reproduction
- [ ] Footprint matches the OSM building outline closely enough to drop into
      the tile without gaps or overlap with neighbors

Reference: Street View, Google 3D Tiles, your own photos. **Google/Mapbox
imagery is visual reference only** — never trace it into shipped geometry
(see `CLAUDE.md`). Blosm/BlenderGIS can pull OSM footprints, terrain, and
reference imagery into Blender as an alternative to `import_tile.py` — same
licensing rule applies.

Put the landmark's objects in one collection named exactly `<slug>` (matching
`assets/landmarks/landmarks.json`), origin at the footprint centroid on the
ground. Budget: 1–3 days per landmark.

## 4. Export

```
blender --background <file.blend> --python blender/export_landmark.py -- \
    --slug virginia-state-capitol
```

Applies transforms, exports the `.glb` (Draco-compressed if available, plain
glTF otherwise), and updates that landmark's `model` field in
`assets/landmarks/landmarks.json`.

Export contract the viewer relies on:

- Origin at the footprint centroid, on the ground (Blender Z=0 → glTF Y=0)
- +Y up in the exported glTF (`export_yup=True` handles the Z-up → Y-up flip)
- Units in meters, matching the source data (EPSG:32618)
- Footprint matches the matched OSM building — the viewer places the model at
  its centroid/ground elevation and hides the procedural extrusion there

## 5. Commit

```
git add assets/landmarks/<slug>.glb assets/landmarks/landmarks.json
git commit -m "Add hand-modeled <slug> landmark"
```

## Visual references (reference only, no derived data)

- Google Maps 3D / satellite over downtown from the river:
  https://www.google.com/maps/@37.5300159,-77.4349121,874a,35y,39.18t/data=!3m1!1e3
- Google Street View for facades; own photos where possible.
- Use these to judge massing, roof form and colour. Never trace geometry or extract data from them; the
  automated pipeline uses only OSM, Overture, USGS 3DEP and NAIP (see `ATTRIBUTION.md`).

## Without the Blender app: the `bpy` Python module

Blender ships as a pip-installable Python module (`bpy`, ~230 MB, Python 3.11 on this machine). It runs the
scripts here headless with no desktop app:

```
.venv/bin/pip install bpy                     # already installed in this repo's venv
.venv/bin/python blender/import_tile.py -- --tile 13_8 --save blender/tile_13_8.blend
.venv/bin/python blender/export_landmark.py -- --slug old-city-hall     # once a <slug> collection exists in the open file
```

What it gives you: tile import, procedural massing scripts, glTF export, batch re-exports in CI. What it does
not give you: a viewport. Hand modelling still needs the desktop app (open the saved `.blend` there), or you
model landmarks procedurally in Python against the imported footprint and export straight from `bpy`.
