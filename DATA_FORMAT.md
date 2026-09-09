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
| `height_source` | `"osm_height"\|"osm_levels"\|"overture_height"\|"overture_levels"\|"lidar"\|"zoning"\|"default"\|"landmark_hint"\|"override"` | resolution order as listed; `override` = supplements file |
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
| `footprint_source` | `"osm"\|"vgin"\|"override"` | VGIN footprints are gap-fill only (no OSM footprint overlapped them); they carry no tags |
| `is_part` | bool | OSM `building:part` (Simple 3D Buildings); rendered as its own extrusion |
| `parent` | string\|null | id of the outline building containing a part; parts inherit name/addr/landmark from it |
| `hidden` | bool | outline whose parts cover ≥ 60% of it; the viewer draws only a 0.6 m plinth (keeps picking and the info card) |
| `addr` | string\|null | `housenumber street` from OSM, else the City of Richmond address point inside the footprint |
| `wikidata` | string\|null | |
| `website` | string\|null | |

### roads (LineString)
`id`, `name`, `highway`, `lanes` (int), `width` (m), `oneway` (bool), `surface`, `sidewalk` (bool), `bridge` (bool), `ramp` (bool: a non-bridge way whose end meets an elevated deck; carries a `deck` so it climbs to it), `tunnel` (bool), `layer` (int), `deck` (bridges only: `[x0,y0,z0,x1,y1,z1]`, the unclipped way's ends with deck elevations relative to `base_elevation`, computed per connected bridge chain from its land ends (chain nodes whose ground is at or above the interpolated deck become anchors too); the GeoJSON driver stores it as a real array)

### rail (LineString)
`id`, `name`, `railway`, `bridge`, `layer`, `deck` (as for roads)

### landuse (Polygon)
`id`, `name`, `kind`: `"park"|"grass"|"parking"|"cemetery"|"plaza"|"industrial"|"forest"`

### water (Polygon)
`id`, `name`, `kind`: `"river"|"canal"|"pond"`, `water_z` (m above `base_elevation`; flat surface for canals and ponds,
40th percentile of the DEM inside the polygon + 0.3 m; `null` for rivers, which follow the terrain). The terrain grid is
pushed down to `water_z - 0.5` under those polygons so the surface is always visible.

### crossings (Point)
`id`, `crossing` (raw OSM `crossing=*` value: `marked`, `unmarked`, `traffic_signals`, `uncontrolled`, `zebra`, …; missing tag → `unmarked`)

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
