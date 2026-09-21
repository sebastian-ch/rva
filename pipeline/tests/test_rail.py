"""process_rail: the tags the viewer needs to decide where trains may run."""
from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

from build_tiles import _write_layer
from process import process_rail


def _write(tmp_path, rows):
    gdf = gpd.GeoDataFrame(rows, geometry=[r["geometry"] for r in rows], crs="EPSG:4326")
    path = tmp_path / "rail.parquet"
    gdf.to_parquet(path)
    return path


def test_service_and_usage_reach_the_tile(tmp_path):
    rows = [
        {"element": "way", "id": 1, "railway": "rail", "usage": "main", "service": None,
         "geometry": LineString([(-77.44, 37.53), (-77.43, 37.53)])},
        {"element": "way", "id": 2, "railway": "rail", "usage": None, "service": "yard",
         "geometry": LineString([(-77.44, 37.532), (-77.43, 37.532)])},
    ]
    rail = process_rail(_write(tmp_path, rows))
    assert list(rail["service"])[1] == "yard"
    assert pd.isna(list(rail["service"])[0])
    assert list(rail["usage"])[0] == "main"
    assert pd.isna(list(rail["usage"])[1])


def test_unset_service_serializes_as_null_not_a_string(tmp_path):
    """The viewer keys 'runs trains here' off a missing service tag; a "nan" string would run them in the yard."""
    rows = [
        {"element": "way", "id": 1, "railway": "rail", "usage": "main", "service": None,
         "geometry": LineString([(-77.44, 37.53), (-77.43, 37.53)])},
        {"element": "way", "id": 2, "railway": "rail", "usage": None, "service": "yard",
         "geometry": LineString([(-77.44, 37.532), (-77.43, 37.532)])},
    ]
    rail = process_rail(_write(tmp_path, rows))
    dst = tmp_path / "rail.geojson"
    _write_layer(rail, dst)
    props = [f["properties"] for f in json.loads(dst.read_text())["features"]]
    assert props[0].get("service") is None
    assert props[1]["service"] == "yard"
    assert props[0]["usage"] == "main"
    assert props[1].get("usage") is None


def test_missing_service_and_usage_columns_are_none(tmp_path):
    rows = [{"element": "way", "id": 3, "railway": "rail",
             "geometry": LineString([(-77.44, 37.53), (-77.43, 37.53)])}]
    rail = process_rail(_write(tmp_path, rows))
    assert rail["service"].isna().all()
    assert rail["usage"].isna().all()
