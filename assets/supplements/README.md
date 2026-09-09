# Supplements

Hand-maintained corrections for buildings the open sources have not caught up with (new towers, venues under
construction when the 2014 LiDAR flew, wrong tags). Applied last in `pipeline/process.py`, after every
automated source, so they always win.

`overrides.json` is a list of entries:

```json
{
  "name": "CoStar Tower", "lat": 37.5338, "lon": -77.4455, "radius_m": 60,
  "height": 155, "levels": 26, "type": "office", "roof_shape": "flat", "wall_color": "glass",
  "note": "26-storey HQ at 600 Tredegar St, topped out 2025; 2014 LiDAR predates it",
  "footprint": null
}
```

- The entry applies to the footprint that contains the point, else the largest footprint within `radius_m`; with
  `match_name` it applies to the largest building whose name contains that text instead.
- Any of `name`, `height`, `levels`, `type`, `roof_shape`, `roof_height`, `wall_color`, `roof_color`,
  `wikidata`, `website` may be given; omitted fields keep the pipeline's value. `height_source` becomes
  `"override"`.
- `footprint` may be a GeoJSON Polygon (WGS84) to create a building where no source has one; it replaces any
  footprints it overlaps by more than half their area.
- Keep `note` with the evidence (news article, site visit, Google 3D reference). Reference imagery may inform
  a height or a massing description but geometry must not be traced from Google or Mapbox (ATTRIBUTION.md).
  Footprints may be traced from VGIN VBMP imagery (`vginmaps.vdem.virginia.gov/.../VBMP_Imagery/MostRecentImagery_WGS/MapServer`,
  export with `f=json` first to get the exact Web Mercator extent, then map pixels through it) or NAIP; say which frame in `note`.
