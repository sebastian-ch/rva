import math

import geopandas as gpd
from shapely.geometry import LineString, Point

from traffic_control import add_stop_signs, infer_stop_signs

CRS = "EPSG:32618"


def _roads(rows):
    return gpd.GeoDataFrame({"id": [r[0] for r in rows], "highway": [r[1] for r in rows],
                             "oneway": [r[3] if len(r) > 3 else False for r in rows], "width": 8.0, "tunnel": False},
                            geometry=[LineString(r[2]) for r in rows], crs=CRS)


NO_POIS = gpd.GeoDataFrame({"id": [], "kind": []}, geometry=[], crs=CRS)


def test_the_stem_of_a_tee_stops_and_the_through_road_does_not():
    roads = _roads([("main", "residential", [(0, 0), (100, 0), (200, 0)]),
                    ("side", "residential", [(100, -80), (100, 0)])])

    signs = infer_stop_signs(roads, NO_POIS)

    assert len(signs) == 1
    sign = signs.iloc[0]
    assert math.isclose(sign["heading"], math.pi / 2, abs_tol=1e-3)     # travelling north toward the node
    assert sign.geometry.x > 100 and sign.geometry.y < 0                 # right-hand curb, before the junction


def test_minor_approaches_stop_at_a_major_road_and_equal_crossroads_are_all_way():
    minor = _roads([("main", "secondary", [(0, 0), (100, 0), (200, 0)]),
                    ("cross", "residential", [(100, -80), (100, 0), (100, 80)])])
    equal = _roads([("a", "residential", [(0, 0), (100, 0), (200, 0)]),
                    ("b", "residential", [(100, -80), (100, 0), (100, 80)])])

    assert len(infer_stop_signs(minor, NO_POIS)) == 2
    assert len(infer_stop_signs(equal, NO_POIS)) == 4


def test_signals_services_and_one_way_exits_get_no_sign():
    tee = _roads([("main", "residential", [(0, 0), (100, 0), (200, 0)]),
                  ("side", "residential", [(100, 0), (100, -80)], True)])     # oneway away from the node
    alley = _roads([("main", "residential", [(0, 0), (100, 0), (200, 0)]),
                    ("alley", "service", [(100, -80), (100, 0)])])
    signal = gpd.GeoDataFrame({"id": ["s"], "kind": ["traffic_signals"]}, geometry=[Point(100, -12)], crs=CRS)
    stem = _roads([("main", "residential", [(0, 0), (100, 0), (200, 0)]),
                   ("side", "residential", [(100, -80), (100, 0)])])

    assert len(infer_stop_signs(tee, NO_POIS)) == 0
    assert len(infer_stop_signs(alley, NO_POIS)) == 0
    assert len(infer_stop_signs(stem, signal)) == 0


def test_signs_are_kept_off_the_rendered_carriageway():
    # a stem meeting a wide road at a shallow angle puts its curb-side sign onto the through road's asphalt
    roads = _roads([("main", "secondary", [(0, 0), (100, 0), (200, 0)]),
                    ("side", "residential", [(40, -30), (100, 0)])])
    roads.loc[roads["id"] == "main", "width"] = 20.0

    signs = add_stop_signs(roads, NO_POIS)
    sign = signs[signs["kind"] == "stop_sign"].iloc[0].geometry

    assert abs(sign.y) >= 10.0
