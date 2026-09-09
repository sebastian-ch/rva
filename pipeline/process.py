"""Normalize raw OSM layers into the schema in DATA_FORMAT.md (still un-tiled, EPSG:32618)."""
from __future__ import annotations

import json
import math
import zlib
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from config import CRS_PROJ, LANDMARKS_PATH, LANE_WIDTH, ROAD_WIDTH
from heights import parse_levels, resolve_colors, resolve_height, resolve_min_height, resolve_roof
from lidar import sample_ndsm_median

SIMPLIFY_TOL = 0.4  # meters, Douglas-Peucker on footprints
MIN_FOOTPRINT_AREA = 12.0  # m^2


def _nn(v: Any):
    """NaN -> None so JSON gets null."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _tags(row: pd.Series) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k != "geometry" and _nn(v) is not None}


def _osm_id(row: pd.Series) -> str:
    return f"osm:{row.get('element', 'way')}/{row.get('id')}"


def _read(path: Path) -> gpd.GeoDataFrame:
    if not path.exists():
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326").to_crs(CRS_PROJ)
    gdf = gpd.read_parquet(path)
    if len(gdf) == 0:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326").to_crs(CRS_PROJ)
    return gdf.to_crs(CRS_PROJ)


# ---------------------------------------------------------------- landmarks


def load_landmarks() -> list[dict]:
    if not LANDMARKS_PATH.exists():
        return []
    return json.loads(LANDMARKS_PATH.read_text())


def match_landmarks(buildings: gpd.GeoDataFrame, landmarks: list[dict], max_dist_m: float = 120.0) -> pd.Series:
    """Assign landmark slugs by name hint match, else the largest footprint within max_dist of the landmark point."""
    from pyproj import Transformer

    slugs = pd.Series([None] * len(buildings), index=buildings.index, dtype=object)
    if len(buildings) == 0:
        return slugs
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    names = buildings["name"].fillna("").str.lower() if "name" in buildings else pd.Series("", index=buildings.index)
    sidx = buildings.sindex
    for lm in landmarks:
        if lm.get("kind") not in ("building", None):
            continue
        hit = None
        for hint in lm.get("osm_name_hints", []) + [lm["name"]]:
            m = names[names.str.contains(hint.lower(), regex=False)]
            if len(m):
                hit = m.index[0]
                break
        if hit is None and lm.get("lat") is not None:
            x, y = tr.transform(lm["lon"], lm["lat"])
            from shapely.geometry import Point

            cand = list(sidx.query(Point(x, y).buffer(max_dist_m), predicate="intersects"))
            if cand:
                sub = buildings.iloc[cand]
                hit = sub.geometry.area.idxmax()
        if hit is not None:
            slugs.loc[hit] = lm["slug"]
    return slugs


# ---------------------------------------------------------------- buildings


def _merge_rowhouses(b: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Merge touching small residential footprints of similar height into blocks (PLAN §3)."""
    small = b[(b["levels"].fillna(3) <= 3) & (b["type"].isin(["house", "residential", "terrace", "detached", "yes"]))
              & (b.geometry.area < 350) & b["landmark"].isna() & b["name"].isna()]
    if len(small) < 2:
        return b
    sidx = small.sindex
    parent = {i: i for i in small.index}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    geoms = small.geometry
    heights = small["height"]
    for i, g in geoms.items():
        for j_pos in sidx.query(g, predicate="intersects"):
            j = small.index[j_pos]
            if j <= i:
                continue
            if abs(heights[i] - heights[j]) <= 1.0 and small.loc[i, "roof_shape"] == small.loc[j, "roof_shape"]:
                parent[find(i)] = find(j)
    groups: dict[int, list] = {}
    for i in small.index:
        groups.setdefault(find(i), []).append(i)
    merged_rows = []
    drop = []
    n = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        sub = small.loc[members]
        geom = unary_union(sub.geometry.values).buffer(0.05).buffer(-0.05)
        if geom.is_empty:
            continue
        first = sub.iloc[0].to_dict()
        first["geometry"] = geom
        first["id"] = f"merged:{n}"
        first["height"] = float(sub["height"].mean())
        first["levels"] = int(sub["levels"].dropna().median()) if sub["levels"].notna().any() else None
        first["merged_count"] = len(members)
        merged_rows.append(first)
        drop.extend(members)
        n += 1
    if not merged_rows:
        return b
    out = pd.concat([b.drop(index=drop), gpd.GeoDataFrame(merged_rows, crs=b.crs)], ignore_index=True)
    return gpd.GeoDataFrame(out, geometry="geometry", crs=b.crs)


def process_buildings(raw_path: Path, terrain=None, merge_rowhouses: bool = True) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    raw = raw[raw.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # building:part without building tag are parts of another footprint; keep only whole buildings
    if "building" in raw:
        raw = raw[raw["building"].notna()]
    raw = raw[raw.geometry.area >= MIN_FOOTPRINT_AREA]
    raw["geometry"] = raw.geometry.simplify(SIMPLIFY_TOL, preserve_topology=True).buffer(0)
    raw = raw[~raw.geometry.is_empty]

    lidar = sample_ndsm_median(raw)
    rows = []
    for k, (idx, row) in enumerate(raw.iterrows()):
        tags = _tags(row)
        area = row.geometry.area
        lid = lidar[k] if np.isfinite(lidar[k]) else None
        h, levels, src = resolve_height(tags, lid)
        h = max(2.5, min(h, 260.0))
        roof_shape, roof_h = resolve_roof(tags, h, area)
        seed = zlib.crc32(str(row.get("id")).encode()) % 1000
        wall, roof = resolve_colors(tags, h, roof_shape, seed)
        addr = None
        if tags.get("addr:housenumber") and tags.get("addr:street"):
            addr = f"{tags['addr:housenumber']} {tags['addr:street']}"
        rows.append({
            "id": _osm_id(row),
            "name": tags.get("name"),
            "height": round(h, 2),
            "min_height": round(resolve_min_height(tags), 2),
            "levels": levels if levels is not None else parse_levels(tags.get("building:levels")),
            "height_source": src,
            "roof_shape": roof_shape,
            "roof_height": round(roof_h, 2),
            "roof_color": roof,
            "wall_color": wall,
            "type": str(tags.get("building", "yes")),
            "landmark": None,
            "addr": addr,
            "wikidata": tags.get("wikidata"),
            "website": tags.get("website") or tags.get("contact:website"),
            "geometry": row.geometry,
        })
    b = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ)
    landmarks = load_landmarks()
    b["landmark"] = match_landmarks(b, landmarks)
    # Landmarks: stylized treatment. Height hint from the registry wins over levels/defaults (OSM height still wins),
    # and walls go cream so they read as "designed" until the hand-modeled glTF replaces them.
    hints = {lm["slug"]: lm.get("height_hint_m") for lm in landmarks}
    for i in b.index[b["landmark"].notna()]:
        hint = hints.get(b.at[i, "landmark"])
        if hint and b.at[i, "height_source"] != "osm_height":
            b.at[i, "height"] = float(hint)
            b.at[i, "height_source"] = "landmark_hint"
        b.at[i, "wall_color"] = "cream"
        if b.at[i, "roof_shape"] == "flat":
            b.at[i, "roof_color"] = "roof_flat"
    if merge_rowhouses:
        b = _merge_rowhouses(b)
    if terrain is not None:
        c = b.geometry.centroid
        b["ground_z"] = np.round(terrain.sample(c.x.values, c.y.values), 2)
    else:
        b["ground_z"] = 0.0
    return b


# ---------------------------------------------------------------- roads / rail


def _road_width(row: pd.Series) -> float:
    hw = str(row.get("highway"))
    w = ROAD_WIDTH.get(hw, 6.0)
    lanes = parse_levels(row.get("lanes"))
    if lanes:
        w = max(w, lanes * LANE_WIDTH)
    return round(w, 1)


def process_roads(raw_path: Path) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """Return (roads, crossings)."""
    raw = _read(raw_path)
    empty = gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    if len(raw) == 0:
        return empty, empty
    lines = raw[raw.geometry.geom_type.isin(["LineString", "MultiLineString"])].copy()
    lines = lines[~lines["highway"].isin(["proposed", "construction", "raceway", "corridor", "elevator", "bus_stop", "platform"])]
    lines = lines.explode(index_parts=False)
    if "area" in lines:
        lines = lines[lines["area"].fillna("no") != "yes"]
    roads = gpd.GeoDataFrame({
        "id": lines.apply(_osm_id, axis=1),
        "name": lines["name"].map(_nn) if "name" in lines else None,
        "highway": lines["highway"],
        "lanes": lines["lanes"].map(parse_levels) if "lanes" in lines else None,
        "width": lines.apply(_road_width, axis=1),
        "oneway": (lines["oneway"].fillna("no") == "yes") if "oneway" in lines else False,
        "surface": lines["surface"].map(_nn) if "surface" in lines else None,
        "sidewalk": (~lines["sidewalk"].fillna("no").isin(["no", "none"])) if "sidewalk" in lines else False,
        "bridge": (lines["bridge"].fillna("no") != "no") if "bridge" in lines else False,
        "tunnel": (lines["tunnel"].fillna("no") != "no") if "tunnel" in lines else False,
        "layer": lines["layer"].map(parse_levels).fillna(0).astype(int) if "layer" in lines else 0,
        "geometry": lines.geometry,
    }, crs=CRS_PROJ)
    pts = raw[(raw.geometry.geom_type == "Point")]
    if "highway" in pts:
        pts = pts[pts["highway"] == "crossing"]
    else:
        pts = pts.iloc[0:0]
    crossings = gpd.GeoDataFrame({
        "id": pts.apply(_osm_id, axis=1) if len(pts) else [],
        "crossing": pts["crossing"].map(_nn).fillna("unmarked") if "crossing" in pts else "unmarked",
        "geometry": pts.geometry,
    }, crs=CRS_PROJ)
    return roads, crossings


def process_rail(raw_path: Path) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    lines = raw[raw.geometry.geom_type.isin(["LineString", "MultiLineString"])].explode(index_parts=False)
    lines = lines[lines["railway"].isin(["rail", "light_rail", "tram", "subway"])]
    return gpd.GeoDataFrame({
        "id": lines.apply(_osm_id, axis=1),
        "name": lines["name"].map(_nn) if "name" in lines else None,
        "railway": lines["railway"],
        "bridge": (lines["bridge"].fillna("no") != "no") if "bridge" in lines else False,
        "layer": lines["layer"].map(parse_levels).fillna(0).astype(int) if "layer" in lines else 0,
        "geometry": lines.geometry,
    }, crs=CRS_PROJ)


# ---------------------------------------------------------------- landuse / water / pois


def _landuse_kind(row: pd.Series) -> str | None:
    lu, le, am, na, pl = (_nn(row.get(k)) for k in ("landuse", "leisure", "amenity", "natural", "place"))
    if le in ("park", "garden", "playground"):
        return "park"
    if le == "pitch" or lu in ("grass", "recreation_ground") or na == "grassland":
        return "grass"
    if am == "parking":
        return "parking"
    if lu == "cemetery":
        return "cemetery"
    if pl == "square":
        return "plaza"
    if lu in ("industrial", "railway"):
        return "industrial"
    if lu == "forest" or na in ("wood", "scrub"):
        return "forest"
    return None


def process_landuse(raw_path: Path) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    polys = raw[raw.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    polys["kind"] = polys.apply(_landuse_kind, axis=1)
    polys = polys[polys["kind"].notna()]
    polys["geometry"] = polys.geometry.simplify(1.0, preserve_topology=True).buffer(0)
    return gpd.GeoDataFrame({
        "id": polys.apply(_osm_id, axis=1),
        "name": polys["name"].map(_nn) if "name" in polys else None,
        "kind": polys["kind"],
        "geometry": polys.geometry,
    }, crs=CRS_PROJ)


def process_water(raw_path: Path) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    polys = raw[raw.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # waterway=canal/stream centerlines -> buffer into thin polygons
    lines = raw[raw.geometry.geom_type.isin(["LineString", "MultiLineString"])].copy()
    if "waterway" in lines and len(lines):
        lines = lines[lines["waterway"].isin(["canal", "stream"])].copy()
        lines["geometry"] = lines.geometry.buffer(lines["waterway"].map({"canal": 5.0, "stream": 2.0}).fillna(3.0))
        polys = pd.concat([polys, lines])

    def kind(row):
        w = _nn(row.get("water")) or _nn(row.get("waterway"))
        if w in ("river", "riverbank"):
            return "river"
        if w in ("canal", "stream"):
            return "canal"
        name = str(_nn(row.get("name")) or "").lower()
        if "river" in name:
            return "river"
        if "canal" in name:
            return "canal"
        return "pond"

    polys["kind"] = polys.apply(kind, axis=1)
    polys["geometry"] = polys.geometry.simplify(1.0, preserve_topology=True).buffer(0)
    return gpd.GeoDataFrame({
        "id": polys.apply(_osm_id, axis=1),
        "name": polys["name"].map(_nn) if "name" in polys else None,
        "kind": polys["kind"],
        "geometry": polys.geometry,
    }, crs=CRS_PROJ)


def _poi_kind(row: pd.Series) -> str | None:
    na, hw, am, sh, to, hi = (_nn(row.get(k)) for k in ("natural", "highway", "amenity", "shop", "tourism", "historic"))
    if na == "tree":
        return "tree"
    if hw == "street_lamp":
        return "streetlight"
    if hw == "bus_stop":
        return "bus_stop"
    if am == "bench":
        return "bench"
    if hi in ("monument", "memorial", "statue") or to == "artwork":
        return "monument"
    if to == "museum":
        return "museum"
    if am in ("restaurant", "cafe", "bar", "pub", "fast_food"):
        return "restaurant"
    if sh:
        return "shop"
    return None


def process_pois(raw_path: Path) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    raw = raw.copy()
    raw["geometry"] = raw.geometry.representative_point()
    raw["kind"] = raw.apply(_poi_kind, axis=1)
    raw = raw[raw["kind"].notna()]
    return gpd.GeoDataFrame({
        "id": raw.apply(_osm_id, axis=1),
        "name": raw["name"].map(_nn) if "name" in raw else None,
        "kind": raw["kind"],
        "geometry": raw.geometry,
    }, crs=CRS_PROJ)
