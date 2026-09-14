import geopandas as gpd
import pandas as pd
import json
import pytest
from shapely.affinity import rotate, translate
from shapely.geometry import Polygon, box

from process import process_landuse


def test_pitch_retains_sport_surface_and_stable_layout_for_rendering(tmp_path):
    raw = gpd.GeoDataFrame({
        "element": ["way", "way"],
        "id": [1, 2],
        "name": ["Court", "Lawn"],
        "leisure": ["pitch", None],
        "sport": ["tennis", None],
        "surface": ["tartan", None],
        "landuse": [None, "grass"],
    }, geometry=[box(-77.45, 37.54, -77.449, 37.541), box(-77.46, 37.54, -77.459, 37.541)], crs="EPSG:4326")
    path = tmp_path / "landuse.parquet"
    raw.to_parquet(path)

    result = process_landuse(path).set_index("id")

    assert result.loc["osm:way/1", "kind"] == "pitch"
    assert result.loc["osm:way/1", "sport"] == "tennis"
    assert result.loc["osm:way/1", "surface"] == "tartan"
    layout = json.loads(result.loc["osm:way/1", "pitch_layout"])
    assert layout["hl"] > layout["hs"] > 1
    assert result.loc["osm:way/2", "kind"] == "grass"
    assert pd.isna(result.loc["osm:way/2", "sport"])


def test_baseball_layout_uses_corner_with_two_long_boundary_runs(tmp_path):
    # The tiny outfield notch is sharper than home, but its adjacent runs are short.
    diamond = translate(rotate(Polygon([(0, 0), (80, 0), (81, 40), (81, 41), (40, 81), (0, 80)]), 12,
                                      origin=(0, 0)), xoff=280000, yoff=4158000)
    expected_home = diamond.exterior.coords[0]
    raw = gpd.GeoDataFrame({
        "element": ["way"], "id": [3], "name": ["Diamond"], "leisure": ["pitch"],
        "sport": ["baseball"], "surface": ["grass"], "landuse": [None],
    }, geometry=[diamond], crs="EPSG:32618")
    path = tmp_path / "baseball.parquet"
    raw.to_parquet(path)

    layout = json.loads(process_landuse(path).iloc[0]["pitch_layout"])

    assert layout["hx"] == pytest.approx(expected_home[0])
    assert layout["hy"] == pytest.approx(expected_home[1])
    assert layout["la"] >= 80
    assert layout["lb"] >= 80
