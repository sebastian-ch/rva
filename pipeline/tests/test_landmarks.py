"""Tests for pipeline/landmarks.py: name-hint matching, kind-based nearest lookup, and full resolution."""
from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd
import pytest
from pyproj import Transformer
from shapely.geometry import Point

import landmarks
from config import CRS_PROJ
from landmarks import (
    HINT_RADIUS,
    NEAR_RADIUS,
    _kind_filter,
    _name_hit,
    _nearest_of_kind,
    _tokens,
    resolve_landmarks,
)

REG_LON, REG_LAT = -77.43, 37.53


# --------------------------------------------------------------------- _tokens

def test_tokens_drops_initial_stopword():
    assert _tokens("Maggie L. Walker Memorial") == ["maggie", "walker", "memorial"]


def test_tokens_drops_leading_article():
    assert _tokens("The Diamond") == ["diamond"]


# --------------------------------------------------------------------- _name_hit

def _name_hit_frame():
    return gpd.GeoDataFrame(
        {
            "name": [
                "Maggie Walker Statue",
                "Hilton Richmond Downtown",
                "Maggie L. Walker National Historic Site",
            ],
            "geometry": [Point(0, 0), Point(50, 0), Point(400, 0)],
        },
        crs=CRS_PROJ,
    )


def test_name_hit_prefix_match_picks_first_by_idxmax():
    g = _name_hit_frame()
    pt = Point(10, 0)
    hit = _name_hit(g, ["Maggie L. Walker Memorial"], pt)
    assert hit is not None
    assert "Maggie" in hit["name"]


def test_name_hit_no_match_returns_none():
    g = _name_hit_frame()
    pt = Point(10, 0)
    assert _name_hit(g, ["Nonexistent Thing"], pt) is None


def test_name_hit_respects_hint_radius():
    g = gpd.GeoDataFrame(
        {"name": ["Maggie Walker Statue"], "geometry": [Point(10_000, 0)]},
        crs=CRS_PROJ,
    )
    pt = Point(0, 0)
    assert _name_hit(g, ["Maggie L. Walker Memorial"], pt) is None


# --------------------------------------------------------------------- _nearest_of_kind

def test_nearest_of_kind_memorial_excludes_hotel():
    g = gpd.GeoDataFrame(
        {
            "historic": ["memorial", None],
            "tourism": [None, "hotel"],
            "geometry": [Point(20, 0), Point(5, 0)],
        },
        crs=CRS_PROJ,
    )
    pt = Point(0, 0)
    hit = _nearest_of_kind(g, "pois", "memorial", pt)
    assert hit is not None
    assert hit["historic"] == "memorial"


def test_nearest_of_kind_excludes_district_sized_polygon():
    from shapely.geometry import box

    g = gpd.GeoDataFrame(
        {"landuse": ["cemetery"], "geometry": [box(0, 0, 500, 500)]},
        crs=CRS_PROJ,
    )
    pt = Point(10, 10)
    assert _nearest_of_kind(g, "landuse", "site", pt) is None


def test_nearest_of_kind_none_within_radius():
    g = gpd.GeoDataFrame(
        {"historic": ["memorial"], "geometry": [Point(NEAR_RADIUS + 10, 0)]},
        crs=CRS_PROJ,
    )
    pt = Point(0, 0)
    assert _nearest_of_kind(g, "pois", "memorial", pt) is None


# --------------------------------------------------------------------- _kind_filter

def test_kind_filter_bridge_excludes_no_and_nan():
    g = gpd.GeoDataFrame(
        {
            "bridge": ["yes", "no", None],
            "geometry": [Point(0, 0), Point(1, 0), Point(2, 0)],
        },
        crs=CRS_PROJ,
    )
    out = _kind_filter(g, "roads", "bridge")
    assert list(out["bridge"]) == ["yes"]


# --------------------------------------------------------------------- resolve_landmarks

@pytest.fixture
def landmarks_registry(tmp_path, monkeypatch):
    reg = [
        {
            "slug": "mayo-bridge",
            "name": "Mayo Bridge",
            "kind": "bridge",
            "osm_name_hints": ["Mayo Bridge"],
            "lon": REG_LON,
            "lat": REG_LAT,
        },
        {
            "slug": "missing-memorial",
            "name": "Nowhere Memorial",
            "kind": "memorial",
            "osm_name_hints": ["Nowhere Memorial"],
            "lon": REG_LON,
            "lat": REG_LAT,
        },
    ]
    path = tmp_path / "landmarks.json"
    path.write_text(json.dumps(reg))
    monkeypatch.setattr(landmarks, "LANDMARKS_PATH", path)
    return path


def _write_raw(tmp_path, tr, name):
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir(exist_ok=True)
    x, y = tr.transform(REG_LON, REG_LAT)
    roads = gpd.GeoDataFrame(
        {"id": [1], "bridge": ["yes"], "name": ["Mayo Bridge"], "geometry": [Point(x, y)]},
        crs=CRS_PROJ,
    ).to_crs("EPSG:4326")
    roads.to_parquet(raw_dir / "roads.parquet")

    pois = gpd.GeoDataFrame(
        {"id": [2], "historic": [None], "tourism": [None], "name": ["Something Else"],
         "geometry": [Point(x + 1000, y + 1000)]},
        crs=CRS_PROJ,
    ).to_crs("EPSG:4326")
    pois.to_parquet(raw_dir / "pois.parquet")
    return raw_dir


def test_resolve_landmarks(tmp_path, landmarks_registry):
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    raw_dir = _write_raw(tmp_path, tr, "raw")

    buildings = gpd.GeoDataFrame({"landmark": []}, geometry=[], crs=CRS_PROJ)

    result = resolve_landmarks(raw_dir, buildings, terrain=None)

    assert set(result.keys()) == {"mayo-bridge", "missing-memorial"}

    bridge = result["mayo-bridge"]
    assert bridge["how"] == "name:roads"
    assert bridge["matched"].startswith("osm:")

    memorial = result["missing-memorial"]
    assert memorial["how"] is None
    x, y = tr.transform(REG_LON, REG_LAT)
    assert memorial["x"] == pytest.approx(x, abs=0.1)
    assert memorial["y"] == pytest.approx(y, abs=0.1)
