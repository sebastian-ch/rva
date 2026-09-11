"""Process raw data into per-tile GeoJSON + terrain grids (see DATA_FORMAT.md).

Usage:
    python pipeline/build_tiles.py [--bbox W S E N] [--no-merge] [--clean]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import box

from config import CRS_PROJ, DATA_RAW, DATA_TILES, DEFAULT_BBOX, TILE_SIZE, REGION, PROFILE, bbox_slug, snap_down
from process import (process_buildings, process_landuse, process_pois, process_rail, process_richmond_decks,
                     process_roads, process_water)
from terrain import Terrain
from landmarks import resolve_landmarks

POINT_LAYERS = {"pois", "crossings"}


def _tile_layer(gdf: gpd.GeoDataFrame, spatial_index, name: str, tile_box):
    """Apply the standard per-layer ownership and clipping rules for one tile."""
    cand = gdf.iloc[list(spatial_index.query(tile_box, predicate="intersects"))]
    if len(cand) == 0:
        return cand
    if name in POINT_LAYERS:
        return cand
    if name == "buildings":
        minx, miny, maxx, maxy = tile_box.bounds
        c = cand.geometry.centroid
        return cand[(c.x >= minx) & (c.x < maxx) & (c.y >= miny) & (c.y < maxy)]
    return gpd.clip(cand, tile_box, keep_geom_type=True)


def _write_layer(gdf: gpd.GeoDataFrame, dst: Path) -> int:
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]
    if len(gdf) == 0:
        return 0
    # compact: 2 decimals (cm) is plenty at this scale
    gdf = gdf.copy()
    if "deck" in gdf:
        gdf["deck"] = gdf["deck"].map(lambda v: json.dumps(v) if isinstance(v, list) else None)
    gdf["geometry"] = gdf.geometry.set_precision(0.01)
    gdf = gdf[~gdf.geometry.is_empty]
    gdf.to_file(dst, driver="GeoJSON", COORDINATE_PRECISION=2, RFC7946="NO")
    return len(gdf)


def build(bbox, merge_rowhouses=True, clean=False) -> Path:
    slug = bbox_slug(bbox)
    raw_dir = DATA_RAW / f"osm_{slug}"
    dem_path = DATA_RAW / f"dem_{slug}.tif"
    if not raw_dir.exists():
        sys.exit(f"raw OSM dir missing: {raw_dir}. Run pipeline/fetch.py first.")
    if clean and DATA_TILES.exists():
        for p in DATA_TILES.iterdir():
            if p.is_dir():
                shutil.rmtree(p)
    DATA_TILES.mkdir(parents=True, exist_ok=True)

    terrain = Terrain(dem_path) if dem_path.exists() else None
    if terrain is None:
        print("  [warn] no DEM found; terrain flat")

    t0 = time.time()
    print("processing layers...")
    buildings_path = raw_dir / "buildings.parquet"
    if REGION == "honolulu":
        from honolulu import enrich_buildings
        city_path = DATA_RAW / f"cch_{slug}.parquet"
        if not city_path.exists():
            sys.exit("CCH data missing: run pipeline/fetch_honolulu.py with ISO_REGION=honolulu first")
        enriched = enrich_buildings(gpd.read_parquet(city_path), gpd.read_parquet(buildings_path))
        buildings_path = DATA_RAW / f"enriched_buildings_{slug}.parquet"
        enriched.to_parquet(buildings_path)
    roads, crossings = process_roads(raw_dir / "roads.parquet", terrain)
    beach_profile = None
    layers = {
        "buildings": process_buildings(buildings_path, terrain, merge_rowhouses,
                                       overture_path=DATA_RAW / f"overture_{slug}.parquet",
                                       lidar_npz=DATA_RAW / f"lidar_{slug}.npz",
                                       richmond_dir=DATA_RAW / f"richmond_{slug}",
                                       richmond_structures_path=DATA_RAW / f"richmond_{slug}" / "structures.parquet",
                                       vgin_path=DATA_RAW / f"vgin_{slug}.parquet"),
        "roads": roads,
        "crossings": crossings,
        "rail": process_rail(raw_dir / "rail.parquet", terrain),
        "landuse": process_landuse(raw_dir / "landuse.parquet"),
        "water": process_water(raw_dir / "water.parquet", terrain),
        "pois": process_pois(raw_dir / "pois.parquet"),
    }
    hydro = None
    surveyed_trees = False
    if REGION == "richmond":
        city_decks = process_richmond_decks(DATA_RAW / f"richmond_{slug}" / "structures.parquet")
        if len(city_decks):
            layers["landuse"] = gpd.GeoDataFrame(pd.concat([layers["landuse"], city_decks], ignore_index=True), crs=CRS_PROJ)
        hydro_path = DATA_RAW / "richmond_hydro_2025.gpkg"
        if hydro_path.exists() and terrain:
            from hydro import load_hydro, merge_water
            hydro = load_hydro(hydro_path, bbox, terrain.base)
            layers["water"] = merge_water(layers["water"], hydro)
            # Land polygons must stop at the surveyed shoreline, including island holes.
            layers["landuse"].geometry = layers["landuse"].geometry.difference(hydro.mask)
        from riverfront import canal_banks
        banks = canal_banks(layers["water"])
        if len(banks):
            layers["landuse"] = gpd.GeoDataFrame(pd.concat([layers["landuse"], banks], ignore_index=True), crs=CRS_PROJ)
        inventory_path = DATA_RAW / f"richmond_{slug}" / "trees.parquet"
        lidar_path = DATA_RAW / f"lidar_{slug}.npz"
        if inventory_path.exists():
            from vegetation import inventory_trees, lidar_canopies, merge_trees
            inventory = inventory_trees(gpd.read_parquet(inventory_path))
            crowns = gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
            if lidar_path.exists() and terrain:
                crown_path = DATA_RAW / f"canopies_{slug}.parquet"
                inputs = [lidar_path, dem_path, Path(__file__).with_name("vegetation.py")]
                if crown_path.exists() and crown_path.stat().st_mtime > max(p.stat().st_mtime for p in inputs):
                    crowns = gpd.read_parquet(crown_path)
                else:
                    crowns = lidar_canopies(lidar_path, terrain)
                    crowns.to_parquet(crown_path)
                surveyed_trees = len(crowns) > 0
            layers["pois"] = merge_trees(layers["pois"], inventory, crowns, layers["buildings"], layers["water"])
            print(f"  vegetation: {len(inventory)} active inventory trees, {len(crowns)} LiDAR crowns")
    if REGION == "honolulu":
        from honolulu import ocean_layer, coastal_green_spaces, coastal_structures
        coast = gpd.read_parquet(DATA_RAW / f"coast_{slug}.parquet")
        ocean = ocean_layer(coast, bbox, terrain.base if terrain else 0.0, coast_is_water=True)
        beaches = layers["landuse"][layers["landuse"].kind == "beach"]
        if len(beaches) and len(ocean):
            beach_profile = (beaches.geometry.union_all(), ocean.geometry.union_all(), float(ocean.iloc[0].water_z))
        layers["landuse"] = coastal_green_spaces(layers["landuse"], ocean)
        structures_path = raw_dir / "coastal_structures.parquet"
        structure_sources = []
        if structures_path.exists():
            structure_sources.append(gpd.read_parquet(structures_path).to_crs(CRS_PROJ))
        supplement = Path(__file__).resolve().parents[1] / "assets/supplements/honolulu-coastal.geojson"
        if supplement.exists():
            structure_sources.append(gpd.read_file(supplement).to_crs(CRS_PROJ))
        if structure_sources:
            structures = coastal_structures(gpd.GeoDataFrame(pd.concat(structure_sources, ignore_index=True), crs=CRS_PROJ), terrain.base if terrain else 0.0)
            layers["landuse"] = gpd.GeoDataFrame(pd.concat([layers["landuse"], structures], ignore_index=True), crs=CRS_PROJ)
        layers["water"] = gpd.GeoDataFrame(pd.concat([layers["water"], ocean], ignore_index=True), crs=CRS_PROJ)
    for k, v in layers.items():
        print(f"  {k:10s} {len(v):6d}")
    b = layers["buildings"]
    if len(b):
        print("  height sources:", b["height_source"].value_counts().to_dict())
        print("  roof sources:", b["roof_source"].value_counts().to_dict())
        print("  landmarks matched:", sorted(b["landmark"].dropna().tolist()))
    print(f"  {time.time() - t0:.1f}s")

    # grid
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    west, south, east, north = bbox
    xs, ys = zip(*[tr.transform(x, y) for x, y in ((west, south), (east, south), (east, north), (west, north))])
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    ox, oy = snap_down(minx, TILE_SIZE), snap_down(miny, TILE_SIZE)
    nx = int(np.ceil((maxx - ox) / TILE_SIZE))
    ny = int(np.ceil((maxy - oy) / TILE_SIZE))
    print(f"grid origin ({ox:.0f}, {oy:.0f}) tiles {nx} x {ny}")

    # spatial indexes once
    sidx = {k: v.sindex for k, v in layers.items() if len(v)}
    still = layers["water"][layers["water"]["water_z"].notna()] if "water_z" in layers["water"] else layers["water"].iloc[0:0]
    tiles_meta = []
    t0 = time.time()
    for tx in range(nx):
        for ty in range(ny):
            tminx, tminy = ox + tx * TILE_SIZE, oy + ty * TILE_SIZE
            tile_box = box(tminx, tminy, tminx + TILE_SIZE, tminy + TILE_SIZE)
            tid = f"{tx}_{ty}"
            tdir = DATA_TILES / tid
            written = []
            counts = {}
            for name, gdf in layers.items():
                if name not in sidx:
                    continue
                part = _tile_layer(gdf, sidx[name], name, tile_box)
                if len(part) == 0:
                    continue
                tdir.mkdir(exist_ok=True)
                n = _write_layer(part, tdir / f"{name}.geojson")
                if n:
                    written.append(name)
                    counts[name] = n
            if terrain is not None and (written or True):
                tdir.mkdir(exist_ok=True)
                flats = [(g, float(z)) for g, z in zip(still.geometry, still["water_z"]) if g.intersects(tile_box)] if len(still) else None
                # Resolve land/water edges at 2.5 m instead of the normal 10 m grid.
                # Entirely underwater tiles keep the inexpensive normal grid.
                shore = REGION == "honolulu" and flats and any(not g.covers(tile_box) for g, _ in flats)
                hydro_here = hydro is not None and hydro.mask.intersects(tile_box)
                grid = terrain.tile_grid(tminx, tminy, TILE_SIZE,
                                                                               n=101 if shore else 26, flatten=flats,
                                                                               beach_profile=beach_profile if beach_profile and beach_profile[0].buffer(8).intersects(tile_box) else None)
                if hydro_here:
                    grid = hydro.apply_grid(grid)
                (tdir / "terrain.json").write_text(json.dumps(grid))
                written.append("terrain")
            if written:
                tiles_meta.append({"id": tid, "x": tx, "y": ty,
                                   "bbox": [tminx, tminy, tminx + TILE_SIZE, tminy + TILE_SIZE],
                                   "layers": written, "counts": counts, "surveyed_trees": surveyed_trees})
    index = {
        "region": REGION,
        "title": PROFILE["title"],
        "crs": CRS_PROJ,
        "tile_size": TILE_SIZE,
        "origin": [ox, oy],
        "grid": [nx, ny],
        "bbox_wgs84": list(bbox),
        "bbox_proj": [minx, miny, maxx, maxy],
        "base_elevation": terrain.base if terrain else 0.0,
        "tiles": tiles_meta,
    }
    (DATA_TILES / "index.json").write_text(json.dumps(index, indent=1))
    lms = resolve_landmarks(raw_dir, layers["buildings"], terrain)
    (DATA_TILES / "landmarks.json").write_text(json.dumps(lms, indent=1))
    # One compact index makes search independent of the currently streamed tiles.
    search = []
    seen = set()
    seen_landmarks = set()
    for _, row in layers["buildings"].iterrows():
        name, addr = row.get("name"), row.get("addr")
        landmark = row.get("landmark")
        landmark = landmark if isinstance(landmark, str) else None
        name = name if isinstance(name, str) else None
        addr = addr if isinstance(addr, str) else None
        if landmark in lms:
            name = lms[landmark]["name"]
        if (not name and not addr) or (row.get("hidden") and not landmark) or row["id"] in seen or (landmark and landmark in seen_landmarks):
            continue
        c = row.geometry.representative_point()
        search.append(dict(id=row["id"], name=name, addr=addr, x=round(c.x, 2), y=round(c.y, 2),
                           ground_z=float(row.get("ground_z", 0)), landmark=landmark))
        seen.add(row["id"])
        if landmark:
            seen_landmarks.add(landmark)
    for slug, lm in lms.items():
        if lm["in_first_slice"] and lm["how"] and not any(r.get("landmark") == slug for r in search):
            search.append(dict(id=f"landmark:{slug}", name=lm["name"], addr=None, x=lm["x"], y=lm["y"],
                               ground_z=lm.get("ground_z", 0), landmark=slug))
    (DATA_TILES / "search.json").write_text(json.dumps(search, separators=(",", ":"), allow_nan=False))
    unmatched = [k for k, v in lms.items() if v["in_first_slice"] and v["how"] is None]
    print(f"  landmarks resolved: {sum(v['how'] is not None for v in lms.values())}/{len(lms)}; unmatched in slice: {unmatched}")
    if terrain:
        terrain.close()
    total = sum(p.stat().st_size for p in DATA_TILES.rglob("*") if p.is_file())
    print(f"wrote {len(tiles_meta)} tiles, {total / 1e6:.1f} MB, {time.time() - t0:.1f}s -> {DATA_TILES}")
    try:
        from qa_report import write_report
        write_report(DATA_TILES)
    except Exception as exc:  # QA must never break a build
        print(f"  [warn] QA report failed: {exc}")
    return DATA_TILES / "index.json"


def rebuild_road_tiles(bbox) -> Path:
    """Reprocess and rewrite only roads/crossings while preserving every other tile layer."""
    index_path = DATA_TILES / "index.json"
    if not index_path.exists():
        sys.exit("tile index missing: run a full pipeline/build_tiles.py build first")
    index = json.loads(index_path.read_text())
    if list(bbox) != index.get("bbox_wgs84"):
        sys.exit("--roads-only requires the existing tile index to use the requested bounding box")

    slug = bbox_slug(bbox)
    raw_dir = DATA_RAW / f"osm_{slug}"
    if not raw_dir.exists():
        sys.exit(f"raw OSM dir missing: {raw_dir}. Run pipeline/fetch.py first.")
    dem_path = DATA_RAW / f"dem_{slug}.tif"
    terrain = Terrain(dem_path) if dem_path.exists() else None
    t0 = time.time()
    roads, crossings = process_roads(raw_dir / "roads.parquet", terrain)
    layers = {"roads": roads, "crossings": crossings}
    indexes = {name: layer.sindex for name, layer in layers.items() if len(layer)}

    for meta in index["tiles"]:
        tile_box = box(*meta["bbox"])
        tdir = DATA_TILES / meta["id"]
        for name, layer in layers.items():
            dst = tdir / f"{name}.geojson"
            part = _tile_layer(layer, indexes[name], name, tile_box) if name in indexes else layer
            count = _write_layer(part, dst) if len(part) else 0
            if not count and dst.exists():
                dst.unlink()
            if count:
                if name not in meta["layers"]:
                    meta["layers"].append(name)
                meta["counts"][name] = count
            else:
                if name in meta["layers"]:
                    meta["layers"].remove(name)
                meta["counts"].pop(name, None)

    index_path.write_text(json.dumps(index, indent=1))
    if terrain:
        terrain.close()
    print(f"rewrote roads/crossings in {len(index['tiles'])} tiles in {time.time() - t0:.1f}s -> {DATA_TILES}")
    try:
        from qa_report import write_report
        write_report(DATA_TILES)
    except Exception as exc:
        print(f"  [warn] QA report failed: {exc}")
    return index_path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--no-merge", action="store_true", help="do not merge touching rowhouse footprints")
    ap.add_argument("--clean", action="store_true", help="delete existing tile dirs first")
    ap.add_argument("--roads-only", action="store_true", help="rewrite roads/crossings in existing tiles without rebuilding other layers")
    a = ap.parse_args(argv)
    if a.roads_only:
        rebuild_road_tiles(tuple(a.bbox))
    else:
        build(tuple(a.bbox), merge_rowhouses=not a.no_merge, clean=a.clean)
    return 0


if __name__ == "__main__":
    sys.exit(main())
