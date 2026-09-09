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
from pyproj import Transformer
from shapely.geometry import box

from config import CRS_PROJ, DATA_RAW, DATA_TILES, DEFAULT_BBOX, TILE_SIZE, bbox_slug, snap_down
from process import (process_buildings, process_landuse, process_pois, process_rail, process_roads,
                     process_water)
from terrain import Terrain
from landmarks import resolve_landmarks

POINT_LAYERS = {"pois", "crossings"}


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
    roads, crossings = process_roads(raw_dir / "roads.parquet", terrain)
    layers = {
        "buildings": process_buildings(raw_dir / "buildings.parquet", terrain, merge_rowhouses,
                                       overture_path=DATA_RAW / f"overture_{slug}.parquet",
                                       lidar_npz=DATA_RAW / f"lidar_{slug}.npz",
                                       richmond_dir=DATA_RAW / f"richmond_{slug}",
                                       vgin_path=DATA_RAW / f"vgin_{slug}.parquet"),
        "roads": roads,
        "crossings": crossings,
        "rail": process_rail(raw_dir / "rail.parquet", terrain),
        "landuse": process_landuse(raw_dir / "landuse.parquet"),
        "water": process_water(raw_dir / "water.parquet", terrain),
        "pois": process_pois(raw_dir / "pois.parquet"),
    }
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
                cand = gdf.iloc[list(sidx[name].query(tile_box, predicate="intersects"))]
                if len(cand) == 0:
                    continue
                if name in POINT_LAYERS:
                    part = cand
                elif name == "buildings":
                    # assign whole footprints to the tile containing their centroid (no split buildings)
                    c = cand.geometry.centroid
                    part = cand[(c.x >= tminx) & (c.x < tminx + TILE_SIZE) & (c.y >= tminy) & (c.y < tminy + TILE_SIZE)]
                else:
                    part = gpd.clip(cand, tile_box, keep_geom_type=True)
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
                (tdir / "terrain.json").write_text(json.dumps(terrain.tile_grid(tminx, tminy, TILE_SIZE, flatten=flats)))
                written.append("terrain")
            if written:
                tiles_meta.append({"id": tid, "x": tx, "y": ty,
                                   "bbox": [tminx, tminy, tminx + TILE_SIZE, tminy + TILE_SIZE],
                                   "layers": written, "counts": counts})
    index = {
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--no-merge", action="store_true", help="do not merge touching rowhouse footprints")
    ap.add_argument("--clean", action="store_true", help="delete existing tile dirs first")
    a = ap.parse_args(argv)
    build(tuple(a.bbox), merge_rowhouses=not a.no_merge, clean=a.clean)
    return 0


if __name__ == "__main__":
    sys.exit(main())
