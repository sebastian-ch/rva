"""DEM helpers: open the 3DEP GeoTIFF, sample elevations, produce per-tile height grids."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform as rio_transform

from config import CRS_PROJ


class Terrain:
    def __init__(self, dem_path: Path):
        self.ds = rasterio.open(dem_path)
        band = self.ds.read(1, masked=True)
        valid = band.compressed()
        # 1st percentile guards against stray nodata / sink pixels.
        self.base = float(np.percentile(valid, 1)) if valid.size else 0.0
        self._fill = float(np.median(valid)) if valid.size else 0.0

    def close(self) -> None:
        self.ds.close()

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Sample elevation (m, relative to base) at projected coords. Out-of-raster -> median."""
        xs = np.asarray(xs, dtype=float)
        ys = np.asarray(ys, dtype=float)
        if self.ds.crs.to_string() != CRS_PROJ:
            xs, ys = rio_transform(CRS_PROJ, self.ds.crs, xs.tolist(), ys.tolist())
            xs, ys = np.asarray(xs), np.asarray(ys)
        samples = list(self.ds.sample(zip(xs, ys), masked=True))
        vals = np.array([float(np.ma.filled(v, np.nan).ravel()[0]) for v in samples], dtype=float)
        vals = np.where(np.isfinite(vals), vals, self._fill)
        nodata = self.ds.nodata
        if nodata is not None:
            vals = np.where(vals == nodata, self._fill, vals)
        return vals - self.base

    def tile_grid(self, minx: float, miny: float, size: float, n: int = 26) -> dict:
        """n x n grid of elevations covering [minx, minx+size] x [miny, miny+size], south->north rows."""
        step = size / (n - 1)
        gx, gy = np.meshgrid(minx + np.arange(n) * step, miny + np.arange(n) * step)
        z = self.sample(gx.ravel(), gy.ravel())
        # light smoothing to hide 2 m DEM noise under the flat-shaded look
        zz = z.reshape(n, n)
        sm = zz.copy()
        sm[1:-1, 1:-1] = (zz[1:-1, 1:-1] * 4 + zz[:-2, 1:-1] + zz[2:, 1:-1] + zz[1:-1, :-2] + zz[1:-1, 2:]) / 8.0
        return {"size": size, "n": n, "origin": [minx, miny], "elev": [round(float(v), 2) for v in sm.ravel()]}
