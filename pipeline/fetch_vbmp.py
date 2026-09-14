"""Fetch VGIN VBMP true-color imagery for Richmond ground-cover extraction.

The statewide Most Recent Imagery service is sharper and leaf-off in Richmond, which makes pavement,
soil and lawn boundaries cleaner than NAIP. It has no NIR band, so groundcover.py combines this RGB
with the existing four-band NAIP raster rather than replacing it.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import requests

from config import CRS_PROJ, DATA_RAW, DEFAULT_BBOX, bbox_slug
from fetch_naip import MAX_TILE_PX, plan_tiles

SERVICE = "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VBMP_Imagery/MostRecentImagery_WGS/MapServer"
DEFAULT_RES_M = 0.6  # sufficient for the final 3 m classification grid


def _export(bounds: tuple[float, float, float, float], size: tuple[int, int]) -> bytes:
    epsg = CRS_PROJ.split(":")[-1]
    params = {
        "bbox": ",".join(str(v) for v in bounds), "bboxSR": epsg, "imageSR": epsg,
        "size": f"{size[0]},{size[1]}", "format": "png32", "transparent": "false", "f": "json",
    }
    generated = requests.get(f"{SERVICE}/export", params=params, timeout=300)
    generated.raise_for_status()
    meta = generated.json()
    if not meta.get("href"):
        raise RuntimeError(f"VBMP export response has no href: {meta!r}")
    image = requests.get(meta["href"], timeout=300)
    image.raise_for_status()
    if not image.content.startswith(b"\x89PNG"):
        raise RuntimeError(f"VBMP export is not PNG: {image.content[:100]!r}")
    return image.content


def fetch_vbmp(bbox: tuple[float, float, float, float], dst: Path, resolution_m: float = DEFAULT_RES_M,
               force: bool = False, dry_run: bool = False) -> Path:
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    from rasterio.warp import transform_bounds

    if dst.exists() and not force and not dry_run:
        print(f"  [skip] VBMP imagery exists {dst.name}")
        return dst
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", CRS_PROJ, *bbox)
    width = int(np.ceil((maxx - minx) / resolution_m))
    height = int(np.ceil((maxy - miny) / resolution_m))
    transform = from_origin(minx, maxy, resolution_m, resolution_m)
    windows = plan_tiles(width, height, MAX_TILE_PX)
    print(f"  VBMP RGB {width}x{height} px @ {resolution_m} m in {len(windows)} request(s)")
    if dry_run:
        return dst

    tmp = dst.with_suffix(".tmp.tif")
    profile = dict(driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=CRS_PROJ,
                   transform=transform, compress="deflate", tiled=True, blockxsize=512, blockysize=512,
                   photometric="RGB")
    with rasterio.open(tmp, "w", **profile) as out:
        for n, (col, row, w, h) in enumerate(windows, 1):
            west, north = transform * (col, row)
            east, south = transform * (col + w, row + h)
            raw = _export((west, south, east, north), (w, h))
            with MemoryFile(raw) as mem, mem.open() as src:
                arr = src.read()
            out.write(arr[:3, :h, :w].astype("uint8"), window=rasterio.windows.Window(col, row, w, h))
            print(f"    tile {n}/{len(windows)} {w}x{h} px")
    tmp.replace(dst)
    metadata = {
        "source": SERVICE, "description": "VGIN VBMP Most Recent Imagery, true-color RGB",
        "resolution_m": resolution_m, "retrieved": date.today().isoformat(),
        "copyright": "Virginia Geographic Information Network (VGIN)",
    }
    dst.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"  VBMP imagery written {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX)
    ap.add_argument("--resolution", type=float, default=DEFAULT_RES_M)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    bbox = tuple(a.bbox)
    dst = DATA_RAW / f"vbmp_{bbox_slug(bbox)}.tif"
    DATA_RAW.mkdir(parents=True, exist_ok=True)
    fetch_vbmp(bbox, dst, a.resolution, a.force, a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
