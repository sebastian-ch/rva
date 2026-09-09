"""Tests for pipeline/overture.py — joining Overture attributes onto OSM footprints."""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pytest
from shapely.geometry import box

from overture import load_overture, match_overture

CRS = "EPSG:32618"


def _osm() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"name": ["A", "B", "C"]},
        geometry=[box(0, 0, 10, 10), box(20, 0, 30, 10), box(40, 0, 50, 10)],
        crs=CRS,
    )


def _ovt() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {
            "id": ["A'", "B'", "D'"],
            "height": [12.0, None, 50.0],
            "num_floors": [None, 3, None],
            "roof_shape": ["gabled", None, None],
            "roof_height": [np.nan, np.nan, np.nan],
        },
        geometry=[box(0.5, 0.5, 10.5, 10.5), box(20, 0, 25, 10), box(100, 100, 110, 110)],
        crs=CRS,
    )


def test_match_overture_basic():
    osm = _osm()
    ovt = _ovt()
    out = match_overture(osm, ovt)

    assert out.loc[0, "ovt_height"] == pytest.approx(12.0)
    assert out.loc[0, "ovt_roof_shape"] == "gable"
    assert out.loc[0, "ovt_iou"] > 0.8

    assert out.loc[1, "ovt_levels"] == 3
    assert pd.isna(out.loc[1, "ovt_height"])

    assert pd.isna(out.loc[2, "ovt_height"])
    assert pd.isna(out.loc[2, "ovt_levels"])
    assert out.loc[2, "ovt_roof_shape"] is None
    assert pd.isna(out.loc[2, "ovt_iou"])


def test_min_iou_threshold_excludes_partial_match():
    osm = _osm()
    ovt = _ovt()
    out = match_overture(osm, ovt, min_iou=0.6)
    # B/B' has IoU exactly 0.5 (50/100), which is below 0.6 -> unmatched.
    assert pd.isna(out.loc[1, "ovt_levels"])
    assert pd.isna(out.loc[1, "ovt_height"])


def test_empty_inputs_return_all_nan_frame_with_same_index():
    osm = _osm()
    empty_ovt = gpd.GeoDataFrame(geometry=[], crs=CRS)
    out = match_overture(osm, empty_ovt)
    assert list(out.index) == list(osm.index)
    assert out["ovt_height"].isna().all()
    assert out["ovt_levels"].isna().all()
    assert out["ovt_roof_shape"].isna().all()
    assert out["ovt_roof_height"].isna().all()
    assert out["ovt_iou"].isna().all()

    empty_osm = gpd.GeoDataFrame(geometry=[], crs=CRS)
    ovt = _ovt()
    out2 = match_overture(empty_osm, ovt)
    assert len(out2) == 0


def test_load_overture_missing_path_returns_empty_geodataframe():
    result = load_overture(Path("/nonexistent/path/does-not-exist.parquet"))
    assert isinstance(result, gpd.GeoDataFrame)
    assert len(result) == 0
