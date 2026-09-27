"""Download Mapillary map-feature detections (street furniture and traffic signs) for the bbox.

    MAPILLARY_TOKEN='MLY|...' python pipeline/fetch_mapillary.py [--bbox W S E N] [--force]

The token is a Mapillary client access token (mapillary.com/dashboard/developers). It is read from MAPILLARY_TOKEN,
else ~/.config/mapillary/token, and sent in the Authorization header so it never appears in a URL or log.

Every map feature in the bbox is kept; `pipeline/mapillary.py` picks the classes the renderer draws. The Graph API
`map_features` endpoint answers one page per bbox and silently thins large ones: in 2026-09 a 0.005 deg cell returned
1,611 of 2,736 features and a 0.0025 x 0.002 deg cell 694 of 706, with no paging offered. At 0.0025 deg (~220 x 280 m)
a cell matched the union of its sub-cells exactly, downtown and in the Fan, so the bbox is walked at that size and a
cell that still comes back with FULL_AT features is split into quarters. Written as GeoParquet in EPSG:4326 to data/raw/mapillary_<slug>.parquet.
Detections are CC BY-SA 4.0 (Mapillary contributors); see ATTRIBUTION.md.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import os
import sys
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import Point

from config import DATA_RAW, DEFAULT_BBOX, bbox_slug

URL = "https://graph.mapillary.com/map_features"
FIELDS = "id,object_value,geometry,first_seen_at,last_seen_at"
LIMIT = 2000
FULL_AT = 1000          # a cell returning this many features may be truncated; split it
CELL_DEG = 0.0025
MIN_CELL_DEG = 0.0003
WORKERS = 8
TOKEN_FILE = Path.home() / ".config" / "mapillary" / "token"


def token() -> str:
    value = os.environ.get("MAPILLARY_TOKEN", "").strip()
    if not value and TOKEN_FILE.exists():
        value = TOKEN_FILE.read_text().strip()
    if not value:
        sys.exit(f"No Mapillary token: set MAPILLARY_TOKEN or write it to {TOKEN_FILE}")
    return value


def _get(session: requests.Session, params: dict, url: str = URL) -> dict:
    for attempt in range(4):
        r = session.get(url, params=params, timeout=60)
        if r.status_code in (401, 403):
            sys.exit(f"Mapillary refused the token ({r.status_code}): {r.text[:200]}")
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(2 ** attempt * 5)
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    raise RuntimeError(f"Mapillary kept failing: {r.status_code}")


def _cell(session: requests.Session, bbox: tuple) -> list[dict]:
    """Every feature in one cell, following `paging.next` if the API offers it."""
    payload = _get(session, {"fields": FIELDS, "bbox": ",".join(f"{v:.6f}" for v in bbox), "limit": LIMIT})
    rows = list(payload.get("data", []))
    while (nxt := (payload.get("paging") or {}).get("next")):
        payload = _get(session, {}, url=nxt)
        rows += payload.get("data", [])
    return rows


def grid(bbox: tuple, step: float = CELL_DEG) -> list[tuple]:
    w, s, e, n = bbox
    cells = []
    y = s
    while y < n - 1e-9:
        x = w
        while x < e - 1e-9:
            cells.append((x, y, min(x + step, e), min(y + step, n)))
            x += step
        y += step
    return cells


def quarters(cell: tuple) -> list[tuple]:
    w, s, e, n = cell
    mx, my = (w + e) / 2, (s + n) / 2
    return [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]


def fetch_features(session: requests.Session, bbox: tuple) -> list[dict]:
    """Walk the grid, splitting full cells. Features on a cell edge come back twice; dedupe by id."""
    todo = grid(bbox, CELL_DEG)
    seen: dict[str, dict] = {}
    calls = 0
    with ThreadPoolExecutor(WORKERS) as pool:
        while todo:
            wave, todo = todo, []
            for cell, rows in zip(wave, pool.map(lambda c: _cell(session, c), wave)):
                calls += 1
                if len(rows) >= FULL_AT and cell[2] - cell[0] > MIN_CELL_DEG:
                    todo += quarters(cell)
                    continue
                if len(rows) >= FULL_AT:
                    print(f"  warning: cell {cell} still returns {len(rows)} features at the minimum size")
                for row in rows:
                    seen[str(row["id"])] = row
            print(f"  {calls} requests, {len(seen)} features, {len(todo)} cells to split")
    return list(seen.values())


def _date(value) -> str | None:
    """Mapillary timestamps arrive as epoch milliseconds or ISO strings; store ISO dates."""
    if value is None:
        return None
    ts = pd.to_datetime(value, unit="ms", utc=True) if isinstance(value, (int, float)) else pd.to_datetime(value, utc=True)
    return ts.strftime("%Y-%m-%d")


def to_frame(rows: list[dict]) -> gpd.GeoDataFrame:
    keep = [r for r in rows if (r.get("geometry") or {}).get("type") == "Point" and r.get("object_value")]
    return gpd.GeoDataFrame({
        "id": [str(r["id"]) for r in keep],
        "value": [r["object_value"] for r in keep],
        "first_seen": [_date(r.get("first_seen_at")) for r in keep],
        "last_seen": [_date(r.get("last_seen_at")) for r in keep],
    }, geometry=[Point(r["geometry"]["coordinates"][:2]) for r in keep], crs="EPSG:4326")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX, metavar=("W", "S", "E", "N"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    bbox = tuple(args.bbox)
    dst = DATA_RAW / f"mapillary_{bbox_slug(bbox)}.parquet"
    if dst.exists() and not args.force:
        print(f"{dst} exists; --force to refetch")
        return
    session = requests.Session()
    session.headers["Authorization"] = f"OAuth {token()}"
    frame = to_frame(fetch_features(session, bbox))
    DATA_RAW.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(dst)
    top = frame["value"].value_counts().head(12).to_dict()
    print(f"wrote {len(frame)} map features to {dst}\n  most common: {top}")


if __name__ == "__main__":
    main()
