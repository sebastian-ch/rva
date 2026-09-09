"""Build the terrain DEM from the NOAA Digital Coast 2025 City of Richmond bare-earth tiles.

    python pipeline/dem_noaa.py [--zip data/raw/J1448888.zip] [--bbox W S E N] [--res 1.0] [--force]

The Data Access Viewer delivers the 1 ft hydro-flattened DEM as a zip of GeoTIFF tiles in NAD83(HARN)
Virginia South (US survey ft, NAVD88 ft). This reprojects and averages them into the pipeline's
`data/raw/dem_<slug>.tif` (EPSG:32618, metres, float32, NaN nodata) so terrain, building `ground_z` and
bridge decks all come from the 2025 survey instead of the 2 m 3DEP export. The previous DEM is kept as
`dem_<slug>.3dep.tif`.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path

import numpy as np

from config import CRS_PROJ, DATA_RAW, DEFAULT_BBOX, bbox_slug

FT_TO_M = 0.3048006096  # US survey foot
DEFAULT_ZIP = DATA_RAW / "J1448888.zip"


def tile_paths(zip_path: Path) -> list[str]:
    names = [n for n in zipfile.ZipFile(zip_path).namelist() if n.lower().endswith(".tif")]
    if not names:
        sys.exit(f"no .tif tiles in {zip_path}")
    return [f"/vsizip/{zip_path}/{n}" for n in sorted(names)]


def build_dem(tiles: list[str], bbox_wgs84, res: float, out: Path) -> dict:
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject, transform_bounds

    west, south, east, north = bbox_wgs84
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", CRS_PROJ, west, south, east, north)
    minx, miny = np.floor(minx), np.floor(miny)
    w, h = int(np.ceil((maxx - minx) / res)), int(np.ceil((maxy - miny) / res))
    transform = from_origin(minx, miny + h * res, res, res)
    dem = np.full((h, w), np.nan, dtype=np.float32)
    used = 0
    for path in tiles:
        with rasterio.open(path) as src:
            sb = transform_bounds(src.crs, CRS_PROJ, *src.bounds)
            if sb[0] >= maxx or sb[2] <= minx or sb[1] >= maxy or sb[3] <= miny:
                continue
            part = np.full((h, w), np.nan, dtype=np.float32)
            reproject(rasterio.band(src, 1), part, dst_transform=transform, dst_crs=CRS_PROJ,
                      dst_nodata=np.nan, src_nodata=src.nodata, resampling=Resampling.average)
            fill = np.isnan(dem) & np.isfinite(part)
            dem[fill] = part[fill]
            used += 1
    if used == 0:
        sys.exit("no DEM tile intersects the bbox")
    dem *= FT_TO_M
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=CRS_PROJ,
                       transform=transform, nodata=np.nan, compress="deflate", tiled=True) as dst:
        dst.write(dem, 1)
    valid = dem[np.isfinite(dem)]
    return {"tiles": used, "width": w, "height": h, "coverage": float(np.isfinite(dem).mean()),
            "min": float(valid.min()) if valid.size else None, "max": float(valid.max()) if valid.size else None}


def compare(new: Path, old: Path) -> float | None:
    """Median (new - old) over a coarse sample grid, in metres."""
    import rasterio

    with rasterio.open(new) as a, rasterio.open(old) as b:
        xs = np.linspace(a.bounds.left + 5, a.bounds.right - 5, 60)
        ys = np.linspace(a.bounds.bottom + 5, a.bounds.top - 5, 60)
        pts = [(x, y) for x in xs for y in ys]
        za = np.array([v[0] for v in a.sample(pts)], dtype=float)
        zb = np.array([v[0] for v in b.sample(pts)], dtype=float)
        if b.nodata is not None:
            zb[zb == b.nodata] = np.nan
        ok = np.isfinite(za) & np.isfinite(zb)
        return float(np.median(za[ok] - zb[ok])) if ok.sum() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", type=Path, default=DEFAULT_ZIP)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--res", type=float, default=1.0, help="output cell size in metres")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    if not a.zip.exists():
        sys.exit(f"missing {a.zip}; order the 2025 City of Richmond DEM from https://coast.noaa.gov/dataviewer/")
    slug = bbox_slug(tuple(a.bbox))
    out = DATA_RAW / f"dem_{slug}.tif"
    backup = DATA_RAW / f"dem_{slug}.3dep.tif"
    if out.exists() and not backup.exists():
        shutil.copy2(out, backup)
        print(f"  kept previous DEM as {backup.name}")
    elif out.exists() and not a.force:
        sys.exit(f"{out.name} already built from NOAA tiles ({backup.name} exists); use --force to rebuild")
    stats = build_dem(tile_paths(a.zip), tuple(a.bbox), a.res, out)
    print(f"  DEM {stats['width']}x{stats['height']} @ {a.res} m from {stats['tiles']} tiles -> {out.name}; "
          f"coverage={stats['coverage']:.3f} z={stats['min']:.1f}..{stats['max']:.1f} m")
    if backup.exists():
        d = compare(out, backup)
        if d is not None:
            print(f"  median offset vs 3DEP DEM: {d:+.2f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
