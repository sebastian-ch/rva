"""Tests for the small row-level helpers in pipeline/process.py."""
from __future__ import annotations

import pandas as pd

from config import LANE_WIDTH
from process import _landuse_kind, _nn, _poi_kind, _road_width


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
