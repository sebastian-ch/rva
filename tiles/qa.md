# QA report — 2026-09-27T16:32:02.165068+00:00

bbox (WGS84): `[-77.486, 37.517, -77.418, 37.568]`

## Buildings

- total: 25532
- named: 1270 (5.0%)
- default height share: 0 (0.0%)
- footprints under 15 m² or < 4 vertices: 691 (first 10 ids: osm:way/755825918, osm:way/755825879, osm:way/755825634, richmond_structure:348419, richmond_structure:344617, osm:way/755825477, richmond_structure:397621, osm:way/755825676, osm:way/755825459, osm:way/755826046)
- with roof_azimuth: 5960

### height_source

| source | count | share |
|---|---|---|
| lidar | 24220 | 94.9% |
| osm_levels | 675 | 2.6% |
| zoning | 440 | 1.7% |
| osm_height | 134 | 0.5% |
| overture_height | 31 | 0.1% |
| lidar_massing | 16 | 0.1% |
| override | 9 | 0.0% |
| landmark_hint | 7 | 0.0% |

### roof_shape

| shape | count |
|---|---|
| flat | 18417 |
| gable | 5510 |
| skillion | 1144 |
| hip | 457 |
| pyramidal | 2 |
| dome | 2 |

### roof_color_source

| source | count | share |
|---|---|---|
| ortho | 20585 | 80.6% |
| heuristic | 4879 | 19.1% |
| landmark | 63 | 0.2% |
| override | 5 | 0.0% |

### wall_color

| color | count |
|---|---|
| brick | 9443 |
| brick_dark | 4906 |
| cream | 4542 |
| sand | 3314 |
| terracotta | 1630 |
| concrete | 862 |
| slate | 533 |
| steel | 178 |
| glass | 123 |
| deck | 1 |

### Buildings taller than 150 m

| id | name | height |
|---|---|---|
| override:CoStar Tower | CoStar Tower | 155.0 |

## Per-tile (top 15 by default-height share, buildings > 0)

| tile | buildings | default share | roads | terrain |
|---|---|---|---|---|
| 0_1 | 53 | 0.0% | 5 | yes |
| 0_2 | 79 | 0.0% | 21 | yes |
| 0_3 | 119 | 0.0% | 24 | yes |
| 0_4 | 88 | 0.0% | 19 | yes |
| 0_5 | 36 | 0.0% | 12 | yes |
| 0_6 | 43 | 0.0% | 13 | yes |
| 0_9 | 3 | 0.0% | 11 | yes |
| 0_10 | 2 | 0.0% | 19 | yes |
| 0_12 | 30 | 0.0% | 47 | yes |
| 0_13 | 51 | 0.0% | 54 | yes |
| 0_14 | 62 | 0.0% | 18 | yes |
| 0_15 | 21 | 0.0% | 20 | yes |
| 0_16 | 61 | 0.0% | 33 | yes |
| 0_17 | 50 | 0.0% | 41 | yes |
| 0_18 | 71 | 0.0% | 37 | yes |

## Roads

- total: 25569
- null/0 width: 0 (0.0%)

| highway | count |
|---|---|
| footway | 13884 |
| service | 5375 |
| residential | 2310 |
| primary | 1010 |
| tertiary | 960 |
| path | 420 |
| secondary | 414 |
| steps | 317 |
| motorway | 304 |
| motorway_link | 234 |

## Landmarks (in_first_slice)

- total in slice: 24
- matched: 24
- unmatched: 0

## Coverage

- LiDAR-sourced heights: 94.9%
- Overture-sourced heights: 0.1%
