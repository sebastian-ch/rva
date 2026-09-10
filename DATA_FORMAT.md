# Tile data format

Produced by `pipeline/build_tiles.py`, consumed by `web/src/tiles.ts`.

## CRS and grid

- All processed geometry is in **EPSG:32618** (UTM zone 18N, meters).
- Tiles are 250 m squares. Grid origin `(origin_x, origin_y)` is the SW corner of the
  study bbox snapped down to a 250 m multiple. Tile `x_y` covers
  `[origin_x + 250x, origin_x + 250(x+1)) × [origin_y + 250y, origin_y + 250(y+1))`.
- Web local coordinates: `local_x = X - origin_x`, `local_z = -(Y - origin_y)`, `local_y = elevation`.
  three.js is Y-up, so projected northing maps to -Z.

## `data/tiles/index.json`

```json
{
  "crs": "EPSG:32618",
  "tile_size": 250,
  "origin": [x, y],
  "bbox_wgs84": [west, south, east, north],
  "base_elevation": 0.0,
  "tiles": [{ "id": "3_2", "x": 3, "y": 2, "bbox": [minx, miny, maxx, maxy], "layers": ["buildings", "roads", ...] }]
}
```

## Per-tile files: `data/tiles/<x>_<y>/<layer>.geojson`

GeoJSON FeatureCollections with coordinates in EPSG:32618 meters (not WGS84).
Geometry is clipped to the tile bbox. All layers optional; missing = empty.

### buildings (Polygon / MultiPolygon)
| property | type | notes |
|---|---|---|
| `id` | string | `osm:<way|relation>/<id>` or `merged:<n>` |
| `name` | string\|null | |
| `height` | number | meters, roof-line height above ground |
| `min_height` | number | meters, default 0 |
| `levels` | int\|null | |
| `height_source` | `"cch_height"\|"osm_height"\|"osm_levels"\|"overture_height"\|"overture_levels"\|"lidar"\|"zoning"\|"default"\|"landmark_hint"\|"override"` | resolution order: OSM height, OSM levels, CCH maximum height (Honolulu only), LiDAR (≥ 10 nDSM cells; eave for pitched roofs), Overture height, Overture levels, sparse LiDAR, zoning, type default; `override` = supplements file. Footprints whose LiDAR surface is at ground (p90 < 1.2 m, ≥ 8 cells) with no OSM height are dropped as stale; LiDAR heights on footprints < 80 m² are capped at 4·√area |
| `zoning` | string\|null | City of Richmond zoning district at the footprint |
| `roof_shape` | `"flat"\|"gable"\|"hip"\|"pyramidal"\|"skillion"\|"dome"` | |
| `roof_height` | number | meters of roof above `height`, 0 for flat |
| `roof_azimuth` | number\|null | ridge direction, degrees clockwise from north (0..180); null unless LiDAR-fitted |
| `roof_source` | `"osm"\|"overture"\|"lidar"\|"heuristic"` | |
| `lidar_p90` | number\|null | 90th percentile nDSM inside the footprint, m |
| `ground_z` | number | terrain height under the footprint centroid, m above `base_elevation` |
| `roof_color` | string | palette key |
| `wall_color` | string | palette key |
| `type` | string | OSM `building=*` value |
| `landmark` | string\|null | slug from `assets/landmarks/landmarks.json` |
| `footprint_source` | `"osm"\|"richmond_structures"\|"vgin"\|"cch"\|"override"` | Richmond Structures is the current city gap-fill; VGIN is the offline fallback. Honolulu uses CCH city outlines, enriched with spatially matched OSM tags, plus non-overlapping OSM gap-fill |
| `source_updated` | string\|null | ISO timestamp from the source feature edit field when available |
| `is_part` | bool | OSM `building:part` (Simple 3D Buildings); rendered as its own extrusion |
| `parent` | string\|null | id of the outline building containing a part; parts inherit name/addr/landmark from it |
| `hidden` | bool | outline whose parts cover ≥ 60% of it; the viewer draws only a 0.6 m plinth (keeps picking and the info card) |
| `addr` | string\|null | `housenumber street` from OSM, else the City of Richmond address point inside the footprint |
| `wikidata` | string\|null | |
| `website` | string\|null | |

### roads (LineString)
`id`, `name`, `highway`, `lanes` (int), `width` (m), `oneway` (bool), `surface`, `sidewalk` (bool), `bridge` (bool), `ramp` (bool: a non-bridge way whose end meets an elevated deck; carries a `deck` so it climbs to it), `tunnel` (bool), `layer` (int), `deck` (bridges and ramps: `[x0,y0,z0,x1,y1,z1]`, the unclipped way's ends with deck elevations relative to `base_elevation`, computed per connected bridge chain from its land ends (chain nodes whose ground is at or above the interpolated deck become anchors too); the GeoJSON driver stores it as a real array)

Optional road attributes: `generated_sidewalk` (the pipeline's normalized curb-strip eligibility),
`sidewalk_left` / `sidewalk_right` (boolean or null; false also covers
an explicitly absent side; a mapped `separate` side is normalized true because its source line is navigation-only),
`footway` (OSM subtype, including crossing), `bus_only` (boolean),
`bus_lanes` (count), and `bus_lane_side` (`left`/`right` or null). Count alone does not imply lane placement.
Richmond downtown Broad Street's tagged one-way bus lanes use the documented curbside configuration.

### rail (LineString)
`id`, `name`, `railway`, `bridge`, `layer`, `deck` (as for roads)

### landuse (Polygon)
`id`, `name`, `kind`: `"park"|"grass"|"parking"|"cemetery"|"plaza"|"industrial"|"forest"|"beach"|"deck"`.
Richmond `deck` surfaces come from Structures subtype 3 and include `source: "richmond_structures"` plus the
optional per-feature `source_updated` timestamp. They are draped 0.12 m above terrain because the source has no elevation.

Elevations in every layer are real metres above `base_elevation`; the viewer multiplies them by `Z_SCALE` (1.6, `web/src/elevation.ts`) when a tile is loaded and divides back for anything shown to the user.

### water (Polygon)
`id`, `name`, `kind`: `"river"|"canal"|"pond"|"ocean"`, `water_z` (m above `base_elevation`; flat surface for canals and ponds,
40th percentile of the DEM inside the polygon + 0.3 m; `null` for rivers, which follow the terrain). The terrain grid is
pushed down to `water_z - 0.5` under those polygons so the surface is always visible.

### crossings (Point)
`id`, `crossing` (raw OSM `crossing=*` value: `marked`, `unmarked`, `traffic_signals`, `uncontrolled`, `zebra`, …; missing tag → `unmarked`),
`road_id`, `road_width`, `road_dx`, `road_dy`, `road_x`, `road_y` (the matched motor-road id, width, unit direction and projected centreline point; nullable when no safe match exists),
`crossing_island` (true only for source `crossing:island=yes`)

### pois (Point)
`id`, `name`, `kind`: `"tree"|"streetlight"|"bench"|"bus_stop"|"traffic_signals"|"fountain"|"monument"|"shop"|"restaurant"|"museum"`

### terrain.json
```json
{ "size": 250, "n": 26, "origin": [minx, miny], "elev": [ ... n*n floats, row-major from south to north, west to east ... ] }
```
Elevation in meters above the index `base_elevation` (min elevation of the study area), so ground sits near y=0.

## `data/tiles/landmarks.json`

Every entry of `assets/landmarks/landmarks.json` resolved to a position by `pipeline/landmarks.py`:

```json
{ "<slug>": { "name", "kind", "x", "y", "ground_z", "extent", "matched": "osm:way/123"|null,
              "how": "building"|"name:<layer>"|"nearest:<layer>"|null, "osm_name", "in_first_slice", "model", "wikidata", "website", "description" } }
```
`x, y` are EPSG:32618 metres (centroid of the matched feature, or the registry lat/lon when `how` is null).

Region profiles select the projected CRS and output path. Honolulu IDs use `cch:<objectid>` for city footprints. Its `cch_height` is a maximum roof height: the rendered wall height plus roof rise fits inside that total. Ocean `water_z` is `-base_elevation`, corresponding to zero in the DEM elevation reference.

Honolulu coastal structures use landuse kinds `groyne`, `breakwater`, `seawall`, and `pier`. Optional `base_z` and `top_z` are elevations relative to the regional DEM base; both scale with terrain exaggeration. Their polygons render as solid extrusions. `source` identifies OSM or imagery tracing; `dimensions_source` marks estimated dimensions.
# Richmond vegetation, hydro, and navigation additions

- `index.json` tile entries may contain `surveyed_trees: true`: complete regional LiDAR canopy processing
  was available, so the renderer suppresses procedural park/street tree scatter. Existing OSM trees remain
  where they do not duplicate inventory/canopy points.
- Tree POIs retain `kind: "tree"` and add optional `species`, `source` (`city_inventory` or `lidar2025`),
  `tree_height` (metres), `crown_radius` (metres), and `height_source` (`estimated` or `lidar2025`).
  Heights/crown widths are independent of terrain exaggeration. Unmatched inventory trees use explicit
  estimated sizes; LiDAR peaks and crown envelopes are approximate.
- Water features may have `source: "noaa2025"`. `water_z` is numeric or null, never a string.
  River elevations use optional `terrain.json.water_elev`, a finite array aligned with `elev` in the same
  unexaggerated, base-relative metre frame. The viewer scales both once. Ground beneath water is lowered
  while island holes remain untouched.
- `landuse.kind: "canal_bank"` uses `base_z` and `top_z` for stylized masonry beside mapped downtown canals.
  Its source is `osm_stylized`; the coping height is an artistic estimate, not a measured wall survey.
- `search.json` is an array of `{id,name,addr,x,y,ground_z,landmark}`. Positions use the index's projected
  CRS; `ground_z` is base-relative metres. Landmark names are canonical and deduplicated across parts.
- Shared URL state is versioned (`view=1`) and region-scoped, with projected target XY, displayed target
  height Z, zoom, azimuth in radians, camera distance, night/map flags, style and optional building ID.
