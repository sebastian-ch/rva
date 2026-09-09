import geopandas as gpd
import numpy as np
from shapely.geometry import Polygon, box

from config import CRS_PROJ
from hydro import HydroSurface, FT_TO_M, merge_water


def test_surface_slopes_and_shared_grid_edges_match():
    polygon = Polygon([(0, 0), (20, 0), (20, 10), (0, 10)], holes=[[(8, 3), (12, 3), (12, 7), (8, 7)]])
    water = gpd.GeoDataFrame({'kind': ['river']}, geometry=[polygon], crs=CRS_PROJ)
    h = HydroSurface(water, np.array([[0, 0, 10], [0, 10, 10], [20, 0, 2], [20, 10, 2]], float))
    assert h.sample([1, 19], [5, 5])[0] > h.sample([1, 19], [5, 5])[1]
    a = h.apply_grid(dict(n=3, size=10, origin=[0, 0], elev=[30.] * 9))
    b = h.apply_grid(dict(n=3, size=10, origin=[10, 0], elev=[30.] * 9))
    assert np.array(a['water_elev']).reshape(3, 3)[:, -1].tolist() == np.array(b['water_elev']).reshape(3, 3)[:, 0].tolist()
    assert a['elev'][5] == 30  # island hole remains dry
    assert a['elev'][4] < 10
    assert abs(100 * FT_TO_M - 30.48006096) < 1e-7


def test_hydro_replaces_coarse_river_but_keeps_unmapped_canal():
    osm = gpd.GeoDataFrame({'kind': ['river', 'canal']}, geometry=[box(0, 0, 20, 10), box(0, 20, 20, 22)], crs=CRS_PROJ)
    water = gpd.GeoDataFrame({'kind': ['river']}, geometry=[box(0, 1, 20, 9)], crs=CRS_PROJ)
    h = HydroSurface(water, np.array([[0, 0, 10], [20, 10, 2]], float))
    merged = merge_water(osm, h)
    assert len(merged) == 2
    assert sorted(merged.geometry.area) == [40, 160]
