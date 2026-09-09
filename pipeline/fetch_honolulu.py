"""Download the CCH building and coastline subsets. Run with ISO_REGION=honolulu.

    ISO_REGION=honolulu .venv/bin/python pipeline/fetch_honolulu.py [--force]
"""
from __future__ import annotations

import argparse
import json

import geopandas as gpd
import requests

from config import DATA_RAW, DEFAULT_BBOX, REGION, bbox_slug

BASE = "https://services.arcgis.com/tNJpAOha4mODLkXz/arcgis/rest/services"
BUILDINGS_URL = f"{BASE}/Structures_Facilities/FeatureServer/0"
COAST_URL = f"{BASE}/Coast_Poly/FeatureServer/3"


def query(url: str, **params):
    response = (requests.post(url, data=params, timeout=180) if url.endswith("/query")
                else requests.get(url, params=params, timeout=180))
    response.raise_for_status()
    data = response.json()
    if "error" in data:
        raise RuntimeError(f"ArcGIS {url}: {data['error']}")
    return data


def download_layer(url, bbox, dst, fields="*", force=False):
    if dst.exists() and not force:
        print(f"  [skip] {dst.name}", flush=True)
        return
    # Snapshot object IDs first; offset paging can silently truncate or shift records.
    selection = query(f"{url}/query", f="json", where="1=1", geometry=",".join(map(str, bbox)),
                      geometryType="esriGeometryEnvelope", inSR=4326,
                      spatialRel="esriSpatialRelIntersects", returnIdsOnly="true")
    ids = sorted(selection.get("objectIds") or [])
    features = []
    for start in range(0, len(ids), 400):
        batch = query(f"{url}/query", f="geojson", objectIds=",".join(map(str, ids[start:start + 400])),
                      outFields=fields, outSR=4326, returnGeometry="true")
        if batch.get("exceededTransferLimit"):
            raise RuntimeError("ArcGIS truncated a batch")
        features.extend(batch["features"])
        print(f"  {dst.stem}: {len(features)}/{len(ids)}", flush=True)
    if len(features) != len(ids) or not features:
        raise RuntimeError(f"Incomplete/empty layer: expected {len(ids)}, got {len(features)}")
    frame = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    dst.parent.mkdir(parents=True, exist_ok=True)
    temporary = dst.with_suffix(".tmp.parquet")
    frame.to_parquet(temporary)
    temporary.replace(dst)
    dst.with_suffix(".metadata.json").write_text(json.dumps(query(url, f="json"), indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    if REGION != "honolulu":
        ap.error("set ISO_REGION=honolulu to keep regional data isolated")
    slug = bbox_slug(DEFAULT_BBOX)
    download_layer(BUILDINGS_URL, DEFAULT_BBOX, DATA_RAW / f"cch_{slug}.parquet",
                   "objectid,structurename,maxht_m,nga_height,gis_height,elevationbase,elevationmax", args.force)
    # The service encodes sea as an offshore rectangle with island holes.
    download_layer(COAST_URL, DEFAULT_BBOX, DATA_RAW / f"coast_{slug}.parquet", force=args.force)
    from shapely.geometry import Point
    coast = gpd.read_parquet(DATA_RAW / f"coast_{slug}.parquet").to_crs("EPSG:4326").geometry.union_all()
    if coast.contains(Point(-157.805, 21.263)) or not coast.contains(Point(-157.82, 21.253)):
        raise RuntimeError("Coast_Poly no longer represents the expected ocean mask")


if __name__ == "__main__":
    main()
