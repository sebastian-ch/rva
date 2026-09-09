"""Resolve every landmark in assets/landmarks/landmarks.json to a map position, including non-buildings
(bridges, sites, memorials). Writes data/tiles/landmarks.json for the viewer's tour, labels and targets.

Strategy per landmark, in order:
  1. buildings already tagged by process.match_landmarks (slug in `landmark`) -> footprint centroid
  2. name-hint match in any raw layer (roads, rail, landuse, water, pois, buildings) within 600 m of lat/lon
  3. nearest plausible feature by kind within 150 m (bridge -> bridge=yes way; site -> landuse/leisure polygon;
     memorial -> historic/tourism point)
  4. the registry lat/lon itself (flagged `matched: null`)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import Point

from config import CRS_PROJ, LANDMARKS_PATH

HINT_RADIUS = 800.0
NEAR_RADIUS = 150.0


def _read(path: Path) -> gpd.GeoDataFrame | None:
    if not path.exists():
        return None
    g = gpd.read_parquet(path)
    if len(g) == 0:
        return None
    return g.to_crs(CRS_PROJ)


def _names(g: gpd.GeoDataFrame) -> pd.Series:
    cols = [c for c in ("name", "bridge:name", "official_name", "alt_name") if c in g]
    if not cols:
        return pd.Series("", index=g.index)
    s = g[cols[0]].fillna("")
    for c in cols[1:]:
        s = s.where(s != "", g[c].fillna(""))
    return s.astype(str).str.lower()


def _kind_filter(g: gpd.GeoDataFrame, layer: str, kind: str) -> gpd.GeoDataFrame:
    if kind == "bridge" and layer in ("roads", "rail") and "bridge" in g:
        return g[g["bridge"].fillna("no") != "no"]
    if kind == "site" and layer == "landuse":
        return g
    if kind in ("memorial", "site") and layer == "pois":
        m = pd.Series(False, index=g.index)
        if "historic" in g:
            m |= g["historic"].isin(["memorial", "monument", "statue", "industrial", "ruins"])
        if "tourism" in g:
            m |= g["tourism"].isin(["artwork", "museum", "attraction"])
        return g[m]
    if kind == "building" and layer == "buildings":
        return g
    return g.iloc[0:0]


_STOP = {"the", "of", "and", "at", "a", "an", "l", "l."}


def _tokens(s: str) -> list[str]:
    import re
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t and t not in _STOP]


def _name_hit(g: gpd.GeoDataFrame, hints: list[str], pt: Point):
    """Feature within HINT_RADIUS whose name contains every token of some hint. Biggest such feature wins."""
    names = _names(g)
    near = g[g.geometry.distance(pt) <= HINT_RADIUS]
    if not len(near):
        return None
    n = names.loc[near.index]
    # full hints first, then progressively shorter token prefixes (min 2 tokens): "Maggie L. Walker Memorial"
    # still finds a statue named "Maggie Walker".
    variants: list[list[str]] = []
    for h in hints:
        toks = _tokens(h)
        if toks:
            variants.append(toks)
    # hint order is priority: the first hint is the most specific name, so exhaust its prefixes before the next
    for v in variants:
        for k in range(len(v), 1, -1):
            toks = v[:k]
            mask = pd.Series(True, index=near.index)
            for t in toks:
                mask &= n.str.contains(t, regex=False)
            hit = near[mask]
            if len(hit):
                sizes = hit.geometry.length + hit.geometry.area
                return hit.loc[sizes.idxmax()]
    return None


def _nearest_of_kind(g: gpd.GeoDataFrame, layer: str, kind: str, pt: Point):
    cand = _kind_filter(g, layer, kind)
    if not len(cand):
        return None
    b = cand.geometry.bounds
    extent = np.maximum(b["maxx"] - b["minx"], b["maxy"] - b["miny"])
    cand = cand[extent <= 400]  # never snap to a district-sized polygon
    cand = cand[cand.geometry.distance(pt) <= NEAR_RADIUS]
    if not len(cand):
        return None
    return cand.loc[cand.geometry.distance(pt).idxmin()]


def resolve_landmarks(raw_dir: Path, buildings: gpd.GeoDataFrame, terrain=None) -> dict:
    landmarks = json.loads(LANDMARKS_PATH.read_text()) if LANDMARKS_PATH.exists() else []
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    layers = {k: _read(raw_dir / f"{k}.parquet") for k in ("roads", "rail", "landuse", "water", "pois")}
    layers["buildings_raw"] = _read(raw_dir / "buildings.parquet")
    out: dict[str, dict] = {}
    for lm in landmarks:
        slug = lm["slug"]
        kind = lm.get("kind", "building")
        hints = list(lm.get("osm_name_hints", [])) + [lm["name"]]
        x, y = tr.transform(lm["lon"], lm["lat"])
        pt = Point(x, y)
        geom, matched, how, name = None, None, None, None
        # 1. tagged building
        if len(buildings) and "landmark" in buildings:
            hit = buildings[buildings["landmark"] == slug]
            if len(hit):
                geom, matched, how = hit.geometry.iloc[0], hit["id"].iloc[0], "building"
        # 2. name hints across every layer (points before areas so a museum beats a district)
        if geom is None:
            name_order = {"bridge": ("roads", "rail", "pois"), "streetscape": ("roads",),
                          "cemetery": ("landuse", "pois")}.get(kind, ("pois", "buildings_raw", "water", "landuse", "roads", "rail"))
            for layer in name_order:
                g = layers.get(layer)
                if g is None:
                    continue
                row = _name_hit(g, hints, pt)
                if row is not None:
                    geom, how = row.geometry, f"name:{layer}"
                    matched = f"osm:{row.get('element', 'way')}/{row.get('id')}"
                    name = row.get("name") if isinstance(row.get("name"), str) else None
                    break
        # 3. nearest feature of a plausible kind
        if geom is None:
            order = {"bridge": ["roads", "rail"], "site": ["pois", "landuse", "water"], "memorial": ["pois"],
                     "streetscape": ["roads"], "cemetery": ["landuse"]}.get(kind, ["pois", "landuse"])
            for layer in order:
                g = layers.get(layer)
                if g is None:
                    continue
                row = _nearest_of_kind(g, layer, kind, pt)
                if row is not None:
                    geom, how = row.geometry, f"nearest:{layer}"
                    matched = f"osm:{row.get('element', 'way')}/{row.get('id')}"
                    name = row.get("name") if isinstance(row.get("name"), str) else None
                    break
        if geom is None:
            geom, how = pt, None
        c = geom.centroid if not geom.geom_type == "Point" else geom
        gz = float(terrain.sample(np.array([c.x]), np.array([c.y]))[0]) if terrain is not None else 0.0
        minx, miny, maxx, maxy = geom.bounds
        out[slug] = {
            "name": lm["name"], "kind": kind, "x": round(c.x, 2), "y": round(c.y, 2), "ground_z": round(gz, 2),
            "extent": round(max(maxx - minx, maxy - miny), 1), "matched": matched, "how": how, "osm_name": name,
            "in_first_slice": bool(lm.get("in_first_slice")), "model": lm.get("model"),
            "wikidata": lm.get("wikidata"), "website": lm.get("website"), "description": lm.get("description"),
        }
    return out
