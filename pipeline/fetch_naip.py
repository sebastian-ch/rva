"""NAIP orthoimagery -> data/raw/ortho_<slug>.tif, the colour source for building roofs.

NAIP (USDA National Agriculture Imagery Program) is public domain, 0.6 m, and 4-band (R, G, B, NIR)
for recent Virginia flights. The NIR band is what lets `ortho.py` tell a tree crown from a roof, so
prefer a service that serves it.

The USGS image server caps a single export at a few thousand pixels a side, and the Richmond bbox at
0.6 m is ~10000 x 9500, so the export is tiled on the destination pixel grid and mosaicked. Every tile
request is derived from the destination transform, so tiles land on exact pixel boundaries with no
resampling seam.

    .venv/bin/python pipeline/fetch_naip.py [--bbox W S E N] [--resolution 0.6] [--dry-run] [--force]

Another ArcGIS ImageServer can be substituted with `--service` (VGIN's VBMP imagery is ~6 in and
sharper, but check its terms before deriving a dataset from it; NAIP has no such question).
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import requests

from config import CRS_PROJ, DATA_RAW, DEFAULT_BBOX, bbox_slug

NAIP_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"
MAX_TILE_PX = 3500      # comfortably inside the server's export cap
DEFAULT_RES_M = 0.6     # NAIP native ground sample distance
RETRIES = 3


def plan_tiles(width: int, height: int, tile_px: int = MAX_TILE_PX) -> list[tuple[int, int, int, int]]:
    """Destination pixel windows (col_off, row_off, w, h) covering the raster."""
    out = []
    for row in range(0, height, tile_px):
        for col in range(0, width, tile_px):
            out.append((col, row, min(tile_px, width - col), min(tile_px, height - row)))
    return out


def _export(service: str, bounds: tuple[float, float, float, float], size: tuple[int, int]) -> bytes:
    """One exportImage call, retried: the image servers answer large exports with JSON errors now and then."""
    minx, miny, maxx, maxy = bounds
    epsg = CRS_PROJ.split(":")[-1]
    params = {
        "bbox": f"{minx},{miny},{maxx},{maxy}",
        "bboxSR": epsg,
        "imageSR": epsg,
        "size": f"{size[0]},{size[1]}",
        "format": "tiff",
        "pixelType": "U8",
        "bandIds": "0,1,2,3",
        "interpolation": "RSP_NearestNeighbor",
        "noDataInterpretation": "esriNoDataMatchAny",
        "f": "image",
    }
    last = b""
    for attempt in range(RETRIES):
        r = requests.get(service, params=params, timeout=300)
        r.raise_for_status()
        if r.content[:2] in (b"II", b"MM"):
            return r.content
        last = r.content[:200]
        print(f"  [retry {attempt + 1}] imagery server returned non-TIFF: {last!r}")
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"imagery server did not return a TIFF after {RETRIES} attempts: {last!r}")


def fetch_ortho(bbox: tuple[float, float, float, float], dst: Path, resolution_m: float = DEFAULT_RES_M,
                service: str = NAIP_URL, force: bool = False, dry_run: bool = False) -> Path:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    from rasterio.warp import transform_bounds

    if dst.exists() and not force and not dry_run:
        print(f"  [skip] ortho exists {dst.name}")
        return dst

    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", CRS_PROJ, *bbox)
    width = int(np.ceil((maxx - minx) / resolution_m))
    height = int(np.ceil((maxy - miny) / resolution_m))
    transform = from_origin(minx, maxy, resolution_m, resolution_m)
    windows = plan_tiles(width, height)
    print(f"  ortho {width}x{height} px @ {resolution_m} m in {len(windows)} request(s)"
          f"  (~{width * height * 4 / 1e6:.0f} MB uncompressed)")
    if dry_run:
        return dst

    tmp = dst.with_suffix(".tmp.tif")
    profile = dict(driver="GTiff", width=width, height=height, count=4, dtype="uint8", crs=CRS_PROJ,
                   transform=transform, compress="deflate", tiled=True, blockxsize=512, blockysize=512,
                   photometric="RGB")
    with rasterio.open(tmp, "w", **profile) as out:
        for n, (col, row, w, h) in enumerate(windows, 1):
            west, north = transform * (col, row)
            east, south = transform * (col + w, row + h)
            raw = _export(service, (west, south, east, north), (w, h))
            with MemoryFile(raw) as mem, mem.open() as src:
                arr = src.read()
            if arr.shape[0] < 4:    # a 3-band service: pad NIR with zeros so the profile stays fixed
                arr = np.concatenate([arr, np.zeros((4 - arr.shape[0], *arr.shape[1:]), arr.dtype)])
            out.write(arr[:4, :h, :w].astype("uint8"), window=rasterio.windows.Window(col, row, w, h))
            print(f"    tile {n}/{len(windows)} {w}x{h} px")
    tmp.replace(dst)
    print(f"  ortho written {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--resolution", type=float, default=DEFAULT_RES_M, help="metres per pixel (default 0.6, NAIP native)")
    ap.add_argument("--service", default=NAIP_URL, help="ArcGIS ImageServer exportImage endpoint")
    ap.add_argument("--dry-run", action="store_true", help="print the request plan and exit")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    bbox = tuple(a.bbox)
    slug = bbox_slug(bbox)
    print(f"bbox {bbox} slug {slug}")
    DATA_RAW.mkdir(parents=True, exist_ok=True)
    fetch_ortho(bbox, DATA_RAW / f"ortho_{slug}.tif", resolution_m=a.resolution, service=a.service,
                force=a.force, dry_run=a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
