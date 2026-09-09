"""Shared pipeline configuration. Single source of truth for CRS, bbox, tiling, paths."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGION = os.environ.get("ISO_REGION", "richmond")
REGIONS = json.loads((ROOT / "regions.json").read_text())
if REGION not in REGIONS:
    raise ValueError(f"Unknown ISO_REGION {REGION!r}; choose from {list(REGIONS)}")
PROFILE = REGIONS[REGION]
DATA_RAW = ROOT / PROFILE["data"] / "raw"
DATA_TILES = ROOT / PROFILE["data"] / "tiles"
ASSETS = ROOT / PROFILE["assets"]
PALETTE_PATH = ROOT / "assets" / "palette.json"
LANDMARKS_PATH = ASSETS / "landmarks" / "landmarks.json"

# Working CRS: UTM 18N, meters. Never do geometry math in EPSG:4326.
CRS_WGS84 = "EPSG:4326"
CRS_PROJ = PROFILE["crs"]

# First slice: Downtown + Shockoe Bottom + Capitol Square. (west, south, east, north)
DEFAULT_BBOX = tuple(PROFILE["bbox"])

TILE_SIZE = 250.0  # meters
LEVEL_HEIGHT = 3.2  # meters per building level
DEFAULT_HEIGHT_BY_TYPE = {
    "house": 7.0,
    "residential": 9.0,
    "apartments": 14.0,
    "commercial": 12.0,
    "retail": 8.0,
    "office": 20.0,
    "industrial": 8.0,
    "warehouse": 8.0,
    "church": 15.0,
    "garage": 3.5,
    "garages": 3.5,
    "shed": 3.0,
    "roof": 4.0,
    "parking": 12.0,
    "hotel": 30.0,
    "school": 10.0,
    "university": 14.0,
    "government": 16.0,
    "public": 12.0,
    "hospital": 20.0,
    "yes": 9.0,
}
DEFAULT_HEIGHT = 9.0

# Road half-widths by highway class, meters (full width).
ROAD_WIDTH = {
    "motorway": 14.0,
    "trunk": 12.0,
    "primary": 11.0,
    "secondary": 9.5,
    "tertiary": 8.0,
    "residential": 7.0,
    "unclassified": 6.5,
    "living_street": 5.5,
    "service": 4.5,
    "motorway_link": 6.0,
    "trunk_link": 6.0,
    "primary_link": 6.0,
    "secondary_link": 5.5,
    "pedestrian": 4.0,
    "footway": 2.0,
    "path": 1.5,
    "track": 2.5,
    "cycleway": 2.5,
    "steps": 2.0,
}
LANE_WIDTH = 3.3


def load_palette() -> dict[str, str]:
    return {k: v for k, v in json.loads(PALETTE_PATH.read_text()).items() if not k.startswith("_")}


def snap_down(v: float, step: float) -> float:
    return math.floor(v / step) * step


def bbox_slug(bbox: tuple[float, float, float, float]) -> str:
    return "_".join(f"{c:.4f}".replace("-", "m").replace(".", "p") for c in bbox)
