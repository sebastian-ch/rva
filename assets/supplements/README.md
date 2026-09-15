# Supplements

Hand-maintained corrections for buildings the open sources have not caught up with (new towers, venues under
construction when the 2014 LiDAR flew, wrong tags). Applied last in `pipeline/process.py`, after every
automated source, so they always win.

`richmond-esri-outlines.geojson` contains a small, explicit set of City of Richmond multipatch outlines
that beat the corresponding OSM geometry against classified 2025 LiDAR. Each feature names its exact
target source ID, city object ID and before/after LiDAR proxy F1. Do not expand it from outline complexity
alone: the older city source often preserves harmless edge serrations while losing newer building parts.
The Shockoe review additionally rejects candidates that overlap a separately modeled building, fill a
real courtyard, or retain a Roofer shell fitted to the old perimeter. The accepted Terrace at The Masonry,
Canal Lofts Phase V and Trinity Methodist Church changes use procedural roofs that regenerate over the
replacement outline.

`richmond-massing.geojson` contains reviewed base and upper parts for large Richmond buildings whose
single extrusion hides a broad, stable height tier in the 1 m normalized 2025 LiDAR. Every group names an
exact processed `target_id` and includes a `base` part that covers the source outline. Upper parts record
their extrusion interval with `min_height` and `height`. Do not derive these from a blind citywide threshold:
courtyards, neighbouring towers, ramps, pitched roofs and rooftop equipment all produce similar histograms.

`richmond-roof-furniture.json` contains exact-position rooftop structures accepted from the dense
classified 2025 Richmond LiDAR cloud. Records use projected `{x,y}` centers, oriented `{w,d}` dimensions,
height `h`, angle `a` in radians from east, and base offset `b` above the modeled wall top. The first
precision-gated pilot reviewed 30 named flat roofs and accepted 20 objects on five buildings. Keep ambiguous
roofs unchanged; cars, trees, parapets, roof edges and broad setback tiers can all resemble equipment in a
surface residual. A reviewed record replaces procedural HVAC for that building.

`rooftops.json` contains separately mapped rooftop assets whose source geometry identifies both the
roof and the exact host building. The renderer attaches these data-backed assets at every building-detail
level, instead of treating them as random roof furniture. Keep the source URL, licence, access date and
the distinction between sourced footprint and illustrative details on every record.

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
