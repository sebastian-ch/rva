"""The reduced-surface cache and its cell index must answer exactly what a brute-force scan would."""
from __future__ import annotations

import numpy as np
import geopandas as gpd
from shapely.geometry import Polygon, box

import lidar


def _cloud(rng, n=20000, origin=(280000.0, 4150000.0), span=200.0):
    x = origin[0] + rng.random(n) * span
    y = origin[1] + rng.random(n) * span
    z = 20.0 + rng.random(n) * 15.0
    return np.c_[x, y, z]


def _write_npz(tmp_path, pts, cls=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    p = tmp_path / "lidar_test.npz"
    kw = dict(x=pts[:, 0].astype(np.float32), y=pts[:, 1].astype(np.float32), z=pts[:, 2].astype(np.float32))
    if cls is not None:
        kw["c"] = np.asarray(cls, np.uint8)
    np.savez_compressed(p, **kw)
    return p


def _footprints(origin=(280000.0, 4150000.0)):
    ox, oy = origin
    return gpd.GeoDataFrame(geometry=[
        box(ox + 20, oy + 20, ox + 45, oy + 40),
        box(ox + 120, oy + 60, ox + 150, oy + 95),
        Polygon([(ox + 60, oy + 120), (ox + 110, oy + 120), (ox + 110, oy + 135),
                 (ox + 75, oy + 135), (ox + 75, oy + 170), (ox + 60, oy + 170)]),  # L-shape: eccentric centroid
    ], crs="EPSG:32618")


def test_surface_points_is_order_independent():
    """The whole-cloud reduction must pick the same point per cell as reducing any subset of it."""
    rng = np.random.default_rng(0)
    pts = _cloud(rng, 5000)
    a = lidar.surface_points(pts)
    b = lidar.surface_points(pts[rng.permutation(len(pts))])
    assert np.array_equal(a[np.lexsort((a[:, 1], a[:, 0]))], b[np.lexsort((b[:, 1], b[:, 0]))])


def test_index_returns_every_point_over_the_footprint(tmp_path):
    rng = np.random.default_rng(1)
    pts = _cloud(rng)
    npz = _write_npz(tmp_path, pts)
    buildings = _footprints()
    pc = lidar.PointCloud(npz, buildings, cell=1.0)

    reduced = lidar.surface_points(pts.astype(np.float32).astype(np.float64))
    from shapely import contains_xy

    for geom in buildings.geometry:
        got = pc.within(geom)
        # classify_roof clips to the footprint, so every reduced point over it has to come back --
        # even for the L-shape, whose bounding box is mostly not the building
        inside = reduced[contains_xy(geom, reduced[:, 0], reduced[:, 1])]
        assert len(inside) > 0
        assert {tuple(r) for r in inside} <= {tuple(r) for r in got}


def test_non_roof_classes_are_dropped(tmp_path):
    rng = np.random.default_rng(2)
    pts = _cloud(rng, 4000)
    cls = np.full(len(pts), 6, np.uint8)
    cls[::2] = 5  # vegetation
    pc = lidar.PointCloud(_write_npz(tmp_path, pts, cls), _footprints(), cell=1.0)
    veg = {tuple(r) for r in pts[cls == 5].astype(np.float32).astype(np.float64)}
    assert not any(tuple(r) in veg for r in pc.xyz)


def test_cache_is_reused_and_rebuilt_when_the_source_changes(tmp_path):
    rng = np.random.default_rng(3)
    npz = _write_npz(tmp_path, _cloud(rng))
    buildings = _footprints()
    cache = tmp_path / "surface.npz"

    first = lidar.surface_cache(npz, buildings, cache)
    assert cache.exists()
    mtime = cache.stat().st_mtime_ns
    again = lidar.surface_cache(npz, buildings, cache)
    assert cache.stat().st_mtime_ns == mtime  # hit: not rewritten
    assert np.array_equal(first, again)

    _write_npz(tmp_path, _cloud(np.random.default_rng(4)))
    rebuilt = lidar.surface_cache(npz, buildings, cache)
    assert cache.stat().st_mtime_ns != mtime
    assert not np.array_equal(first, rebuilt)


def test_cache_rebuilds_when_the_footprint_set_changes(tmp_path):
    rng = np.random.default_rng(5)
    npz = _write_npz(tmp_path, _cloud(rng))
    cache = tmp_path / "surface.npz"
    buildings = _footprints()

    lidar.surface_cache(npz, buildings, cache)
    grown = gpd.GeoDataFrame(geometry=list(buildings.geometry) + [box(280160, 4150160, 280190, 4150190)],
                             crs="EPSG:32618")
    assert len(lidar.surface_cache(npz, grown, cache)) > len(lidar.surface_cache(npz, buildings, cache))


def test_corrupt_cache_is_rebuilt_rather_than_raising(tmp_path):
    npz = _write_npz(tmp_path, _cloud(np.random.default_rng(6)))
    cache = tmp_path / "surface.npz"
    cache.write_bytes(b"not an npz")
    assert len(lidar.surface_cache(npz, _footprints(), cache)) > 0


def test_offsets_preserve_northings_that_absolute_float32_loses():
    """Why the npz stores offsets rather than absolute UTM coordinates."""
    true_y = np.array([4150000.1, 4155018.63, 4152345.37])
    assert np.spacing(np.float32(4155018.5)) == 0.25  # a quarter-metre lattice in y

    absolute = true_y.astype(np.float32).astype(np.float64)
    origin = 4150000.0
    offsets = (true_y - origin).astype(np.float32).astype(np.float64) + origin

    assert np.abs(absolute - true_y).max() > 0.05   # coarser than the roof planes fitted from it
    assert np.abs(offsets - true_y).max() < 0.001   # same four bytes, sub-millimetre


def test_an_offset_cloud_lands_at_the_right_absolute_coordinates(tmp_path):
    rng = np.random.default_rng(7)
    pts = _cloud(rng, 8000)
    buildings = _footprints()
    ox, oy = 280000.0, 4150000.0
    np.savez_compressed(tmp_path / "lidar_test.npz",
                        x=(pts[:, 0] - ox).astype(np.float32), y=(pts[:, 1] - oy).astype(np.float32),
                        z=pts[:, 2].astype(np.float32), origin=np.array([ox, oy], np.float64))
    pc = lidar.PointCloud(tmp_path / "lidar_test.npz", buildings, cell=1.0)

    assert len(pc.xyz) > 0
    from shapely import contains_xy

    for geom in buildings.geometry:
        got = pc.within(geom)
        inside = got[contains_xy(geom, got[:, 0], got[:, 1])]
        assert len(inside) > 0  # nothing lands here unless the origin was applied
    # and the reduction still agrees with a direct one over the same absolute points
    direct = lidar.surface_points(np.c_[(pts[:, 0] - ox).astype(np.float32).astype(np.float64) + ox,
                                        (pts[:, 1] - oy).astype(np.float32).astype(np.float64) + oy,
                                        pts[:, 2].astype(np.float32).astype(np.float64)])
    assert {tuple(r) for r in pc.xyz} <= {tuple(r) for r in direct}


def test_cloud_origin_defaults_to_zero_for_older_files(tmp_path):
    npz = _write_npz(tmp_path, _cloud(np.random.default_rng(8), 100))
    with np.load(npz) as d:
        assert lidar.cloud_origin(d) == (0.0, 0.0)
