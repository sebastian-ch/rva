"""Richmond Structures footprint gap-fill and deck/patio conversion."""
from __future__ import annotations

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from config import CRS_PROJ
from process import _add_gap_footprints, process_richmond_decks


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
