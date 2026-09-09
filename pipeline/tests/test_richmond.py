"""Tests for pipeline/richmond.py: zoning height defaults and address/zoning joins."""
from __future__ import annotations

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import Point, box

from config import CRS_PROJ
from richmond import join_addresses, join_zoning, zoning_height


# --------------------------------------------------------------------- zoning_height

@pytest.mark.parametrize(
    "name,expected",
    [
        ("B-4", 24.0),
        ("B-5C", 20.0),
        ("R-63", 9.0),
        ("R-6", 7.5),
        ("TOD-1", 16.0),
        ("M-1", 8.0),
        (None, None),
        ("ZZZ", None),
    ],
)
def test_zoning_height(name, expected):
    assert zoning_height(name) == expected


# --------------------------------------------------------------------- join_addresses

def test_join_addresses_lowest_address_id_wins():
    buildings = gpd.GeoDataFrame(
        {"geometry": [box(0, 0, 10, 10), box(100, 100, 110, 110)]},
        crs=CRS_PROJ,
    )
    addresses = gpd.GeoDataFrame(
        {
            "AddressLabel": ["B", "A"],
            "AddressId": [7, 3],
            "geometry": [Point(5, 5), Point(6, 6)],
        },
        crs=CRS_PROJ,
    )
    out = join_addresses(buildings, addresses)
    assert out.iloc[0] == "A"
    assert out.iloc[1] is None


def test_join_addresses_none_input():
    buildings = gpd.GeoDataFrame({"geometry": [box(0, 0, 10, 10)]}, crs=CRS_PROJ)
    out = join_addresses(buildings, None)
    assert out.iloc[0] is None


def test_join_addresses_preserves_custom_index():
    buildings = gpd.GeoDataFrame(
        {"geometry": [box(0, 0, 10, 10), box(100, 100, 110, 110)]},
        index=[10, 20],
        crs=CRS_PROJ,
    )
    addresses = gpd.GeoDataFrame(
        {
            "AddressLabel": ["B", "A"],
            "AddressId": [7, 3],
            "geometry": [Point(5, 5), Point(6, 6)],
        },
        crs=CRS_PROJ,
    )
    out = join_addresses(buildings, addresses)
    assert list(out.index) == [10, 20]
    assert out.loc[10] == "A"
    assert out.loc[20] is None


# --------------------------------------------------------------------- join_zoning

def test_join_zoning_inside_and_outside():
    zoning = gpd.GeoDataFrame(
        {"Name": ["B-4", "R-6"], "geometry": [box(0, 0, 50, 50), box(100, 100, 150, 150)]},
        crs=CRS_PROJ,
    )
    buildings = gpd.GeoDataFrame(
        {"geometry": [box(10, 10, 20, 20), box(500, 500, 510, 510)]},
        crs=CRS_PROJ,
    )
    out = join_zoning(buildings, zoning)
    assert out.iloc[0] == "B-4"
    assert pd.isna(out.iloc[1])


def test_join_zoning_overlapping_polygons_no_duplicates():
    zoning = gpd.GeoDataFrame(
        {"Name": ["B-4", "R-6"], "geometry": [box(0, 0, 50, 50), box(20, 20, 70, 70)]},
        crs=CRS_PROJ,
    )
    buildings = gpd.GeoDataFrame(
        {"geometry": [box(25, 25, 35, 35)]},
        crs=CRS_PROJ,
    )
    out = join_zoning(buildings, zoning)
    assert len(out) == 1
    assert out.iloc[0] in ("B-4", "R-6")
