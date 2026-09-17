from __future__ import annotations

import struct

import geopandas as gpd
import pytest
from shapely.geometry import Point

from poi_table import HEADER, RECORD, encode_pois


def test_encode_pois_quantizes_coordinates_and_deduplicates_strings():
    pois = gpd.GeoDataFrame({
        "id": ["tree-1", "tree-2"], "name": [None, None], "kind": ["tree", "tree"],
        "species": ["Quercus alba", "Quercus alba"], "tree_height": [8.5, None],
        "crown_radius": [2.25, None], "geometry": [Point(10.123, 20.987), Point(11, 21)],
    }, crs="EPSG:32618")
    payload = encode_pois(pois, (10, 20, 260, 270))
    magic, count, strings, string_bytes = HEADER.unpack_from(payload)
    assert (magic, count, strings) == (b"POI1", 2, 4)  # null, two ids, shared species
    assert string_bytes == len(b"tree-1tree-2Quercus alba")
    assert RECORD.unpack_from(payload, HEADER.size)[:3] == (12, 99, 1)


def test_encode_pois_rejects_a_point_outside_its_tile():
    pois = gpd.GeoDataFrame({"id": ["bad"], "kind": ["tree"], "geometry": [Point(261, 20)]}, crs="EPSG:32618")
    with pytest.raises(ValueError, match="outside"):
        encode_pois(pois, (10, 20, 260, 270))
