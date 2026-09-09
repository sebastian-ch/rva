# Honolulu / Diamond Head prototype

Built locally on 2026-09-09, branch `explore/honolulu`.

## Scope and result

Requested bbox (west, south, east, north):

```text
-157.827499, 21.252022, -157.794901, 21.278613
```

The prototype renders in the existing viewer. It covers approximately 3.4 × 3.0 km around
Diamond Head, including ocean. UTM 4N (`EPSG:32604`) produces a 15 × 13 grid of 250 m tiles.
The 195 generated tiles total approximately 7.8 MB before HTTP compression.

The Honolulu camera opens in perspective from the Waikīkī side looking southeast toward Diamond Head,
with nearby towers in the foreground and the crater in the distance. Terrain relief is exaggerated 1.5× to emphasize
Diamond Head; building heights and displayed elevation measurements retain their real scale.

Daylight has a blue sky, procedural clouds, and a sun; Night mode hides the daytime sky.
Normal terrain uses smooth shading without contour lines; the Heights view retains contours.
Honolulu tree instances use two stylized palm models. Park/grass polygons within 180 m of the
coast use a denser planting rate (one candidate per 110 m²), excluding roads and buildings.
These are procedural placements, not LiDAR-derived trees or species identifications.
Untagged towers use warm concrete/cream defaults with subtle shader weathering. Colors have
not been matched to façade imagery; explicit mapped color/material information is preserved.

All output is isolated in `data/honolulu/`. `ISO_REGION=honolulu` selects the profile in
`regions.json`; absent that variable the pipeline and viewer still select Richmond.
The shared palette, terrain renderer, building/road geometry, prop system, traffic simulation,
height resolver, Overture matcher, QA reporter, and browser smoke tools are reused.
Richmond's landmark registry, corrections, and raw data are not applied to Honolulu.

See [README commands](../README.md#honolulu-prototype-local). No Honolulu deployment has been made.

## Source coverage measured in this box

| Source | Downloaded records / result |
| --- | --- |
| CCH buildings | 4,475 intersecting footprints; 3,524 usable `maxht_m` values |
| OSM buildings | 1,646 raw features; 551 strong matches enrich city outlines; 120 gap-fill footprints retained |
| Overture buildings | 4,474 footprints, used for matching height/roof fallbacks |
| OSM helper layers | 2,056 road features, 194 land-use features, 7 water features, 1,442 POIs; no rail features |
| USGS 3DEP | Full valid raster coverage; 1,702 × 1,484 pixels on an approximately 2 m export grid; elevations −0.05 to 231.83 m |
| CCH Coast_Poly | One surrounding-water polygon with 43 island holes |

The exported terrain pixel spacing is not the native DEM resolution. Source quality and dates vary.
Normal tiles use 26 × 26 terrain samples (10 m spacing); tiles crossing water boundaries use 101 × 101 (2.5 m). Water-level statistics ignore missing DEM samples, keeping Ala Wai near 1.03 m relative to the local base instead of the polluted 8.36 m estimate.

After geometry filtering, the model contains 4,587 unique buildings:

| Height source | Buildings |
| --- | ---: |
| CCH maximum height | 3,509 |
| OSM explicit height | 50 |
| OSM levels | 120 |
| Overture height | 155 |
| Type/default estimate | 753 |

About 83.6% have height information beyond the type default. This does not establish survey accuracy.
Only 10 roofs have an explicit OSM shape; other roof shapes and materials remain procedural estimates.
The city maximum height includes the roof: procedural roof rise is kept inside that total.

## Source details and limitations

- [CCH building footprints](https://honolulu-cchnl.opendata.arcgis.com/datasets/building-footprints-cch/about):
  mixed 2004–2010 aerial/LiDAR source material with ongoing city updates. `maxht_m` is interpreted as
  maximum height in metres; sample `nga_height` values agree after feet-to-metres conversion.
  `gis_height`, `elevationbase`, and `elevationmax` are retained but not used without clear semantics.
- [CCH Coast_Poly](https://www.arcgis.com/home/item.html?id=e52658803ae2456d9aff09c50f695e89):
  the actual geometry represents surrounding water, despite the generic coastline description.
  Clip it directly, preserving island holes. Reversing it floods the city. The downloader checks a
  crater point and an offshore point to guard against a change in source geometry meaning.
  Its source is 1983 USGS 1:24,000 linework; shoreline details can be dated or generalized.
- [USGS 3DEP](https://www.usgs.gov/3d-elevation-program): current prototype terrain source.
  Sea level is represented as zero relative to the raster's elevation reference; precise coastal
  work would require explicit local tidal/vertical datum reconciliation.
- [Overture buildings](https://docs.overturemaps.org/schema/reference/buildings/building/): optional
  heights, floor counts, and roof attributes. Spatial matching supplements city/OSM information.
- [2013 NOAA Oʻahu DEM](https://coast.noaa.gov/htdata/raster2/elevation/NOAA_Oahu_DEM_2013_8497/)
  and [point cloud](https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid12b/3655/index.html):
  identified for a later terrain/roof quality pass, not downloaded or integrated in this prototype.

Attribution and posted city terms are recorded in [ATTRIBUTION.md](../ATTRIBUTION.md).

## Validation

- Python tests cover region isolation/projection, OSM enrichment without duplicate buildings,
  city height provenance, and correct ocean/land polarity.
- Existing Python and frontend suites pass; production build and typecheck pass.
- Browser smoke checks load all 195 tiles in the initial view, navigate to crater/coast views,
  and exercise Night, Pause, Map, and Heights without console errors.
- The initial and coastal screenshots were inspected. The first check exposed an inverted
  coastline mask; that issue was corrected and the browser checks repeated successfully.
- Screenshots are in `web/snapshots/`; generated source statistics are in
  `data/honolulu/tiles/qa.md` (both generated locally).

## Next quality improvements

1. Better building classes, roof forms, and Hawaiʻi-appropriate materials/vegetation. Do not mistake
   the current shared Richmond art palette for observed building appearance.
2. Use Oʻahu LiDAR where it improves the 753 default-height buildings and generic roof forms.
3. Compare a more recent shoreline and higher-resolution terrain against the current coastal edge.
4. Add a small local landmark registry after validating coordinates and sources.

## Walkways and coastal structures

OSM supplies 538 footway/path/cycleway/steps/track features in this bbox, including 181 with surface tags. City Existing Bike Facilities and the June 2020 Pedestrian Plan identify Paki Avenue and Kapahulu shared-use paths, but are supplementary inventories rather than a complete sidewalk survey; not integrated yet.

Four OSM coastal structures are imported, including the polygon outline of Kapahulu Groin (Waikīkī Wall). Four additional Kūhiō basin wall centerlines were hand-traced from Esri World Imagery into `assets/supplements/honolulu-coastal.geojson`. Traces are approximate, preserve visible gaps, and are not survey data. Centerline widths (3 m) and crest heights (0.8–1.5 m above sea level) are visual estimates. The renderer uses solid sides and a flat concrete crest, independent of the underwater DEM.

Mapped sandy beaches use an artistic foreshore profile: terrain approaches sea level at the waterline and blends into the DEM over 35 m inland, with an 8 m fade at beach polygon edges. This lowers beach terrain only; it does not alter canal banks or the separate coastal-structure crest elevations. Beach surface triangles use a 2.5 m maximum edge.
