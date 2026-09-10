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
from shapely.geometry import Point
from pyproj import Transformer

from config import ASSETS, CRS_PROJ, DATA_RAW, LANDMARKS_PATH, LANE_WIDTH, LEVEL_HEIGHT, ROAD_WIDTH, REGION
from heights import cap_small_footprint, looks_demolished, parse_levels, resolve_colors, resolve_height, resolve_min_height, resolve_roof
from lidar import classify_roofs, sample_ndsm_stats
from overture import load_overture, match_overture
from richmond import _read as _read_rva, join_addresses, join_zoning, zoning_height

SIMPLIFY_TOL = 0.4  # meters, Douglas-Peucker on footprints
MIN_FOOTPRINT_AREA = 12.0  # m^2


def _nn(v: Any):
    """NaN -> None so JSON gets null."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _is_nan_str(v: Any) -> bool:
    return _nn(v) is None


def _tags(row: pd.Series) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k != "geometry" and _nn(v) is not None}


def _osm_id(row: pd.Series) -> str:
    el = row.get("element", "way")
    if el in ("vgin", "cch", "richmond_structure"):
        return f"{el}:{row.get('id')}"
    return f"osm:{el}/{row.get('id')}"


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
              & (b.geometry.area < 350) & b["landmark"].isna() & b["name"].isna() & ~b["is_part"] & ~b["hidden"]]
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
        first["ground_z"] = round(float(sub["ground_z"].mean()), 2)
        # keep a shared ridge azimuth only if the members agree (rowhouse blocks usually do)
        az = pd.to_numeric(sub["roof_azimuth"], errors="coerce").dropna().to_numpy()
        if len(az) and (np.ptp(np.where(az > 90, az - 180, az)) < 15 or np.ptp(az) < 15):
            first["roof_azimuth"] = round(float(np.median(az)), 1)
        else:
            first["roof_azimuth"] = None
        merged_rows.append(first)
        drop.extend(members)
        n += 1
    if not merged_rows:
        return b
    out = pd.concat([b.drop(index=drop), gpd.GeoDataFrame(merged_rows, crs=b.crs)], ignore_index=True)
    return gpd.GeoDataFrame(out, geometry="geometry", crs=b.crs)


PART_COVER = 0.6  # parts covering this share of the outline hide the outline (rendered as a plinth)
VGIN_MIN_AREA = 20.0  # m^2; smaller VGIN footprints are sheds/steps and add noise
RICHMOND_STRUCTURE_MIN_AREA = 12.0


def _source_date(v: Any) -> str | None:
    if _nn(v) is None:
        return None
    try:
        stamp = pd.to_datetime(v, unit="ms", utc=True) if isinstance(v, (int, float, np.integer, np.floating)) else pd.to_datetime(v, utc=True)
        return stamp.isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def _add_gap_footprints(raw: gpd.GeoDataFrame, is_part: pd.Series, path: Path, *,
                        source: str, element: str, min_area: float,
                        subtype: int | None = None) -> tuple[gpd.GeoDataFrame, pd.Series]:
    """Append source footprints that do not substantially overlap an existing building.

    Area overlap, rather than the intersects predicate alone, allows attached buildings that share a wall.
    """
    city = gpd.read_parquet(path)
    if len(city) == 0:
        return raw, is_part
    city = city.to_crs(raw.crs)
    if subtype is not None and "Subtype" in city:
        city = city[city["Subtype"] == subtype]
    city = city[city.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    city = city[city.geometry.area >= min_area].copy()
    if len(city) == 0:
        return raw, is_part
    hit = gpd.sjoin(city[["geometry"]], raw[["geometry"]], how="inner", predicate="intersects")
    covered = set()
    for ci, oi in zip(hit.index, hit["index_right"]):
        overlap = city.at[ci, "geometry"].intersection(raw.at[oi, "geometry"]).area
        if overlap >= 0.25 * min(city.at[ci, "geometry"].area, raw.at[oi, "geometry"].area):
            covered.add(ci)
    add = city[~city.index.isin(covered)].copy().reset_index(drop=True)
    if len(add) == 0:
        return raw, is_part
    add["element"] = element
    add["id"] = add["OBJECTID"].astype(str) if "OBJECTID" in add else [str(i) for i in add.index]
    add["building"] = "yes"
    add["footprint_source"] = source
    add["source_updated"] = add["EditDate"].map(_source_date) if "EditDate" in add else None
    add["geometry"] = add.geometry.simplify(SIMPLIFY_TOL, preserve_topology=True).buffer(0)
    add = add[~add.geometry.is_empty]
    start = raw.index.max() + 1 if len(raw) else 0
    add.index = range(start, start + len(add))
    for col in add.columns:
        if col not in raw and col != "geometry":
            raw[col] = None
    out = gpd.GeoDataFrame(pd.concat([raw, add[[c for c in add.columns if c in raw.columns or c == "geometry"]]]), geometry="geometry", crs=raw.crs)
    parts = pd.concat([is_part, pd.Series(False, index=add.index)])
    print(f"  {source} footprints added: {len(add)} (of {len(city)} >= {min_area:g} m2 in bbox)")
    return out, parts


def _add_vgin_footprints(raw: gpd.GeoDataFrame, is_part: pd.Series, path: Path) -> tuple[gpd.GeoDataFrame, pd.Series]:
    """Append VGIN footprints that overlap no OSM footprint (gap-fill: garages, alley buildings, unmapped blocks)."""
    return _add_gap_footprints(raw, is_part, path, source="vgin", element="vgin", min_area=VGIN_MIN_AREA)


def process_richmond_decks(path: Path) -> gpd.GeoDataFrame:
    """Convert Richmond Structures subtype 3 deck/patio outlines to low terrain surfaces."""
    city = _read(path)
    if len(city) == 0 or "Subtype" not in city:
        return gpd.GeoDataFrame(columns=["id", "name", "kind", "source", "source_updated", "geometry"], geometry="geometry", crs=CRS_PROJ)
    city = city[(city["Subtype"] == 3) & city.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    city = city[city.geometry.area >= 2.0]
    city["geometry"] = city.geometry.simplify(0.2, preserve_topology=True).buffer(0)
    city = city[~city.geometry.is_empty]
    return gpd.GeoDataFrame({
        "id": "richmond_structure:" + city["OBJECTID"].astype(str),
        "name": None,
        "kind": "deck",
        "source": "richmond_structures",
        "source_updated": city["EditDate"].map(_source_date) if "EditDate" in city else None,
        "geometry": city.geometry,
    }, crs=CRS_PROJ)


def _assign_parts(raw: gpd.GeoDataFrame, is_part: pd.Series) -> tuple[dict, dict]:
    """Map each part to the outline containing its representative point; flag outlines covered by their parts."""
    parent_of: dict = {}
    hidden: dict = {}
    parts = raw[is_part]
    outlines = raw[~is_part]
    if len(parts) == 0 or len(outlines) == 0:
        return parent_of, hidden
    # parent = the outline with the largest overlap (parts often poke past the outline, e.g. porticos, spires)
    j = gpd.sjoin(parts[["geometry"]], outlines[["geometry"]], how="inner", predicate="intersects")
    if len(j) == 0:
        return parent_of, hidden
    j["_ov"] = [parts.at[pi, "geometry"].intersection(outlines.at[oi, "geometry"]).area
                for pi, oi in zip(j.index, j["index_right"])]
    j = j[j["_ov"] > 0].sort_values("_ov", ascending=False)
    j = j[~j.index.duplicated(keep="first")]
    ids = raw.apply(_osm_id, axis=1)
    for pi, oi in zip(j.index, j["index_right"]):
        parent_of[pi] = ids.at[oi]
    for oi in set(j["index_right"]):
        members = [pi for pi, o in zip(j.index, j["index_right"]) if o == oi]
        cover = unary_union(parts.loc[members].geometry.values).intersection(outlines.at[oi, "geometry"]).area
        hidden[oi] = cover >= PART_COVER * outlines.at[oi, "geometry"].area
    return parent_of, hidden


OVERRIDES_PATH = ASSETS / "supplements" / "overrides.json"
OVERRIDE_FIELDS = ("name", "height", "levels", "type", "roof_shape", "roof_height", "wall_color", "roof_color", "wikidata", "website")


def apply_overrides(b: gpd.GeoDataFrame, terrain=None, path: Path = OVERRIDES_PATH) -> gpd.GeoDataFrame:
    """Hand-maintained corrections (assets/supplements/overrides.json); see the README there."""
    if not path.exists() or len(b) == 0:
        return b
    from shapely.geometry import shape

    entries = json.loads(path.read_text())
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    b = b.copy()
    applied = 0
    for e in entries:
        x, y = tr.transform(e["lon"], e["lat"])
        pt = Point(x, y)
        target = None
        if e.get("footprint"):
            geom = gpd.GeoSeries([shape(e["footprint"])], crs="EPSG:4326").to_crs(CRS_PROJ).iloc[0]
            overlapped = b[b.geometry.intersects(geom)]
            drop = [i for i in overlapped.index if overlapped.at[i, "geometry"].intersection(geom).area > 0.5 * overlapped.at[i, "geometry"].area]
            b = b.drop(index=drop)
            gz = float(terrain.sample(np.array([geom.centroid.x]), np.array([geom.centroid.y]))[0]) if terrain is not None else 0.0
            row = {c: None for c in b.columns}
            row.update({"id": f"override:{e.get('name', len(b))}", "height": 10.0, "min_height": 0.0, "height_source": "override",
                        "roof_shape": "flat", "roof_height": 0.0, "roof_source": "override", "roof_color": "roof_flat", "wall_color": "concrete",
                        "type": "yes", "footprint_source": "override", "is_part": False, "hidden": False, "ground_z": round(gz, 2), "geometry": geom})
            new_idx = int(b.index.max()) + 1
            b = gpd.GeoDataFrame(pd.concat([b, gpd.GeoDataFrame([row], index=[new_idx], crs=b.crs)]), geometry="geometry", crs=b.crs)
            target = new_idx
        elif e.get("match_name"):
            hit = b[b["name"].fillna("").str.lower().str.contains(str(e["match_name"]).lower(), regex=False) & ~b["is_part"]]
            if len(hit):
                target = hit.geometry.area.idxmax()
        else:
            inside = b[b.geometry.contains(pt) & ~b["is_part"]]
            if len(inside):
                target = inside.geometry.area.idxmax()
            else:
                near = b[(b.geometry.distance(pt) <= float(e.get("radius_m", 40))) & ~b["is_part"]]
                if len(near):
                    target = near.geometry.area.idxmax()
        if target is None:
            print(f"  [warn] override '{e.get('name')}' matched no footprint")
            continue
        for k in OVERRIDE_FIELDS:
            if k in e and e[k] is not None:
                b.at[target, k] = e[k]
        if "height" in e:
            b.at[target, "height_source"] = "override"
        if "roof_shape" in e:
            b.at[target, "roof_source"] = "override"
            if e["roof_shape"] == "flat":
                b.at[target, "roof_height"] = 0.0
        applied += 1
    if applied:
        print(f"  overrides applied: {applied}/{len(entries)}")
    return b


def process_buildings(raw_path: Path, terrain=None, merge_rowhouses: bool = True,
                      overture_path: Path | None = None, lidar_npz: Path | None = None,
                      richmond_dir: Path | None = None, vgin_path: Path | None = None,
                      richmond_structures_path: Path | None = None) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    raw = raw[raw.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # Simple 3D Buildings: keep building:part polygons as their own rows (setbacks, towers on podiums) and
    # remember which outline they belong to; the outline is hidden when its parts cover it.
    if "building:part" not in raw:
        raw["building:part"] = None
    if "building" not in raw:
        raw["building"] = None
    is_part = raw["building:part"].notna() & raw["building"].isna()
    raw = raw[raw["building"].notna() | is_part]
    # underground structures (parking decks, the Capitol extension) never rise above ground
    below = pd.Series(False, index=raw.index)
    if "location" in raw:
        below |= raw["location"].fillna("") == "underground"
    for col in ("layer", "level"):
        if col in raw:
            below |= pd.to_numeric(raw[col], errors="coerce").fillna(0) < 0
    raw = raw[~below]
    is_part = is_part.loc[raw.index]
    if "footprint_source" not in raw:
        raw["footprint_source"] = "osm"
    raw["footprint_source"] = raw["footprint_source"].fillna("osm")
    if richmond_structures_path is not None and Path(richmond_structures_path).exists():
        raw, is_part = _add_gap_footprints(raw, is_part, Path(richmond_structures_path),
                                           source="richmond_structures", element="richmond_structure",
                                           min_area=RICHMOND_STRUCTURE_MIN_AREA, subtype=1)
    elif vgin_path is not None and Path(vgin_path).exists():
        raw, is_part = _add_vgin_footprints(raw, is_part, Path(vgin_path))
    raw = raw[raw.geometry.area >= MIN_FOOTPRINT_AREA]
    is_part = is_part.loc[raw.index]
    raw["geometry"] = raw.geometry.simplify(SIMPLIFY_TOL, preserve_topology=True).buffer(0)
    raw = raw[~raw.geometry.is_empty]
    is_part = is_part.loc[raw.index]
    parent_of, hidden = _assign_parts(raw, is_part)

    # ground under each footprint first: LiDAR roof fits are relative to it
    cent = raw.geometry.centroid
    ground = terrain.sample(cent.x.values, cent.y.values) if terrain is not None else np.zeros(len(raw))
    ground_abs = ground + (terrain.base if terrain is not None else 0.0)

    ovt = match_overture(raw, load_overture(overture_path)) if overture_path else None
    rva_addr = join_addresses(raw, _read_rva(richmond_dir / "addresses.parquet") if richmond_dir else None)
    rva_zone = join_zoning(raw, _read_rva(richmond_dir / "zoning.parquet") if richmond_dir else None)
    ndsm_med, ndsm_p90, ndsm_n = sample_ndsm_stats(raw)
    fits = classify_roofs(raw, ground_abs, lidar_npz)

    rows = []
    phantoms = 0
    for k, (idx, row) in enumerate(raw.iterrows()):
        tags = _tags(row)
        area = row.geometry.area
        fit = fits[k]
        lid = float(ndsm_med[k]) if np.isfinite(ndsm_med[k]) else None
        p90 = float(ndsm_p90[k]) if np.isfinite(ndsm_p90[k]) else None
        h, levels, src = resolve_height(tags)
        # City maximum heights are in metres. Keep provenance distinct from OSM tags.
        city_height = tags.get("cch_height_m")
        if src == "default" and city_height is not None and 2.0 < float(city_height) <= 260.0:
            h, src = float(city_height), "cch_height"
        if looks_demolished(src, int(ndsm_n[k]), p90):
            phantoms += 1
            continue
        if src == "default" and lid is not None and lid > 2.0 and ndsm_n[k] >= LIDAR_TRUST_SAMPLES:
            # 2025 LiDAR beats Overture's modelled heights (which run ~1.5x low on Richmond houses)
            h, src = (fit.eave_z - ground_abs[k]) if fit and fit.shape != "flat" else lid, "lidar"
            h = max(2.5, h)
        if src == "default" and ovt is not None:
            oh, ol = ovt.at[idx, "ovt_height"], ovt.at[idx, "ovt_levels"]
            if np.isfinite(oh) and oh > 2:
                h, src = float(oh), "overture_height"
            elif np.isfinite(ol) and ol >= 1:
                h, levels, src = float(ol) * LEVEL_HEIGHT, int(ol), "overture_levels"
        if src == "default" and lid is not None and lid > 2.0:
            # eave height when a pitched roof was fitted, else the median roof surface
            h, src = (fit.eave_z - ground_abs[k]) if fit and fit.shape != "flat" else lid, "lidar"
            h = max(2.5, h)
        if src == "default":
            zh = zoning_height(rva_zone.at[idx])
            if zh is not None:
                h, src = zh, "zoning"
        if src == "lidar":
            h = cap_small_footprint(h, area, tags.get("building"))
        h = max(2.5, min(h, 260.0))
        # roof: OSM tag -> Overture tag -> LiDAR fit -> heuristic
        roof_shape, roof_h = resolve_roof(tags, h, area)
        roof_src = "osm" if not _is_nan_str(tags.get("roof:shape")) else "heuristic"
        roof_az = None
        if roof_src == "heuristic" and ovt is not None and ovt.at[idx, "ovt_roof_shape"]:
            roof_shape = ovt.at[idx, "ovt_roof_shape"]
            _, roof_h = resolve_roof({**tags, "roof:shape": roof_shape}, h, area)
            roof_src = "overture"
        if roof_src == "heuristic" and fit is not None:
            roof_shape, roof_src = fit.shape, "lidar"
            roof_h = round(fit.roof_height, 2) if fit.shape != "flat" else 0.0
            roof_az = round(fit.azimuth, 1) if fit.shape != "flat" else None
            if src not in ("osm_height", "landmark_hint") and fit.shape != "flat":
                # trust the fitted eave over levels x 3.2 when they disagree by more than one storey
                eave = fit.eave_z - ground_abs[k]
                if eave > 2.5 and abs(eave - h) > LEVEL_HEIGHT:
                    h, src = max(2.5, eave), "lidar"
        if roof_shape == "flat":
            roof_h = 0.0
        # CCH gives a maximum height, so all roof sources must fit within that total.
        if src == "cch_height":
            roof_h = min(roof_h, max(0.0, h - 2.5))
            h -= roof_h
        seed = zlib.crc32(str(row.get("id")).encode()) % 1000
        wall, roof = resolve_colors(tags, h, roof_shape, seed)
        # Regional fallback styling only; retain explicit mapped colour/material evidence.
        if REGION == "honolulu" and h > 25 and not tags.get("building:colour") and not tags.get("building:material"):
            wall = ("cream", "concrete", "sand", "concrete")[seed % 4]
        addr = None
        if tags.get("addr:housenumber") and tags.get("addr:street"):
            addr = f"{tags['addr:housenumber']} {tags['addr:street']}"
        elif isinstance(rva_addr.at[idx], str):
            addr = rva_addr.at[idx]
        rows.append({
            "id": _osm_id(row),
            "name": tags.get("name"),
            "height": round(h, 2),
            "min_height": round(resolve_min_height(tags), 2),
            "levels": levels if levels is not None else parse_levels(tags.get("building:levels")),
            "height_source": src,
            "roof_shape": roof_shape,
            "roof_height": round(roof_h, 2),
            "roof_azimuth": roof_az,
            "roof_source": roof_src,
            "roof_color": roof,
            "wall_color": wall,
            "type": str(tags.get("building") or tags.get("building:part") or "yes"),
            "landmark": None,
            "footprint_source": str(row.get("footprint_source") or "osm"),
            "source_updated": _source_date(row.get("source_updated")) or _source_date(row.get("EditDate")),
            "is_part": bool(is_part.at[idx]),
            "parent": parent_of.get(idx),
            "hidden": bool(hidden.get(idx, False)),
            "addr": addr,
            "wikidata": tags.get("wikidata"),
            "website": tags.get("website") or tags.get("contact:website"),
            "zoning": rva_zone.at[idx] if isinstance(rva_zone.at[idx], str) else None,
            "lidar_p90": round(float(ndsm_p90[k]), 2) if np.isfinite(ndsm_p90[k]) else None,
            "ground_z": round(float(ground[k]), 2),
            "geometry": row.geometry,
        })
    b = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ)
    landmarks = load_landmarks()
    outlines = b[~b["is_part"]]
    b["landmark"] = None
    b.loc[outlines.index, "landmark"] = match_landmarks(outlines, landmarks)
    # parts inherit identity from their outline (info card, landmark swap, facade style)
    by_id = b.set_index("id")
    for i in b.index[b["is_part"] & b["parent"].notna()]:
        pid = b.at[i, "parent"]
        if pid in by_id.index:
            for col in ("name", "addr", "landmark", "wikidata", "website"):
                if b.at[i, col] is None:
                    b.at[i, col] = by_id.at[pid, col]
            if b.at[i, "type"] in ("yes", "True", "true"):
                b.at[i, "type"] = by_id.at[pid, "type"]
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
    if phantoms:
        print(f"  dropped {phantoms} stale footprints (LiDAR surface at ground, no OSM height)")
    b = apply_overrides(b, terrain)
    if merge_rowhouses:
        b = _merge_rowhouses(b)
    # mixed None/float object columns would be written as strings by the GeoJSON driver
    for col in ("roof_azimuth", "lidar_p90", "levels"):
        b[col] = pd.to_numeric(b[col], errors="coerce")
    return b


# ---------------------------------------------------------------- roads / rail


def _sidewalk_side(row: pd.Series, side: str) -> bool | None:
    """None retains the renderer fallback; separate means use the mapped footway."""
    value = next((_nn(row.get(k)) for k in (f"sidewalk:{side}", "sidewalk:both", "sidewalk") if _nn(row.get(k)) is not None), None)
    if value is None:
        return None
    return value in ("yes", "both", side)


def _road_width(row: pd.Series) -> float:
    hw = str(row.get("highway"))
    w = ROAD_WIDTH.get(hw, 6.0)
    lanes = parse_levels(row.get("lanes"))
    if lanes:
        w = max(w, lanes * LANE_WIDTH)
    return round(w, 1)


WATER_REL_Z = 2.0        # endpoints lower than this (m above base) are over the river, not on a bank
LIDAR_TRUST_SAMPLES = 10  # nDSM cells inside the footprint before LiDAR outranks Overture
CONNECTOR_MAX_M = 450.0  # non-bridge stretch between two bridge chains (an island, a pier) treated as deck
CONNECTOR_MAX_TURN_DEG = 35.0  # connector ways must continue the bridge's line (not a cross street between two overpasses)
ABUTMENT_REACH_M = (2.0, 4.0, 6.0, 8.0)  # look this far back up the approach for the abutment top
ABUTMENT_MAX_RAISE_M = 3.0


def _dir_at(coords, at_start: bool) -> tuple[float, float]:
    """Unit vector pointing from the way's end node into the way."""
    (x0, y0), (x1, y1) = (coords[0], coords[1]) if at_start else (coords[-1], coords[-2])
    d = math.hypot(x1 - x0, y1 - y0) or 1.0
    return (x1 - x0) / d, (y1 - y0) / d


def _deck_endpoints(lines: gpd.GeoDataFrame, terrain) -> tuple[pd.Series, list]:
    """For bridge ways: [x0, y0, z0, x1, y1, z1] with deck elevations at the way's ends.

    Bridges are chains of OSM ways whose joints often sit over water, so per-way bank sampling reads the river.
    Ways sharing endpoints are grouped into chains; short non-bridge stretches that link two chains (the road
    across Mayo's Island) are absorbed as connectors so the deck is continuous bank to bank. Each chain is
    anchored on its land ends (degree-1 nodes above WATER_REL_Z) and every joint gets the inverse-distance
    weighted mean of the anchors: linear along a simple span, smooth on branching viaducts.
    Returns (deck series, list of connector indices that should be drawn as bridge).
    """
    out = pd.Series([None] * len(lines), index=lines.index, dtype=object)
    if "bridge" not in lines:
        return out, []
    is_bridge = (lines["bridge"].fillna("no") != "no").to_dict()
    if not any(is_bridge.values()):
        return out, []
    key = lambda x, y: (round(x, 1), round(y, 1))
    ends, length, dirs = {}, {}, {}
    hw = lines["highway"].astype(str).to_dict() if "highway" in lines else {}
    for idx, g in zip(lines.index, lines.geometry):
        (x0, y0), (x1, y1) = g.coords[0], g.coords[-1]
        ends[idx] = (key(x0, y0), key(x1, y1))
        length[idx] = float(g.length)
        dirs[idx] = {ends[idx][0]: _dir_at(g.coords, True), ends[idx][1]: _dir_at(g.coords, False)}
    cos_turn = math.cos(math.radians(CONNECTOR_MAX_TURN_DEG))

    def straight(n, idx_in, idx_out) -> bool:
        """Leaving node n from way idx_in into way idx_out keeps heading (both dirs point away from n)."""
        a, b = dirs[idx_in][n], dirs[idx_out][n]
        return -(a[0] * b[0] + a[1] * b[1]) >= cos_turn

    parent = {}
    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    def union(a, b):
        parent[find(a)] = find(b)
    for idx, (a, b) in ends.items():
        if is_bridge[idx]:
            union(a, b)
    chain_nodes = {n for idx, (a, b) in ends.items() if is_bridge[idx] for n in (a, b)}

    # connectors: BFS over non-bridge ways from every chain node, at most CONNECTOR_MAX_M, reaching another chain
    adj = {}
    for idx, (a, b) in ends.items():
        if is_bridge[idx]:
            continue
        adj.setdefault(a, []).append((b, idx)); adj.setdefault(b, []).append((a, idx))
    # A connector must continue the bridge's line with the same highway class at every joint, so a cross
    # street running between two overpasses is not mistaken for the road across an island.
    bridge_at = {}
    for idx, (a, b) in ends.items():
        if is_bridge[idx]:
            bridge_at.setdefault(a, []).append(idx); bridge_at.setdefault(b, []).append(idx)
    connectors = set()
    for start in chain_nodes:
        if start not in adj:
            continue
        best = {start: (0.0, [])}
        frontier = [start]
        while frontier:
            n = frontier.pop()
            dist, path = best[n]
            prev = [path[-1]] if path else bridge_at.get(n, [])
            for m, idx in adj.get(n, []):
                nd = dist + length[idx]
                if nd > CONNECTOR_MAX_M or (m in best and best[m][0] <= nd):
                    continue
                if not any(hw.get(w) == hw.get(idx) and straight(n, w, idx) for w in prev):
                    continue
                best[m] = (nd, path + [idx])
                if m in chain_nodes and find(m) != find(start):
                    if not any(hw.get(w) == hw.get(idx) and straight(m, idx, w) for w in bridge_at.get(m, [])):
                        continue
                    connectors.update(path + [idx])
                    for w in path + [idx]:
                        union(ends[w][0], ends[w][1])
                else:
                    frontier.append(m)
    members_idx = [idx for idx in ends if is_bridge[idx] or idx in connectors]
    degree = {}
    for idx in members_idx:
        for n in ends[idx]:
            degree[n] = degree.get(n, 0) + 1
    nodes = list(degree)
    xs = np.array([n[0] for n in nodes]); ys = np.array([n[1] for n in nodes])
    z = terrain.sample(xs, ys) if terrain is not None else np.zeros(len(nodes))
    zmap = dict(zip(nodes, z))
    # Abutments: the DEM cell under a span's end node often lies on the cut/bank slope, so look a few metres
    # back up the approach and take the highest ground (capped) as the deck anchor.
    if terrain is not None:
        away = {}
        for idx in members_idx:
            for n in ends[idx]:
                if degree[n] == 1:
                    dx, dy = dirs[idx][n]
                    away[n] = (-dx, -dy)
        if away:
            an = list(away)
            sx = np.array([n[0] + away[n][0] * r for n in an for r in ABUTMENT_REACH_M])
            sy = np.array([n[1] + away[n][1] * r for n in an for r in ABUTMENT_REACH_M])
            sz = terrain.sample(sx, sy).reshape(len(an), len(ABUTMENT_REACH_M))
            for n, row in zip(an, sz):
                if zmap[n] > WATER_REL_Z:
                    zmap[n] = float(min(max(zmap[n], row.max()), zmap[n] + ABUTMENT_MAX_RAISE_M))
    # A bridge end can sit over a road beneath it: the bare-earth DEM then
    # reads the underpass, not the deck. Fit the connected approach beyond that
    # cut, only when its grade is consistent and it continues the same road class.
    if terrain is not None:
        member_set = set(members_idx)
        for n in nodes:
            bridge_classes = {lines.at[i, "highway"] for i in members_idx if n in ends[i]} if "highway" in lines else set()
            for approach, (a, b) in ends.items():
                if approach in member_set or n not in (a, b):
                    continue
                if bridge_classes and lines.at[approach, "highway"] not in bridge_classes:
                    continue
                line = lines.at[approach, "geometry"]
                if line.length < 28:
                    continue
                distances = np.array([20., 24., 28.])
                points = [line.interpolate(float(d if n == a else line.length-d)) for d in distances]
                elevations = terrain.sample(np.array([p.x for p in points]), np.array([p.y for p in points]))
                slope, intercept = np.polyfit(distances, elevations, 1)
                residual = np.max(np.abs(elevations-(slope*distances+intercept)))
                if abs(slope) <= 0.15 and residual <= 0.6 and 1.0 < intercept-zmap[n] <= 12.0:
                    zmap[n] = float(intercept)
    comps = {}
    for n in nodes:
        comps.setdefault(find(n), []).append(n)
    deck_z = {}
    for members in comps.values():
        anchors = [n for n in members if degree[n] == 1 and zmap[n] > WATER_REL_Z]
        if not anchors:
            top = max(zmap[n] for n in members)
            for n in members:
                deck_z[n] = top
            continue
        # nodes whose ground is at/above the interpolated deck are on land (a bridge touching down mid-chain,
        # a street crossing at grade): promote them to anchors and re-interpolate until stable
        anchors = list(anchors)
        for _ in range(5):
            for n in members:
                if n in anchors:
                    deck_z[n] = zmap[n]
                    continue
                w = np.array([1.0 / (math.hypot(n[0] - a[0], n[1] - a[1]) + 1.0) for a in anchors])
                deck_z[n] = float(np.dot(w, [zmap[a] for a in anchors]) / w.sum())
            promote = [n for n in members if n not in anchors and zmap[n] > WATER_REL_Z and zmap[n] >= deck_z[n] - 1.0]
            if not promote:
                break
            anchors.extend(promote)
    vals = {}
    for idx in members_idx:
        a, b = ends[idx]
        vals[idx] = [round(a[0], 2), round(a[1], 2), round(float(deck_z[a]), 2), round(b[0], 2), round(b[1], 2), round(float(deck_z[b]), 2)]
    out.loc[list(vals)] = list(vals.values())
    return out, sorted(connectors)


RAMP_TOUCH_M = 0.6
RAMP_MIN_GAP_M = 1.0
_CLASS_RANK = {"motorway": 6, "trunk": 5, "primary": 4, "secondary": 3, "tertiary": 2, "motorway_link": 3, "trunk_link": 2,
               "primary_link": 2, "secondary_link": 1, "tertiary_link": 1}


def _rank(hw) -> int:
    return _CLASS_RANK.get(str(hw), 0)


def _ramp_decks(lines: gpd.GeoDataFrame, deck: pd.Series, bridge_flag: pd.Series, terrain) -> tuple[pd.Series, pd.Series]:
    """Non-bridge ways (ramps, approaches) whose end touches an elevated deck get their own deck so they climb
    from terrain to the deck instead of stopping short. Returns (deck, ramp_flag)."""
    ramp = pd.Series(False, index=lines.index)
    bridges = lines[bridge_flag & deck.notna()]
    if len(bridges) == 0:
        return deck, ramp
    from shapely.strtree import STRtree
    from shapely.geometry import Point

    geoms = list(bridges.geometry)
    idxs = list(bridges.index)
    tree = STRtree(geoms)

    def deck_at(d, x, y):
        dx, dy = d[3] - d[0], d[4] - d[1]
        L = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - d[0]) * dx + (y - d[1]) * dy) / L)) if L > 1e-6 else 0.0
        return d[2] + (d[5] - d[2]) * t

    deck = deck.copy()
    for idx in lines.index[~bridge_flag]:
        g = lines.at[idx, "geometry"]
        ends = [g.coords[0], g.coords[-1]]
        zs = []
        touched = False
        for x, y in ends:
            pt = Point(x, y)
            best = None
            for k in tree.query(pt.buffer(RAMP_TOUCH_M)):
                if geoms[k].distance(pt) <= RAMP_TOUCH_M:
                    # a mainline never ramps up to a lower-class bridge that merely touches it (a link flyover
                    # landing beside a sunken expressway would otherwise hump the expressway)
                    if "highway" in lines and _rank(lines.at[idxs[k], "highway"]) < _rank(lines.at[idx, "highway"]):
                        continue
                    z = deck_at(deck.at[idxs[k]], x, y)
                    best = z if best is None else max(best, z)
            tz = float(terrain.sample(np.array([x]), np.array([y]))[0]) if terrain is not None else 0.0
            if best is not None and best - tz > RAMP_MIN_GAP_M:
                zs.append(best); touched = True
            else:
                zs.append(tz)
        if touched:
            (x0, y0), (x1, y1) = ends
            deck.at[idx] = [round(x0, 2), round(y0, 2), round(zs[0], 2), round(x1, 2), round(y1, 2), round(zs[1], 2)]
            ramp.at[idx] = True
    return deck, ramp


def process_roads(raw_path: Path, terrain=None) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
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
    deck, connectors = _deck_endpoints(lines, terrain)
    bridge_flag = (lines["bridge"].fillna("no") != "no") if "bridge" in lines else pd.Series(False, index=lines.index)
    if connectors:
        bridge_flag = bridge_flag.copy()
        bridge_flag.loc[connectors] = True
    deck, ramp_flag = _ramp_decks(lines, deck, bridge_flag, terrain)
    roads = gpd.GeoDataFrame({
        "id": lines.apply(_osm_id, axis=1),
        "name": lines["name"].map(_nn) if "name" in lines else None,
        "highway": lines["highway"],
        "lanes": lines["lanes"].map(parse_levels) if "lanes" in lines else None,
        "width": lines.apply(_road_width, axis=1),
        "oneway": (lines["oneway"].fillna("no") == "yes") if "oneway" in lines else False,
        "surface": lines["surface"].map(_nn) if "surface" in lines else None,
        "footway": lines["footway"].map(_nn) if "footway" in lines else None,
        "sidewalk_left": lines.apply(lambda row: _sidewalk_side(row, "left"), axis=1),
        "sidewalk_right": lines.apply(lambda row: _sidewalk_side(row, "right"), axis=1),
        "bus_lanes": lines["lanes:bus"].map(parse_levels) if "lanes:bus" in lines else None,
        "bus_lane_side": lines.apply(lambda row: "right" if REGION == "richmond" and
            row.get("name") in ("East Broad Street", "West Broad Street") and
            row.get("oneway") == "yes" and parse_levels(row.get("lanes:bus")) else None, axis=1),
        "bus_only": lines.apply(lambda row: row.get("highway") == "busway" or
            (row.get("bus") in ("yes", "designated") and
             (row.get("access") in ("no", "private") or row.get("motor_vehicle") == "no")), axis=1),
        "sidewalk": (~lines["sidewalk"].fillna("no").isin(["no", "none"])) if "sidewalk" in lines else False,
        "bridge": bridge_flag,
        "ramp": ramp_flag,
        "tunnel": (lines["tunnel"].fillna("no") != "no") if "tunnel" in lines else False,
        "layer": lines["layer"].map(parse_levels).fillna(0).astype(int) if "layer" in lines else 0,
        "deck": deck,
        "geometry": lines.geometry,
    }, crs=CRS_PROJ)
    pts = raw[(raw.geometry.geom_type == "Point")]
    if "highway" in pts:
        pts = pts[pts["highway"] == "crossing"]
    else:
        pts = pts.iloc[0:0]
    topology = _match_crossings_to_roads(pts, roads)
    crossings = gpd.GeoDataFrame({
        "id": pts.apply(_osm_id, axis=1) if len(pts) else [],
        "crossing": pts["crossing"].map(_nn).fillna("unmarked") if "crossing" in pts else "unmarked",
        "road_id": topology["road_id"],
        "road_width": topology["road_width"],
        "road_dx": topology["road_dx"],
        "road_dy": topology["road_dy"],
        "road_x": topology["road_x"],
        "road_y": topology["road_y"],
        "crossing_island": (pts["crossing:island"].fillna("no") == "yes").tolist() if "crossing:island" in pts else [False] * len(pts),
        "geometry": pts.geometry,
    }, crs=CRS_PROJ)
    return roads, crossings


def _match_crossings_to_roads(points: gpd.GeoDataFrame, roads: gpd.GeoDataFrame) -> dict[str, list]:
    """Attach each crossing to the road it crosses, using mapped crossing-footway direction when available."""
    empty = {k: [None] * len(points) for k in ("road_id", "road_width", "road_dx", "road_dy", "road_x", "road_y")}
    if len(points) == 0 or len(roads) == 0:
        return empty
    from shapely.geometry import LineString
    from shapely.strtree import STRtree

    minor = {"footway", "path", "steps", "cycleway", "pedestrian", "service", "living_street", "track"}
    motor = roads[~roads["highway"].isin(minor) & ~roads["bridge"] & ~roads["tunnel"]].reset_index(drop=True)
    foot = roads[roads["footway"] == "crossing"].reset_index(drop=True)
    if len(motor) == 0:
        return empty
    motor_geoms = list(motor.geometry)
    motor_tree = STRtree(motor_geoms)
    foot_geoms = list(foot.geometry)
    foot_tree = STRtree(foot_geoms) if foot_geoms else None

    def tangent(geom, point: Point) -> tuple[float, float]:
        coords = list(geom.coords)
        best = (1.0, 0.0)
        best_dist = float("inf")
        for a, b in zip(coords, coords[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            dist = LineString([a, b]).distance(point)
            if dist < best_dist:
                best_dist = dist
                best = (dx / length, dy / length)
        return best

    out = {k: [] for k in empty}
    for point in points.geometry:
        foot_dir = None
        if foot_tree is not None:
            nearest_foot = min(foot_tree.query(point.buffer(2)), key=lambda i: foot_geoms[i].distance(point), default=None)
            if nearest_foot is not None and foot_geoms[nearest_foot].distance(point) <= 1.5:
                foot_dir = tangent(foot_geoms[nearest_foot], point)
        best = None
        for i in motor_tree.query(point.buffer(15)):
            row = motor.iloc[i]
            geom = motor_geoms[i]
            distance = geom.distance(point)
            if distance > float(row["width"]) / 2 + 2:
                continue
            road_dir = tangent(geom, point)
            parallel_penalty = abs(road_dir[0] * foot_dir[0] + road_dir[1] * foot_dir[1]) * 4 if foot_dir else 0
            score = distance + parallel_penalty
            if best is None or score < best[0]:
                projected = geom.interpolate(geom.project(point))
                best = (score, row, road_dir, projected)
        if best is None:
            for key in out:
                out[key].append(None)
            continue
        _, row, (dx, dy), projected = best
        out["road_id"].append(row["id"])
        out["road_width"].append(round(float(row["width"]), 2))
        out["road_dx"].append(round(dx, 6))
        out["road_dy"].append(round(dy, 6))
        out["road_x"].append(round(projected.x, 2))
        out["road_y"].append(round(projected.y, 2))
    return out


def process_rail(raw_path: Path, terrain=None) -> gpd.GeoDataFrame:
    raw = _read(raw_path)
    if len(raw) == 0:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    lines = raw[raw.geometry.geom_type.isin(["LineString", "MultiLineString"])].explode(index_parts=False)
    lines = lines[lines["railway"].isin(["rail", "light_rail", "tram", "subway"])]
    deck, connectors = _deck_endpoints(lines, terrain)
    bridge_flag = (lines["bridge"].fillna("no") != "no") if "bridge" in lines else pd.Series(False, index=lines.index)
    if connectors:
        bridge_flag = bridge_flag.copy()
        bridge_flag.loc[connectors] = True
    deck, ramp_flag = _ramp_decks(lines, deck, bridge_flag, terrain)
    return gpd.GeoDataFrame({
        "id": lines.apply(_osm_id, axis=1),
        "name": lines["name"].map(_nn) if "name" in lines else None,
        "railway": lines["railway"],
        "bridge": bridge_flag,
        "ramp": ramp_flag,
        "layer": lines["layer"].map(parse_levels).fillna(0).astype(int) if "layer" in lines else 0,
        "deck": deck,
        "geometry": lines.geometry,
    }, crs=CRS_PROJ)


# ---------------------------------------------------------------- landuse / water / pois


def _landuse_kind(row: pd.Series) -> str | None:
    lu, le, am, na, pl = (_nn(row.get(k)) for k in ("landuse", "leisure", "amenity", "natural", "place"))
    if na in ("beach", "sand"):
        return "beach"
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


WATER_LEVEL_PCT = 40      # DEM percentile inside a canal/pond polygon taken as its surface
WATER_LEVEL_LIFT_M = 0.3  # above that percentile (the polygon edges climb the banks)


def water_levels(polys: gpd.GeoDataFrame, terrain, spacing: float = 2.0) -> list[float | None]:
    """Flat surface height (m above base) per non-river polygon from the DEM inside it; None for rivers /
    no terrain. Canals and ponds are still water: the DEM inside the outline is the bed plus bank slopes, so a
    low percentile is the water and the terrain grid is flattened to it under the polygon (see Terrain.tile_grid)."""
    out: list[float | None] = [None] * len(polys)
    if terrain is None or len(polys) == 0:
        return out
    from shapely import contains_xy

    for k, (kind, g) in enumerate(zip(polys["kind"], polys.geometry)):
        if kind == "river" or g is None or g.is_empty:
            continue
        minx, miny, maxx, maxy = g.bounds
        gx, gy = np.meshgrid(np.arange(minx, maxx + spacing, spacing), np.arange(miny, maxy + spacing, spacing))
        gx, gy = gx.ravel(), gy.ravel()
        inside = contains_xy(g, gx, gy)
        if inside.sum() < 3:
            ring = np.array(g.exterior.coords) if g.geom_type == "Polygon" else np.array(max(g.geoms, key=lambda p: p.area).exterior.coords)
            gx, gy, inside = ring[:, 0], ring[:, 1], np.ones(len(ring), bool)
        # Large water features can extend beyond this region's DEM. Do not let its
        # fallback median masquerade as measured water elevations.
        sample = getattr(terrain, "sample_valid", terrain.sample)
        z = sample(gx[inside], gy[inside])
        z = z[np.isfinite(z)]
        if z.size:
            out[k] = round(float(np.percentile(z, WATER_LEVEL_PCT)) + WATER_LEVEL_LIFT_M, 2)
    return out


def process_water(raw_path: Path, terrain=None) -> gpd.GeoDataFrame:
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
    if "name" in polys:
        polys = polys[~polys["name"].fillna("").str.contains("dry bed", case=False)].copy()
    polys["geometry"] = polys.geometry.simplify(1.0, preserve_topology=True).buffer(0)
    return gpd.GeoDataFrame({
        "id": polys.apply(_osm_id, axis=1),
        "name": polys["name"].map(_nn) if "name" in polys else None,
        "kind": polys["kind"],
        "water_z": water_levels(polys, terrain),
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
    if hw == "traffic_signals":
        return "traffic_signals"
    if am == "fountain":
        return "fountain"
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
