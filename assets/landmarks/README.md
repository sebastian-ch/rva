# Landmarks

`landmarks.json` is the hand-curated landmark registry. It began with the 18 landmarks from `PLAN.md`
section 2d and now also contains reviewed additions such as Richmond City Hall.

## Schema

| field | notes |
|---|---|
| `slug` | kebab-case, unique, used as the asset/model key |
| `name` | display name |
| `osm_name_hints` | strings likely to appear in the OSM `name` tag |
| `lat`, `lon` | approximate centroid, WGS84, 4 decimals |
| `approx` | present and `true` only when the coordinate is a rough estimate |
| `kind` | `building` \| `bridge` \| `streetscape` \| `cemetery` \| `site` |
| `wikidata` | Q-id, only when verified against wikidata.org; otherwise `null` |
| `website` | official site, or `null` |
| `description` | one or two sentences for the info card UI |
| `district` | neighborhood label used for grouping/filtering |
| `in_first_slice` | `true` if inside the Downtown/Shockoe Bottom/Capitol Square bbox (roughly lon -77.452..-77.418, lat 37.527..37.548) |
| `model` | reserved; will point to `assets/landmarks/<slug>.glb` once hand-modeled |

## Matching to OSM footprints

The pipeline (`pipeline/build_tiles.py`) matches a building footprint to a
landmark by fuzzy-comparing the OSM `name` tag against `osm_name_hints` and
checking that the footprint centroid falls near `lat`/`lon`. A match sets
`landmark` on the building feature (see `DATA_FORMAT.md`) to the landmark's
`slug`, which the web app uses to swap in the hand-modeled glTF from `model`
in place of the procedural extrusion.

Richmond City Hall is Blender-authored because the city's BIM-flagged I3S leaf is only 152 triangles and reads
as a plain block at map scale. Its reviewed 71 x 58 m base comes from that city object; the 53 x 33 m tower
comes from the separately mapped OSM building part. `blender/build_landmark.py` adds the documented four-story
plinth, expressed frame, roof overhang, service box and antenna. Rebuild the visible model with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python blender/build_landmark.py -- --slug richmond-city-hall
```

`web/tools/import-i3s-object.mjs` remains the generic selective I3S converter. The reviewed raw City Hall
conversion is retained under `data/raw/`; do not overwrite the authored landmark with that coarse leaf.
Run the converter from `web/` with the exact SceneServer layer, leaf node, map CRS and target-footprint anchor:

```sh
node tools/import-i3s-object.mjs \
  --layer https://example.test/SceneServer/layers/0 \
  --node 123 --target-crs EPSG:32618 --anchor 285000,4157000 \
  --output ../data/raw/reviewed-source.glb --name "Reviewed source"
```

The output is a review artifact until its alignment, geometry and texture have been checked in the app. Copy a
validated model into this directory and add it to `landmarks.json`; set `preserve_material` only when the source
texture is useful and should remain visible across map styles.
