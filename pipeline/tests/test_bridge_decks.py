"""Tests for process._deck_endpoints: connector filtering and abutment anchoring."""
from __future__ import annotations

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString

from config import CRS_PROJ
from process import _deck_endpoints


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
