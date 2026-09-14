"""Stylized ground-cover polygons from VGIN RGB, NAIP NIR and LiDAR nDSM.

VGIN supplies the clean leaf-off boundaries; NAIP supplies NIR for vegetation; nDSM removes trees,
buildings and other elevated objects. The output is deliberately coarse and sparse. Existing mapped
parks, pitches, parking, plazas and other semantic landuse retain priority.
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
from scipy.ndimage import binary_closing, binary_opening
from shapely.geometry import box, shape

from config import CRS_PROJ

CELL_M = 3.0
MIN_AREA_M2 = {"groundcover_lawn": 90.0, "groundcover_paved": 120.0, "groundcover_bare": 120.0}
PRESERVE_KINDS = {"park", "grass", "pitch", "parking", "cemetery", "plaza", "forest", "beach",
                  "deck", "groyne", "breakwater", "seawall", "pier", "canal_bank"}


def classify_arrays(naip: np.ndarray, rgb: np.ndarray, ndsm: np.ndarray) -> np.ndarray:
    """Return 0 unknown, 1 lawn, 2 paving, 3 bare ground for aligned arrays."""
    if naip.shape[0] < 4 or rgb.shape[0] < 3 or naip.shape[1:] != rgb.shape[1:] or ndsm.shape != rgb.shape[1:]:
        raise ValueError("ground-cover arrays must be aligned RGB/NIR and nDSM grids")
    n = naip.astype(np.float32) / 255.0
    v = rgb.astype(np.float32) / 255.0
    red, nir = n[0], n[3]
    ndvi = np.divide(nir - red, nir + red, out=np.zeros_like(red), where=(nir + red) > 0.03)
    valid = (v[:3].max(axis=0) > 0.03) & np.isfinite(ndsm)
    low = valid & (ndsm < 1.25)

    lawn = low & (ndvi > 0.16)
    nonveg = low & (ndvi < 0.11)
    r, g, b = v[:3]
    brightness = (r + g + b) / 3
    brown = nonveg & (brightness > 0.16) & (r > g * 1.07) & (g > b * 1.03) & ((r - b) > 0.08)
    paved = nonveg & ~brown

    out = np.zeros(ndsm.shape, np.uint8)
    for value, mask in ((1, lawn), (2, paved), (3, brown)):
        # Close one-cell gaps and drop isolated speckle before polygonization.
        clean = binary_opening(binary_closing(mask, structure=np.ones((3, 3), bool)),
                               structure=np.ones((2, 2), bool))
        out[clean] = value
    return out


def _aligned_inputs(vbmp_path: Path, naip_path: Path, ndsm_path: Path, cell: float):
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    with rasterio.open(vbmp_path) as src:
        bounds = src.bounds
    width = int(np.ceil((bounds.right - bounds.left) / cell))
    height = int(np.ceil((bounds.top - bounds.bottom) / cell))
    transform = from_origin(bounds.left, bounds.top, cell, cell)

    def read(path: Path, bands: list[int], dtype, resampling):
        dst = np.zeros((len(bands), height, width), dtype=dtype)
        with rasterio.open(path) as src:
            for i, band in enumerate(bands):
                reproject(rasterio.band(src, band), dst[i], src_transform=src.transform, src_crs=src.crs,
                          dst_transform=transform, dst_crs=CRS_PROJ, resampling=resampling,
                          dst_nodata=np.nan if np.issubdtype(np.dtype(dtype), np.floating) else 0)
        return dst

    rgb = read(vbmp_path, [1, 2, 3], np.uint8, Resampling.average)
    naip = read(naip_path, [1, 2, 3, 4], np.uint8, Resampling.average)
    ndsm = read(ndsm_path, [1], np.float32, Resampling.bilinear)[0]
    return naip, rgb, ndsm, transform


def _exclusion_mask(shape_: tuple[int, int], transform, buildings: gpd.GeoDataFrame,
                    roads: gpd.GeoDataFrame, landuse: gpd.GeoDataFrame, water: gpd.GeoDataFrame) -> np.ndarray:
    from rasterio.features import rasterize

    geoms = []
    geoms.extend(g.buffer(1.0) for g in buildings.geometry if g is not None and not g.is_empty)
    for _, row in roads.iterrows():
        if row.geometry is None or row.geometry.is_empty:
            continue
        geoms.append(row.geometry.buffer(max(1.0, float(row.get("width", 4) or 4) / 2 + 0.8)))
    if len(landuse) and "kind" in landuse:
        geoms.extend(g for g in landuse.loc[landuse.kind.isin(PRESERVE_KINDS), "geometry"]
                     if g is not None and not g.is_empty)
    geoms.extend(g.buffer(0.5) for g in water.geometry if g is not None and not g.is_empty)
    if not geoms:
        return np.zeros(shape_, bool)
    return rasterize(((g, 1) for g in geoms), out_shape=shape_, transform=transform,
                     fill=0, dtype=np.uint8, all_touched=True).astype(bool)


def polygonize(classes: np.ndarray, transform, exclusion: np.ndarray | None = None,
               clip=None) -> gpd.GeoDataFrame:
    """Convert a coarse class grid to aggressively simplified map-scale polygons."""
    from rasterio.features import shapes

    data = classes.copy()
    if exclusion is not None:
        data[exclusion] = 0
    names = {1: "groundcover_lawn", 2: "groundcover_paved", 3: "groundcover_bare"}
    rows = []
    for raw, value in shapes(data, mask=data > 0, transform=transform, connectivity=8):
        kind = names.get(int(value))
        if kind is None:
            continue
        geom = shape(raw)
        if clip is not None:
            geom = geom.intersection(clip)
        if geom.is_empty or geom.area < MIN_AREA_M2[kind]:
            continue
        geom = geom.simplify(1.5, preserve_topology=True).buffer(0)
        if geom.is_empty or geom.area < MIN_AREA_M2[kind]:
            continue
        rows.append({"id": f"imagery:{kind}:{len(rows)}", "name": None, "kind": kind,
                     "sport": None, "surface": None, "pitch_layout": None,
                     "source": "vgin_vbmp+naip+lidar2025", "geometry": geom})
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ) if rows else gpd.GeoDataFrame(
        columns=["id", "name", "kind", "sport", "surface", "pitch_layout", "source", "geometry"],
        geometry="geometry", crs=CRS_PROJ)


def derive_groundcover(vbmp_path: Path, naip_path: Path, ndsm_path: Path, buildings: gpd.GeoDataFrame,
                       roads: gpd.GeoDataFrame, landuse: gpd.GeoDataFrame, water: gpd.GeoDataFrame,
                       cell: float = CELL_M) -> gpd.GeoDataFrame:
    if not all(Path(p).exists() for p in (vbmp_path, naip_path, ndsm_path)):
        return gpd.GeoDataFrame(columns=["id", "name", "kind", "sport", "surface", "pitch_layout",
                                               "source", "geometry"], geometry="geometry", crs=CRS_PROJ)
    naip, rgb, ndsm, transform = _aligned_inputs(vbmp_path, naip_path, ndsm_path, cell)
    classes = classify_arrays(naip, rgb, ndsm)
    exclusion = _exclusion_mask(classes.shape, transform, buildings, roads, landuse, water)
    left, top = transform * (0, 0)
    right, bottom = transform * (classes.shape[1], classes.shape[0])
    result = polygonize(classes, transform, exclusion, box(left, bottom, right, top))
    if len(result):
        counts = result.groupby("kind").size().to_dict()
        area = {k: round(float(v.geometry.area.sum()) / 1e6, 2) for k, v in result.groupby("kind")}
        print(f"  ground cover: {len(result)} polygons {counts}; area km2 {area}")
    return result
