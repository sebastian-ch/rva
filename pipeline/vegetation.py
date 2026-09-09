"""Surveyed street trees plus approximate crowns from classified 2025 LiDAR.

Inventory supplies stem positions/species; LiDAR supplies heights and gap-fill crowns.
Winter crowns are estimates, not a botanical inventory or a current tree-health survey.
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.ndimage import maximum_filter, gaussian_filter
from scipy.spatial import cKDTree
from shapely.geometry import Point

from config import CRS_PROJ


def inventory_trees(raw):
    active = raw[raw.Status.fillna("").str.lower().eq("in service")].copy()
    species = active.SPP.fillna("")
    active = active[~species.str.contains("vacant|stump|removed|planting site", case=False, regex=True)].copy()
    active = active.drop_duplicates("OBJECTID").to_crs(CRS_PROJ)
    return gpd.GeoDataFrame({"id": "rva-tree:" + active.OBJECTID.astype(str), "name": active.SPP,
                             "kind": "tree", "species": active.SPP, "source": "city_inventory",
                             "tree_height": 8.0, "crown_radius": 2.5, "height_source": "estimated",
                             "geometry": active.geometry}, crs=CRS_PROJ).reset_index(drop=True)


def canopy_peaks(canopy, origin, cell=1.0):
    """Local maxima with deterministic spacing; measured crown envelope is approximate."""
    smooth = gaussian_filter(canopy, 0.8)
    peaks = (smooth == maximum_filter(smooth, size=7)) & (smooth >= 3.0)
    yy, xx = np.where(peaks)
    order = np.lexsort((xx, yy, -smooth[yy, xx]))
    rows, occupied = [], {}
    for i in order:
        x, y = int(xx[i]), int(yy[i])
        h = float(canopy[max(0, y - 1):y + 2, max(0, x - 1):x + 2].max())
        if h < 3 or h > 45:
            continue
        window = canopy[max(0, y - 6):y + 7, max(0, x - 6):x + 7]
        radius = float(np.clip(np.sqrt(np.count_nonzero(window > h * 0.45) * cell * cell / np.pi), 1.4, 6.0))
        px, py = origin[0] + (x + 0.5) * cell, origin[1] + (y + 0.5) * cell
        key = (int(px // 8), int(py // 8))
        nearby = [p for dx in (-1, 0, 1) for dy in (-1, 0, 1) for p in occupied.get((key[0] + dx, key[1] + dy), [])]
        if any(np.hypot(px - qx, py - qy) < max(3, (radius + qr) * 0.7) for qx, qy, qr in nearby):
            continue
        occupied.setdefault(key, []).append((px, py, radius))
        rows.append(dict(id=f"lidar-tree:{round(px)}:{round(py)}", name=None, kind="tree", species=None,
                         source="lidar2025", tree_height=round(h, 1), crown_radius=round(radius, 1),
                         height_source="lidar2025", geometry=Point(px, py)))
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ) if rows else gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)


def lidar_canopies(npz_path, terrain):
    import rasterio
    with np.load(npz_path) as pts:
        vegetation = np.isin(pts["c"], [4, 5])
        x, y, z = pts["x"][vegetation], pts["y"][vegetation], pts["z"][vegetation]
    if not len(x):
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    ds = terrain.ds
    if ds.crs.to_string() != CRS_PROJ:
        raise ValueError("Canopy processing requires the terrain in the region's projected CRS")
    rr, cc = rasterio.transform.rowcol(ds.transform, x, y)
    rr, cc = np.asarray(rr), np.asarray(cc)
    ok = (rr >= 0) & (rr < ds.height) & (cc >= 0) & (cc < ds.width)
    x, y, z, rr, cc = x[ok], y[ok], z[ok], rr[ok], cc[ok]
    ground = ds.read(1, masked=True).filled(np.nan)
    height = z - ground[rr, cc]
    good = np.isfinite(height) & (height >= 2.5) & (height <= 45)
    x, y, height = x[good], y[good], height[good]
    if not len(x):
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    ox, oy = np.floor(x.min()), np.floor(y.min())
    ix, iy = np.floor(x - ox).astype(int), np.floor(y - oy).astype(int)
    canopy = np.zeros((iy.max() + 1, ix.max() + 1), dtype=np.float32)
    np.maximum.at(canopy, (iy, ix), height)
    return canopy_peaks(canopy, (ox, oy))


def merge_trees(pois, inventory, crowns, buildings, water):
    """Keep surveyed stems; use nearby canopy measurements once, then fill the gaps."""
    measured = inventory.copy()
    extras = crowns.copy()
    if len(crowns) and len(measured):
        xy = np.column_stack([crowns.geometry.x, crowns.geometry.y])
        d, idx = cKDTree(xy).query(np.column_stack([measured.geometry.x, measured.geometry.y]))
        matched = d <= 7
        for col in ("tree_height", "crown_radius", "height_source"):
            measured.loc[matched, col] = crowns.iloc[idx[matched]][col].to_numpy()
        # Exclude crowns near any surveyed stem, even if several peaks describe one crown.
        stem_dist, _ = cKDTree(np.column_stack([measured.geometry.x, measured.geometry.y])).query(xy)
        extras = crowns[stem_dist > 6].copy()
    trees = gpd.GeoDataFrame(pd.concat([measured, extras], ignore_index=True), crs=CRS_PROJ)
    if len(trees):
        obstacles = pd.concat([buildings[["geometry"]], water[["geometry"]]], ignore_index=True)
        if len(obstacles):
            trees = trees[~trees.geometry.intersects(obstacles.geometry.union_all())].copy()
    osm = pois.copy()
    if len(trees) and len(osm):
        nearby = trees.geometry.buffer(6).union_all()
        osm = osm[~((osm.kind == "tree") & osm.geometry.intersects(nearby))]
    return gpd.GeoDataFrame(pd.concat([osm, trees], ignore_index=True), crs=CRS_PROJ)
