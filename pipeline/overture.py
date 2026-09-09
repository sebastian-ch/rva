"""Join Overture building attributes onto OSM footprints (second height source)."""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from config import CRS_PROJ
from heights import parse_levels

MIN_IOU = 0.5
ROOF_ALIAS = {"gabled": "gable", "hipped": "hip", "flat": "flat", "skillion": "skillion", "pyramidal": "pyramidal",
              "dome": "dome", "mansard": "hip", "gambrel": "gable", "half_hipped": "hip", "round": "dome"}


def load_overture(path: Path) -> gpd.GeoDataFrame:
    if not path.exists():
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    g = gpd.read_parquet(path, columns=["id", "height", "num_floors", "roof_shape", "roof_height", "geometry"])
    g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    return g.to_crs(CRS_PROJ)


def match_overture(osm: gpd.GeoDataFrame, ovt: gpd.GeoDataFrame, min_iou: float = MIN_IOU) -> pd.DataFrame:
    """For each OSM footprint (index preserved) pick the Overture footprint with the best IoU >= min_iou.

    Returns a DataFrame indexed like `osm` with columns ovt_height, ovt_levels, ovt_roof_shape, ovt_roof_height, ovt_iou.
    """
    out = pd.DataFrame(index=osm.index, data={"ovt_height": np.nan, "ovt_levels": np.nan, "ovt_roof_shape": None,
                                              "ovt_roof_height": np.nan, "ovt_iou": np.nan})
    if len(osm) == 0 or len(ovt) == 0:
        return out
    ovt = ovt.reset_index(drop=True)
    # only Overture rows that carry something useful
    useful = ovt[ovt["height"].notna() | ovt["num_floors"].notna() | ovt["roof_shape"].notna()].reset_index(drop=True)
    if len(useful) == 0:
        return out
    left = osm[["geometry"]].reset_index().rename(columns={"index": "_osm_idx"})
    if "_osm_idx" not in left.columns:  # named index
        left = left.rename(columns={left.columns[0]: "_osm_idx"})
    joined = gpd.sjoin(left, useful[["geometry"]], how="inner", predicate="intersects")
    if len(joined) == 0:
        return out
    a = joined.geometry.values
    b = useful.geometry.values[joined["index_right"].values]
    inter = np.array([x.intersection(y).area for x, y in zip(a, b)])
    union = np.array([x.union(y).area for x, y in zip(a, b)])
    iou = np.where(union > 0, inter / union, 0.0)
    joined = joined.assign(_iou=iou)
    joined = joined[joined["_iou"] >= min_iou].sort_values("_iou", ascending=False).drop_duplicates("_osm_idx")
    ridx = joined["index_right"].values
    sel = useful.iloc[ridx]
    idx = joined["_osm_idx"].values
    out.loc[idx, "ovt_height"] = pd.to_numeric(sel["height"].values, errors="coerce")
    out.loc[idx, "ovt_levels"] = [parse_levels(v) if v is not None and not (isinstance(v, float) and np.isnan(v)) else np.nan
                                  for v in sel["num_floors"].values]
    out.loc[idx, "ovt_roof_shape"] = [ROOF_ALIAS.get(str(v).lower()) if isinstance(v, str) else None for v in sel["roof_shape"].values]
    out.loc[idx, "ovt_roof_height"] = pd.to_numeric(sel["roof_height"].values, errors="coerce")
    out.loc[idx, "ovt_iou"] = joined["_iou"].values
    return out
