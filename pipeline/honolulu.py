"""CCH footprints enriched with OSM semantics, and a coastal ocean mask."""
from __future__ import annotations

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from config import CRS_PROJ, TILE_SIZE, snap_down


def coastal_structures(raw: gpd.GeoDataFrame, base_elevation: float = 0) -> gpd.GeoDataFrame:
    """OSM coastal outlines; line widths and crest heights are visual estimates, not surveys."""
    rows = []
    for _, row in raw.to_crs(CRS_PROJ).iterrows():
        kind = row.get("man_made")
        if kind not in ("breakwater", "groyne", "seawall", "pier"):
            if row.get("barrier") != "sea_wall":
                continue
            kind = "seawall"
        geom = row.geometry
        if geom.geom_type in ("LineString", "MultiLineString"):
            # Keep mapped polygons exactly; only centerlines need an estimated width.
            geom = geom.buffer(1.5 if kind in ("breakwater", "groyne") else 0.6, cap_style=2, join_style=2)
        if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.is_empty:
            continue
        source = row.get("source")
        traced = isinstance(source, str) and source.startswith("Esri World Imagery")
        rows.append({"id": f"{'trace' if traced else 'osm'}:{row.get('id')}", "name": row.get("name"), "kind": kind,
                     "source": source if traced else "OpenStreetMap", "dimensions_source": "visual estimate",
                     "base_z": -base_elevation - 0.5,
                     "top_z": -base_elevation + (1.5 if kind in ("groyne", "pier") else 0.8),
                     "geometry": geom})
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ) if rows else gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)


def coastal_green_spaces(landuse: gpd.GeoDataFrame, ocean: gpd.GeoDataFrame, distance: float = 180):
    """Split park/grass polygons at the coastal band without duplicating their land cover."""
    if ocean.empty:
        return landuse
    band = ocean.geometry.union_all().buffer(distance)
    rows = []
    for _, row in landuse.iterrows():
        if row["kind"] not in ("park", "grass") or not row.geometry.intersects(band):
            rows.append({**row.to_dict(), "coastal": False})
            continue
        for coastal, geometry in ((True, row.geometry.intersection(band)),
                                  (False, row.geometry.difference(band))):
            if not geometry.is_empty and geometry.area > 0:
                rows.append({**row.to_dict(), "id": f"{row['id']}:{'coast' if coastal else 'inland'}",
                             "geometry": geometry, "coastal": coastal})
    return gpd.GeoDataFrame(rows, crs=landuse.crs)


def enrich_buildings(city: gpd.GeoDataFrame, osm: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Use city outlines; transfer OSM tags only from a strong spatial match.

    Retain unmatched OSM buildings/parts only when <20% overlaps city outlines,
    avoiding duplicate extrusions. Height fields with ambiguous units are not used.
    """
    city = city.to_crs(CRS_PROJ).copy().reset_index(drop=True)
    city.geometry = city.geometry.make_valid()
    city = city[city.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    city["id"] = city["objectid"].astype(str)
    city["element"] = "cch"
    city["building"] = "yes"
    city["footprint_source"] = "cch"
    city["name"] = city["structurename"].replace("", None)
    heights = pd.to_numeric(city["maxht_m"], errors="coerce")
    city["cch_height_m"] = heights.where(heights.between(2.0, 260.0, inclusive="right"))
    tag_cols = ["name", "building", "height", "building:levels", "roof:shape", "roof:height",
                "addr:housenumber", "addr:street", "wikidata", "website", "building:colour", "roof:colour"]
    for col in tag_cols:
        if col not in city:
            city[col] = None
    if osm.empty:
        return city
    osm = osm.to_crs(CRS_PROJ).copy().reset_index(drop=True)
    osm["id"] = osm["id"].astype(str)
    osm.geometry = osm.geometry.make_valid()
    osm = osm[osm.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    matched = 0
    for idx, row in city.iterrows():
        best, score = None, 0.5
        for oi in osm.sindex.query(row.geometry, predicate="intersects"):
            candidate = osm.iloc[oi]
            intersection = row.geometry.intersection(candidate.geometry).area
            union = row.geometry.area + candidate.geometry.area - intersection
            iou = intersection / union if union else 0
            if iou > score:
                best, score = candidate, iou
        if best is not None:
            matched += 1
            for col in tag_cols:
                value = best.get(col)
                if pd.notna(value) and value != "":
                    city.at[idx, col] = value
    extras = []
    for idx, row in osm.iterrows():
        candidates = city.iloc[city.sindex.query(row.geometry, predicate="intersects")]
        overlap = row.geometry.intersection(candidates.geometry.union_all()).area if len(candidates) else 0
        if row.geometry.area > 0 and overlap / row.geometry.area < 0.2:
            extras.append(idx)
    extra = osm.loc[extras].copy()
    extra["footprint_source"] = "osm"
    print(f"  CCH: {len(city)} footprints, {city.cch_height_m.notna().sum()} valid maxht_m; "
          f"OSM: {matched} matches, {len(extra)} gap-fill footprints", flush=True)
    return gpd.GeoDataFrame(pd.concat([city, extra], ignore_index=True), crs=CRS_PROJ)


def ocean_layer(coast: gpd.GeoDataFrame, bbox, base_elevation: float = 0,
                coast_is_water: bool = False) -> gpd.GeoDataFrame:
    """Clip water or subtract land across the entire snapped tile extent.

    CCH Coast_Poly is an offshore rectangle with island holes: pass coast_is_water=True.
    """
    from pyproj import Transformer
    import math

    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    w, s, e, n = bbox
    corners = [tr.transform(x, y) for x, y in ((w, s), (e, s), (e, n), (w, n))]
    xs, ys = zip(*corners)
    extent = box(snap_down(min(xs), TILE_SIZE), snap_down(min(ys), TILE_SIZE),
                 math.ceil(max(xs) / TILE_SIZE) * TILE_SIZE, math.ceil(max(ys) / TILE_SIZE) * TILE_SIZE)
    mask = coast.to_crs(CRS_PROJ).geometry.make_valid().union_all()
    ocean = extent.intersection(mask) if coast_is_water else extent.difference(mask)
    if ocean.is_empty:
        return gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    return gpd.GeoDataFrame([{"id": "cch:ocean", "name": "Pacific Ocean", "kind": "ocean",
                              "water_z": -base_elevation, "geometry": ocean}], crs=CRS_PROJ)
