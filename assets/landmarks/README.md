# Landmarks

`landmarks.json` is a hand-curated array of the 18 landmarks from `PLAN.md`
section 2d, the first pass for hand-modeling in Blender.

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
