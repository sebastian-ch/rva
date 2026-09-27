"""Mapillary map-feature detections -> hydrant, bench and traffic-sign POIs.

Mapillary triangulates each map feature from the street-level images that detected it, so a position is good to a
few metres rather than the city survey's sub-metre fix, and coverage follows where contributors drove. The step
therefore only adds classes no other source has (hydrants, signs other than inferred stops) or fills gaps in one
(benches OSM has not mapped). Stop signs belong to `traffic_control.py`, which also feeds the traffic sim; a detected
stop sign is only drawn where inference placed none nearby, and it carries no heading, so the sim ignores it.

Every POI keeps `source: mapillary`: the detections are CC BY-SA 4.0, and the tag keeps them separable.
"""
from __future__ import annotations

import math

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from config import CRS_PROJ

POINT_KINDS = {"object--fire-hydrant": "hydrant", "object--bench": "bench"}
SIGN_KINDS = {"regulatory": "street_sign", "information": "street_sign", "warning": "warning_sign"}
STOP_PREFIX = "regulatory--stop--"
# A feature last seen before this is probably gone (benches move, signs are replaced).
MIN_LAST_SEEN = "2016-01-01"
SAME_M = 2.0            # two detections of one kind this close are one object seen twice
OSM_BENCH_M = 5.0       # an OSM bench this close is the same bench; OSM keeps it
STOP_COVER_M = 25.0     # an inferred stop sign this close already stands for the detected one


def kind_of(value: str) -> str | None:
    if value in POINT_KINDS:
        return POINT_KINDS[value]
    if value.startswith(STOP_PREFIX):
        return "stop_sign"
    return SIGN_KINDS.get(value.split("--", 1)[0])


def detection_pois(raw: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Classify, drop stale features and collapse near-duplicates of one kind."""
    kinds = raw["value"].map(kind_of)
    fresh = raw["last_seen"].isna() | (raw["last_seen"] >= MIN_LAST_SEEN)
    keep = raw[kinds.notna() & fresh].to_crs(CRS_PROJ)
    keep = keep.assign(kind=kinds[keep.index])
    parts = []
    for kind, group in keep.groupby("kind", sort=True):
        group = group.sort_values("last_seen", ascending=False, na_position="last")
        xy = np.c_[group.geometry.x, group.geometry.y]
        taken = np.zeros(len(group), bool)
        chosen = []
        # newest first, so the most recently confirmed detection of a cluster wins
        for i, near in enumerate(cKDTree(xy).query_ball_point(xy, SAME_M)):
            if taken[i]:
                continue
            taken[near] = True
            chosen.append(i)
        parts.append(group.iloc[chosen])
    if not parts:
        return gpd.GeoDataFrame({"id": [], "kind": [], "name": [], "source": [], "pole_height": [], "heading": []},
                                geometry=[], crs=CRS_PROJ)
    out = pd.concat(parts)
    return gpd.GeoDataFrame({
        "id": [f"mly:{i}" for i in out["id"]], "kind": out["kind"].to_numpy(), "name": None, "source": "mapillary",
        "pole_height": math.nan, "heading": math.nan,
    }, geometry=out.geometry.to_numpy(), crs=CRS_PROJ)


def _near(points: gpd.GeoDataFrame, others: gpd.GeoDataFrame, radius: float) -> np.ndarray:
    if len(points) == 0 or len(others) == 0:
        return np.zeros(len(points), bool)
    dist, _ = cKDTree(np.c_[others.geometry.x, others.geometry.y]).query(np.c_[points.geometry.x, points.geometry.y])
    return dist <= radius


def drop_covered(detected: gpd.GeoDataFrame, pois: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Drop benches OSM already maps and stop signs traffic_control already inferred."""
    drop = np.zeros(len(detected), bool)
    for kind, radius in (("bench", OSM_BENCH_M), ("stop_sign", STOP_COVER_M)):
        mine = (detected["kind"] == kind).to_numpy()
        drop[mine] = _near(detected[mine], pois[pois["kind"] == kind], radius)
    return detected[~drop]


def outside_buildings(points: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    visible = buildings[~buildings["hidden"].fillna(False).astype(bool)] if "hidden" in buildings else buildings
    if len(points) == 0 or len(visible) == 0:
        return points
    inside = gpd.sjoin(points[["geometry"]], visible[["geometry"]], predicate="within").index.unique()
    return points.drop(index=inside)


def merge_detections(pois: gpd.GeoDataFrame, raw: gpd.GeoDataFrame, roads: gpd.GeoDataFrame,
                     buildings: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    from streetlights import clear_carriageways
    detected = drop_covered(detection_pois(raw), pois)
    detected = outside_buildings(clear_carriageways(detected, roads), buildings)
    print(f"  mapillary: {detected['kind'].value_counts().to_dict()}")
    return gpd.GeoDataFrame(pd.concat([pois, detected], ignore_index=True), crs=CRS_PROJ) if len(detected) else pois
