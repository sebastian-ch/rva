"""Fetch LiDAR (Entwine Point Tiles) for the bbox and build a normalized DSM.

    python pipeline/fetch_lidar.py [--source noaa2025|usgs2014] [--bbox W S E N] [--max-depth N] [--dry-run] [--force]

Sources (see SOURCES): the default is the 2025 City of Richmond survey (Sanborn, flown 2025-02-14..03-01,
0.35 m pulse spacing, classified LAS 1.4) served by NOAA Digital Coast as EPT in EPSG:3748 + NAVD88 m;
`usgs2014` is the older USGS 3DEP VA_Sandy_2014 cloud (EPSG:3857, ellipsoid heights).

Outputs (gitignored):
    data/raw/ept_<source>_<slug>/<key>.laz  cached EPT nodes (usgs2014 keeps the legacy ept_<slug>/ dir)
    data/raw/lidar_<slug>.npz           x, y, z (EPSG:32618, meters), classification
    data/raw/ndsm.tif                   1 m normalized DSM (DSM - 3DEP DEM), EPSG:32618

EPT layout: bounds is a cube; node key d-x-y-z covers the cube split 2**d ways per axis. Every level holds a
decimated subset of points, so --max-depth trades density for download size.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

from config import CRS_PROJ, DATA_RAW, DEFAULT_BBOX, bbox_slug
from lidar import cloud_origin

SOURCES = {
    # NOAA OCM InPort 80312, "2025 City of Richmond Lidar" (CC0). Depth 8 ~ 10 pts/m2 over the default bbox
    # (117 M points); depth 9 is the full 32 pts/m2 cloud and needs ~6 GB RAM.
    "noaa2025": {"root": "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/14835/",
                 "crs": "EPSG:3748", "max_depth": 8},
    "usgs2014": {"root": "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_VA_Sandy_2014_LAS_2015/",
                 "crs": "EPSG:3857", "max_depth": 13},
}
DEFAULT_SOURCE = "noaa2025"
EPT_ROOT = SOURCES[DEFAULT_SOURCE]["root"]
NDSM_PATH = DATA_RAW / "ndsm.tif"
NOISE_CLASSES = (7, 18)
NON_SURFACE_CLASSES = (3, 4, 5, 9)  # vegetation and water: excluded from the DSM so canopies do not inflate building heights
CELL = 1.0  # m

_session = requests.Session()


def _get_json(url: str) -> dict:
    r = _session.get(url, timeout=60)
    r.raise_for_status()
    return r.json()


def node_bounds(key: str, bounds: list[float]) -> tuple[float, float, float, float]:
    """XY extent of an EPT node key 'd-x-y-z' in the EPT CRS."""
    d, x, y, _z = (int(v) for v in key.split("-"))
    size = (bounds[3] - bounds[0]) / (2**d)
    return bounds[0] + x * size, bounds[1] + y * size, bounds[0] + (x + 1) * size, bounds[1] + (y + 1) * size


def _intersects(a, b) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def select_nodes(bbox_ept, bounds: list[float], max_depth: int, root_hier: dict, fetch_hier) -> dict[str, int]:
    """Walk the hierarchy; return {key: point_count} for nodes intersecting bbox up to max_depth."""
    out: dict[str, int] = {}
    hier = dict(root_hier)
    stack = ["0-0-0-0"]
    while stack:
        key = stack.pop()
        if key not in hier:
            continue
        count = hier[key]
        if count == -1:  # subtree lives in its own hierarchy file
            hier.update(fetch_hier(key))
            count = hier.get(key, 0)
        if count <= 0 or not _intersects(node_bounds(key, bounds), bbox_ept):
            continue
        out[key] = count
        d, x, y, z = (int(v) for v in key.split("-"))
        if d >= max_depth:
            continue
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    stack.append(f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}")
    return out


def ept_crs(ept_json: dict, fallback: str) -> str:
    """CRS string from an ept.json `srs` block (authority + horizontal code), else `fallback`."""
    srs = ept_json.get("srs") or {}
    if srs.get("authority") and srs.get("horizontal"):
        return f"{srs['authority']}:{srs['horizontal']}"
    return fallback


def download_nodes(keys: list[str], cache: Path, force: bool = False, root: str = EPT_ROOT) -> list[Path]:
    cache.mkdir(parents=True, exist_ok=True)

    def one(key: str) -> Path:
        dst = cache / f"{key}.laz"
        if dst.exists() and dst.stat().st_size > 0 and not force:
            return dst
        for attempt in range(3):
            try:
                r = _session.get(f"{root}ept-data/{key}.laz", timeout=300)
                r.raise_for_status()
                dst.write_bytes(r.content)
                return dst
            except requests.RequestException as exc:
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))
        return dst

    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(one, keys))


def read_points(paths: list[Path], bbox_proj, src_crs: str = "EPSG:3857") -> dict[str, np.ndarray]:
    """Read LAZ nodes, drop noise, reproject src_crs -> CRS_PROJ, clip to bbox."""
    import laspy
    from pyproj import Transformer

    tr = Transformer.from_crs(src_crs, CRS_PROJ, always_xy=True)
    xs, ys, zs, cs = [], [], [], []
    minx, miny, maxx, maxy = bbox_proj
    # Store coordinates as offsets from this origin. A UTM northing near 4.15e6 held in float32 quantizes
    # to a 0.25 m lattice -- coarser than the roof planes fitted from these points, and anisotropic, since
    # eastings near 2.8e5 keep ~0.03 m. An offset under ~10 km resolves to well under a millimetre in the
    # same four bytes. See pipeline/tests/test_lidar_index.py.
    ox, oy = float(np.floor(minx)), float(np.floor(miny))
    for p in paths:
        try:
            las = laspy.read(p)
        except Exception as exc:  # corrupt cache entry
            print(f"  [warn] {p.name}: {exc}")
            continue
        cls = np.asarray(las.classification, dtype=np.uint8)
        keep = ~np.isin(cls, NOISE_CLASSES)
        x, y = tr.transform(np.asarray(las.x)[keep], np.asarray(las.y)[keep])
        z = np.asarray(las.z)[keep]
        m = (x >= minx) & (x < maxx) & (y >= miny) & (y < maxy)
        xs.append((x[m] - ox).astype(np.float32)); ys.append((y[m] - oy).astype(np.float32))
        zs.append(z[m].astype(np.float32)); cs.append(cls[keep][m])
    origin = np.array([ox, oy], np.float64)
    if not xs:
        return {"x": np.zeros(0, np.float32), "y": np.zeros(0, np.float32), "z": np.zeros(0, np.float32),
                "c": np.zeros(0, np.uint8), "origin": origin}
    return {"x": np.concatenate(xs), "y": np.concatenate(ys), "z": np.concatenate(zs),
            "c": np.concatenate(cs), "origin": origin}


def detect_feet(z_ground_sample: np.ndarray, dem_sample: np.ndarray) -> bool:
    """True if LiDAR Z looks like US survey feet relative to the DEM (meters)."""
    ok = np.isfinite(dem_sample) & (dem_sample > 1.0)
    if ok.sum() < 50:
        return False
    ratio = np.median(z_ground_sample[ok] / dem_sample[ok])
    return abs(ratio - 3.2808) < abs(ratio - 1.0)


def vertical_calibration(z_ground: np.ndarray, dem: np.ndarray) -> tuple[float, float]:
    """Return (scale, offset) so that z * scale + offset matches the DEM datum.

    Handles feet vs meters and a constant datum shift (e.g. ellipsoidal vs NAVD88 heights: the USGS EPT
    clouds reprojected to EPSG:3857 carry WGS84 ellipsoid heights, ~33 m below NAVD88 around Richmond).
    """
    ok = np.isfinite(dem) & np.isfinite(z_ground)
    if ok.sum() < 50:
        return 1.0, 0.0
    z, d = z_ground[ok], dem[ok]
    # feet if the spread of z is ~3.28x the spread of the DEM
    sz, sd = np.percentile(z, 90) - np.percentile(z, 10), np.percentile(d, 90) - np.percentile(d, 10)
    scale = 0.3048 if sd > 1.0 and abs(sz / sd - 3.2808) < abs(sz / sd - 1.0) else 1.0
    offset = float(np.median(d - z * scale))
    if abs(offset) < 0.5:
        offset = 0.0
    return scale, offset


def build_ndsm(pts: dict[str, np.ndarray], dem_path: Path, bbox_proj, out: Path) -> dict:
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject
    from scipy.ndimage import maximum_filter

    minx, miny, maxx, maxy = bbox_proj
    minx, miny = np.floor(minx), np.floor(miny)
    w, h = int(np.ceil(maxx - minx) / CELL), int(np.ceil(maxy - miny) / CELL)
    transform = from_origin(minx, miny + h * CELL, CELL, CELL)

    # DEM -> same grid
    dem = np.full((h, w), np.nan, dtype=np.float32)
    with rasterio.open(dem_path) as src:
        reproject(rasterio.band(src, 1), dem, dst_transform=transform, dst_crs=CRS_PROJ, dst_nodata=np.nan,
                  src_nodata=src.nodata, resampling=Resampling.bilinear)

    ox, oy = cloud_origin(pts)
    col = ((pts["x"] + (ox - minx)) / CELL).astype(np.int64)
    row = (((miny + h * CELL) - (pts["y"] + oy)) / CELL).astype(np.int64)
    ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
    col, row, z = col[ok], row[ok], pts["z"][ok].astype(np.float64)

    # vertical calibration against the DEM: ground-classified points (class 2) if present, else per-cell minima
    ground = pts["c"][ok] == 2
    if ground.sum() > 1000:
        gz, gd = z[ground], dem[row[ground], col[ground]]
    else:
        cell = row * w + col
        order = np.lexsort((z, cell))
        first = np.r_[True, cell[order][1:] != cell[order][:-1]]
        sel = order[first]
        gz, gd = z[sel], dem[row[sel], col[sel]]
    scale, offset = vertical_calibration(gz, gd)
    z = z * scale + offset
    feet = scale != 1.0

    dsm = np.full((h, w), -np.inf, dtype=np.float64)
    surf = ~np.isin(pts["c"][ok], NON_SURFACE_CLASSES)
    np.maximum.at(dsm, (row[surf], col[surf]), z[surf])
    dsm[~np.isfinite(dsm)] = np.nan
    # fill single-cell gaps once with a 3x3 max
    filled = maximum_filter(np.nan_to_num(dsm, nan=-1e9), size=3)
    gap = np.isnan(dsm) & (filled > -1e8)
    dsm[gap] = filled[gap]

    ndsm = np.clip(dsm - dem, 0, 300).astype(np.float32)
    ndsm[np.isnan(dsm) | np.isnan(dem)] = np.nan
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=CRS_PROJ,
                       transform=transform, nodata=np.nan, compress="deflate", tiled=True) as dst:
        dst.write(ndsm, 1)
    valid = ndsm[np.isfinite(ndsm)]
    return {"width": w, "height": h, "feet": bool(feet), "scale": scale, "offset": offset, "coverage": float(np.isfinite(ndsm).mean()),
            "ndsm_p50": float(np.percentile(valid, 50)) if valid.size else None,
            "ndsm_p99": float(np.percentile(valid, 99)) if valid.size else None}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--source", choices=sorted(SOURCES), default=DEFAULT_SOURCE)
    ap.add_argument("--max-depth", type=int, default=None, help="EPT depth cap (default per source)")
    ap.add_argument("--dry-run", action="store_true", help="list nodes and point counts only")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    from pyproj import Transformer

    src = SOURCES[a.source]
    root = src["root"]
    max_depth = src["max_depth"] if a.max_depth is None else a.max_depth
    bbox = tuple(a.bbox)
    slug = bbox_slug(bbox)
    west, south, east, north = bbox
    ept = _get_json(root + "ept.json")
    crs = ept_crs(ept, src["crs"])
    to_ept = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_proj = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    ex, ey = zip(to_ept.transform(west, south), to_ept.transform(east, north))
    bbox_ept = (min(ex), min(ey), max(ex), max(ey))
    px, py = zip(*[to_proj.transform(x, y) for x, y in ((west, south), (east, south), (east, north), (west, north))])
    bbox_proj = (min(px), min(py), max(px), max(py))

    root_hier = _get_json(root + "ept-hierarchy/0-0-0-0.json")
    nodes = select_nodes(bbox_ept, ept["bounds"], max_depth, root_hier,
                         lambda k: _get_json(f"{root}ept-hierarchy/{k}.json"))
    total = sum(nodes.values())
    area_m2 = (bbox_proj[2] - bbox_proj[0]) * (bbox_proj[3] - bbox_proj[1])
    by_depth: dict[int, int] = {}
    for k, c in nodes.items():
        by_depth[int(k.split("-")[0])] = by_depth.get(int(k.split("-")[0]), 0) + c
    print(f"{a.source} ({crs}, depth<={max_depth}): {len(nodes)} nodes, {total / 1e6:.1f} M points (upper bound; nodes overhang the bbox), "
          f"~{total / area_m2:.1f} pts/m2 over {area_m2 / 1e6:.1f} km2")
    print("  points by depth:", {d: f"{c / 1e6:.1f}M" for d, c in sorted(by_depth.items())})
    if a.dry_run:
        return 0

    t0 = time.time()
    cache = DATA_RAW / f"ept_{slug}" if a.source == "usgs2014" else DATA_RAW / f"ept_{a.source}_{slug}"
    paths = download_nodes(sorted(nodes), cache, force=a.force, root=root)
    size = sum(p.stat().st_size for p in paths) / 1e6
    print(f"  downloaded/cached {len(paths)} nodes, {size:.0f} MB, {time.time() - t0:.0f}s")

    t0 = time.time()
    pts = read_points(paths, bbox_proj, crs)
    print(f"  {len(pts['x']) / 1e6:.1f} M points in bbox after clip/noise filter, {time.time() - t0:.0f}s")
    dem_path = DATA_RAW / f"dem_{slug}.tif"
    if not dem_path.exists():
        sys.exit(f"DEM missing: {dem_path}; run pipeline/fetch.py first")
    stats = build_ndsm(pts, dem_path, bbox_proj, NDSM_PATH)
    pts["z"] = (pts["z"] * stats["scale"] + stats["offset"]).astype(np.float32)
    np.savez_compressed(DATA_RAW / f"lidar_{slug}.npz", **pts)
    print(f"  nDSM {stats['width']}x{stats['height']} @ {CELL} m -> {NDSM_PATH.name}; "
          f"scale={stats['scale']} offset={stats['offset']:+.2f} coverage={stats['coverage']:.2f} p50={stats['ndsm_p50']} p99={stats['ndsm_p99']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
