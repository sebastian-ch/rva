"""NOAA 2025 hydro polygons and sloping water surfaces, in the pipeline's metre frame."""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely import force_2d, get_coordinates, contains_xy
from shapely.geometry import box

from config import CRS_PROJ

FT_TO_M = 1200 / 3937
BREAKLINES_URL = "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid18/14835/breaklines/Virginia_Lidar_2025_Richmond_Breaklines.gpkg"


class HydroSurface:
    def __init__(self, water, samples):
        self.water = water
        self.mask = water.geometry.union_all()
        self.samples = samples
        self.tree = cKDTree(samples[:, :2])

    def sample(self, xs, ys):
        """IDW shoreline elevations; shared global samples prevent tile-edge seams."""
        d, i = self.tree.query(np.column_stack([xs, ys]), k=min(6, len(self.samples)))
        if d.ndim == 1:
            return self.samples[i, 2]
        w = 1 / np.maximum(d, 0.05) ** 2
        return (w * self.samples[i, 2]).sum(axis=1) / w.sum(axis=1)

    def apply_grid(self, grid):
        n, size = grid["n"], grid["size"]
        x, y = grid["origin"]
        gx, gy = np.meshgrid(x + np.linspace(0, size, n), y + np.linspace(0, size, n))
        gx, gy = gx.ravel(), gy.ravel()
        surface = self.sample(gx, gy)
        bed = np.asarray(grid["elev"])
        mask = contains_xy(self.mask, gx, gy)
        bed[mask] = np.minimum(bed[mask], surface[mask] - 0.5)
        grid["elev"] = bed.round(2).tolist()
        grid["water_elev"] = surface.round(2).tolist()
        return grid


def load_hydro(path: Path, bbox, base: float) -> HydroSurface:
    boundary = gpd.GeoSeries([box(*bbox)], crs="EPSG:4326").to_crs(CRS_PROJ).iloc[0]
    rows, samples = [], []
    for layer, kind in (("Rivers", "river"), ("Waterbodies", "pond")):
        raw = gpd.read_file(path, layer=layer)
        # Reproject XY only: source Z is NAVD88 US survey feet, not metres.
        xy = raw.copy()
        xy.geometry = force_2d(raw.geometry.array)
        xy = xy.to_crs(CRS_PROJ)
        from pyproj import Transformer
        tr = Transformer.from_crs(raw.crs.to_2d(), CRS_PROJ, always_xy=True)
        for idx, row in xy.iterrows():
            if not row.geometry.intersects(boundary):
                continue
            coords = get_coordinates(raw.loc[idx].geometry, include_z=True)
            x, y = tr.transform(coords[:, 0], coords[:, 1])
            pts = np.column_stack([x, y, coords[:, 2] * FT_TO_M - base])
            pts = pts[np.isfinite(pts).all(axis=1)]
            if not len(pts):
                continue
            samples.append(pts)
            rows.append(dict(id=f"noaa:{layer}:{row.OBJECTID}", name="James River" if kind == "river" else None,
                             kind=kind, source="noaa2025", water_z=None if kind == "river" else float(np.median(pts[:, 2])),
                             geometry=row.geometry.intersection(boundary)))
    if not rows:
        raise ValueError("NOAA hydro package has no water polygons in this region")
    return HydroSurface(gpd.GeoDataFrame(rows, crs=CRS_PROJ), np.concatenate(samples))


def merge_water(osm, hydro):
    """Replace intersecting OSM river outlines; retain small unmapped canals and ponds."""
    covered = hydro.water.geometry.union_all()
    keep = osm.copy()
    replace = keep.geometry.intersects(covered) & (keep.kind == "river")
    keep = keep[~replace].copy()
    keep.geometry = keep.geometry.difference(covered)
    keep = keep[~keep.geometry.is_empty]
    out = gpd.GeoDataFrame(pd.concat([keep, hydro.water], ignore_index=True), crs=CRS_PROJ)
    if "water_z" in out:
        out["water_z"] = pd.to_numeric(out["water_z"], errors="coerce")
    return out
