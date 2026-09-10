"""Download City of Richmond ArcGIS feature services for the bbox.

    python pipeline/fetch_richmond.py [--bbox W S E N] [--force]

Layers (see ATTRIBUTION.md): addresses, zoning, trees, and Structures buildings/decks. Written as GeoParquet
in EPSG:4326 to data/raw/richmond_<slug>/<layer>.parquet. The Esri basemap itself is not used.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
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
    "trees": f"{ORG}/TreeInventoryLive_ViewUFWebPage/FeatureServer/0",
    "structures": f"{ORG}/Structures/FeatureServer/0",
}
LAYER_WHERE = {"structures": "Subtype IN (1,3)"}
LAYER_FIELDS = {"structures": "OBJECTID,Subtype,FIPS,PermitID,CreatedDate,EditDate"}
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


def _write_metadata(s: requests.Session, url: str, dst: Path) -> None:
    response = s.get(url, params={"f": "json"}, timeout=120)
    response.raise_for_status()
    info = response.json()
    dst.write_text(json.dumps({
        "url": url,
        "accessed_utc": datetime.now(timezone.utc).isoformat(),
        "description": info.get("description"),
        "copyrightText": info.get("copyrightText"),
        "editingInfo": info.get("editingInfo"),
        "fields": [{k: field.get(k) for k in ("name", "alias", "type")} for field in info.get("fields", [])],
    }, indent=2))


def fetch_layer(url: str, bbox, dst: Path, force: bool = False,
                where: str = "1=1", out_fields: str = "*") -> Path:
    metadata_dst = dst.parent / f"{dst.stem}.metadata.json"
    if dst.exists() and not force:
        if not metadata_dst.exists():
            _write_metadata(_session(), url, metadata_dst)
        print(f"  [skip] {dst.name} exists")
        return dst
    west, south, east, north = bbox
    s = _session()
    frames = []
    offset = 0
    t0 = time.time()
    while True:
        params = {
            "where": where, "geometry": f"{west},{south},{east},{north}", "geometryType": "esriGeometryEnvelope",
            "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": out_fields, "outSR": "4326",
            "f": "geojson", "resultOffset": offset, "resultRecordCount": PAGE,
            "orderByFields": "OBJECTID",
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
    _write_metadata(s, url, metadata_dst)
    print(f"  {dst.stem:10s} {len(gdf):6d} features  {time.time() - t0:5.1f}s")
    return dst


def fetch_richmond(bbox, force: bool = False, layers: list[str] | None = None) -> dict[str, Path]:
    out_dir = DATA_RAW / f"richmond_{bbox_slug(bbox)}"
    selected = layers or list(LAYERS)
    return {name: fetch_layer(LAYERS[name], bbox, out_dir / f"{name}.parquet", force,
                              LAYER_WHERE.get(name, "1=1"), LAYER_FIELDS.get(name, "*"))
            for name in selected}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--layer", action="append", choices=sorted(LAYERS), help="fetch only this layer; repeatable")
    a = ap.parse_args(argv)
    fetch_richmond(tuple(a.bbox), force=a.force, layers=a.layer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
