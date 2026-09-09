"""LiDAR inputs for building heights and roofs.

Two artefacts from `pipeline/fetch_lidar.py`, both optional:
    data/raw/ndsm.tif            1 m normalized DSM -> per-footprint height statistics
    data/raw/lidar_<slug>.npz    point cloud (EPSG:32618) -> roof classification (roofs.py)
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np

from config import DATA_RAW
from roofs import RoofFit, classify_roof

NDSM_PATH = DATA_RAW / "ndsm.tif"
SHRINK_M = 1.0  # pull footprint edges in so walls/neighbours do not leak into the stats


def sample_ndsm_stats(buildings: gpd.GeoDataFrame, ndsm_path: Path = NDSM_PATH) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-footprint (median, p90, sample_count) of the nDSM. NaN / 0 where unavailable."""
    n = len(buildings)
    med, p90, cnt = np.full(n, np.nan), np.full(n, np.nan), np.zeros(n, dtype=int)
    if not ndsm_path.exists() or n == 0:
        return med, p90, cnt
    import rasterio
    from rasterio.mask import mask as rio_mask

    with rasterio.open(ndsm_path) as ds:
        geoms = buildings.to_crs(ds.crs).geometry
        for i, g in enumerate(geoms):
            if g is None or g.is_empty:
                continue
            inner = g.buffer(-SHRINK_M)
            if inner.is_empty or inner.area < 4:
                inner = g
            try:
                arr, _ = rio_mask(ds, [inner.__geo_interface__], crop=True, filled=False, all_touched=False)
            except ValueError:
                continue
            vals = arr[0].compressed() if np.ma.isMaskedArray(arr) else arr[0].ravel()
            vals = vals[np.isfinite(vals)]
            if vals.size >= 4:
                med[i], p90[i], cnt[i] = float(np.median(vals)), float(np.percentile(vals, 90)), vals.size
    return med, p90, cnt


NON_ROOF_CLASSES = (3, 4, 5, 9)  # vegetation, water: never part of a roof surface
SURFACE_CELL = 1.0  # m; roof fits run on the top surface (max z per cell), not the raw cloud


def surface_points(p: np.ndarray, cell: float = SURFACE_CELL) -> np.ndarray:
    """Top surface of a cloud: the highest point in each cell x cell bin. Removes facade returns and the
    density bias of dense clouds so the plane fits see one sample per roof cell."""
    if len(p) == 0:
        return p
    k = np.floor(p[:, :2] / cell).astype(np.int64)
    key = k[:, 0] * 10_000_000 + k[:, 1]
    order = np.lexsort((-p[:, 2], key))
    key = key[order]
    first = np.r_[True, key[1:] != key[:-1]]
    return p[order][first]


class PointCloud:
    """KD-tree over the npz cloud for per-footprint queries."""

    def __init__(self, npz_path: Path):
        from scipy.spatial import cKDTree

        d = np.load(npz_path)
        keep = ~np.isin(d["c"], NON_ROOF_CLASSES) if "c" in d else np.ones(len(d["x"]), bool)
        self.xyz = np.c_[d["x"][keep], d["y"][keep], d["z"][keep]].astype(np.float64)
        self.tree = cKDTree(self.xyz[:, :2])

    def within(self, geom) -> np.ndarray:
        """Top-surface points (see surface_points) within the footprint's bounding circle."""
        c = geom.centroid
        minx, miny, maxx, maxy = geom.bounds
        r = 0.5 * float(np.hypot(maxx - minx, maxy - miny)) + 0.5
        idx = self.tree.query_ball_point([c.x, c.y], r)
        return surface_points(self.xyz[idx]) if idx else self.xyz[:0]


def classify_roofs(buildings: gpd.GeoDataFrame, ground: np.ndarray, npz_path: Path | None) -> list[RoofFit | None]:
    if npz_path is None or not npz_path.exists() or len(buildings) == 0:
        return [None] * len(buildings)
    pc = PointCloud(npz_path)
    out: list[RoofFit | None] = []
    for g, gz in zip(buildings.geometry, ground):
        try:
            out.append(classify_roof(pc.within(g), g, float(gz)))
        except Exception:
            out.append(None)
    return out
