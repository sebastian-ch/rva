"""water_z for still water and terrain flattening under it."""
from __future__ import annotations

import geopandas as gpd
import numpy as np
from shapely.geometry import box

from config import CRS_PROJ
from process import water_levels
from terrain import WATER_BED_M


class Trench:
    """Ground 30 m, with a canal trench (x in 40..60) whose bed is 24 m and banks slope."""

    base = 0.0

    def sample(self, xs, ys):
        xs = np.asarray(xs, float)
        z = np.full(xs.shape, 30.0)
        d = np.abs(xs - 50)
        z[d < 10] = 24 + np.clip(d[d < 10] - 6, 0, 4) * 1.5  # flat bed 6 m either side, then 1.5 m/m slope
        return z


def test_water_levels_pick_the_bed_not_the_banks():
    polys = gpd.GeoDataFrame({"kind": ["canal", "river"]}, geometry=[box(40, 0, 60, 100), box(0, 0, 10, 10)], crs=CRS_PROJ)
    wz = water_levels(polys, Trench())
    assert wz[1] is None
    assert 24.2 <= wz[0] <= 25.5


def test_water_levels_without_terrain():
    polys = gpd.GeoDataFrame({"kind": ["canal"]}, geometry=[box(0, 0, 10, 10)], crs=CRS_PROJ)
    assert water_levels(polys, None) == [None]


def test_tile_grid_flattens_under_still_water():
    from terrain import Terrain

    t = Terrain.__new__(Terrain)
    t.base = 0.0
    t._fill = 30.0
    t.sample = Trench().sample  # type: ignore[method-assign]
    grid = Terrain.tile_grid(t, 0, 0, 100, n=26, flatten=[(box(40, 0, 60, 100), 25.0)])
    n = grid["n"]
    step = 100 / (n - 1)
    elev = np.array(grid["elev"]).reshape(n, n)
    xs = np.arange(n) * step
    inside = (xs > 40) & (xs < 60)
    assert np.all(elev[:, inside] <= 25.0 - WATER_BED_M + 1e-6)
    assert np.all(elev[:, xs > 70] > 29)
