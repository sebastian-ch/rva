import math

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, Point

from poi_table import RECORD, HEADER, encode_pois
from streetlights import lamp_kind, mark_surveyed_roads, merge_survey, survey_pois

CRS = "EPSG:32618"


def _luminaires(rows):
    return gpd.GeoDataFrame({"OBJECTID": [r[0] for r in rows], "LuminaireType": [r[1] for r in rows],
                             "FixtureType": [r[2] for r in rows]},
                            geometry=[Point(r[3], r[4]) for r in rows], crs=CRS)


def _poles(rows):
    return gpd.GeoDataFrame({"OBJECTID": [r[0] for r in rows], "Material": [r[1] for r in rows],
                             "PoleHeight": [r[2] for r in rows], "PoleLength": [r[3] for r in rows]},
                            geometry=[Point(r[4], r[5]) for r in rows], crs=CRS)


def test_lamps_snap_to_their_pole_once_per_kind_and_wood_poles_become_utility_poles():
    lum = _luminaires([
        (1, "Streetlight", "Cobrahead", 100.6, 200.2),   # two cobraheads on one wooden pole
        (2, "Streetlight", "Cobrahead", 99.5, 199.8),
        (3, "Pedestrian", "Hanover", 150, 200),        # no pole within reach: stays at its own fix
        (4, "Streetlight", "Gaslight", 180.4, 200),
    ])
    poles = _poles([(10, "Creosote Wood", 29.0, None, 100, 200), (11, "Salt Treated Wood", None, 40.0, 300, 300),
                    (12, "CastIron", None, None, 180, 200)])

    out = survey_pois(lum, poles).set_index("id")

    lamps = out[out["kind"] != "utility_pole"]
    assert sorted(lamps["kind"]) == ["lamp_post", "lamp_post", "streetlight"]
    cobra = lamps[lamps["kind"] == "streetlight"].geometry.iloc[0]
    assert (cobra.x, cobra.y) == (100, 200)
    assert (out.loc["cor_luminaire:4"].geometry.x, out.loc["cor_luminaire:3"].geometry.x) == (180, 150)
    utility = out[out["kind"] == "utility_pole"]
    assert list(utility.index) == ["cor_pole:10", "cor_pole:11"]
    assert utility.loc["cor_pole:10", "pole_height"] == round(29 * 0.3048, 2)
    assert utility.loc["cor_pole:11", "pole_height"] == round((0.9 * 40 - 2) * 0.3048, 2)
    assert set(out["source"]) == {"city_survey"}


def test_lamp_kind_treats_decorative_fixtures_as_post_tops():
    assert lamp_kind("Streetlight", "Cobrahead") == "streetlight"
    assert lamp_kind("Alley", "Cobrahead") == "streetlight"
    assert lamp_kind("Pedestrian", "Cobrahead") == "lamp_post"
    assert lamp_kind("Streetlight", "Granville") == "lamp_post"


def test_merge_drops_osm_lamps_the_survey_already_has():
    survey = survey_pois(_luminaires([(1, "Streetlight", "Cobrahead", 0, 0)]), _poles([]))
    osm = gpd.GeoDataFrame({"id": ["osm:node/1", "osm:node/2", "osm:node/3"], "name": [None] * 3,
                            "kind": ["streetlight", "streetlight", "bench"]},
                           geometry=[Point(5, 0), Point(40, 0), Point(1, 0)], crs=CRS)

    merged = merge_survey(osm, survey)

    assert sorted(merged["id"]) == ["cor_luminaire:1", "osm:node/2", "osm:node/3"]


def test_only_roads_mostly_near_surveyed_lamps_are_marked():
    survey = survey_pois(_luminaires([(i, "Streetlight", "Cobrahead", x, 0) for i, x in enumerate(range(0, 201, 50))]),
                         _poles([]))
    roads = gpd.GeoDataFrame({"id": ["lit", "half", "dark"]},
                             geometry=[LineString([(0, 5), (200, 5)]), LineString([(100, 0), (500, 0)]),
                                       LineString([(0, 400), (200, 400)])], crs=CRS)

    marked = mark_surveyed_roads(roads, survey).set_index("id")["lamps_surveyed"]

    assert marked.to_dict() == {"lit": True, "half": False, "dark": False}


def test_pole_height_uses_the_first_float_slot():
    pois = gpd.GeoDataFrame({"id": ["cor_pole:1"], "kind": ["utility_pole"], "pole_height": [8.84]},
                            geometry=[Point(1, 1)], crs=CRS)
    record = RECORD.unpack_from(encode_pois(pois, (0, 0, 250, 250)), HEADER.size)
    assert record[2] == 12 and math.isclose(record[7], 8.84, rel_tol=1e-6) and np.isnan(record[8])


def test_points_on_the_carriageway_move_to_the_curb_and_centreline_ones_drop():
    from streetlights import CURB_CLEARANCE_M, clear_carriageways

    roads = gpd.GeoDataFrame({"id": ["st", "walk"], "highway": ["residential", "footway"], "width": [10.0, 3.0],
                              "tunnel": [False, False]},
                             geometry=[LineString([(0, 0), (100, 0)]), LineString([(0, 30), (100, 30)])], crs=CRS)
    survey = gpd.GeoDataFrame({"id": ["curb", "asphalt", "middle", "footpath"]},
                              geometry=[Point(50, -7), Point(50, -4), Point(50, 0.5), Point(50, 30)], crs=CRS)

    out = clear_carriageways(survey, roads).set_index("id")

    assert list(out.index) == ["curb", "asphalt", "footpath"]
    assert out.loc["curb"].geometry.y == -7 and out.loc["footpath"].geometry.y == 30
    assert out.loc["asphalt"].geometry.x == 50
    assert math.isclose(out.loc["asphalt"].geometry.y, -(5 + CURB_CLEARANCE_M), abs_tol=0.05)
