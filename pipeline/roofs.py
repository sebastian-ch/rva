"""LiDAR roof classification. Pure numpy; testable with synthetic clouds.

classify_roof(points, footprint, ground) -> RoofFit | None
    points: (N, 3) float array in the footprint's CRS (meters)
    footprint: shapely Polygon
    ground: ground elevation (m) under the footprint
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from shapely.geometry import Polygon
from shapely.prepared import prep
from shapely import vectorized

MIN_POINTS = 25
FLAT_RMS = 0.35
FLAT_SLOPE_DEG = 8.0
FLAT_IQR = 1.0  # interquartile z spread for the flat-with-clutter rule
TWO_PLANE_RMS = 0.6  # 2025 cloud: chimneys/parapets on rowhouses push a clean two-plane fit past 0.45
PITCH_MIN_DEG, PITCH_MAX_DEG = 10.0, 55.0
SKILLION_RMS = 0.35
EAVE_CLEARANCE = 2.0  # ignore points lower than ground + this (walls, cars, shrubs)


@dataclass
class RoofFit:
    shape: str            # flat | gable | hip | skillion
    azimuth: float        # ridge direction, degrees clockwise from north (0..180)
    ridge_z: float        # absolute
    eave_z: float         # absolute
    rms: float
    n_points: int

    @property
    def roof_height(self) -> float:
        return max(0.0, self.ridge_z - self.eave_z)


def _fit_plane(p: np.ndarray) -> tuple[np.ndarray, float]:
    """Least squares z = a x + b y + c. Returns (coef[a,b,c], rms)."""
    A = np.c_[p[:, 0], p[:, 1], np.ones(len(p))]
    coef, *_ = np.linalg.lstsq(A, p[:, 2], rcond=None)
    res = p[:, 2] - A @ coef
    return coef, float(np.sqrt(np.mean(res**2)))


def _slope_deg(coef: np.ndarray) -> float:
    return math.degrees(math.atan(math.hypot(coef[0], coef[1])))


def _obb_axes(poly: Polygon) -> list[float]:
    """Candidate ridge azimuths (radians, math convention: angle of the axis direction) from the OBB."""
    with np.errstate(all="ignore"):
        rect = poly.minimum_rotated_rectangle
    xs, ys = rect.exterior.coords.xy
    e0 = (xs[1] - xs[0], ys[1] - ys[0])
    e1 = (xs[2] - xs[1], ys[2] - ys[1])
    long_e = e0 if math.hypot(*e0) >= math.hypot(*e1) else e1
    base = math.atan2(long_e[1], long_e[0])
    return [base, base + math.pi / 2, base + math.radians(15), base - math.radians(15)]


def _two_plane(p: np.ndarray, cx: float, cy: float, theta: float) -> tuple[float, np.ndarray, np.ndarray, float] | None:
    """Split by signed distance to the axis through (cx,cy) with direction theta; fit a plane per side."""
    ux, uy = math.cos(theta), math.sin(theta)
    s = -(p[:, 0] - cx) * uy + (p[:, 1] - cy) * ux  # signed perpendicular distance
    left, right = p[s < 0], p[s >= 0]
    if len(left) < 8 or len(right) < 8:
        return None
    cl, rl = _fit_plane(left)
    cr, rr = _fit_plane(right)
    rms = math.sqrt((rl**2 * len(left) + rr**2 * len(right)) / len(p))
    # ridge line z: evaluate both planes at the axis, average along the footprint extent
    t = (p[:, 0] - cx) * ux + (p[:, 1] - cy) * uy
    ts = np.linspace(t.min(), t.max(), 5)
    ax, ay = cx + ux * ts, cy + uy * ts
    zl = cl[0] * ax + cl[1] * ay + cl[2]
    zr = cr[0] * ax + cr[1] * ay + cr[2]
    ridge_z = float(np.mean((zl + zr) / 2))
    return rms, cl, cr, ridge_z


def _azimuth_from_theta(theta: float) -> float:
    """Math angle (from +x, CCW) -> compass azimuth of a line (0..180, clockwise from north)."""
    az = (90.0 - math.degrees(theta)) % 180.0
    return az


def classify_roof(points: np.ndarray, footprint: Polygon, ground: float) -> RoofFit | None:
    if points is None or len(points) < MIN_POINTS or footprint.is_empty:
        return None
    inner = footprint.buffer(-0.8)
    if inner.is_empty:
        inner = footprint
    inside = vectorized.contains(inner, points[:, 0], points[:, 1])
    p = points[inside]
    p = p[p[:, 2] > ground + EAVE_CLEARANCE]
    if len(p) < MIN_POINTS:
        return None
    # drop obvious outliers (antennas, birds): keep between 1st and 99.5th percentile
    lo, hi = np.percentile(p[:, 2], [1, 99.5])
    p = p[(p[:, 2] >= lo) & (p[:, 2] <= hi)]
    if len(p) < MIN_POINTS:
        return None

    coef, rms = _fit_plane(p)
    slope = _slope_deg(coef)
    zmax, zmin = float(np.percentile(p[:, 2], 98)), float(np.percentile(p[:, 2], 5))
    if rms < FLAT_RMS and slope < FLAT_SLOPE_DEG:
        z = float(np.median(p[:, 2]))
        return RoofFit("flat", 0.0, z, z, rms, len(p))
    # flat with clutter: HVAC, parapets and penthouses spoil the plane fit, but most of the surface is level
    q25, q75 = np.percentile(p[:, 2], [25, 75])
    level_frac = float(np.mean(np.abs(p[:, 2] - np.median(p[:, 2])) < 0.3))
    if q75 - q25 < FLAT_IQR and level_frac > 0.6 and slope < FLAT_SLOPE_DEG * 2:
        z = float(np.median(p[:, 2]))
        return RoofFit("flat", 0.0, z, z, rms, len(p))
    if rms < SKILLION_RMS and 5.0 <= slope <= 35.0:
        theta = math.atan2(-coef[0], coef[1])  # ridge (level line) is perpendicular to the gradient
        return RoofFit("skillion", _azimuth_from_theta(theta), zmax, zmin, rms, len(p))

    cx, cy = footprint.centroid.x, footprint.centroid.y
    best = None
    for theta in _obb_axes(footprint):
        r = _two_plane(p, cx, cy, theta)
        if r is None:
            continue
        rms2, cl, cr, ridge_z = r
        sl, sr = _slope_deg(cl), _slope_deg(cr)
        if not (PITCH_MIN_DEG <= sl <= PITCH_MAX_DEG and PITCH_MIN_DEG <= sr <= PITCH_MAX_DEG):
            continue
        if best is None or rms2 < best[0]:
            best = (rms2, theta, ridge_z)
    if best is None or best[0] > TWO_PLANE_RMS:
        return None
    rms2, theta, ridge_z = best
    ridge_z = min(ridge_z, zmax + 0.5)
    shape = "hip" if _has_hip_ends(p, cx, cy, theta, ridge_z, zmin) else "gable"
    return RoofFit(shape, _azimuth_from_theta(theta), ridge_z, zmin, rms2, len(p))


def _has_hip_ends(p: np.ndarray, cx: float, cy: float, theta: float, ridge_z: float, eave_z: float) -> bool:
    """Hip: the outer 20% at each end along the ridge axis descends toward the eave."""
    ux, uy = math.cos(theta), math.sin(theta)
    t = (p[:, 0] - cx) * ux + (p[:, 1] - cy) * uy
    span = t.max() - t.min()
    if span < 6 or ridge_z - eave_z < 1.0:
        return False
    near_ridge = np.abs(-(p[:, 0] - cx) * uy + (p[:, 1] - cy) * ux) < 1.0  # within 1 m of the ridge line
    if near_ridge.sum() < 10:
        return False
    ends = near_ridge & ((t < t.min() + 0.2 * span) | (t > t.max() - 0.2 * span))
    mid = near_ridge & ~ends
    if ends.sum() < 5 or mid.sum() < 5:
        return False
    drop = float(np.median(p[mid, 2]) - np.median(p[ends, 2]))
    return drop > 0.35 * (ridge_z - eave_z)
