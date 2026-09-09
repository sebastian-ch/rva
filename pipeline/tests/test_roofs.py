"""Tests for pipeline/roofs.py roof classification on synthetic point clouds."""
from __future__ import annotations

import math

import numpy as np
import pytest
from shapely.affinity import rotate
from shapely.geometry import Polygon, box

from roofs import RoofFit, classify_roof

N_POINTS = 600
NOISE = 0.05


def _xy(footprint: Polygon, n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    minx, miny, maxx, maxy = footprint.bounds
    xs = rng.uniform(minx, maxx, n)
    ys = rng.uniform(miny, maxy, n)
    return xs, ys, rng


def test_flat_roof():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = np.full(N_POINTS, 10.0) + rng.normal(0, NOISE, N_POINTS)
    pts = np.column_stack([xs, ys, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "flat"
    assert fit.ridge_z == pytest.approx(10.0, abs=0.1)
    assert fit.eave_z == pytest.approx(10.0, abs=0.1)
    assert fit.roof_height == pytest.approx(0.0, abs=0.15)


def test_gable_ridge_along_x():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = 10 + (4 - np.abs(ys - 4)) * 0.7 + rng.normal(0, NOISE, N_POINTS)
    pts = np.column_stack([xs, ys, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "gable"
    assert fit.azimuth == pytest.approx(90.0, abs=5)
    assert 1.8 <= fit.roof_height <= 3.0


def test_gable_ridge_along_y():
    fp = box(0, 0, 8, 12)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = 10 + (4 - np.abs(xs - 4)) * 0.7 + rng.normal(0, NOISE, N_POINTS)
    pts = np.column_stack([xs, ys, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "gable"
    az = fit.azimuth
    assert min(az, 180 - az) <= 5


def test_gable_rotated_30_degrees():
    fp0 = box(0, 0, 12, 8)
    fp = rotate(fp0, 30, origin=(6, 4))
    xs, ys, rng = _xy(fp0, N_POINTS)
    z = 10 + (4 - np.abs(ys - 4)) * 0.7 + rng.normal(0, NOISE, N_POINTS)

    theta = math.radians(30)
    cx, cy = 6.0, 4.0
    dx, dy = xs - cx, ys - cy
    rx = cx + dx * math.cos(theta) - dy * math.sin(theta)
    ry = cy + dx * math.sin(theta) + dy * math.cos(theta)

    pts = np.column_stack([rx, ry, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "gable"
    assert fit.azimuth == pytest.approx(60.0, abs=6)


def test_skillion():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = 10 + ys * 0.3 + rng.normal(0, NOISE, N_POINTS)
    pts = np.column_stack([xs, ys, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "skillion"
    assert 1.5 <= fit.roof_height <= 2.6


def test_hip():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = 10 + np.minimum(4 - np.abs(ys - 4), np.minimum(xs, 12 - xs)) * 0.7 + rng.normal(0, NOISE, N_POINTS)
    pts = np.column_stack([xs, ys, z])
    fit = classify_roof(pts, fp, 0.0)
    assert fit is not None
    assert fit.shape == "hip"


def test_too_few_points_returns_none():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, 10)
    z = np.full(10, 10.0)
    pts = np.column_stack([xs, ys, z])
    assert classify_roof(pts, fp, 0.0) is None


def test_all_points_below_ground_clearance_returns_none():
    fp = box(0, 0, 12, 8)
    xs, ys, rng = _xy(fp, N_POINTS)
    z = np.full(N_POINTS, 1.0) + rng.normal(0, NOISE, N_POINTS)  # below ground + EAVE_CLEARANCE(2.0)
    pts = np.column_stack([xs, ys, z])
    assert classify_roof(pts, fp, 0.0) is None


def test_empty_polygon_returns_none():
    fp = Polygon()
    pts = np.column_stack([np.zeros(50), np.zeros(50), np.full(50, 10.0)])
    assert classify_roof(pts, fp, 0.0) is None


def test_roof_height_never_negative():
    fit = RoofFit(shape="flat", azimuth=0.0, ridge_z=5.0, eave_z=8.0, rms=0.1, n_points=100)
    assert fit.roof_height == 0.0
    assert fit.roof_height >= 0.0


def test_surface_points_keeps_highest_per_cell():
    from lidar import surface_points

    p = np.array([[0.2, 0.2, 1.0], [0.7, 0.4, 3.0], [0.1, 0.9, 2.0], [1.5, 0.5, 5.0], [1.2, 0.1, 4.0]])
    s = surface_points(p, cell=1.0)
    assert len(s) == 2
    assert sorted(s[:, 2].tolist()) == [3.0, 5.0]
    assert len(surface_points(p[:0])) == 0
