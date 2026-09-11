from __future__ import annotations

import geopandas as gpd
from shapely.geometry import LineString, box

from build_tiles import _tile_layer


def test_road_tile_clips_features_to_its_bounds():
    roads = gpd.GeoDataFrame([
        {"id": "road", "highway": "residential", "footway": None,
         "geometry": LineString([(0, 9), (10, 9)])},
        {"id": "sidewalk", "highway": "footway", "footway": "sidewalk",
         "geometry": LineString([(0, 12), (10, 12)])},
    ], crs="EPSG:32618")

    part = _tile_layer(roads, roads.sindex, "roads", box(0, 0, 10, 10))

    assert list(part["id"]) == ["road"]
    assert tuple(part.total_bounds) == (0.0, 9.0, 10.0, 9.0)
