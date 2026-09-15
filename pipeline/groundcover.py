"""Stylized ground-cover polygons from VGIN RGB, NAIP NIR and LiDAR nDSM.

VGIN supplies the clean leaf-off boundaries; NAIP supplies NIR for vegetation; nDSM removes trees,
buildings and other elevated objects. The output is deliberately coarse and sparse. Existing mapped
parks, pitches, parking, plazas and other semantic landuse retain priority.
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
from scipy.ndimage import binary_closing, binary_opening, distance_transform_edt, label
from shapely.geometry import box, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

from config import CRS_PROJ

CELL_M = 3.0
SIMPLIFY_M = 3.0
SMOOTH_M = 3.0
MAX_GAP_CELLS = 4
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

    # NAIP and VGIN can be flown years apart. Strong bare-soil evidence in the
    # newer, sharper RGB must veto stale NIR vegetation (for example, a site
    # cleared after the NAIP flight).
    r, g, b = v[:3]
    brightness = (r + g + b) / 3
    rgb_bare = low & (brightness > 0.16) & (r > g * 1.07) & (g > b * 1.03) & ((r - b) > 0.08)

    lawn = low & (ndvi > 0.16)
    # Do not apply the temporal veto pixel by pixel: dormant grass is also
    # brown in leaf-off imagery. Reclassify only coherent vegetation regions
    # whose current RGB is dominated by unambiguous, bright exposed soil.
    strong_rgb_bare = rgb_bare & (brightness > 0.55)
    components, count = label(lawn)
    sizes = np.bincount(components.ravel(), minlength=count + 1)
    strong_counts = np.bincount(components.ravel(), weights=strong_rgb_bare.ravel(), minlength=count + 1)
    stale_components = (sizes >= 4) & (strong_counts > sizes * 0.5)
    stale_components[0] = False
    stale_region = stale_components[components]
    # Follow the current RGB boundary, not the old vegetation component's
    # blocky outline. A slightly wider close removes machinery/shadow gaps
    # inside a confirmed cleared site without expanding into adjacent lawn.
    stale_bare = binary_closing(strong_rgb_bare & stale_region, structure=np.ones((5, 5), bool)) & stale_region
    lawn &= ~stale_bare
    nonveg = low & (ndvi < 0.11)
    paved = nonveg & ~rgb_bare
    bare = rgb_bare & nonveg | stale_bare

    out = np.zeros(ndsm.shape, np.uint8)
    for value, mask in ((1, lawn), (2, paved), (3, bare)):
        # Close one-cell gaps and drop isolated speckle before polygonization.
        clean = binary_opening(binary_closing(mask, structure=np.ones((3, 3), bool)),
                               structure=np.ones((2, 2), bool))
        out[clean] = value
    # The NDVI deadband and low-height shadows otherwise punch base-ground
    # seams between nearby classified cells. Extend only to short gaps; broad
    # uncertain regions remain unknown, and exact vectors are subtracted later.
    if np.any(out):
        distance, nearest = distance_transform_edt(out == 0, return_indices=True)
        fill = low & (out == 0) & (distance <= MAX_GAP_CELLS)
        out[fill] = out[tuple(index[fill] for index in nearest)]
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


def _exclusion_geometries(buildings: gpd.GeoDataFrame, roads: gpd.GeoDataFrame,
                          landuse: gpd.GeoDataFrame, water: gpd.GeoDataFrame) -> list:
    """Return source-resolution geometry that imagery-derived cover must not obscure."""
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
    return geoms


def polygonize(classes: np.ndarray, transform, exclusion: np.ndarray | None = None,
               clip=None, vector_exclusion: list | None = None,
               kind_vector_exclusion: dict[str, list] | None = None) -> gpd.GeoDataFrame:
    """Convert a coarse class grid to aggressively simplified map-scale polygons."""
    from rasterio.features import shapes

    data = classes.copy()
    if exclusion is not None:
        data[exclusion] = 0
    names = {1: "groundcover_lawn", 2: "groundcover_paved", 3: "groundcover_bare"}
    exclusions = [g for g in (vector_exclusion or []) if g is not None and not g.is_empty]
    exclusion_tree = STRtree(exclusions) if exclusions else None
    kind_exclusions = {
        kind: [g for g in geoms if g is not None and not g.is_empty]
        for kind, geoms in (kind_vector_exclusion or {}).items()
    }
    kind_trees = {kind: STRtree(geoms) for kind, geoms in kind_exclusions.items() if geoms}
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
        # Boundaries cannot justify detail below the source grid. A one-cell
        # tolerance removes raster stair steps while retaining broad image edges.
        geom = geom.simplify(SIMPLIFY_M, preserve_topology=True).buffer(0)
        # Round both outward and inward raster corners with a bounded map-scale
        # operation. Keep this before vector subtraction so surveyed buildings,
        # roads, landuse and water retain their exact source boundaries.
        geom = geom.buffer(SMOOTH_M, quad_segs=1).buffer(-SMOOTH_M, quad_segs=1)
        geom = geom.buffer(-SMOOTH_M, quad_segs=1).buffer(SMOOTH_M, quad_segs=1)
        if exclusion_tree is not None and not geom.is_empty:
            hits = exclusion_tree.query(geom, predicate="intersects")
            if len(hits):
                # Subtract the original vectors after polygonization. Rasterizing
                # these masks first creates 3 m sawteeth around every building and road.
                geom = geom.difference(unary_union([exclusions[int(i)] for i in hits]))
        extra_tree = kind_trees.get(kind)
        if extra_tree is not None and not geom.is_empty:
            hits = extra_tree.query(geom, predicate="intersects")
            if len(hits):
                extra = kind_exclusions[kind]
                geom = geom.difference(unary_union([extra[int(i)] for i in hits]))
        if geom.is_empty:
            continue
        # Difference can split one large classified region into dozens of tiny
        # wedges around buildings. Reapply the area gate per polygon rather than
        # to the combined MultiPolygon, or those blocky remnants survive.
        parts = list(geom.geoms) if geom.geom_type in {"MultiPolygon", "GeometryCollection"} else [geom]
        parts = [part for part in parts if part.geom_type == "Polygon" and part.area >= MIN_AREA_M2[kind]]
        if not parts:
            continue
        geom = unary_union(parts)
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
    exclusions = _exclusion_geometries(buildings, roads, landuse, water)
    # The 3 m classifier cannot resolve narrow driveways and side yards cleanly.
    # Keep inferred paving away from building edges while retaining broad lots.
    paved_exclusions = [g.buffer(5.0) for g in buildings.geometry if g is not None and not g.is_empty]
    left, top = transform * (0, 0)
    right, bottom = transform * (classes.shape[1], classes.shape[0])
    result = polygonize(classes, transform, clip=box(left, bottom, right, top),
                        vector_exclusion=exclusions,
                        kind_vector_exclusion={"groundcover_paved": paved_exclusions})
    if len(result):
        counts = result.groupby("kind").size().to_dict()
        area = {k: round(float(v.geometry.area.sum()) / 1e6, 2) for k, v in result.groupby("kind")}
        print(f"  ground cover: {len(result)} polygons {counts}; area km2 {area}")
    return result
