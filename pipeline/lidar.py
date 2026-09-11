"""LiDAR inputs for building heights and roofs.

Two artefacts from `pipeline/fetch_lidar.py`, both optional:
    data/raw/ndsm.tif            1 m normalized DSM -> per-footprint height statistics
    data/raw/lidar_<slug>.npz    point cloud (EPSG:32618) -> roof classification (roofs.py)

The raw cloud is huge (310 M points for the expanded Richmond bbox) but roof fitting only ever looks at
the top point per 1 m cell inside a footprint. `surface_cache` does that reduction once, keyed on the
source files and the footprint set, and writes `lidar_<slug>_surface.npz` (~8 M points). Queries then run
against a sorted cell-key index instead of a KD-tree over the whole cloud.
"""
from __future__ import annotations

import os
from pathlib import Path

import geopandas as gpd
import numpy as np

from config import DATA_RAW
from roofs import RoofFit, classify_roof

NDSM_PATH = DATA_RAW / "ndsm.tif"
SHRINK_M = 1.0  # pull footprint edges in so walls/neighbours do not leak into the stats


def _ndsm_chunk(args):
    """Worker: (median, p90, count) of the nDSM for one slice of footprints."""
    ndsm_path, wkbs, offset = args
    import rasterio
    from rasterio.mask import mask as rio_mask
    from shapely import wkb as shapely_wkb

    out = []
    with rasterio.open(ndsm_path) as ds:
        for i, raw in enumerate(wkbs):
            g = shapely_wkb.loads(raw)
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
                out.append((offset + i, float(np.median(vals)), float(np.percentile(vals, 90)), int(vals.size)))
    return out


def _workers(n_items: int, per_worker: int) -> int:
    """Processes worth starting for an embarrassingly parallel loop of n_items."""
    if os.environ.get("ISO_SERIAL"):
        return 1
    return max(1, min(os.cpu_count() or 1, n_items // per_worker))


def sample_ndsm_stats(buildings: gpd.GeoDataFrame, ndsm_path: Path = NDSM_PATH) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-footprint (median, p90, sample_count) of the nDSM. NaN / 0 where unavailable."""
    n = len(buildings)
    med, p90, cnt = np.full(n, np.nan), np.full(n, np.nan), np.zeros(n, dtype=int)
    if not ndsm_path.exists() or n == 0:
        return med, p90, cnt

    wkbs = [g.wkb if g is not None else None for g in buildings.geometry]
    nproc = _workers(n, 500)
    chunk = (n + nproc - 1) // nproc
    jobs = [(str(ndsm_path), wkbs[s:s + chunk], s) for s in range(0, n, chunk)]
    results = None
    if nproc > 1:
        from concurrent.futures import BrokenExecutor, ProcessPoolExecutor
        try:
            with ProcessPoolExecutor(max_workers=nproc) as ex:
                results = list(ex.map(_ndsm_chunk, jobs))
        except BrokenExecutor:  # e.g. a caller with no __main__ guard under spawn
            print("  [warn] nDSM worker pool unavailable; sampling serially")
            results = None
    if results is None:
        results = [_ndsm_chunk(j) for j in jobs]
    for part in results:
        for i, m, p, c in part:
            med[i], p90[i], cnt[i] = m, p, c
    return med, p90, cnt


NON_ROOF_CLASSES = (3, 4, 5, 9)  # vegetation, water: never part of a roof surface
SURFACE_CELL = 1.0  # m; roof fits run on the top surface (max z per cell), not the raw cloud
FOOTPRINT_PAD = 2.0  # m; keep cells this far outside a footprint so edge cells stay whole
CACHE_VERSION = 2


def surface_points(p: np.ndarray, cell: float = SURFACE_CELL) -> np.ndarray:
    """Top surface of a cloud: the highest point in each cell x cell bin. Removes facade returns and the
    density bias of dense clouds so the plane fits see one sample per roof cell."""
    if len(p) == 0:
        return p
    k = np.floor(p[:, :2] / cell).astype(np.int64)
    key = k[:, 0] * 10_000_000 + k[:, 1]
    # x/y break z ties so the winner does not depend on input order: reducing the whole cloud once
    # (surface_cache) must pick the same point per cell as reducing any subset of it.
    order = np.lexsort((p[:, 1], p[:, 0], -p[:, 2], key))
    key = key[order]
    first = np.r_[True, key[1:] != key[:-1]]
    return p[order][first]


def _footprint_fingerprint(buildings: gpd.GeoDataFrame | None) -> np.ndarray:
    """Cheap identity for a footprint set: count, bounds and total area. Changing the set busts the cache."""
    if buildings is None or len(buildings) == 0:
        return np.array([0, 0, 0, 0, 0, 0], dtype=np.float64)
    minx, miny, maxx, maxy = buildings.total_bounds
    return np.array([len(buildings), round(minx, 2), round(miny, 2), round(maxx, 2), round(maxy, 2),
                     round(float(buildings.geometry.area.sum()), 2)], dtype=np.float64)


def _cache_meta(npz_path: Path, buildings: gpd.GeoDataFrame | None) -> np.ndarray:
    """Fingerprint covering the source cloud, this module and the footprint set."""
    return np.r_[np.array([CACHE_VERSION, npz_path.stat().st_mtime_ns,
                           Path(__file__).stat().st_mtime_ns, SURFACE_CELL, FOOTPRINT_PAD], dtype=np.float64),
                 _footprint_fingerprint(buildings)]


def _cell_mask(buildings: gpd.GeoDataFrame, cell: float, pad: float):
    """Boolean grid of the 1 m cells covered by the padded footprints, plus its (col0, row0) origin.

    The grid is aligned to `surface_points`' absolute floor(x / cell) lattice, so masking by cell keeps
    every point of a kept cell — the per-cell top point is then identical to the whole-cloud reduction.
    """
    from rasterio.features import rasterize
    from rasterio.transform import from_origin

    minx, miny, maxx, maxy = buildings.total_bounds
    col0 = int(np.floor((minx - pad) / cell))
    row0 = int(np.floor((miny - pad) / cell))
    w = int(np.ceil((maxx + pad) / cell)) - col0 + 1
    h = int(np.ceil((maxy + pad) / cell)) - row0 + 1
    # rasterize writes rows top-down; keep our own bottom-up row order by flipping afterwards
    transform = from_origin(col0 * cell, (row0 + h) * cell, cell, cell)
    shapes = [(g.buffer(pad), 1) for g in buildings.geometry if g is not None and not g.is_empty]
    grid = rasterize(shapes, out_shape=(h, w), transform=transform, fill=0, all_touched=True, dtype="uint8")
    return np.flipud(grid).astype(bool), col0, row0


def _reduce_cloud(npz_path: Path, buildings: gpd.GeoDataFrame | None,
                  cell: float = SURFACE_CELL, pad: float = FOOTPRINT_PAD,
                  chunk: int = 20_000_000) -> np.ndarray:
    """Whole-cloud top-per-cell surface, restricted to cells near a footprint when one is given."""
    d = np.load(npz_path)
    x, y, z = d["x"], d["y"], d["z"]
    cls = d["c"] if "c" in d.files else None
    mask = col0 = row0 = None
    if buildings is not None and len(buildings):
        mask, col0, row0 = _cell_mask(buildings, cell, pad)
    kept = []
    for s in range(0, len(x), chunk):
        e = min(s + chunk, len(x))
        keep = np.ones(e - s, bool) if cls is None else ~np.isin(cls[s:e], NON_ROOF_CLASSES)
        if mask is not None:
            col = np.floor(x[s:e] / cell).astype(np.int64) - col0
            row = np.floor(y[s:e] / cell).astype(np.int64) - row0
            inside = (col >= 0) & (col < mask.shape[1]) & (row >= 0) & (row < mask.shape[0])
            keep &= inside
            if keep.any():
                keep[keep] = mask[row[keep], col[keep]]
        if keep.any():
            kept.append(np.c_[x[s:e][keep], y[s:e][keep], z[s:e][keep]].astype(np.float64))
    del d, x, y, z, cls
    if not kept:
        return np.zeros((0, 3), np.float64)
    return surface_points(np.concatenate(kept), cell)


def surface_cache(npz_path: Path, buildings: gpd.GeoDataFrame | None = None,
                  cache_path: Path | None = None) -> np.ndarray:
    """Load — building it first if stale — the reduced roof surface for `npz_path`."""
    cache_path = cache_path or npz_path.with_name(f"{npz_path.stem}_surface.npz")
    meta = _cache_meta(npz_path, buildings)
    if cache_path.exists():
        try:
            cached = np.load(cache_path)
            if cached["meta"].shape == meta.shape and np.array_equal(cached["meta"], meta):
                return cached["p"]
        except Exception:  # truncated or older-format cache: rebuild
            pass
    pts = _reduce_cloud(npz_path, buildings)
    tmp = cache_path.with_suffix(".tmp.npz")
    np.savez(tmp, p=pts, meta=meta)
    tmp.replace(cache_path)
    return pts


class PointCloud:
    """Cell-key index over the reduced surface cloud, for per-footprint queries."""

    ROW_BITS = 1 << 26  # rows per column stripe; UTM metres fit comfortably

    def __init__(self, npz_path: Path, buildings: gpd.GeoDataFrame | None = None, cell: float = SURFACE_CELL):
        self.cell = cell
        pts = surface_cache(npz_path, buildings)
        self.xyz = pts
        col = np.floor(pts[:, 0] / cell).astype(np.int64) if len(pts) else np.zeros(0, np.int64)
        row = np.floor(pts[:, 1] / cell).astype(np.int64) if len(pts) else np.zeros(0, np.int64)
        self.keys = col * self.ROW_BITS + row
        order = np.argsort(self.keys, kind="stable")
        self.keys = self.keys[order]
        self.xyz = self.xyz[order]

    def within(self, geom) -> np.ndarray:
        """Top-surface points in the footprint's bounding box (padded half a cell).

        A box rather than the old bounding circle: `classify_roof` clips to the footprint itself, and the
        box is a superset of that circle's useful part, so the fit sees the same points.
        """
        if len(self.xyz) == 0:
            return self.xyz
        minx, miny, maxx, maxy = geom.bounds
        c0 = int(np.floor((minx - 0.5 * self.cell) / self.cell))
        c1 = int(np.floor((maxx + 0.5 * self.cell) / self.cell))
        r0 = int(np.floor((miny - 0.5 * self.cell) / self.cell))
        r1 = int(np.floor((maxy + 0.5 * self.cell) / self.cell))
        cols = np.arange(c0, c1 + 1, dtype=np.int64)
        lo = np.searchsorted(self.keys, cols * self.ROW_BITS + r0, "left")
        hi = np.searchsorted(self.keys, cols * self.ROW_BITS + r1 + 1, "left")
        counts = hi - lo
        total = int(counts.sum())
        if total == 0:
            return self.xyz[:0]
        starts = np.repeat(lo - np.r_[0, np.cumsum(counts)[:-1]], counts)
        return self.xyz[starts + np.arange(total)]


def classify_roofs(buildings: gpd.GeoDataFrame, ground: np.ndarray, npz_path: Path | None) -> list[RoofFit | None]:
    if npz_path is None or not npz_path.exists() or len(buildings) == 0:
        return [None] * len(buildings)
    pc = PointCloud(npz_path, buildings)
    out: list[RoofFit | None] = []
    for g, gz in zip(buildings.geometry, ground):
        try:
            out.append(classify_roof(pc.within(g), g, float(gz)))
        except Exception:
            out.append(None)
    return out
