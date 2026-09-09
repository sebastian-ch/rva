"""Pure functions: building height, roof and color resolution. No I/O, easy to test.

Height resolution order (CLAUDE.md): OSM height -> building:levels x 3.2 m -> LiDAR nDSM median -> type default.
"""
from __future__ import annotations

import math
import re
from typing import Any

from config import DEFAULT_HEIGHT, DEFAULT_HEIGHT_BY_TYPE, LEVEL_HEIGHT

_NUM = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(m|meters?|ft|feet|'|\"|)\s*$", re.I)
_FT_IN = re.compile(r"^\s*(\d+)\s*'\s*(\d+)?\s*\"?\s*$")

ROOF_SHAPES = {"flat", "gable", "hip", "pyramidal", "skillion", "dome"}
_ROOF_ALIAS = {
    "gabled": "gable",
    "hipped": "hip",
    "half-hipped": "hip",
    "mansard": "hip",
    "gambrel": "gable",
    "round": "dome",
    "onion": "dome",
    "pyramid": "pyramidal",
    "sawtooth": "gable",
    "side_hipped": "hip",
    "shed": "skillion",
    "lean_to": "skillion",
}

# Named colors that appear in OSM roof:colour / building:colour, mapped to palette keys.
_COLOR_WORDS = {
    "red": "brick",
    "brown": "brick_dark",
    "grey": "concrete",
    "gray": "concrete",
    "white": "cream",
    "beige": "sand",
    "tan": "sand",
    "yellow": "sand",
    "orange": "terracotta",
    "black": "roof_dark",
    "green": "roof_green",
    "blue": "slate",
    "silver": "steel",
}
_MATERIAL_WALL = {
    "brick": "brick",
    "concrete": "concrete",
    "glass": "glass",
    "metal": "steel",
    "steel": "steel",
    "stone": "sand",
    "sandstone": "sand",
    "limestone": "cream",
    "marble": "cream",
    "wood": "terracotta",
    "plaster": "cream",
    "stucco": "cream",
}

_PALETTE_RGB = {
    "cream": (238, 227, 204),
    "brick": (181, 88, 63),
    "brick_dark": (142, 66, 50),
    "terracotta": (211, 138, 92),
    "sand": (220, 197, 154),
    "slate": (93, 107, 120),
    "glass": (159, 191, 208),
    "steel": (139, 147, 155),
    "concrete": (217, 210, 196),
    "roof_flat": (201, 189, 166),
    "roof_dark": (84, 80, 75),
    "roof_red": (168, 73, 58),
    "roof_green": (95, 138, 106),
}


def _is_nan(v: Any) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def parse_length_m(raw: Any) -> float | None:
    """Parse an OSM length ('12', '12 m', '40 ft', "40'6\"") to meters."""
    if _is_nan(raw):
        return None
    s = str(raw).strip().replace(",", ".")
    if ";" in s:
        s = s.split(";")[0]
    m = _FT_IN.match(s)
    if m:
        ft = float(m.group(1))
        inch = float(m.group(2) or 0)
        return (ft + inch / 12.0) * 0.3048
    m = _NUM.match(s)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).lower()
    if unit in ("ft", "feet", "'"):
        val *= 0.3048
    return val if val > 0 else None


def parse_levels(raw: Any) -> int | None:
    if _is_nan(raw):
        return None
    s = str(raw).strip()
    if ";" in s:
        s = s.split(";")[0]
    try:
        v = float(s)
    except ValueError:
        return None
    return int(round(v)) if v > 0 else None


def resolve_height(tags: dict[str, Any], lidar_median: float | None = None) -> tuple[float, int | None, str]:
    """Return (height_m, levels, source)."""
    levels = parse_levels(tags.get("building:levels"))
    h = parse_length_m(tags.get("height"))
    if h is not None:
        return h, levels, "osm_height"
    if levels is not None:
        return levels * LEVEL_HEIGHT, levels, "osm_levels"
    if lidar_median is not None and lidar_median > 2.0:
        return float(lidar_median), None, "lidar"
    btype = str(tags.get("building") or "yes").lower()
    return DEFAULT_HEIGHT_BY_TYPE.get(btype, DEFAULT_HEIGHT), None, "default"


def resolve_min_height(tags: dict[str, Any]) -> float:
    mh = parse_length_m(tags.get("min_height"))
    if mh is not None:
        return mh
    ml = parse_levels(tags.get("building:min_level"))
    return ml * LEVEL_HEIGHT if ml else 0.0


def resolve_roof(tags: dict[str, Any], height: float, footprint_area: float) -> tuple[str, float]:
    """Return (roof_shape, roof_height_m). Fallback mirrors Richmond's stock: small houses gable, else flat."""
    raw = tags.get("roof:shape")
    shape = None if _is_nan(raw) else str(raw).strip().lower()
    if shape:
        shape = _ROOF_ALIAS.get(shape, shape)
        if shape not in ROOF_SHAPES:
            shape = None
    btype = str(tags.get("building") or "yes").lower()
    if shape is None:
        if btype in ("house", "detached", "semidetached_house", "terrace", "residential") and footprint_area < 400 and height < 14:
            shape = "gable"
        elif btype in ("church", "cathedral", "chapel") and footprint_area < 2500:
            shape = "gable"
        else:
            shape = "flat"
    rh = parse_length_m(tags.get("roof:height"))
    if rh is None:
        if shape == "flat":
            rh = 0.0
        elif shape in ("gable", "hip", "skillion"):
            rh = min(4.0, max(1.5, math.sqrt(footprint_area) * 0.25))
        elif shape == "pyramidal":
            rh = min(6.0, max(2.0, math.sqrt(footprint_area) * 0.3))
        else:  # dome
            rh = min(8.0, max(2.0, math.sqrt(footprint_area) * 0.35))
    return shape, rh


def _hex_to_rgb(s: str) -> tuple[int, int, int] | None:
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return None
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        return None


def snap_color(raw: Any, candidates: tuple[str, ...]) -> str | None:
    """Snap an OSM colour (name or hex) to the nearest palette key among candidates."""
    if _is_nan(raw):
        return None
    s = str(raw).strip().lower()
    if s in _COLOR_WORDS and _COLOR_WORDS[s] in candidates:
        return _COLOR_WORDS[s]
    rgb = _hex_to_rgb(s)
    if rgb is None:
        return None
    best, best_d = None, 1e9
    for key in candidates:
        pr = _PALETTE_RGB[key]
        d = sum((a - b) ** 2 for a, b in zip(rgb, pr))
        if d < best_d:
            best, best_d = key, d
    return best


WALL_KEYS = ("cream", "brick", "brick_dark", "terracotta", "sand", "slate", "glass", "steel", "concrete")
ROOF_KEYS = ("roof_flat", "roof_dark", "roof_red", "roof_green", "brick_dark", "slate", "concrete")


def resolve_colors(tags: dict[str, Any], height: float, roof_shape: str, seed: int = 0) -> tuple[str, str]:
    """Return (wall_color, roof_color) palette keys, deterministic per seed."""
    wall = snap_color(tags.get("building:colour"), WALL_KEYS)
    if wall is None:
        mat = tags.get("building:material")
        if not _is_nan(mat):
            wall = _MATERIAL_WALL.get(str(mat).lower())
    btype = str(tags.get("building") or "yes").lower()
    if wall is None:
        if height > 60:
            wall = ("glass", "steel", "concrete", "slate")[seed % 4]
        elif height > 25:
            wall = ("concrete", "cream", "sand", "glass", "brick")[seed % 5]
        elif btype in ("house", "residential", "apartments", "terrace", "detached"):
            wall = ("brick", "brick", "brick_dark", "cream", "terracotta", "sand")[seed % 6]
        elif btype in ("industrial", "warehouse"):
            wall = ("brick_dark", "concrete", "steel")[seed % 3]
        elif btype in ("church", "cathedral", "government", "public"):
            wall = ("cream", "sand")[seed % 2]
        else:
            wall = ("brick", "cream", "sand", "concrete", "terracotta")[seed % 5]
    roof = snap_color(tags.get("roof:colour"), ROOF_KEYS)
    if roof is None:
        if roof_shape == "flat":
            roof = ("roof_flat", "roof_flat", "concrete", "roof_dark")[seed % 4]
        elif wall in ("brick", "brick_dark", "terracotta"):
            roof = ("roof_dark", "slate", "roof_red")[seed % 3]
        else:
            roof = ("roof_red", "roof_dark", "roof_green", "slate")[seed % 4]
    return wall, roof
