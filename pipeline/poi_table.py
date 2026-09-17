"""Compact, versioned on-disk POI table for streamed map tiles.

Coordinates are centimetres relative to the tile's southwest corner.  Properties
remain lossless through a deduplicated UTF-8 string table; float fields use NaN
for null.  The browser decoder lives in ``web/src/poiTable.ts``.
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

import geopandas as gpd

MAGIC = b"POI1"
HEADER = struct.Struct("<4sIII")  # magic, records, strings (including null), string bytes
RECORD = struct.Struct("<HHB3xIIIIff")
OFFSETS = struct.Struct("<I")
KIND_CODES = ("tree", "streetlight", "bench", "bus_stop", "traffic_signals", "fountain", "monument", "shop", "restaurant", "museum")
KIND_CODE = {kind: i + 1 for i, kind in enumerate(KIND_CODES)}


def _text(value) -> str | None:
    return value if isinstance(value, str) else None


def _number(value) -> float:
    if not isinstance(value, (int, float)):
        return math.nan
    value = float(value)
    return value if math.isfinite(value) else math.nan


def encode_pois(pois: gpd.GeoDataFrame, bounds: tuple[float, float, float, float]) -> bytes:
    """Encode point POIs. Coordinates outside the tile bounds are rejected."""
    minx, miny, maxx, maxy = bounds
    strings: list[str] = [""]  # index zero represents null
    string_index: dict[str, int] = {"": 0}

    def intern(value) -> int:
        text = _text(value)
        if text is None:
            return 0
        if text not in string_index:
            string_index[text] = len(strings)
            strings.append(text)
        return string_index[text]

    records: list[bytes] = []
    for _, row in pois.iterrows():
        point = row.geometry
        xq, yq = round((point.x - minx) * 100), round((point.y - miny) * 100)
        if not (0 <= xq <= 65535 and 0 <= yq <= 65535 and point.x <= maxx + 0.005 and point.y <= maxy + 0.005):
            raise ValueError(f"POI {row.get('id')!r} lies outside its tile bounds")
        kind = _text(row.get("kind"))
        if kind not in KIND_CODE:
            raise ValueError(f"POI {row.get('id')!r} has unsupported kind {kind!r}")
        records.append(RECORD.pack(xq, yq, KIND_CODE[kind], intern(row.get("id")), intern(row.get("name")),
                                   intern(row.get("species")), intern(row.get("source")),
                                   _number(row.get("tree_height")), _number(row.get("crown_radius"))))

    encoded = [s.encode("utf-8") for s in strings]
    offsets = [0]
    for value in encoded:
        offsets.append(offsets[-1] + len(value))
    blob = b"".join(encoded)
    return b"".join((HEADER.pack(MAGIC, len(records), len(strings), len(blob)), *records,
                     b"".join(OFFSETS.pack(offset) for offset in offsets), blob))


def write_pois(pois: gpd.GeoDataFrame, dst: Path, bounds: tuple[float, float, float, float]) -> int:
    """Write a POI table and return its feature count."""
    dst.write_bytes(encode_pois(pois, bounds))
    return len(pois)
