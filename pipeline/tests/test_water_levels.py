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


def test_water_levels_ignore_raster_gaps(tmp_path):
    import rasterio
    from rasterio.transform import from_origin
    from terrain import Terrain

    path = tmp_path / "partial.tif"
    values = np.full((10, 10), 30, dtype="float32")
    values[:, :2] = 1
    values[0, 0] = -9999
    with rasterio.open(path, "w", driver="GTiff", height=10, width=10, count=1,
                       dtype="float32", crs=CRS_PROJ, transform=from_origin(0, 10, 1, 1), nodata=-9999) as ds:
        ds.write(values, 1)
    terrain = Terrain(path)
    try:
        assert np.isnan(terrain.sample_valid(np.array([-1, 0.5]), np.array([5, 9.5]))).all()
        assert np.isfinite(terrain.sample(np.array([-1]), np.array([5]))).all()
        # Most of this canal lies outside the DEM; only its low valid cells count.
        polys = gpd.GeoDataFrame({"kind": ["canal"]}, geometry=[box(-100, 0, 2, 10)], crs=CRS_PROJ)
        assert water_levels(polys, terrain, spacing=1) == [0.3]
    finally:
        terrain.close()


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


def test_beach_profile_softens_only_mapped_sandy_shore():
    from terrain import Terrain

    t = Terrain.__new__(Terrain)
    t.sample = lambda xs, ys: np.full(np.asarray(xs).shape, 5.0)
    ocean = box(-100, -100, 0, 200)
    beach = box(0, 0, 40, 40)
    grid = t.tile_grid(-20, 0, 100, n=101, flatten=[(ocean, 0)], beach_profile=(beach, ocean, 0))
    elev = np.array(grid["elev"]).reshape(101, 101)
    assert elev[20, 20] == 0.12  # shoreline meets the sea instead of a five-metre cliff
    assert np.all(np.diff(elev[20, 20:56]) >= 0)
    assert elev[20, 55] == 5  # original DEM resumes inland
    assert elev[80, 20] == 5  # non-beach coastline is unchanged
    assert elev[20, 10] == -WATER_BED_M
