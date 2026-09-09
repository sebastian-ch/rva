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
| `height_source` | `"osm_height"\|"osm_levels"\|"lidar"\|"default"\|"landmark_hint"` | |
| `roof_shape` | `"flat"\|"gable"\|"hip"\|"pyramidal"\|"skillion"\|"dome"` | |
| `roof_height` | number | meters of roof above `height`, 0 for flat |
| `roof_color` | string | palette key |
| `wall_color` | string | palette key |
| `type` | string | OSM `building=*` value |
| `landmark` | string\|null | slug from `assets/landmarks/landmarks.json` |
| `addr` | string\|null | `housenumber street` |
| `wikidata` | string\|null | |
| `website` | string\|null | |

### roads (LineString)
`id`, `name`, `highway`, `lanes` (int), `width` (m), `oneway` (bool), `surface`, `sidewalk` (bool), `bridge` (bool), `tunnel` (bool), `layer` (int)

### rail (LineString)
`id`, `name`, `railway`, `bridge`, `layer`

### landuse (Polygon)
`id`, `name`, `kind`: `"park"|"grass"|"parking"|"cemetery"|"plaza"|"industrial"|"forest"`

### water (Polygon)
`id`, `name`, `kind`: `"river"|"canal"|"pond"`

### crossings (Point)
`id`, `crossing` (marked/unmarked)

### pois (Point)
`id`, `name`, `kind`: `"tree"|"streetlight"|"bench"|"bus_stop"|"monument"|"shop"|"restaurant"|"museum"`

### terrain.json
```json
{ "size": 250, "n": 26, "origin": [minx, miny], "elev": [ ... n*n floats, row-major from south to north, west to east ... ] }
```
Elevation in meters above the index `base_elevation` (min elevation of the study area), so ground sits near y=0.
