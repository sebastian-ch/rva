import geopandas as gpd
from shapely.geometry import Point, box

from wall_colors import ERA_WALLS, assessor_walls, building_use, era, era_wall

CRS = "EPSG:32618"


def test_era_and_use_pick_from_the_matching_palette():
    assert era(1905) == "pre1940" and era(1968) == "1940_1975" and era(2015) == "2000s" and era(0) is None
    assert building_use(None) == "residential"
    assert building_use("Apartments - High Rise:001 ") == "residential"
    assert building_use("Storage Warehouse:001 ") == "industrial"
    assert building_use("General Office:001 ") == "commercial"
    keys = {k for k, _ in ERA_WALLS[("residential", "pre1940")]}
    assert {era_wall(1910, "residential", 10, seed) for seed in range(50)} <= keys
    assert {era_wall(1985, "commercial", 80, seed) for seed in range(50)} <= {k for k, _ in ERA_WALLS[("tall", "1976_1999")]}
    assert era_wall(None, "residential", 10, 3) is None


def test_only_seeded_guesses_take_the_assessor_prior():
    buildings = gpd.GeoDataFrame({
        "id": ["guess", "mapped", "no_parcel"], "height": [10.0, 10.0, 10.0],
        "wall_color": ["glass", "slate", "glass"], "wall_color_source": ["heuristic", "osm", "heuristic"],
    }, geometry=[box(0, 0, 10, 10), box(20, 0, 30, 10), box(100, 100, 110, 110)], crs=CRS)
    parcels = gpd.GeoDataFrame({"PIN": ["W1", "W2"], "Year_Built": [1950, 1950]},
                               geometry=[box(-5, -5, 15, 15), box(15, -5, 35, 15)], crs=CRS)
    assessor = gpd.GeoDataFrame({"parcel_id": ["W1   ", "W2"], "year_built": [1912, 1912],
                                 "comm_bldg_type": [None, None], "property_class": [120, 120]},
                                geometry=[Point(5, 5), Point(25, 5)], crs=CRS)

    out = assessor_walls(buildings, parcels, assessor).set_index("id")

    assert out.loc["guess", "wall_color_source"] == "assessor"
    assert out.loc["guess", "wall_color"] in {k for k, _ in ERA_WALLS[("residential", "pre1940")]}
    assert (out.loc["mapped", "wall_color"], out.loc["mapped", "wall_color_source"]) == ("slate", "osm")
    assert (out.loc["no_parcel", "wall_color"], out.loc["no_parcel", "wall_color_source"]) == ("glass", "heuristic")
