"""Tests for pipeline/schema.py: validate_feature on synthetic data, plus a real-data sanity check."""
from __future__ import annotations

import json

import pytest

from config import DATA_TILES
from schema import LAYER_KEYS, validate_feature

# --------------------------------------------------------------------- synthetic good/bad dicts

GOOD_BUILDING = {
    "id": "osm:way/1", "name": "Test Building", "height": 12.5, "min_height": 0.0, "levels": 4,
    "height_source": "osm_levels", "roof_shape": "flat", "roof_height": 0.0, "roof_azimuth": None,
    "roof_source": "heuristic", "roof_color": "roof_flat", "wall_color": "brick", "type": "yes",
    "landmark": None, "is_part": False, "footprint_source": "osm", "parent": None, "hidden": False, "addr": "100 Main Street", "wikidata": None, "website": None,
    "zoning": "B-3", "lidar_p90": None, "ground_z": 30.0,
}

GOOD_ROAD = {
    "id": "osm:way/2", "name": "Main Street", "highway": "primary", "lanes": 2, "width": 11.0,
    "oneway": False, "surface": "asphalt", "sidewalk": True, "bridge": False, "ramp": False, "tunnel": False,
    "layer": 0, "deck": None,
}

GOOD_BRIDGE_ROAD = {**GOOD_ROAD, "id": "osm:way/3", "bridge": True, "ramp": False, "deck": [0.0, 0.0, 5.0, 10.0, 10.0, 6.0]}


def test_good_building_has_no_problems():
    assert validate_feature("buildings", GOOD_BUILDING) == []


def test_good_road_has_no_problems():
    assert validate_feature("roads", GOOD_ROAD) == []


def test_good_bridge_road_has_no_problems():
    assert validate_feature("roads", GOOD_BRIDGE_ROAD) == []


def test_missing_keys_reported():
    bad = dict(GOOD_BUILDING)
    del bad["height_source"]
    del bad["roof_shape"]
    problems = validate_feature("buildings", bad)
    assert len(problems) == 1
    assert "missing keys" in problems[0]
    assert "height_source" in problems[0] and "roof_shape" in problems[0]


def test_unknown_height_source():
    bad = {**GOOD_BUILDING, "height_source": "guessed"}
    problems = validate_feature("buildings", bad)
    assert any("height_source" in p for p in problems)


def test_unknown_roof_shape():
    bad = {**GOOD_BUILDING, "roof_shape": "tent"}
    problems = validate_feature("buildings", bad)
    assert any("roof_shape" in p for p in problems)


def test_negative_height_reported():
    bad = {**GOOD_BUILDING, "height": -3.0}
    problems = validate_feature("buildings", bad)
    assert any("height" in p and "negative" in p for p in problems)


def test_negative_min_height_reported():
    bad = {**GOOD_BUILDING, "min_height": -1.0}
    problems = validate_feature("buildings", bad)
    assert any("min_height" in p and "negative" in p for p in problems)


def test_roof_azimuth_out_of_range():
    bad = {**GOOD_BUILDING, "roof_azimuth": 270.0}
    problems = validate_feature("buildings", bad)
    assert any("roof_azimuth" in p for p in problems)


def test_roof_azimuth_in_range_ok():
    good = {**GOOD_BUILDING, "roof_azimuth": 90.0}
    assert validate_feature("buildings", good) == []


def test_bridge_without_deck_list_reported():
    bad = {**GOOD_ROAD, "bridge": True, "ramp": False, "deck": None}
    problems = validate_feature("roads", bad)
    assert any("deck" in p for p in problems)


def test_bridge_deck_wrong_length_reported():
    bad = {**GOOD_ROAD, "bridge": True, "ramp": False, "deck": [1.0, 2.0, 3.0]}
    problems = validate_feature("roads", bad)
    assert any("deck" in p for p in problems)


def test_bridge_deck_as_json_string_ok():
    # DATA_FORMAT.md: on-disk tile files may carry deck as a JSON-encoded string.
    ok = {**GOOD_ROAD, "bridge": True, "ramp": False, "deck": json.dumps([0.0, 0.0, 5.0, 10.0, 10.0, 6.0])}
    assert validate_feature("roads", ok) == []


def test_unknown_landuse_kind():
    bad = {"id": "osm:way/4", "name": None, "kind": "swamp"}
    problems = validate_feature("landuse", bad)
    assert any("landuse kind" in p for p in problems)


def test_unknown_layer():
    problems = validate_feature("not_a_layer", {})
    assert problems and "unknown layer" in problems[0]


def test_layer_keys_cover_data_format_columns():
    # Sanity check on the fixture itself: every layer in DATA_FORMAT.md has a non-empty key set.
    assert set(LAYER_KEYS) == {"buildings", "roads", "rail", "landuse", "water", "crossings", "pois"}
    assert all(LAYER_KEYS[layer] for layer in LAYER_KEYS)


# --------------------------------------------------------------------- real data/tiles sanity check

def _iter_real_features():
    for tdir in sorted(p for p in DATA_TILES.iterdir() if p.is_dir()):
        for layer in LAYER_KEYS:
            fp = tdir / f"{layer}.geojson"
            if not fp.exists():
                continue
            d = json.loads(fp.read_text())
            for feat in d.get("features", []):
                yield layer, tdir.name, feat


def test_real_tiles_validate_clean():
    if not (DATA_TILES / "index.json").exists():
        pytest.skip("no data/tiles/index.json; run pipeline/build_tiles.py first")
    problems = []
    for layer, tid, feat in _iter_real_features():
        for msg in validate_feature(layer, feat["properties"]):
            problems.append(f"[{layer}/{tid}] {msg}")
    assert not problems, f"{len(problems)} problem(s), first 20: {problems[:20]}"
