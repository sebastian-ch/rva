"""City of Richmond open data joins: address points -> building `addr`, zoning -> height defaults."""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from config import CRS_PROJ

# Zoning district prefix -> typical building height (m) used only when nothing better is known.
ZONING_HEIGHT = [
    ("B-4", 24.0), ("B-5", 20.0), ("B-6", 14.0), ("B-7", 14.0), ("B-3", 12.0), ("B-2", 10.0), ("B-1", 8.0),
    ("TOD", 16.0), ("UB", 12.0), ("RO", 10.0), ("R-63", 9.0), ("R-53", 9.0), ("R-73", 9.0), ("R-48", 8.0), ("R-", 7.5),
    ("M-2", 9.0), ("M-1", 8.0), ("I", 12.0), ("OS", 4.0), ("DCC", 20.0), ("CM", 12.0), ("HO", 30.0),
]


def _read(path: Path | None) -> gpd.GeoDataFrame | None:
    if path is None or not path.exists():
        return None
    g = gpd.read_parquet(path)
    return g.to_crs(CRS_PROJ) if len(g) else None


def zoning_height(name: str | None) -> float | None:
    if not isinstance(name, str):
        return None
    for prefix, h in ZONING_HEIGHT:
        if name.upper().startswith(prefix):
            return h
    return None


def join_addresses(buildings: gpd.GeoDataFrame, addresses: gpd.GeoDataFrame | None) -> pd.Series:
    """One address label per footprint (the point inside it; lowest AddressId wins). Series indexed like buildings."""
    out = pd.Series([None] * len(buildings), index=buildings.index, dtype=object)
    if addresses is None or len(buildings) == 0:
        return out
    pts = addresses[["AddressLabel", "AddressId", "geometry"]].dropna(subset=["AddressLabel"])
    j = gpd.sjoin(pts, buildings[["geometry"]], how="inner", predicate="within")
    if len(j) == 0:
        return out
    j = j.sort_values("AddressId").drop_duplicates("index_right")
    out.loc[j["index_right"].values] = j["AddressLabel"].values
    return out


def join_zoning(buildings: gpd.GeoDataFrame, zoning: gpd.GeoDataFrame | None) -> pd.Series:
    """Zoning district name at each footprint's representative point."""
    out = pd.Series([None] * len(buildings), index=buildings.index, dtype=object)
    if zoning is None or len(buildings) == 0 or "Name" not in zoning:
        return out
    rp = gpd.GeoDataFrame({"geometry": buildings.geometry.representative_point()}, index=buildings.index, crs=buildings.crs)
    j = gpd.sjoin(rp, zoning[["Name", "geometry"]], how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    out.loc[j.index] = j["Name"].values
    return out
