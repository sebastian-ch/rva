"""Wall colour prior from the City of Richmond assessor: building era and use instead of a blind seeded guess.

Nadir imagery cannot see facades, and no open source records wall material citywide (OSM tags about 1% of
buildings). The assessor does record when a building was built and what it is used for. That constrains the
palette well in Richmond: pre-war rowhouses and warehouses are overwhelmingly brick, downtown's pre-war towers
are limestone and terra cotta, post-war commercial is concrete and brick, and recent apartments use grey and
cream siding over a brick base.

Only buildings whose wall is still the seeded guess (`wall_color_source` "heuristic") change, and they get
`wall_color_source: "assessor"`. Mapped colours and materials, overrides and landmarks stay. The result is still
a guess, drawn from an era-and-use distribution, not a survey of each facade.
"""
from __future__ import annotations

import math
import zlib

import geopandas as gpd
import numpy as np
import pandas as pd

TALL_M = 25.0
# weights per (use, era); a building draws one key, seeded by its id so rebuilds are stable
ERA_WALLS: dict[tuple[str, str], list[tuple[str, int]]] = {
    ("residential", "pre1940"): [("brick", 5), ("brick_dark", 3), ("cream", 2), ("terracotta", 1), ("sand", 1)],
    ("residential", "1940_1975"): [("brick", 4), ("brick_dark", 2), ("cream", 2), ("sand", 2)],
    ("residential", "1976_1999"): [("sand", 3), ("cream", 3), ("brick", 2), ("slate", 1)],
    ("residential", "2000s"): [("slate", 3), ("cream", 2), ("sand", 2), ("brick", 2), ("brick_dark", 1)],
    ("commercial", "pre1940"): [("brick", 4), ("cream", 2), ("brick_dark", 2), ("sand", 2), ("terracotta", 1)],
    ("commercial", "1940_1975"): [("concrete", 3), ("brick", 3), ("sand", 2), ("cream", 1)],
    ("commercial", "1976_1999"): [("concrete", 3), ("sand", 2), ("glass", 2), ("brick", 2)],
    ("commercial", "2000s"): [("glass", 3), ("slate", 2), ("concrete", 2), ("brick", 2), ("steel", 1)],
    ("industrial", "pre1940"): [("brick_dark", 4), ("brick", 4), ("concrete", 1)],
    ("industrial", "1940_1975"): [("concrete", 3), ("brick_dark", 2), ("steel", 2), ("brick", 1)],
    ("industrial", "1976_1999"): [("steel", 3), ("concrete", 3), ("slate", 1)],
    ("industrial", "2000s"): [("steel", 3), ("concrete", 3), ("slate", 1)],
    # tall buildings of any use: stone and terra cotta before the war, concrete after, then glass curtain walls
    ("tall", "pre1940"): [("cream", 3), ("sand", 3), ("brick", 2), ("terracotta", 1)],
    ("tall", "1940_1975"): [("concrete", 4), ("cream", 2), ("sand", 2), ("glass", 1)],
    ("tall", "1976_1999"): [("glass", 4), ("concrete", 2), ("steel", 2), ("slate", 1)],
    ("tall", "2000s"): [("glass", 4), ("concrete", 2), ("steel", 2), ("slate", 1)],
}
_INDUSTRIAL = ("warehouse", "manufactur", "industrial", "distribution", "storage", "garage", "plant", "mill")
_RESIDENTIAL = ("apartment", "dormitor", "residential", "condo", "rooming", "nursing")


def era(year) -> str | None:
    if not isinstance(year, (int, float)) or not math.isfinite(year) or year < 1700:
        return None
    return "pre1940" if year < 1940 else "1940_1975" if year < 1976 else "1976_1999" if year < 2000 else "2000s"


def building_use(comm_bldg_type) -> str:
    """Assessor commercial building type -> residential / commercial / industrial. No type means a dwelling."""
    if not isinstance(comm_bldg_type, str) or not comm_bldg_type.strip():
        return "residential"
    t = comm_bldg_type.lower()
    if any(k in t for k in _RESIDENTIAL):
        return "residential"
    if any(k in t for k in _INDUSTRIAL):
        return "industrial"
    return "commercial"


def era_wall(year, use: str, height: float, seed: int) -> str | None:
    e = era(year)
    if e is None:
        return None
    items = ERA_WALLS[("tall" if height > TALL_M else use, e)]
    total = sum(w for _, w in items)
    x = seed % total
    for key, w in items:
        if x < w:
            return key
        x -= w
    return items[-1][0]


def parcel_attributes(parcels: gpd.GeoDataFrame, assessor: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Parcel polygons with year built (assessor 2024 over the 2022 parcel layer) and use."""
    a = pd.DataFrame({"pin": assessor["parcel_id"].astype(str).str.strip(),
                      "year": pd.to_numeric(assessor["year_built"], errors="coerce"),
                      "comm": assessor["comm_bldg_type"]})
    a.loc[a["year"] < 1700, "year"] = np.nan
    # a parcel with several improvement records: its oldest recorded building, and any commercial type
    per = a.groupby("pin").agg(year=("year", "min"), comm=("comm", lambda s: next((v for v in s if isinstance(v, str) and v.strip()), None)))
    out = parcels.rename(columns={"PIN": "pin"})[["pin", "Year_Built", "geometry"]].copy()
    out["pin"] = out["pin"].astype(str).str.strip()
    out = out.join(per, on="pin")
    parcel_year = pd.to_numeric(out["Year_Built"], errors="coerce").where(lambda y: y >= 1700)
    out["year"] = out["year"].fillna(parcel_year)
    out["use"] = out["comm"].map(building_use)
    return out[["pin", "year", "use", "geometry"]]


def assessor_walls(buildings: gpd.GeoDataFrame, parcels: gpd.GeoDataFrame, assessor: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    out = buildings.copy()
    if "wall_color_source" not in out:
        out["wall_color_source"] = "heuristic"
    source = out["wall_color_source"].fillna("heuristic")
    cand = out[source == "heuristic"]
    if len(cand) == 0 or len(parcels) == 0:
        return out
    attrs = parcel_attributes(parcels.to_crs(out.crs), assessor)
    pts = gpd.GeoDataFrame(geometry=cand.geometry.representative_point(), index=cand.index, crs=out.crs)
    hit = gpd.sjoin(pts, attrs, predicate="within", how="inner")
    hit = hit[~hit.index.duplicated()]
    changed = 0
    for idx, row in hit.iterrows():
        seed = zlib.crc32(str(out.at[idx, "id"]).encode()) % 1000
        wall = era_wall(row["year"], row["use"], float(out.at[idx, "height"] or 0), seed)
        if wall is None:
            continue
        out.at[idx, "wall_color"] = wall
        out.at[idx, "wall_color_source"] = "assessor"
        changed += 1
    print(f"  wall colours: {changed}/{len(cand)} seeded guesses replaced by the assessor era prior")
    return out
