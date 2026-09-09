"""Clip the VGIN / City of Richmond building-footprint shapefile to the bbox (third footprint source).

    python pipeline/fetch_vgin_footprints.py --shp ~/Downloads/Richmond_Building_Footprints.shp [--bbox W S E N]

Writes data/raw/vgin_<slug>.parquet (EPSG:4326). The layer has no usable attributes (height/storey columns are
empty), so it is used only to add footprints that OSM lacks; heights then come from LiDAR / zoning.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import box

from config import DATA_RAW, DEFAULT_BBOX, bbox_slug


def vgin_path(bbox) -> Path:
    return DATA_RAW / f"vgin_{bbox_slug(bbox)}.parquet"


def fetch_vgin(shp: Path, bbox, force: bool = False) -> Path:
    dst = vgin_path(bbox)
    if dst.exists() and not force:
        print(f"  [skip] {dst.name} exists")
        return dst
    west, south, east, north = bbox
    g = gpd.read_file(shp, bbox=(west, south, east, north))
    g = g.to_crs("EPSG:4326")
    g = g[g.geometry.intersects(box(west, south, east, north))]
    keep = [c for c in ("OBJECTID", "BLDGHEIGHT", "NUMSTORIES", "LASTUPDATE", "DATASOURCE", "geometry") if c in g]
    g = g[keep].reset_index(drop=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    g.to_parquet(dst)
    print(f"  wrote {dst.name}: {len(g)} footprints")
    return dst


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shp", required=True, type=Path)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    fetch_vgin(a.shp.expanduser(), tuple(a.bbox), force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
