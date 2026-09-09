"""City height provenance, helper joins, and ocean/land separation."""
import json
import os
from pathlib import Path
import subprocess
import sys

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from config import CRS_PROJ
from honolulu import enrich_buildings, ocean_layer, coastal_green_spaces
from process import process_buildings


def test_coastal_structures_preserve_outlines_and_raise_crests():
    from shapely.geometry import LineString
    from honolulu import coastal_structures

    outline = box(0, 0, 100, 5)
    raw = gpd.GeoDataFrame({"id": [1, 2], "man_made": ["groyne", "breakwater"]},
                          geometry=[outline, LineString([(0, 20), (100, 20)])], crs=CRS_PROJ)
    result = coastal_structures(raw, base_elevation=2)
    assert result.iloc[0].geometry.equals(outline)
    assert result.iloc[1].geometry.area == 300
    assert (result.top_z > -2).all()
    assert (result.base_z < -2).all()


def test_city_outlines_keep_osm_details_without_duplicate_buildings(tmp_path):
    city = gpd.GeoDataFrame({"objectid": [10, 11], "structurename": [None, None],
                            "maxht_m": [12.0, 0.0]},
                           geometry=[box(0, 0, 20, 20), box(50, 0, 70, 20)], crs=CRS_PROJ)
    osm = gpd.GeoDataFrame({"id": [1, 2], "element": ["way", "way"], "building": ["house", "house"],
                           "name": ["OSM name", "Gap building"], "roof:shape": ["flat", "flat"]},
                          geometry=[box(0, 0, 20, 20), box(100, 0, 120, 20)], crs=CRS_PROJ)
    enriched = enrich_buildings(city, osm)
    assert len(enriched) == 3
    assert enriched.iloc[0]["name"] == "OSM name"
    assert pd.isna(enriched.iloc[1]["cch_height_m"])
    assert enriched.iloc[2]["footprint_source"] == "osm"
    path = tmp_path / "buildings.parquet"
    enriched.to_parquet(path)
    buildings = process_buildings(path, merge_rowhouses=False)
    first = buildings[buildings.id == "cch:10"].iloc[0]
    assert first.height == 12
    assert first.height_source == "cch_height"
    assert first.footprint_source == "cch"


def test_ocean_does_not_cover_land_and_uses_relative_sea_level():
    bbox = (-77.45, 37.53, -77.44, 37.54)
    land = gpd.GeoDataFrame(geometry=[box(-77.445, 37.52, -77.43, 37.55)], crs="EPSG:4326")
    ocean = ocean_layer(land, bbox, base_elevation=3.25)
    assert ocean.iloc[0].water_z == -3.25
    assert ocean.iloc[0].geometry.area > 0
    assert ocean.iloc[0].geometry.intersection(land.to_crs(CRS_PROJ).geometry.iloc[0]).area < 0.01


def test_honolulu_projection_and_paths_are_isolated():
    root = Path(__file__).resolve().parents[2]
    code = "import config,json; print(json.dumps([config.CRS_PROJ,str(config.DATA_TILES),str(config.ASSETS),config.DEFAULT_BBOX]))"
    result = subprocess.check_output([sys.executable, "-c", code], cwd=root / "pipeline",
                                     env={**os.environ, "ISO_REGION": "honolulu"}, text=True)
    crs, tiles, assets, bbox = json.loads(result)
    assert crs == "EPSG:32604"
    assert tiles == str(root / "data/honolulu/tiles")
    assert assets == str(root / "assets/honolulu")
    assert bbox == [-157.827499, 21.252022, -157.794901, 21.278613]


def test_city_ocean_polygon_preserves_its_island_holes():
    from shapely.geometry import Point, Polygon
    coast = gpd.GeoDataFrame(geometry=[Polygon(box(-158, 21, -157, 22).exterior.coords,
                                              [box(-157.82, 21.26, -157.80, 21.28).exterior.coords])],
                             crs="EPSG:4326")
    bbox = (-157.83, 21.25, -157.79, 21.29)
    water = ocean_layer(coast, bbox, coast_is_water=True).to_crs("EPSG:4326").geometry.iloc[0]
    assert not water.contains(Point(-157.81, 21.27))
    assert water.contains(Point(-157.825, 21.255))


def test_coastal_green_band_preserves_area_without_marking_inland_forest():
    land = gpd.GeoDataFrame({"id": ["park", "forest"], "kind": ["park", "forest"]},
                            geometry=[box(0, 0, 500, 200), box(0, 250, 500, 400)], crs=CRS_PROJ)
    ocean = gpd.GeoDataFrame(geometry=[box(-100, -100, 0, 500)], crs=CRS_PROJ)
    result = coastal_green_spaces(land, ocean, distance=180)
    assert result.geometry.area.sum() == land.geometry.area.sum()
    assert result[result.coastal].geometry.area.sum() == 180 * 200
    assert not result[result.kind == "forest"].coastal.any()
