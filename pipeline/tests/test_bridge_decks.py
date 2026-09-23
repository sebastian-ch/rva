"""Tests for process._deck_endpoints: connector filtering and abutment anchoring."""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Polygon

from config import CRS_PROJ
from process import _deck_endpoints, _ramp_decks


class FlatWithTrench:
    """Ground 40 m everywhere except a trench (y in 20..80 -> 30 m) whose lips slope: 37 m within 4 m of the edge."""

    def sample(self, xs, ys):
        xs, ys = np.asarray(xs, float), np.asarray(ys, float)
        z = np.full(xs.shape, 40.0)
        z[(ys > 16) & (ys < 84)] = 37.0
        z[(ys > 20) & (ys < 80)] = 30.0
        return z


def _gdf(rows):
    return gpd.GeoDataFrame(rows, geometry=[r["geometry"] for r in rows], crs=CRS_PROJ)


def test_abutment_anchor_looks_back_up_the_approach():
    # a span whose end nodes sit on the sloping lip (37 m); the approach behind is 40 m
    rows = [
        {"highway": "tertiary", "bridge": "yes", "geometry": LineString([(0, 18), (0, 82)])},
        {"highway": "tertiary", "bridge": None, "geometry": LineString([(0, 0), (0, 18)])},
        {"highway": "tertiary", "bridge": None, "geometry": LineString([(0, 82), (0, 100)])},
    ]
    deck, connectors = _deck_endpoints(_gdf(rows), FlatWithTrench())
    assert connectors == []
    z0, z1 = deck.iloc[0][2], deck.iloc[0][5]
    assert z0 == 40.0 and z1 == 40.0


def test_cross_street_between_two_overpasses_is_not_a_connector():
    # two parallel spans over the trench joined at the south bank by a perpendicular street: no merge
    rows = [
        {"highway": "tertiary", "bridge": "yes", "geometry": LineString([(0, 10), (0, 90)])},
        {"highway": "tertiary", "bridge": "yes", "geometry": LineString([(100, 10), (100, 90)])},
        {"highway": "tertiary", "bridge": None, "geometry": LineString([(0, 10), (100, 10)])},
    ]
    deck, connectors = _deck_endpoints(_gdf(rows), FlatWithTrench())
    assert connectors == []
    assert deck.iloc[2] is None


def test_collinear_same_class_stretch_between_spans_is_a_connector():
    # bridge - island road - bridge along one line (the Mayo's Island case)
    rows = [
        {"highway": "primary", "bridge": "yes", "geometry": LineString([(0, 0), (0, 40)])},
        {"highway": "primary", "bridge": None, "geometry": LineString([(0, 40), (0, 60)])},
        {"highway": "primary", "bridge": "yes", "geometry": LineString([(0, 60), (0, 100)])},
    ]
    deck, connectors = _deck_endpoints(_gdf(rows), FlatWithTrench())
    assert connectors == [1]
    assert deck.iloc[1] is not None


def test_connector_requires_same_highway_class():
    rows = [
        {"highway": "primary", "bridge": "yes", "geometry": LineString([(0, 0), (0, 40)])},
        {"highway": "footway", "bridge": None, "geometry": LineString([(0, 40), (0, 60)])},
        {"highway": "primary", "bridge": "yes", "geometry": LineString([(0, 60), (0, 100)])},
    ]
    _deck, connectors = _deck_endpoints(_gdf(rows), FlatWithTrench())
    assert connectors == []


def test_ground_trail_between_short_footbridges_is_not_a_connector():
    rows = [
        {"highway": "path", "bridge": "yes", "geometry": LineString([(0, 0), (0, 5)])},
        {"highway": "path", "bridge": None, "geometry": LineString([(0, 5), (0, 95)])},
        {"highway": "path", "bridge": "yes", "geometry": LineString([(0, 95), (0, 100)])},
    ]
    deck, connectors = _deck_endpoints(_gdf(rows), FlatWithTrench())
    assert connectors == []
    assert deck.iloc[1] is None


def test_ground_trail_touching_footbridge_is_not_a_ramp():
    rows = [
        {"highway": "path", "bridge": "yes", "geometry": LineString([(0, 0), (0, 5)])},
        {"highway": "path", "bridge": None, "geometry": LineString([(0, 5), (0, 95)])},
    ]
    lines = _gdf(rows)
    deck = pd.Series([[0, 0, 40, 0, 5, 40], None], index=lines.index, dtype=object)
    bridge_flag = pd.Series([True, False], index=lines.index)

    deck, ramp = _ramp_decks(lines, deck, bridge_flag, FlatWithTrench())

    assert deck.iloc[1] is None
    assert not ramp.iloc[1]


def test_bridge_end_over_underpass_uses_connected_approach_grade():
    class Underpass:
        def sample(self, xs, ys):
            xs = np.asarray(xs, float)
            return np.where(xs < 10, 10.0, 20.0 - xs * 0.02)

    rows = [
        {"highway": "motorway", "bridge": "yes", "geometry": LineString([(-100, 0), (0, 0)])},
        {"highway": "motorway", "bridge": None, "geometry": LineString([(0, 0), (50, 0)])},
        {"highway": "motorway_link", "bridge": "yes", "geometry": LineString([(-100, 10), (0, 0)])},
    ]
    deck, _ = _deck_endpoints(_gdf(rows), Underpass())
    assert abs(deck.iloc[0][5] - 20.0) < 0.01


class Valley:
    """Street-level ground: 33 m on the north-west bank, falling to 26 m at the far end of the span."""

    def sample(self, xs, ys):
        xs = np.asarray(xs, float)
        return np.where(xs < 10, 33.0, 26.0)


def test_skybridge_dead_end_into_a_building_keeps_the_connected_level():
    # osm:way/113038428: a footbridge over North 14th Street ending inside a building. Its far end touches no
    # other way and lies in the footprint, so the 26 m street under it must not pull the deck down 7 m.
    rows = [
        {"highway": "footway", "bridge": "yes", "geometry": LineString([(0, 0), (60, 0)])},
        {"highway": "footway", "bridge": None, "geometry": LineString([(-10, 0), (0, 0)])},
    ]
    hospital = gpd.GeoDataFrame(geometry=[Polygon([(58, -10), (90, -10), (90, 10), (58, 10)])], crs=CRS_PROJ)
    deck, _ = _deck_endpoints(_gdf(rows), Valley(), hospital)
    z0, z1 = deck.iloc[0][2], deck.iloc[0][5]
    assert z0 == 33.0 and z1 == 33.0


def test_footbridge_dead_end_on_open_ground_still_anchors():
    # the Belle Isle footbridge descends to the island: an untouched end outside any building is an abutment
    rows = [
        {"highway": "footway", "bridge": "yes", "geometry": LineString([(0, 0), (60, 0)])},
        {"highway": "footway", "bridge": None, "geometry": LineString([(-10, 0), (0, 0)])},
    ]
    elsewhere = gpd.GeoDataFrame(geometry=[Polygon([(70, 20), (90, 20), (90, 40), (70, 40)])], crs=CRS_PROJ)
    deck, _ = _deck_endpoints(_gdf(rows), Valley(), elsewhere)
    assert deck.iloc[0][5] == 26.0


def test_road_bridge_dead_end_still_anchors_on_its_ground():
    # a road bridge cut at the bbox edge keeps its own ground anchor: only pedestrian bridges enter buildings
    rows = [
        {"highway": "tertiary", "bridge": "yes", "geometry": LineString([(0, 0), (60, 0)])},
        {"highway": "tertiary", "bridge": None, "geometry": LineString([(-10, 0), (0, 0)])},
    ]
    deck, _ = _deck_endpoints(_gdf(rows), Valley())
    assert deck.iloc[0][5] == 26.0



def test_deck_lift_ends_mark_where_a_deck_continues():
    from process import _deck_lift_ends

    rows = [
        {"highway": "tertiary", "geometry": LineString([(0, 0), (0, 20)])},    # ramp up to the bridge
        {"highway": "tertiary", "geometry": LineString([(0, 20), (0, 80)])},   # bridge
        {"highway": "tertiary", "geometry": LineString([(0, 80), (0, 100)])},  # bridge continues (split way)
        {"highway": "footway", "geometry": LineString([(8, 20), (8, 80)])},    # footbridge landing at grade
    ]
    lines = _gdf(rows)
    deck = pd.Series([[0, 0, 40, 0, 20, 41], [0, 20, 41, 0, 80, 42], [0, 80, 42, 0, 100, 41],
                      [8, 20, 40, 8, 80, 41]], index=lines.index, dtype=object)
    bridge = pd.Series([False, True, True, True], index=lines.index)
    ramp = pd.Series([True, False, False, False], index=lines.index)
    ends = _deck_lift_ends(lines, deck, bridge, ramp)
    assert ends[0] == [0, 1]  # ground end, then the bridge
    assert ends[1] == [1, 1]  # a ramp at one end, the next bridge span at the other
    assert ends[2] == [1, 0]  # lands at grade
    assert ends[3] == [0, 0]
