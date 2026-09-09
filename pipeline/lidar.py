"""Optional LiDAR nDSM sampling. VGIN LiDAR is not downloaded automatically (multi-GB); if you build a
normalized DSM (DSM - DTM) GeoTIFF and place it at data/raw/ndsm.tif (any CRS), buildings that lack OSM
height/levels get the median nDSM value inside their footprint, per the resolution order.
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np

from config import DATA_RAW

NDSM_PATH = DATA_RAW / "ndsm.tif"


def sample_ndsm_median(buildings: gpd.GeoDataFrame, ndsm_path: Path = NDSM_PATH) -> np.ndarray:
    """Return an array of per-footprint nDSM medians (NaN where unavailable)."""
    out = np.full(len(buildings), np.nan, dtype=float)
    if not ndsm_path.exists():
        return out
    import rasterio
    from rasterio.mask import mask as rio_mask

    with rasterio.open(ndsm_path) as ds:
        geoms = buildings.to_crs(ds.crs).geometry
        nodata = ds.nodata
        for i, g in enumerate(geoms):
            if g is None or g.is_empty:
                continue
            try:
                arr, _ = rio_mask(ds, [g.__geo_interface__], crop=True, filled=False)
            except ValueError:
                continue
            vals = arr[0].compressed() if np.ma.isMaskedArray(arr) else arr[0].ravel()
            if nodata is not None:
                vals = vals[vals != nodata]
            vals = vals[np.isfinite(vals)]
            if vals.size >= 4:
                out[i] = float(np.median(vals))
    return out
