"""Tile data schema: required property keys per layer + validation.

Single source of truth for "what a valid tile feature looks like", derived from
DATA_FORMAT.md and the property dicts built in process.py. Used by pipeline/tiles_inspect.py
and pipeline/tests/test_schema.py / test_integration.py. Read-only w.r.t. process.py:
this module never imports anything that does I/O, just the plain constants it needs.
"""
from __future__ import annotations

import json
from typing import Any

from heights import ROOF_SHAPES  # single definition of the roof-shape enum lives in heights.py

# ---------------------------------------------------------------- enums

HEIGHT_SOURCES: set[str] = {
    "override", "cch_height",
    "osm_height", "osm_levels", "overture_height", "overture_levels",
    "lidar", "zoning", "default", "landmark_hint",
}

ROOF_SOURCES: set[str] = {"osm", "overture", "lidar", "heuristic", "override"}

POI_KINDS: set[str] = {
    "tree", "streetlight", "bench", "bus_stop", "traffic_signals",
    "fountain", "monument", "shop", "restaurant", "museum",
}

LANDUSE_KINDS: set[str] = {"park", "grass", "parking", "cemetery", "plaza", "industrial", "forest", "beach", "deck", "groyne", "breakwater", "seawall", "pier", "canal_bank"}

WATER_KINDS: set[str] = {"river", "canal", "pond", "ocean"}

# process.py only defaults a missing `crossing` tag to "unmarked" -- it passes the raw OSM
# crossing=* value through otherwise (e.g. "traffic_signals", "uncontrolled"), so there is no
# closed enum to validate against here, unlike DATA_FORMAT.md's "marked|unmarked" gloss.

# ---------------------------------------------------------------- required keys per layer
# Exactly the keys emitted in the row dicts of process.py's process_* functions
# (geometry excluded -- that's the GeoJSON geometry, not a property).

LAYER_KEYS: dict[str, set[str]] = {
    "buildings": {
        "id", "name", "height", "min_height", "levels", "height_source",
        "roof_shape", "roof_height", "roof_azimuth", "roof_source",
        "roof_color", "wall_color", "type", "landmark", "addr",
        "wikidata", "website", "zoning", "lidar_p90", "ground_z",
            "is_part", "parent", "hidden",
            "footprint_source", "source_updated",
    },
    "roads": {
        "id", "name", "highway", "lanes", "width", "oneway", "surface",
        "sidewalk", "bridge", "tunnel", "layer", "deck",
            "ramp",
    },
    "rail": {
        "id", "name", "railway", "bridge", "layer", "deck",
            "ramp",
    },
    "landuse": {"id", "name", "kind"},
    "water": {"id", "name", "kind"},
    "crossings": {"id", "crossing", "road_id", "road_width", "road_dx", "road_dy", "road_x", "road_y", "crossing_island"},
    "pois": {"id", "name", "kind"},
}


def _feature_id(props: dict[str, Any]) -> str:
    v = props.get("id")
    return str(v) if v is not None else "<no id>"


def _check_deck(props: dict[str, Any], problems: list[str], fid: str) -> None:
    if "bridge" not in props or not props.get("bridge"):
        return
    deck = props.get("deck")
    if isinstance(deck, str):
        try:
            deck = json.loads(deck)
        except (TypeError, ValueError):
            problems.append(f"{fid}: deck is not valid JSON on a bridge feature")
            return
    if not isinstance(deck, list) or len(deck) != 6:
        problems.append(f"{fid}: deck is not a 6-element list on a bridge feature (got {props.get('deck')!r})")


def validate_feature(layer: str, props: dict[str, Any]) -> list[str]:
    """Return a list of human-readable problems with one feature's properties. Empty = valid."""
    problems: list[str] = []
    keys = LAYER_KEYS.get(layer)
    if keys is None:
        return [f"unknown layer {layer!r}"]
    fid = _feature_id(props)

    missing = keys - props.keys()
    if missing:
        problems.append(f"{fid}: missing keys {sorted(missing)}")

    if layer == "buildings":
        for key in ("height", "min_height", "roof_height"):
            v = props.get(key)
            if v is not None and isinstance(v, (int, float)) and v < 0:
                problems.append(f"{fid}: {key} is negative ({v})")
        lp = props.get("lidar_p90")
        if lp is not None and isinstance(lp, (int, float)) and lp < 0:
            problems.append(f"{fid}: lidar_p90 is negative ({lp})")
        az = props.get("roof_azimuth")
        if az is not None:
            if not isinstance(az, (int, float)) or not (0 <= az <= 180):
                problems.append(f"{fid}: roof_azimuth {az!r} outside 0..180")
        hs = props.get("height_source")
        if hs is not None and hs not in HEIGHT_SOURCES:
            problems.append(f"{fid}: unknown height_source {hs!r}")
        rs = props.get("roof_shape")
        if rs is not None and rs not in ROOF_SHAPES:
            problems.append(f"{fid}: unknown roof_shape {rs!r}")
        rsrc = props.get("roof_source")
        if rsrc is not None and rsrc not in ROOF_SOURCES:
            problems.append(f"{fid}: unknown roof_source {rsrc!r}")

    if layer in ("roads", "rail"):
        _check_deck(props, problems, fid)

    if layer == "landuse":
        k = props.get("kind")
        if k is not None and k not in LANDUSE_KINDS:
            problems.append(f"{fid}: unknown landuse kind {k!r}")

    if layer == "water":
        k = props.get("kind")
        if k is not None and k not in WATER_KINDS:
            problems.append(f"{fid}: unknown water kind {k!r}")

    if layer == "pois":
        k = props.get("kind")
        if k is not None and k not in POI_KINDS:
            problems.append(f"{fid}: unknown poi kind {k!r}")

    return problems
