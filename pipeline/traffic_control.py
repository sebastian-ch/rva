"""Stop signs for the traffic sim and the viewer, inferred from the road network.

No open source maps Richmond's stop signs: OSM has none in the bbox, and the city's 186 stop-controlled
intersections are a safety-study selection, not an inventory. US practice is regular enough to infer them.
At an unsignalized junction the approaches off the through road stop, and a four-way junction of equal classes
is an all-way stop. Signals come from OSM `highway=traffic_signals` POIs. Those are mostly tagged at each
approach's stop line, so any signal within SIGNAL_RADIUS_M of a junction marks it signalized.

The result is `stop_sign` POIs at the curb of each stopping approach, with `heading` (the approach's travel
direction, projected radians) and `source: "inferred"`. The viewer draws them and the traffic worker stops
traffic at them.
"""
from __future__ import annotations

import math
from collections import defaultdict

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiLineString

from config import CRS_PROJ

SIGNAL_RADIUS_M = 20.0
ARM_PROBE_M = 8.0          # direction of an arm: from the node to this far along it
THROUGH_MIN_DEG = 120.0    # two top-class arms at least this far apart form the through road
SIGN_CURB_M = 0.6
SIGN_MAX_SHIFT_M = 8.0
# Not part of the junction topology: paths, and service ways (alleys, driveways, parking aisles), whose
# mouths are yield-and-go in practice. Motorway and trunk junctions are grade-separated or merges.
IGNORED = {"footway", "path", "track", "cycleway", "steps", "pedestrian", "corridor", "bridleway", "service",
           "construction", "proposed", "platform"}
FREEWAY = {"motorway", "trunk", "motorway_link", "trunk_link"}


def rank(highway: str) -> int:
    """Right-of-way rank, matching web/src/traffic/graph.ts `priority`."""
    return {"motorway": 5, "trunk": 4, "primary": 3, "secondary": 2, "tertiary": 1,
            "motorway_link": 3, "trunk_link": 2, "primary_link": 1}.get(highway, 0)


def _lines(geom):
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    return []


def _arms(roads: gpd.GeoDataFrame) -> dict[tuple, list[dict]]:
    """Arms by junction vertex (a vertex shared by two or more ways). An arm is one direction out of the
    vertex along one way."""
    tunnel = roads["tunnel"].fillna(False).astype(bool) if "tunnel" in roads else pd.Series(False, index=roads.index)
    ways = []
    shared: dict[tuple, int] = defaultdict(int)
    for idx, row in roads.iterrows():
        if row["highway"] in IGNORED or tunnel[idx]:
            continue
        for line in _lines(row.geometry):
            coords = np.asarray(line.coords)[:, :2]
            keys = [(round(x, 1), round(y, 1)) for x, y in coords]
            for k in set(keys):
                shared[k] += 1
            ways.append((idx, row, line, coords, keys))
    at: dict[tuple, list[dict]] = defaultdict(list)
    for idx, row, line, coords, keys in ways:
        oneway = bool(row.get("oneway")) if row.get("oneway") is not None else False
        width = float(row.get("width") or 7)
        cum = None
        for i, key in enumerate(keys):
            if shared[key] < 2:
                continue
            if cum is None:
                cum = np.r_[0, np.cumsum(np.hypot(*np.diff(coords, axis=0).T))]
            for side in (-1, 1):
                if not 0 <= i + side < len(coords):
                    continue
                target = float(np.clip(cum[i] + side * ARM_PROBE_M, 0, cum[-1]))
                p = line.interpolate(target)
                dx, dy = p.x - coords[i][0], p.y - coords[i][1]
                n = math.hypot(dx, dy)
                if n < 1e-6:
                    continue
                # traffic on the arm behind the vertex travels forward into it; a oneway way has no
                # approach on the arm ahead
                at[key].append({"road": idx, "highway": row["highway"], "rank": rank(row["highway"]),
                                "dir": (dx / n, dy / n), "approach": side == -1 or not oneway, "width": width,
                                "length": abs(target - cum[i])})
    return at


def _stopping_arms(arms: list[dict]) -> list[dict]:
    if any(a["highway"] in FREEWAY for a in arms):
        return []
    top = max(a["rank"] for a in arms)
    lead = [a for a in arms if a["rank"] == top]
    if len(arms) >= 4 and len(lead) == len(arms):
        through: list[dict] = []           # all-way stop
    else:
        pairs = [(math.degrees(math.acos(max(-1.0, min(1.0, a["dir"][0] * b["dir"][0] + a["dir"][1] * b["dir"][1])))), a, b)
                 for i, a in enumerate(lead) for b in lead[i + 1:]]
        if len(lead) == 1:
            others = [a for a in arms if a is not lead[0]]
            opposite = min(others, key=lambda b: lead[0]["dir"][0] * b["dir"][0] + lead[0]["dir"][1] * b["dir"][1])
            through = [lead[0], opposite]
        else:
            angle, a, b = max(pairs, key=lambda t: t[0])
            if len(lead) > 2 and angle < THROUGH_MIN_DEG:
                return []                  # ambiguous (a Y of equal roads): leave it to the yield rule
            through = [a, b]
    return [a for a in arms if a["approach"] and not any(a is t for t in through) and not a["highway"].endswith("_link")]


def infer_stop_signs(roads: gpd.GeoDataFrame, pois: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """One `stop_sign` POI per stopping approach at every unsignalized junction."""
    at = _arms(roads)
    signals = pois[pois["kind"] == "traffic_signals"] if len(pois) else pois
    tree = cKDTree(np.c_[signals.geometry.x, signals.geometry.y]) if len(signals) else None
    rows = []
    for key, arms in at.items():
        if len(arms) < 3:
            continue
        if tree is not None and tree.query(key, distance_upper_bound=SIGNAL_RADIUS_M)[0] < math.inf:
            continue
        stopping = _stopping_arms(arms)
        if not stopping:
            continue
        cross = max((a["width"] for a in arms if not any(a is b for b in stopping)), default=8.0)
        for k, a in enumerate(stopping):
            back = min(max(cross / 2 + 2.5, 4.0), 12.0, max(a["length"] * 0.6, 1.0))
            tx, ty = -a["dir"][0], -a["dir"][1]            # travel direction toward the node
            rx, ry = ty, -tx                                 # right of travel
            off = a["width"] / 2 + SIGN_CURB_M
            x = key[0] + a["dir"][0] * back + rx * off
            y = key[1] + a["dir"][1] * back + ry * off
            rows.append({"id": f"stop:{key[0]:.1f}:{key[1]:.1f}:{k}", "name": None, "kind": "stop_sign",
                         "source": "inferred", "heading": round(math.atan2(ty, tx), 4), "x": x, "y": y})
    if not rows:
        return gpd.GeoDataFrame({"id": [], "kind": []}, geometry=[], crs=CRS_PROJ)
    df = pd.DataFrame(rows)
    return gpd.GeoDataFrame(df.drop(columns=["x", "y"]), geometry=gpd.points_from_xy(df["x"], df["y"]), crs=CRS_PROJ)


def add_stop_signs(roads: gpd.GeoDataFrame, pois: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    from streetlights import clear_carriageways
    # at a skewed junction the curb offset can land a sign on the crossing road; move it to that road's curb.
    # Signs get a longer reach than poles: dropping one would also remove the stop from the traffic sim.
    signs = clear_carriageways(infer_stop_signs(roads, pois), roads, max_shift=SIGN_MAX_SHIFT_M)
    print(f"  traffic control: {len(signs)} inferred stop signs")
    return gpd.GeoDataFrame(pd.concat([pois, signs], ignore_index=True), crs=CRS_PROJ) if len(signs) else pois
