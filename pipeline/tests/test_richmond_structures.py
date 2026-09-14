"""Richmond Structures footprint gap-fill and deck/patio conversion."""
from __future__ import annotations

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from config import CRS_PROJ
from process import _add_gap_footprints, apply_footprint_replacements, apply_massing_parts, process_richmond_decks


def _write_structures(path):
    city = gpd.GeoDataFrame({
        "OBJECTID": [1, 2, 3],
        "Subtype": [1, 1, 3],
        "EditDate": [1788869233637, 1788869233637, 1788869233637],
    }, geometry=[box(0.2, 0.2, 10.2, 10.2), box(10, 0, 20, 10), box(2, 12, 8, 16)], crs=CRS_PROJ)
    city.to_parquet(path)


def test_city_gap_fill_rejects_overlap_but_keeps_shared_wall(tmp_path):
    path = tmp_path / "structures.parquet"
    _write_structures(path)
    raw = gpd.GeoDataFrame({
        "id": [10], "element": ["way"], "building": ["house"], "building:part": [None],
        "footprint_source": ["osm"],
    }, geometry=[box(0, 0, 10, 10)], crs=CRS_PROJ)
    result, parts = _add_gap_footprints(raw, pd.Series([False], index=raw.index), path,
                                        source="richmond_structures", element="richmond_structure",
                                        min_area=12, subtype=1)
    assert len(result) == 2
    added = result[result["footprint_source"] == "richmond_structures"].iloc[0]
    assert added["id"] == "2"
    assert added["source_updated"] == "2026-09-08T12:07:13.637000Z"
    assert not parts.iloc[-1]


def test_richmond_decks_keep_only_subtype_three(tmp_path):
    path = tmp_path / "structures.parquet"
    _write_structures(path)
    decks = process_richmond_decks(path)
    assert len(decks) == 1
    assert decks.iloc[0]["id"] == "richmond_structure:3"
    assert decks.iloc[0]["kind"] == "deck"
    assert decks.iloc[0]["source"] == "richmond_structures"


def test_verified_footprint_replacement_keeps_source_row_metadata(tmp_path):
    raw = gpd.GeoDataFrame({
        "id": [10, 20], "element": ["way", "way"], "building": ["school", "house"],
        "name": ["Keep this name", "Neighbour"], "footprint_source": ["osm", "osm"],
        "source_updated": [None, None],
    }, geometry=[box(0, 0, 10, 10), box(20, 0, 30, 10)], crs=CRS_PROJ)
    path = tmp_path / "replacements.geojson"
    gpd.GeoDataFrame({
        "target_id": ["osm:way/10"], "source_updated": ["2020-07-01"],
    }, geometry=[box(-1, -1, 11, 11)], crs=CRS_PROJ).to_file(path, driver="GeoJSON")

    result = apply_footprint_replacements(raw, path)

    assert result.loc[0, "name"] == "Keep this name"
    assert result.loc[0, "building"] == "school"
    assert result.loc[0, "geometry"].equals(box(-1, -1, 11, 11))
    assert result.loc[0, "footprint_source"] == "richmond_multipatch"
    assert result.loc[1, "geometry"].equals(raw.loc[1, "geometry"])


def test_verified_massing_hides_outline_and_adds_tiers(tmp_path):
    buildings = gpd.GeoDataFrame({
        "id": ["osm:way/10"], "name": ["Test tower"], "height": [30.0], "min_height": [0.0],
        "levels": [None], "height_source": ["osm_height"], "roof_shape": ["flat"],
        "roof_height": [0.0], "roof_azimuth": [None], "roof_source": ["osm"],
        "roof_color": ["roof_flat"], "roof_color_source": ["heuristic"], "lod2_roof": [None],
        "wall_color": ["brick"], "type": ["office"], "landmark": [None],
        "footprint_source": ["osm"], "source_updated": [None], "is_part": [False],
        "parent": [None], "hidden": [False], "addr": [None], "wikidata": [None],
        "website": [None], "zoning": [None], "lidar_p90": [30.0], "ground_z": [0.0],
    }, geometry=[box(0, 0, 20, 20)], crs=CRS_PROJ)
    path = tmp_path / "massing.geojson"
    gpd.GeoDataFrame({
        "target_id": ["osm:way/10", "osm:way/10"], "part_id": ["base", "tier-1"],
        "height": [8.0, 30.0], "min_height": [0.0, 8.0], "source_date": ["2025-03-01"] * 2,
    }, geometry=[box(0, 0, 20, 20), box(5, 5, 15, 15)], crs=CRS_PROJ).to_file(path, driver="GeoJSON")

    result = apply_massing_parts(buildings, path)

    assert len(result) == 3
    assert bool(result.loc[result["id"] == "osm:way/10", "hidden"].iloc[0])
    parts = result[result["is_part"]].sort_values("height")
    assert parts["height"].tolist() == [8.0, 30.0]
    assert parts["min_height"].tolist() == [0.0, 8.0]
    assert set(parts["parent"]) == {"osm:way/10"}
    assert set(parts["height_source"]) == {"lidar_massing"}
    assert set(parts["source_updated"]) == {"2025-03-01T00:00:00Z"}
