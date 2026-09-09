# Phase 1 technical implementation — data quality (ROADMAP 1.1–1.4)

Goal: cut the share of buildings whose height is a type default from 80% to under 15%, get real roof shapes
for rowhouses, and make data quality measurable. No visual work in this phase beyond consuming new fields.

## Sources and access

| Need | Source | Access | Why this one |
|---|---|---|---|
| Point cloud | USGS 3DEP `USGS_LPC_VA_Sandy_2014_LAS_2015` (public domain, includes the VGIN-era collection) | Entwine Point Tile (EPT) on S3, `ept.json` + `ept-hierarchy/*.json` + `ept-data/*.laz`, CRS EPSG:3857 | Programmatic, no login, pure Python via `laspy[lazrs]`; PDAL is not installed |
| Bare earth | The 2 m 3DEP DEM already fetched | `data/raw/dem_<slug>.tif` | Avoids ground classification; nDSM = DSM − DEM |
| Second height source | Overture Maps buildings | `overturemaps download --bbox … --type=building` (GeoParquet over S3) | Carries Microsoft/Google-derived heights OSM lacks |

## 1.1 LiDAR nDSM — `pipeline/fetch_lidar.py`

1. Read `ept.json`; convert the study bbox to EPSG:3857.
2. Walk the EPT octree from `0-0-0-0`: a node key `d-x-y-z` covers cube `bounds` split 2^d ways. Keep nodes whose
   XY extent intersects the bbox. Hierarchy values of `-1` mean the subtree lives in `ept-hierarchy/<key>.json`;
   follow those lazily. Stop at `--max-depth` (default chosen so the sampled density is ≥ 2 pts/m²; EPT stores a
   decimated subset at every level, so shallow depth = cheaper, coarser cloud).
3. Download intersecting `ept-data/<key>.laz` with a small thread pool into `data/raw/ept_<slug>/` (cached).
4. Read each LAZ with `laspy`, drop classes 7 and 18 (noise), reproject XY 3857 → 32618 with `pyproj`,
   clip to bbox, concatenate. Detect Z units: compare the median of low points against the DEM; if the ratio is
   ~3.28 convert feet to meters. Save `data/raw/lidar_<slug>.npz` (float32 x, y, z, classification) for 1.3.
5. Rasterize DSM at 1 m: max Z per cell (`np.maximum.at` on cell indices). Fill empty cells by 3×3 max filter,
   once. Resample the DEM to the same grid with `rasterio.warp.reproject` (bilinear). Write
   `data/raw/ndsm.tif = clip(DSM − DEM, 0, 300)` as float32, EPSG:32618, nodata NaN.

`pipeline/lidar.py` already samples the nDSM median per footprint; extend it to return the median and the 90th
percentile and to shrink each footprint by 1 m before sampling so wall edges and neighbours do not leak in.

## 1.2 Overture heights — `pipeline/fetch_overture.py` + `process.py`

1. `overturemaps download --bbox W,S,E,N -f geoparquet --type=building -o data/raw/overture_<slug>.parquet`.
2. In `process_buildings`: spatial join Overture footprints to OSM footprints on representative point within
   polygon, keep the pair with the largest intersection-over-union ≥ 0.5. Pull `height`, `num_floors`, `roof_shape`.
3. Height order becomes: OSM `height` → OSM `building:levels` × 3.2 → Overture `height` → Overture `num_floors` × 3.2 →
   LiDAR nDSM median → type default. `height_source` gains `overture_height` and `overture_levels`.
4. Roof order: OSM `roof:shape` → Overture `roof_shape` → LiDAR classification (1.3) → type fallback.

## 1.3 LiDAR roof classification — `pipeline/roofs.py`

Pure function `classify_roof(points_xyz, footprint) -> RoofFit | None` using the npz cloud from 1.1:

1. Select points inside the footprint shrunk by 0.8 m, with z above `eave_floor = ground + 2 m`; need ≥ 25 points.
2. Least-squares plane fit. If RMS residual < 0.35 m and slope < 8°, the roof is `flat`.
3. Otherwise, for each candidate ridge axis (footprint OBB long axis, short axis, and ±15° around the long axis)
   split points by the signed distance to the axis through the centroid and fit one plane per side. Score by pooled
   RMS. Best score < 0.45 m and both slopes between 10° and 55° → `gable` (or `hip` when the two end regions,
   the 20% of the footprint length at each end, have their own descending slopes; measured by fitting planes to
   the end caps). A single tilted plane with RMS < 0.35 m and slope 5–35° → `skillion`.
4. Output: `roof_shape`, `roof_azimuth` (degrees clockwise from north of the ridge line), `roof_height`
   (ridge z − eave z, from the fitted planes), `eave_height` (eave z − ground), `fit_rms`.
5. `process_buildings` uses the fit when no OSM/Overture roof tag exists; `roof_height` from the fit replaces the
   heuristic; `height` for LiDAR-sourced buildings becomes the eave height so the roof prism sits at the right place.

Viewer: `buildings.ts` reads `roof_azimuth` when present and uses it as the roof axis instead of the OBB axis
(extents still from projecting the footprint onto that axis).

## 1.4 QA report — `pipeline/qa_report.py`

Writes `data/tiles/qa.md` and `data/tiles/qa.json` after `build_tiles.py`:
height-source histogram overall and per tile, roof-shape histogram, buildings taller than 150 m, footprints
under 15 m², roads with null width, tiles with no terrain, unmatched landmarks from `landmarks.json`,
and the LiDAR/Overture coverage ratios. Delegable; spec is `DATA_FORMAT.md`.

## Tests

- `test_roofs.py`: synthetic point clouds for flat, gable (two azimuths), hip, skillion footprints; assert shape,
  azimuth within 5°, roof height within 0.3 m; degenerate input returns `None`.
- `test_lidar.py`: EPT key → bounds math; feet/meters detection on synthetic arrays.
- `test_overture.py`: IoU matcher on hand-made squares.
- Existing pipeline tests keep passing; `build_tiles.py --clean` on the slice must finish and the QA report must
  show `default` under 15%.

## Acceptance

| Check | Target |
|---|---|
| `default` height share | < 15% |
| Buildings with LiDAR-classified roofs | > 800 |
| nDSM sanity: median nDSM over 20 known flat lots (parking) | < 1 m |
| Pipeline wall time on the slice (cached downloads) | < 3 min |

## Status (2026-09-09)

Implemented and run on the first slice. Results against the acceptance table:

| Check | Target | Result |
|---|---|---|
| `default` height share | < 15% | 2.9% (66 of 2,266) |
| Buildings with LiDAR-classified roofs | > 800 | 722 (520 flat, 137 gable, 53 skillion, 11 hip); 1,549 footprints returned no fit, see below |
| nDSM over 30 surface parking lots | median < 1 m | 0.06 m |
| Pipeline wall time (cached downloads) | < 3 min | 14 s build; LiDAR fetch 27 s download + 12 s decode on first run |

Height sources after the change: LiDAR 1,372, Overture 581, OSM levels 354, OSM height 96, landmark hint 7, default 66.

Findings worth knowing:
- The USGS EPT cloud carries WGS84 ellipsoid heights, 33.08 m below the NAVD88 DEM at Richmond. `fetch_lidar.py`
  calibrates scale and offset from ground-classified points against the DEM before building the nDSM.
- The python.org CPython build has no system CA bundle for `urllib`; `fetch_overture.py` sets `SSL_CERT_FILE` from
  `certifi` so the `overturemaps` CLI can reach the STAC catalog.
- Roof fits fail mostly on cluttered flat roofs (HVAC, parapets push the plane RMS past 0.35 m). A "flat with
  clutter" rule (interquartile z spread under 1 m) would recover most of the 1,549 unfitted footprints; left for
  ROADMAP 2.2 alongside the straight-skeleton roofs.
- Merged rowhouse blocks keep a shared ridge azimuth only when member fits agree within 15°.

## 1.5 and 1.6 addendum (2026-09-09)

**1.5 Landmark resolution** — `pipeline/landmarks.py` resolves every registry entry: tagged building footprint
first; then name hints (tokenised, stop-words dropped, each hint tried with progressively shorter prefixes, hint
order = priority) across POIs, raw buildings, water, landuse, roads and rail within 800 m of the registry point,
with a kind-aware layer order (bridges look at roads/rail first); then the nearest feature of a plausible kind
within 150 m, never a polygon wider than 400 m; finally the registry point itself, flagged. Output
`data/tiles/landmarks.json`; the viewer loads it for tour targets and labels of non-building landmarks. Result:
15 of 18 resolved (the three misses are outside the slice), all 12 in-slice ones by name. Two registry fixes were
needed: a wrong hint (Potterfield bridge) and a memorial point 670 m off.

**1.6 City of Richmond open data** — `pipeline/fetch_richmond.py` pages the city's ArcGIS feature services
(`Addresses`, `ZoningDistricts`) for the bbox into GeoParquet. `pipeline/richmond.py` joins address points inside
each footprint (lowest AddressId wins) into `addr`, and zoning district prefixes into a height default that
sits between LiDAR and the type default. The hub publishes no building-footprint or street-tree layer, so those
parts of the roadmap item are not possible from this source.

| Check | Target | Result |
|---|---|---|
| Buildings with an address | > 60% | 80% (3,152 of 3,962) |
| Pure type-default heights | — | 7 (zoning covers 171) |
| In-slice landmarks resolved | 12 | 12 |
| Tests | green | 82 pytest, 107 vitest |
