"""Tests for pipeline/fetch_lidar.py — node_bounds, _intersects, select_nodes, detect_feet."""
from __future__ import annotations

import numpy as np
import pytest

from fetch_lidar import _intersects, detect_feet, node_bounds, select_nodes

BOUNDS = [0, 0, 0, 256, 256, 256]


def test_node_bounds_root():
    assert node_bounds("0-0-0-0", BOUNDS) == (0, 0, 256, 256)


def test_node_bounds_depth1():
    assert node_bounds("1-1-0-0", BOUNDS) == (128, 0, 256, 128)


def test_node_bounds_depth2():
    assert node_bounds("2-3-2-0", BOUNDS) == (192, 128, 256, 192)


def test_intersects_true():
    assert _intersects((0, 0, 10, 10), (5, 5, 15, 15)) is True


def test_intersects_false():
    assert _intersects((0, 0, 10, 10), (20, 20, 30, 30)) is False


def test_intersects_edge_touching_is_false():
    # Sharing only an edge (no area overlap) must not count as intersecting.
    assert _intersects((0, 0, 10, 10), (10, 0, 20, 10)) is False


def test_select_nodes_walks_hierarchy_and_respects_bbox_and_depth():
    root_hier = {
        "0-0-0-0": 100,
        "1-0-0-0": 50,   # -x half: does not intersect the +x bbox -> excluded
        "1-1-0-0": -1,   # +x half: subtree lives in its own hierarchy file
        "1-0-1-0": 0,    # count 0 -> excluded regardless of intersection
    }
    fetch_calls: list[str] = []

    def fetch_hier(key: str) -> dict[str, int]:
        fetch_calls.append(key)
        return {"1-1-0-0": 20, "2-2-0-0": 5, "3-4-0-0": 99}

    bbox_ept = (128, 0, 256, 256)  # +x half only
    result = select_nodes(bbox_ept, BOUNDS, max_depth=2, root_hier=root_hier, fetch_hier=fetch_hier)

    assert result == {"0-0-0-0": 100, "1-1-0-0": 20, "2-2-0-0": 5}
    assert "1-0-0-0" not in result
    assert "1-0-1-0" not in result
    assert "3-4-0-0" not in result  # depth 3 > max_depth(2), never expanded
    assert fetch_calls == ["1-1-0-0"]


def test_detect_feet_true_for_survey_feet_ratio():
    rng = np.random.default_rng(0)
    dem = rng.uniform(20, 60, 200)
    z = dem * 3.2808
    assert detect_feet(z, dem) == True


def test_detect_feet_false_for_meters():
    rng = np.random.default_rng(0)
    dem = rng.uniform(20, 60, 200)
    z = dem.copy()
    assert detect_feet(z, dem) == False


def test_detect_feet_false_with_too_few_valid_samples():
    rng = np.random.default_rng(0)
    dem = rng.uniform(20, 60, 40)  # fewer than 50
    z = dem * 3.2808
    assert detect_feet(z, dem) == False


def test_detect_feet_ignores_nans():
    rng = np.random.default_rng(0)
    dem = rng.uniform(20, 60, 200)
    z = dem * 3.2808
    dem = dem.copy()
    dem[:100] = np.nan  # leaves 100 valid samples, still >= 50
    assert detect_feet(z, dem) == True


def test_ept_crs_reads_srs_block_or_falls_back():
    from fetch_lidar import SOURCES, ept_crs

    assert ept_crs({"srs": {"authority": "EPSG", "horizontal": "3748", "vertical": "5703"}}, "EPSG:3857") == "EPSG:3748"
    assert ept_crs({"srs": {}}, "EPSG:3857") == "EPSG:3857"
    assert ept_crs({}, "EPSG:3857") == "EPSG:3857"
    assert all({"root", "crs", "max_depth"} <= set(v) for v in SOURCES.values())
