"""Tests for pipeline/heights.py pure functions."""
from __future__ import annotations

import json

import pytest

from config import DEFAULT_HEIGHT, DEFAULT_HEIGHT_BY_TYPE, LEVEL_HEIGHT, PALETTE_PATH
from heights import (
    WALL_KEYS,
    parse_length_m,
    parse_levels,
    resolve_colors,
    resolve_height,
    resolve_min_height,
    resolve_roof,
    snap_color,
)


# --------------------------------------------------------------------- parse_length_m

def test_parse_length_m_valid_forms():
    cases = {
        "12": 12.0,
        "12 m": 12.0,
        "12.5m": 12.5,
        "40 ft": 40 * 0.3048,
        "40'": 40 * 0.3048,
        "40'6\"": (40 + 6 / 12.0) * 0.3048,
        "3;5": 3.0,  # takes first of a semicolon list
    }
    for raw, expected in cases.items():
        assert parse_length_m(raw) == pytest.approx(expected), raw


def test_parse_length_m_invalid_forms():
    for raw in (None, float("nan"), "abc", "0", "-5"):
        assert parse_length_m(raw) is None, raw


# --------------------------------------------------------------------- parse_levels

def test_parse_levels_valid_forms():
    cases = {
        "3": 3,
        "3.0": 3,
        "2.5": 2,  # Python round-half-to-even: round(2.5) == 2
        "4;5": 4,  # takes first of a semicolon list
    }
    for raw, expected in cases.items():
        assert parse_levels(raw) == expected, raw


def test_parse_levels_invalid_forms():
    for raw in (None, float("nan"), "x", "0"):
        assert parse_levels(raw) is None, raw


# --------------------------------------------------------------------- resolve_height

def test_resolve_height_osm_height_wins_over_levels():
    h, levels, source = resolve_height({"height": "20", "building:levels": "3"})
    assert h == pytest.approx(20.0)
    assert levels == 3
    assert source == "osm_height"


def test_resolve_height_levels_times_level_height():
    h, levels, source = resolve_height({"building:levels": "4"})
    assert h == pytest.approx(4 * LEVEL_HEIGHT)
    assert levels == 4
    assert source == "osm_levels"


def test_resolve_height_lidar_used_when_no_osm_data():
    h, levels, source = resolve_height({}, lidar_median=15.0)
    assert h == pytest.approx(15.0)
    assert levels is None
    assert source == "lidar"


def test_resolve_height_lidar_ignored_at_or_below_threshold():
    for lidar_median in (2.0, 1.0):
        h, _, source = resolve_height({}, lidar_median=lidar_median)
        assert source == "default", lidar_median
        assert h == DEFAULT_HEIGHT


def test_resolve_height_type_default_office():
    h, _, source = resolve_height({"building": "office"})
    assert h == pytest.approx(DEFAULT_HEIGHT_BY_TYPE["office"])
    assert h == pytest.approx(20.0)
    assert source == "default"


def test_resolve_height_unknown_type_falls_back_to_default_height():
    h, _, source = resolve_height({"building": "some_unlisted_type"})
    assert h == DEFAULT_HEIGHT
    assert source == "default"


# --------------------------------------------------------------------- resolve_min_height

def test_resolve_min_height():
    assert resolve_min_height({"min_height": "3.5"}) == pytest.approx(3.5)
    assert resolve_min_height({"building:min_level": "2"}) == pytest.approx(2 * LEVEL_HEIGHT)
    assert resolve_min_height({}) == 0.0
    # min_height wins over building:min_level when both present
    assert resolve_min_height({"min_height": "1", "building:min_level": "5"}) == pytest.approx(1.0)


# --------------------------------------------------------------------- resolve_roof

def test_resolve_roof_explicit_shape_and_aliases():
    cases = {
        "dome": "dome",
        "gabled": "gable",
        "hipped": "hip",
        "mansard": "hip",
    }
    for raw_shape, expected in cases.items():
        shape, _ = resolve_roof({"roof:shape": raw_shape}, height=10, footprint_area=100)
        assert shape == expected, raw_shape


def test_resolve_roof_invalid_shape_falls_back():
    shape, _ = resolve_roof(
        {"roof:shape": "not_a_real_shape", "building": "house"}, height=8, footprint_area=100
    )
    assert shape == "gable"


def test_resolve_roof_small_house_defaults_to_gable():
    shape, _ = resolve_roof({"building": "house"}, height=8, footprint_area=150)
    assert shape == "gable"


def test_resolve_roof_church_small_defaults_to_gable():
    shape, _ = resolve_roof({"building": "church"}, height=10, footprint_area=500)
    assert shape == "gable"


def test_resolve_roof_large_commercial_defaults_to_flat_with_zero_height():
    shape, rh = resolve_roof({"building": "commercial"}, height=25, footprint_area=3000)
    assert shape == "flat"
    assert rh == 0.0


def test_resolve_roof_explicit_roof_height_respected():
    shape, rh = resolve_roof(
        {"building": "house", "roof:height": "2.5"}, height=8, footprint_area=150
    )
    assert shape == "gable"
    assert rh == pytest.approx(2.5)


def test_resolve_roof_fallback_heights_are_bounded():
    _, rh_gable = resolve_roof({"roof:shape": "gabled"}, height=10, footprint_area=1.0)
    assert 1.5 <= rh_gable <= 4.0
    _, rh_pyramidal = resolve_roof({"roof:shape": "pyramid"}, height=10, footprint_area=1_000_000.0)
    assert 2.0 <= rh_pyramidal <= 6.0


# --------------------------------------------------------------------- snap_color

def test_snap_color_named_and_hex():
    assert snap_color("red", WALL_KEYS) == "brick"
    assert snap_color("#b5583f", WALL_KEYS) == "brick"
    assert snap_color("#fff", WALL_KEYS) == "cream"


def test_snap_color_garbage_and_missing_return_none():
    assert snap_color("not-a-color-at-all", WALL_KEYS) is None
    assert snap_color(None, WALL_KEYS) is None


def test_snap_color_candidate_restriction():
    # "red" maps to "brick", which is excluded from the candidate set here.
    assert snap_color("red", ("concrete", "steel")) is None
    # Nearest palette color to white is still restricted to the candidates given.
    assert snap_color("#ffffff", ("concrete", "steel")) in ("concrete", "steel")


# --------------------------------------------------------------------- resolve_colors

def _palette_keys() -> set[str]:
    data = json.loads(PALETTE_PATH.read_text())
    return {k for k in data if not k.startswith("_")}


def test_resolve_colors_deterministic_for_same_seed():
    tags = {"building": "house"}
    a = resolve_colors(tags, height=8, roof_shape="gable", seed=3)
    b = resolve_colors(tags, height=8, roof_shape="gable", seed=3)
    assert a == b


def test_resolve_colors_building_colour_honored():
    wall, _ = resolve_colors({"building:colour": "red"}, height=8, roof_shape="gable", seed=0)
    assert wall == "brick"


def test_resolve_colors_material_glass():
    wall, _ = resolve_colors({"building:material": "glass"}, height=8, roof_shape="flat", seed=0)
    assert wall == "glass"


def test_resolve_colors_flat_roof_default_in_flat_roof_key_set():
    for seed in range(4):
        _, roof = resolve_colors({}, height=8, roof_shape="flat", seed=seed)
        assert roof in {"roof_flat", "concrete", "roof_dark"}, seed


def test_resolve_colors_keys_exist_in_palette():
    palette_keys = _palette_keys()
    for seed in range(6):
        for height in (5, 30, 80):
            for roof_shape in ("flat", "gable", "hip"):
                wall, roof = resolve_colors({}, height=height, roof_shape=roof_shape, seed=seed)
                assert wall in palette_keys
                assert roof in palette_keys
