"""Detect and attach reviewed roof furniture from the Richmond 2025 LiDAR surface.

Detection is deliberately separate from attachment. The detector creates candidates for visual review;
the build only reads the reviewed exact-ID supplement. This keeps cars, broad setback tiers and roof-edge
noise from silently becoming architecture across the city.
"""
from __future__ import annotations

import json
import math
import warnings
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
from scipy.ndimage import label
from shapely import contains_xy
from shapely.geometry import MultiPoint, Point

from lidar import NON_ROOF_CLASSES, _cell_mask, cloud_origin, surface_points

CELL_M = 0.35
EDGE_INSET_M = 2.5
MIN_AREA_M2 = 4.0
MAX_AREA_M2 = 100.0
MIN_HEIGHT_M = 1.0
MAX_HEIGHT_M = 6.0
MAX_COUNT = 8


def dense_surface(npz_path: Path, buildings: gpd.GeoDataFrame, cell: float = CELL_M,
                  chunk: int = 20_000_000) -> np.ndarray:
    """Return a dense top surface only around *buildings*, scanning the existing cloud once."""
    if not Path(npz_path).exists() or len(buildings) == 0:
        return np.zeros((0, 3), np.float64)
    mask, col0, row0 = _cell_mask(buildings, 1.0, 1.0)
    data = np.load(npz_path)
    x, y, z = data["x"], data["y"], data["z"]
    classes = data["c"] if "c" in data.files else None
    ox, oy = cloud_origin(data)
    kept: list[np.ndarray] = []
    for start in range(0, len(x), chunk):
        end = min(start + chunk, len(x))
        keep = np.ones(end - start, bool) if classes is None else ~np.isin(classes[start:end], NON_ROOF_CLASSES)
        col = np.floor(x[start:end] + ox).astype(np.int64) - col0
        row = np.floor(y[start:end] + oy).astype(np.int64) - row0
        inside = (col >= 0) & (col < mask.shape[1]) & (row >= 0) & (row < mask.shape[0])
        keep &= inside
        keep[keep] = mask[row[keep], col[keep]]
        if keep.any():
            kept.append(np.c_[x[start:end][keep].astype(np.float64) + ox,
                              y[start:end][keep].astype(np.float64) + oy,
                              z[start:end][keep].astype(np.float64)])
    if not kept:
        return np.zeros((0, 3), np.float64)
    return surface_points(np.concatenate(kept), cell)


def _dominant_plane(z: np.ndarray) -> tuple[float, float] | None:
    """Return the dominant horizontal elevation and its support fraction."""
    if len(z) < 40:
        return None
    bins = np.round(z / 0.2).astype(np.int64)
    values, counts = np.unique(bins, return_counts=True)
    mode = values[np.argmax(counts)] * 0.2
    near = z[np.abs(z - mode) <= 0.35]
    if len(near) < 20:
        return None
    return float(np.median(near)), len(near) / len(z)


def detect(building: Any, points: np.ndarray, base_elevation: float = 0,
           cell: float = CELL_M) -> list[dict[str, float]]:
    """Detect compact rectangular objects above one dominant flat roof plane."""
    name = str(getattr(building, "name", "") or "").lower()
    kind = str(getattr(building, "type", "") or "").lower()
    landmark = getattr(building, "landmark", None)
    if any(word in name for word in ("parking", "garage", " deck")) or kind in {"garage", "garages", "parking"}:
        return []
    if isinstance(landmark, str) and landmark:
        return []
    geom = building.geometry
    inner = geom.buffer(-EDGE_INSET_M)
    if inner.is_empty or len(points) == 0:
        return []
    pts = points[contains_xy(inner, points[:, 0], points[:, 1])]
    plane = _dominant_plane(pts[:, 2]) if len(pts) else None
    if plane is None or plane[1] < 0.35:
        return []
    roof_z, _support = plane
    residual = pts[:, 2] - roof_z
    elevated = (residual >= MIN_HEIGHT_M) & (residual <= MAX_HEIGHT_M)
    if elevated.sum() * cell * cell < MIN_AREA_M2:
        return []

    minx, miny, maxx, maxy = inner.bounds
    grid_x, grid_y = math.floor(minx / cell) * cell, math.floor(miny / cell) * cell
    width = int(math.ceil((maxx - grid_x) / cell)) + 1
    height = int(math.ceil((maxy - grid_y) / cell)) + 1
    cols = np.floor((pts[:, 0] - grid_x) / cell).astype(np.int64)
    rows = np.floor((pts[:, 1] - grid_y) / cell).astype(np.int64)
    valid = elevated & (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
    grid = np.zeros((height, width), bool)
    grid[rows[valid], cols[valid]] = True
    labels, count = label(grid, np.ones((3, 3), dtype=np.uint8))
    props: list[tuple[float, dict[str, float]]] = []
    for component in range(1, count + 1):
        rr, cc = np.where(labels == component)
        area = len(cc) * cell * cell
        if not MIN_AREA_M2 <= area <= min(MAX_AREA_M2, geom.area * 0.08):
            continue
        xy = np.c_[grid_x + (cc + 0.5) * cell, grid_y + (rr + 0.5) * cell]
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=RuntimeWarning, module="shapely.constructive")
            rect = MultiPoint(xy).minimum_rotated_rectangle
        coords = list(rect.exterior.coords)[:4]
        edges = [(math.dist(coords[i], coords[(i + 1) % 4]), i) for i in range(4)]
        long, edge = max(edges)
        short = min(length for length, _ in edges)
        if short < 1.2 or long > 20 or long / short > 5 or area / (long * short) < 0.45:
            continue
        in_component = valid & (labels[rows.clip(0, height - 1), cols.clip(0, width - 1)] == component)
        object_height = float(np.median(residual[in_component]))
        if not MIN_HEIGHT_M <= object_height <= MAX_HEIGHT_M:
            continue
        a, b = coords[edge], coords[(edge + 1) % 4]
        center = rect.centroid
        wall_top_abs = float(building.ground_z) + float(building.height) + base_elevation
        base_offset = roof_z - wall_top_abs
        # A procedural extrusion cannot support a floating object on an unmodeled upper tier. Roofer meshes
        # may contain those tiers, but an object below their wall top would be buried by the accepted shell.
        if getattr(building, "roof_source", None) == "lod2":
            if not -0.75 <= base_offset <= 10:
                continue
        elif abs(base_offset) > 0.75:
            continue
        if abs(base_offset) <= 0.75:
            base_offset = 0.0
        props.append((area, {
            "x": round(center.x, 2), "y": round(center.y, 2),
            "w": round(long + cell, 2), "d": round(short + cell, 2),
            "h": round(object_height, 2), "a": round(math.atan2(b[1] - a[1], b[0] - a[0]), 4),
            "b": round(base_offset, 2),
        }))
    props.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in props[:MAX_COUNT]]


def attach(buildings: gpd.GeoDataFrame, supplement: Path) -> gpd.GeoDataFrame:
    """Attach reviewed exact-ID records; missing or empty supplements are a no-op."""
    out = buildings.copy()
    if "roof_props" not in out:
        out["roof_props"] = None
    if not Path(supplement).exists():
        return out
    records = json.loads(Path(supplement).read_text()).get("buildings", {})
    by_id = {str(value): idx for idx, value in out["id"].items()}
    applied = 0
    for target_id, props in records.items():
        if target_id not in by_id or not isinstance(props, list) or not props:
            continue
        target = out.loc[by_id[target_id]]
        target_top = float(target.get("ground_z", 0) or 0) + float(target.get("height", 0) or 0)
        parts = out[out.get("parent", None) == target_id] if "parent" in out else out.iloc[0:0]
        accepted = []
        for prop in props:
            point = Point(prop.get("x", math.nan), prop.get("y", math.nan))
            covered = any(
                part.geometry.covers(point)
                and float(part.get("ground_z", 0) or 0) + float(part.get("height", 0) or 0) > target_top + 0.75
                for _, part in parts.iterrows()
            )
            if not covered:
                accepted.append(prop)
        if not accepted:
            continue
        out.at[by_id[target_id], "roof_props"] = json.dumps(accepted, separators=(",", ":"))
        applied += 1
    if applied:
        print(f"  reviewed roof furniture: {applied}/{len(records)} buildings")
    return out
