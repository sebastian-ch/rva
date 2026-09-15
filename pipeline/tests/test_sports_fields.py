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


def test_specific_court_is_cut_out_of_enclosing_anonymous_pitch(tmp_path):
    outer = box(280000, 4158000, 280100, 4158100)
    court = box(280020, 4158020, 280080, 4158080)
    raw = gpd.GeoDataFrame({
        "element": ["way", "way"], "id": [10, 11], "name": [None, None],
        "leisure": ["pitch", "pitch"], "sport": [None, "tennis"],
        "surface": [None, None], "landuse": [None, None],
    }, geometry=[outer, court], crs="EPSG:32618")
    path = tmp_path / "overlapping-pitches.parquet"
    raw.to_parquet(path)

    result = process_landuse(path).set_index("id")

    assert result.loc["osm:way/10", "geometry"].intersection(court).area == pytest.approx(0)
    assert result.loc["osm:way/11", "geometry"].area == pytest.approx(court.area)


def test_reviewed_removed_richmond_court_becomes_paving(tmp_path):
    raw = gpd.GeoDataFrame({
        "element": ["way", "way"], "id": [236156641, 99], "name": [None, None],
        "leisure": ["pitch", "pitch"], "sport": ["tennis", "tennis"],
        "surface": [None, None], "landuse": [None, None],
    }, geometry=[box(280000, 4158000, 280050, 4158050), box(280100, 4158000, 280150, 4158050)],
       crs="EPSG:32618")
    path = tmp_path / "removed-richmond-court.parquet"
    raw.to_parquet(path)

    result = process_landuse(path)

    assert set(result.id) == {"osm:way/236156641", "osm:way/99"}
    assert result.set_index("id").loc["osm:way/236156641", "kind"] == "groundcover_paved"


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
