# QA report — 2026-09-11T22:52:21.623274+00:00

bbox (WGS84): `[-77.486, 37.517, -77.418, 37.568]`

## Buildings

- total: 22655
- named: 1137 (5.0%)
- default height share: 2 (0.0%)
- footprints under 15 m² or < 4 vertices: 653 (first 10 ids: osm:way/755825918, osm:way/755825879, osm:way/755825634, richmond_structure:348419, richmond_structure:344617, osm:way/755825477, osm:way/755826046, richmond_structure:397621, osm:way/755825676, osm:way/755825459)
- with roof_azimuth: 5535

### height_source

| source | count | share |
|---|---|---|
| lidar | 20741 | 91.6% |
| osm_levels | 865 | 3.8% |
| zoning | 808 | 3.6% |
| osm_height | 189 | 0.8% |
| overture_height | 31 | 0.1% |
| landmark_hint | 16 | 0.1% |
| override | 3 | 0.0% |
| default | 2 | 0.0% |

### roof_shape

| shape | count |
|---|---|
| flat | 16029 |
| gable | 5105 |
| skillion | 1065 |
| hip | 452 |
| pyramidal | 2 |
| dome | 2 |

### wall_color

| color | count |
|---|---|
| brick | 4899 |
| sand | 4555 |
| cream | 4364 |
| terracotta | 4327 |
| concrete | 4063 |
| brick_dark | 378 |
| glass | 29 |
| steel | 28 |
| slate | 12 |

### Buildings taller than 150 m

| id | name | height |
|---|---|---|
| override:CoStar Tower | CoStar Tower | 155.0 |

## Per-tile (top 15 by default-height share, buildings > 0)

| tile | buildings | default share | roads | terrain |
|---|---|---|---|---|
| 13_5 | 3 | 33.3% | 57 | yes |
| 19_12 | 10 | 10.0% | 115 | yes |
| 0_1 | 53 | 0.0% | 5 | yes |
| 0_2 | 78 | 0.0% | 21 | yes |
| 0_3 | 116 | 0.0% | 24 | yes |
| 0_4 | 87 | 0.0% | 19 | yes |
| 0_5 | 36 | 0.0% | 12 | yes |
| 0_6 | 42 | 0.0% | 13 | yes |
| 0_9 | 3 | 0.0% | 11 | yes |
| 0_10 | 2 | 0.0% | 19 | yes |
| 0_12 | 30 | 0.0% | 47 | yes |
| 0_13 | 51 | 0.0% | 54 | yes |
| 0_14 | 62 | 0.0% | 18 | yes |
| 0_15 | 21 | 0.0% | 20 | yes |
| 0_16 | 61 | 0.0% | 33 | yes |

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

- total in slice: 12
- matched: 12
- unmatched: 0

## Coverage

- LiDAR-sourced heights: 91.6%
- Overture-sourced heights: 0.1%
