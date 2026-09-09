import geopandas as gpd
import numpy as np
from shapely.geometry import Point, box

from config import CRS_PROJ
from vegetation import inventory_trees, canopy_peaks, merge_trees


def test_inventory_excludes_vacancies_stumps_and_retired_assets():
    raw = gpd.GeoDataFrame(dict(OBJECTID=[1, 2, 3, 4, 1], SPP=['Quercus phellos', 'Vacant Site Small', 'Stump', 'Acer rubrum', 'Quercus phellos'],
                               Status=['In Service', 'In Service', 'In Service', 'Retired', 'In Service']),
                           geometry=[Point(i, 0) for i in range(5)], crs=CRS_PROJ)
    trees = inventory_trees(raw)
    assert trees.id.tolist() == ['rva-tree:1']


def test_canopy_peaks_preserve_separate_trees_and_heights():
    y, x = np.mgrid[:50, :50]
    canopy = np.maximum(12 * np.exp(-((x - 12)**2 + (y - 20)**2) / 16), 20 * np.exp(-((x - 34)**2 + (y - 20)**2) / 25))
    crowns = canopy_peaks(canopy, (100, 200))
    assert len(crowns) == 2
    assert sorted(crowns.tree_height) == [12, 20]
    assert crowns.geometry.x.between(110, 136).all()


def test_stems_win_over_crowns_and_water_excludes_trees():
    inventory = inventory_trees(gpd.GeoDataFrame(dict(OBJECTID=[1], SPP=['Quercus'], Status=['In Service']), geometry=[Point(5, 5)], crs=CRS_PROJ))
    crowns = inventory.copy()
    crowns['id'] = 'crown'; crowns['tree_height'] = 20.; crowns['height_source'] = 'lidar2025'
    crowns.geometry = [Point(7, 5)]
    empty = gpd.GeoDataFrame({'kind': []}, geometry=[], crs=CRS_PROJ)
    trees = merge_trees(empty, inventory, crowns, empty, empty)
    assert len(trees) == 1 and trees.iloc[0].tree_height == 20
    assert trees.geometry.iloc[0].equals(Point(5, 5))
    water = gpd.GeoDataFrame(geometry=[box(0, 0, 10, 10)], crs=CRS_PROJ)
    assert len(merge_trees(empty, inventory, crowns, empty, water)) == 0
