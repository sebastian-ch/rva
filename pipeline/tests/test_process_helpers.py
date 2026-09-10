"""Tests for the small row-level helpers in pipeline/process.py."""
from __future__ import annotations

import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString, Point

from config import LANE_WIDTH
from process import (_generated_sidewalk, _landuse_kind, _match_crossings_to_roads, _nn, _poi_kind,
                     _render_sidewalk_side, _road_width)


# --------------------------------------------------------------------- _nn

def test_nn():
    assert _nn(float("nan")) is None
    assert _nn(None) is None
    assert _nn("hello") == "hello"
    assert _nn(5) == 5
    assert _nn(0) == 0  # falsy but not NaN/None: must be preserved


# --------------------------------------------------------------------- _landuse_kind

def test_landuse_kind():
    cases = [
        ({"leisure": "park"}, "park"),
        ({"amenity": "parking"}, "parking"),
        ({"landuse": "cemetery"}, "cemetery"),
        ({"natural": "grassland"}, "grass"),
        ({"place": "square"}, "plaza"),
        ({"landuse": "forest"}, "forest"),
        ({}, None),
        ({"landuse": float("nan"), "leisure": float("nan")}, None),
    ]
    for tags, expected in cases:
        row = pd.Series(tags, dtype=object)
        assert _landuse_kind(row) == expected, tags


# --------------------------------------------------------------------- _poi_kind

def test_poi_kind():
    cases = [
        ({"natural": "tree"}, "tree"),
        ({"highway": "street_lamp"}, "streetlight"),
        ({"shop": "bakery"}, "shop"),
        ({"amenity": "restaurant"}, "restaurant"),
        ({"highway": "bus_stop"}, "bus_stop"),
        ({}, None),
        # natural=tree should win even when other matching tags are present
        ({"natural": "tree", "shop": "kiosk"}, "tree"),
    ]
    for tags, expected in cases:
        row = pd.Series(tags, dtype=object)
        assert _poi_kind(row) == expected, tags


# --------------------------------------------------------------------- _road_width

def test_road_width_unknown_highway_default():
    row = pd.Series({"highway": "mystery_type"})
    assert _road_width(row) == 6.0


def test_road_width_residential_base():
    row = pd.Series({"highway": "residential"})
    assert _road_width(row) == 7.0


def test_road_width_lanes_override_widens():
    row = pd.Series({"highway": "residential", "lanes": "4"})
    expected = round(max(7.0, 4 * LANE_WIDTH), 1)
    assert _road_width(row) == expected
    assert _road_width(row) > 7.0


def test_road_width_lanes_do_not_narrow_below_class_width():
    # A primary road (base width 11.0) with a single lane must not shrink.
    row = pd.Series({"highway": "primary", "lanes": "1"})
    assert _road_width(row) == 11.0


def test_service_road_normalizes_missing_sidewalk_tags_to_false():
    row = pd.Series({"highway": "service"})
    assert not _generated_sidewalk(row)
    assert _render_sidewalk_side(row, "left") is False
    assert _render_sidewalk_side(row, "right") is False


def test_residential_road_retains_sidewalk_source_state():
    assert _generated_sidewalk(pd.Series({"highway": "residential"}))
    assert _render_sidewalk_side(pd.Series({"highway": "residential"}), "left") is None
    assert _render_sidewalk_side(pd.Series({"highway": "residential", "sidewalk:left": "no"}), "left") is False
    assert _render_sidewalk_side(pd.Series({"highway": "residential", "sidewalk:right": "separate"}), "right") is True


def test_crossing_topology_prefers_road_perpendicular_to_crossing_footway():
    roads = gpd.GeoDataFrame([
        {"id": "east-west", "highway": "primary", "width": 10.0, "bridge": False, "tunnel": False, "footway": None,
         "geometry": LineString([(-10, 0), (10, 0)])},
        {"id": "north-south", "highway": "secondary", "width": 8.0, "bridge": False, "tunnel": False, "footway": None,
         "geometry": LineString([(0.5, -10), (0.5, 10)])},
        {"id": "pedestrian-crossing", "highway": "footway", "width": 2.0, "bridge": False, "tunnel": False, "footway": "crossing",
         "geometry": LineString([(0.5, -5), (0.5, 5)])},
    ], crs="EPSG:32618")
    points = gpd.GeoDataFrame([{"geometry": Point(0.5, 0)}], crs=roads.crs)
    matched = _match_crossings_to_roads(points, roads)
    assert matched["road_id"] == ["east-west"]
    assert matched["road_x"] == [0.5]
    assert matched["road_y"] == [0.0]
