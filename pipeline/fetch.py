"""Download raw source data for a bbox: OSM features (Overpass via osmnx) and a USGS 3DEP DEM.

Usage:
    python pipeline/fetch.py [--bbox W S E N] [--force] [--skip-dem]

Outputs (gitignored):
    data/raw/osm_<slug>/<layer>.parquet   EPSG:4326 GeoParquet, one per layer
    data/raw/dem_<slug>.tif               float32 GeoTIFF in EPSG:32618, ~2 m
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import geopandas as gpd
import osmnx as ox
import requests

from config import CRS_PROJ, DATA_RAW, DEFAULT_BBOX, bbox_slug

ox.settings.log_console = False
ox.settings.use_cache = True
ox.settings.cache_folder = str(DATA_RAW / "osmnx_cache")

# layer -> Overpass tag filter (osmnx `tags` dict). True = any value.
LAYER_TAGS: dict[str, dict] = {
    "buildings": {"building": True, "building:part": True},
    "roads": {"highway": True},
    "rail": {"railway": ["rail", "light_rail", "tram", "subway", "platform"]},
    "landuse": {
        "landuse": ["grass", "cemetery", "industrial", "railway", "recreation_ground", "forest", "commercial", "retail"],
        "leisure": ["park", "garden", "pitch", "playground"],
        "amenity": ["parking"],
        "natural": ["wood", "grassland", "scrub"],
        "place": ["square"],
    },
    "water": {"natural": ["water"], "waterway": ["river", "canal", "riverbank", "stream"], "water": True},
    "pois": {
        "natural": ["tree"],
        "highway": ["street_lamp", "bus_stop", "crossing"],
        "amenity": ["bench", "restaurant", "cafe", "bar", "pub", "fast_food", "theatre", "place_of_worship", "fountain"],
        "shop": True,
        "tourism": ["museum", "attraction", "artwork", "hotel", "information"],
        "historic": ["monument", "memorial", "statue"],
    },
}

DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"

LIST_COLS = ("nodes", "ways", "members")


def _clean_for_parquet(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """OSM frames carry list-typed columns and a MultiIndex; flatten for Parquet."""
    gdf = gdf.reset_index()
    for c in LIST_COLS:
        if c in gdf.columns:
            gdf = gdf.drop(columns=c)
    for c in gdf.columns:
        if c == gdf.geometry.name:
            continue
        if gdf[c].dtype == object:
            gdf[c] = gdf[c].map(lambda v: v if v is None or isinstance(v, str) else str(v))
    return gdf


def fetch_osm(bbox: tuple[float, float, float, float], out_dir: Path, force: bool = False) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    west, south, east, north = bbox
    written: dict[str, Path] = {}
    for layer, tags in LAYER_TAGS.items():
        dst = out_dir / f"{layer}.parquet"
        if dst.exists() and not force:
            print(f"  [skip] {layer} exists")
            written[layer] = dst
            continue
        t0 = time.time()
        try:
            gdf = ox.features.features_from_bbox(bbox=(west, south, east, north), tags=tags)
        except ox._errors.InsufficientResponseError:
            gdf = gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
        gdf = _clean_for_parquet(gdf)
        gdf.to_parquet(dst)
        print(f"  {layer:10s} {len(gdf):6d} features  {time.time() - t0:5.1f}s")
        written[layer] = dst
    return written


def fetch_dem(bbox: tuple[float, float, float, float], dst: Path, resolution_m: float = 2.0, force: bool = False) -> Path:
    if dst.exists() and not force:
        print(f"  [skip] DEM exists {dst.name}")
        return dst
    from pyproj import Transformer

    west, south, east, north = bbox
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    xs, ys = zip(tr.transform(west, south), tr.transform(east, north), tr.transform(west, north), tr.transform(east, south))
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w = int((maxx - minx) / resolution_m)
    h = int((maxy - miny) / resolution_m)
    params = {
        "bbox": f"{minx},{miny},{maxx},{maxy}",
        "bboxSR": "32618",
        "imageSR": "32618",
        "size": f"{w},{h}",
        "format": "tiff",
        "pixelType": "F32",
        "noDataInterpretation": "esriNoDataMatchAny",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    print(f"  DEM {w}x{h} px @ {resolution_m} m ...")
    r = requests.get(DEM_URL, params=params, timeout=180)
    r.raise_for_status()
    if not r.content.startswith(b"II") and not r.content.startswith(b"MM"):
        raise RuntimeError(f"3DEP did not return a TIFF: {r.content[:200]!r}")
    dst.write_bytes(r.content)
    print(f"  DEM written {dst.name} ({len(r.content) / 1e6:.1f} MB)")
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-dem", action="store_true")
    a = ap.parse_args(argv)
    bbox = tuple(a.bbox)
    slug = bbox_slug(bbox)
    print(f"bbox {bbox} slug {slug}")
    print("OSM:")
    fetch_osm(bbox, DATA_RAW / f"osm_{slug}", force=a.force)
    if not a.skip_dem:
        print("DEM:")
        fetch_dem(bbox, DATA_RAW / f"dem_{slug}.tif", force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
