"""Download City of Richmond open data (ArcGIS Hub feature services) for the bbox.

    python pipeline/fetch_richmond.py [--bbox W S E N] [--force]

Layers (see ATTRIBUTION.md): Addresses (points), ZoningDistricts (polygons). Written as GeoParquet in EPSG:4326 to
data/raw/richmond_<slug>/<layer>.parquet. The Esri basemap itself is not used (proprietary).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

from config import DATA_RAW, DEFAULT_BBOX, bbox_slug

ORG = "https://services1.arcgis.com/k3vhq11XkBNeeOfM/arcgis/rest/services"
LAYERS = {
    "addresses": f"{ORG}/Addresses/FeatureServer/0",
    "zoning": f"{ORG}/ZoningDistricts/FeatureServer/0",
}
PAGE = 2000


def _session() -> requests.Session:
    s = requests.Session()
    if "SSL_CERT_FILE" not in os.environ:
        try:
            import certifi
            s.verify = certifi.where()
        except ImportError:
            pass
    return s


def fetch_layer(url: str, bbox, dst: Path, force: bool = False) -> Path:
    if dst.exists() and not force:
        print(f"  [skip] {dst.name} exists")
        return dst
    west, south, east, north = bbox
    s = _session()
    frames = []
    offset = 0
    t0 = time.time()
    while True:
        params = {
            "where": "1=1", "geometry": f"{west},{south},{east},{north}", "geometryType": "esriGeometryEnvelope",
            "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "outSR": "4326",
            "f": "geojson", "resultOffset": offset, "resultRecordCount": PAGE,
        }
        r = s.get(f"{url}/query", params=params, timeout=120)
        r.raise_for_status()
        fc = r.json()
        if "error" in fc:
            raise RuntimeError(f"{url}: {fc['error']}")
        feats = fc.get("features", [])
        if feats:
            frames.append(gpd.GeoDataFrame.from_features(feats, crs="EPSG:4326"))
        if len(feats) < PAGE or not fc.get("properties", {}).get("exceededTransferLimit", len(feats) == PAGE):
            break
        offset += len(feats)
    gdf = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326") if frames else gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    dst.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(dst)
    print(f"  {dst.stem:10s} {len(gdf):6d} features  {time.time() - t0:5.1f}s")
    return dst


def fetch_richmond(bbox, force: bool = False) -> dict[str, Path]:
    out_dir = DATA_RAW / f"richmond_{bbox_slug(bbox)}"
    return {name: fetch_layer(url, bbox, out_dir / f"{name}.parquet", force) for name, url in LAYERS.items()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    fetch_richmond(tuple(a.bbox), force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
