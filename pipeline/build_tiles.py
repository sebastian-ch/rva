"""Process raw data into per-tile GeoJSON + terrain grids (see DATA_FORMAT.md).

Usage:
    python pipeline/build_tiles.py [--bbox W S E N] [--no-merge] [--clean] [--no-cache] [--clear-cache]

Every build is incremental. The layer stage runs as cached steps (`layer_steps.py`): only the steps whose
code, sources or upstream layers changed are recomputed. The tiling loop then rewrites only the tile files
whose features changed since the last build (`layer_cache.row_digests`), so fixing one building rewrites
one tile. `--clean` rewrites every tile while retaining the step cache; `--clear-cache` forgets both.
`--no-cache` recomputes every step but still skips tile files whose resulting content is unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
from pyproj import Transformer
from shapely.geometry import box

from config import CRS_PROJ, DATA_RAW, DATA_TILES, DEFAULT_BBOX, TILE_SIZE, REGION, PROFILE, bbox_slug, snap_down
from terrain import Terrain
from landmarks import resolve_landmarks
import deps
import layer_cache
from layer_steps import StepContext, run_steps

POINT_LAYERS = {"pois", "crossings"}


def _tile_layer(gdf: gpd.GeoDataFrame, spatial_index, name: str, tile_box):
    """Apply the standard per-layer ownership and clipping rules for one tile."""
    cand = gdf.iloc[list(spatial_index.query(tile_box, predicate="intersects"))]
    return _clip_candidates(cand, name, tile_box)


def _clip_candidates(cand: gpd.GeoDataFrame, name: str, tile_box):
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
        # a deck may arrive as a list or, via the layer cache's parquet round-trip, as an ndarray
        gdf["deck"] = gdf["deck"].map(
            lambda v: json.dumps([float(x) for x in v]) if isinstance(v, (list, tuple, np.ndarray)) else None)
    gdf["geometry"] = gdf.geometry.set_precision(0.01)
    gdf = gdf[~gdf.geometry.is_empty]
    gdf.to_file(dst, driver="GeoJSON", COORDINATE_PRECISION=2, RFC7946="NO")
    return len(gdf)


def _search_index(buildings, lms) -> list[dict]:
    """One compact index that makes viewer search independent of the currently streamed tiles."""
    search = []
    seen = set()
    seen_landmarks = set()
    for _, row in buildings.iterrows():
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
    return search


def _terrain_fingerprint(dem_path: Path, hydro_path: Path | None, beach_profile) -> str:
    """Everything a tile's terrain grid depends on besides the still water and hydro mask inside the tile."""
    parts = {
        "dem": layer_cache.stat_entry(dem_path) if dem_path.exists() else None,
        "hydro": layer_cache.stat_entry(hydro_path) if hydro_path and hydro_path.exists() else None,
        "code": [hashlib.sha1((Path(__file__).with_name(m)).read_bytes()).hexdigest()[:16]
                 for m in ("terrain.py", "hydro.py")],
        "beach": [g.wkb_hex for g in beach_profile[:2]] + [beach_profile[2]] if beach_profile else None,
    }
    return layer_cache.make_key(parts)


def write_tiles(layers, terrain, hydro, beach_profile, bbox, surveyed_trees, prev_state: dict,
                terrain_fp: str, tiles_dir: Path = DATA_TILES) -> tuple[list[dict], dict, dict, dict]:
    """Tile every layer into `tiles_dir`, rewriting only what changed since `prev_state`.

    Returns (tiles_meta, new_state, grid, counters). A tile's layer file is left alone when the same set of
    features (by content digest) fed the previous write and the file still exists; its terrain grid is left
    alone when the DEM, hydro, still-water and code inputs are unchanged.
    """
    # Include the tiling function, the same-module helpers it reaches, and the layer_cache implementation.
    # A serialization, clipping, ownership or digest-code edit must rewrite output even when source rows match.
    tile_code_fp = layer_cache.make_key(deps.code_fingerprint((write_tiles,)))
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    west, south, east, north = bbox
    xs, ys = zip(*[tr.transform(x, y) for x, y in ((west, south), (east, south), (east, north), (west, north))])
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    ox, oy = snap_down(minx, TILE_SIZE), snap_down(miny, TILE_SIZE)
    nx = int(np.ceil((maxx - ox) / TILE_SIZE))
    ny = int(np.ceil((maxy - oy) / TILE_SIZE))
    grid = {"origin": [ox, oy], "grid": [nx, ny], "bbox_proj": [minx, miny, maxx, maxy]}
    print(f"grid origin ({ox:.0f}, {oy:.0f}) tiles {nx} x {ny}")

    t0 = time.time()
    sidx = {k: v.sindex for k, v in layers.items() if len(v)}
    digests = {k: layer_cache.row_digests(v) for k, v in layers.items() if len(v)}
    # buildings are owned by centroid, so a footprint straddling a tile edge must only dirty its owner tile
    bc = layers["buildings"].geometry.centroid if len(layers.get("buildings", [])) else None
    bcx, bcy = (bc.x.to_numpy(), bc.y.to_numpy()) if bc is not None else (None, None)
    water = layers.get("water")
    still = water[water["water_z"].notna()] if water is not None and "water_z" in water else None
    if still is not None and len(still) == 0:
        still = None
    still_sidx = still.sindex if still is not None else None
    still_digests = layer_cache.row_digests(still) if still is not None else None
    print(f"  digests {time.time() - t0:.1f}s")

    n = {"written": 0, "unchanged": 0, "removed": 0, "terrain_written": 0, "terrain_unchanged": 0}
    tiles_meta = []
    new_state = {}
    for tx in range(nx):
        for ty in range(ny):
            tminx, tminy = ox + tx * TILE_SIZE, oy + ty * TILE_SIZE
            tile_box = box(tminx, tminy, tminx + TILE_SIZE, tminy + TILE_SIZE)
            tid = f"{tx}_{ty}"
            tdir = tiles_dir / tid
            prev = prev_state.get(tid, {})
            prev_layers = prev.get("layers", {})
            tstate = {"layers": {}, "terrain": None}
            written = []
            counts = {}
            for name, gdf in layers.items():
                dst = tdir / f"{name}.geojson"
                idx = sidx[name].query(tile_box, predicate="intersects") if name in sidx else []
                if name == "buildings" and len(idx):
                    idx = idx[(bcx[idx] >= tminx) & (bcx[idx] < tminx + TILE_SIZE) & (bcy[idx] >= tminy) & (bcy[idx] < tminy + TILE_SIZE)]
                if len(idx) == 0:
                    if dst.exists():
                        dst.unlink()
                        n["removed"] += 1
                    continue
                digest = layer_cache.make_key({
                    "rows": layer_cache.digest_rows(digests[name], idx),
                    "code": tile_code_fp,
                })
                old = prev_layers.get(name)
                if old and old["digest"] == digest and (dst.exists() == (old["count"] > 0)):
                    count = old["count"]
                    n["unchanged"] += 1
                else:
                    part = _clip_candidates(gdf.iloc[idx], name, tile_box)
                    tdir.mkdir(exist_ok=True)
                    count = _write_layer(part, dst) if len(part) else 0
                    if not count and dst.exists():
                        dst.unlink()
                    n["written"] += 1
                tstate["layers"][name] = {"digest": digest, "count": count}
                if count:
                    written.append(name)
                    counts[name] = count
            if terrain is not None:
                tdir.mkdir(exist_ok=True)
                flat_idx = still_sidx.query(tile_box, predicate="intersects") if still_sidx is not None else []
                flats = [(g, float(z)) for g, z in zip(still.geometry.iloc[flat_idx], still["water_z"].iloc[flat_idx])] if len(flat_idx) else None
                # Resolve land/water edges at 2.5 m instead of the normal 10 m grid.
                # Entirely underwater tiles keep the inexpensive normal grid.
                shore = REGION == "honolulu" and flats and any(not g.covers(tile_box) for g, _ in flats)
                hydro_here = hydro is not None and hydro.mask.intersects(tile_box)
                beach_here = bool(beach_profile) and beach_profile[0].buffer(8).intersects(tile_box)
                tdigest = layer_cache.make_key({
                    "fp": terrain_fp, "tile_code": tile_code_fp,
                    "shore": bool(shore), "hydro": bool(hydro_here), "beach": beach_here,
                    "flats": layer_cache.digest_rows(still_digests, flat_idx) if len(flat_idx) else None})
                tpath = tdir / "terrain.json"
                if prev.get("terrain") == tdigest and tpath.exists():
                    n["terrain_unchanged"] += 1
                else:
                    grid_json = terrain.tile_grid(tminx, tminy, TILE_SIZE, n=101 if shore else 26, flatten=flats,
                                                  beach_profile=beach_profile if beach_here else None)
                    if hydro_here:
                        grid_json = hydro.apply_grid(grid_json)
                    tpath.write_text(json.dumps(grid_json))
                    n["terrain_written"] += 1
                tstate["terrain"] = tdigest
                written.append("terrain")
            new_state[tid] = tstate
            if written:
                tiles_meta.append({"id": tid, "x": tx, "y": ty,
                                   "bbox": [tminx, tminy, tminx + TILE_SIZE, tminy + TILE_SIZE],
                                   "layers": written, "counts": counts, "surveyed_trees": surveyed_trees})
    # tile dirs outside the grid or without any content are stale: drop them so index.json stays the only manifest
    live = {m["id"] for m in tiles_meta}
    for p in tiles_dir.iterdir() if tiles_dir.exists() else []:
        if p.is_dir() and p.name not in live and "_" in p.name:
            shutil.rmtree(p, ignore_errors=True)
    n["seconds"] = round(time.time() - t0, 1)
    return tiles_meta, new_state, grid, n


def build(bbox, merge_rowhouses=True, clean=False, no_cache=False) -> Path:
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

    # The tiling loop needs the hydro grid whether or not the layers themselves were recomputed.
    hydro = None
    hydro_path = None
    if REGION == "richmond" and terrain is not None:
        hydro_path = DATA_RAW / "richmond_hydro_2025.gpkg"
        if hydro_path.exists():
            from hydro import load_hydro
            hydro = load_hydro(hydro_path, bbox, terrain.base)

    t0 = time.time()
    ctx = StepContext(REGION, tuple(bbox), slug, raw_dir, dem_path, terrain, hydro,
                      merge_rowhouses=merge_rowhouses, no_cache=no_cache)
    print("layer steps..." + (" (--no-cache: every step recomputed)" if no_cache else ""))
    layers, extras, report = run_steps(ctx)
    surveyed_trees = extras.get("surveyed_trees", False)
    beach_profile = ctx.beach_profile

    for k, v in layers.items():
        print(f"  {k:10s} {len(v):6d}")
    b = layers["buildings"]
    if len(b):
        print("  height sources:", b["height_source"].value_counts().to_dict())
        print("  roof sources:", b["roof_source"].value_counts().to_dict())
        print("  landmarks matched:", sorted(b["landmark"].dropna().tolist()))
    print(f"  layers {time.time() - t0:.1f}s")

    prev_state = {} if clean else layer_cache.load_tile_state(slug)
    terrain_fp = _terrain_fingerprint(dem_path, hydro_path, beach_profile)
    tiles_meta, new_state, grid, n = write_tiles(layers, terrain, hydro, beach_profile, bbox, surveyed_trees,
                                                 prev_state, terrain_fp)
    layer_cache.save_tile_state(slug, new_state)
    print(f"  tiles: {n['written']} layer files written, {n['unchanged']} unchanged, {n['removed']} removed; "
          f"terrain {n['terrain_written']} written, {n['terrain_unchanged']} unchanged; {n['seconds']}s")

    t1 = time.time()
    index = {
        "region": REGION,
        "title": PROFILE["title"],
        "crs": CRS_PROJ,
        "tile_size": TILE_SIZE,
        "origin": grid["origin"],
        "grid": grid["grid"],
        "bbox_wgs84": list(bbox),
        "bbox_proj": grid["bbox_proj"],
        "base_elevation": terrain.base if terrain else 0.0,
        "tiles": tiles_meta,
    }
    (DATA_TILES / "index.json").write_text(json.dumps(index, indent=1))
    lms = resolve_landmarks(raw_dir, layers["buildings"], terrain)
    (DATA_TILES / "landmarks.json").write_text(json.dumps(lms, indent=1))
    (DATA_TILES / "search.json").write_text(json.dumps(_search_index(layers["buildings"], lms),
                                                       separators=(",", ":"), allow_nan=False))
    unmatched = [k for k, v in lms.items() if v["in_first_slice"] and v["how"] is None]
    print(f"  landmarks resolved: {sum(v['how'] is not None for v in lms.values())}/{len(lms)}; unmatched in slice: {unmatched}"
          f" ({time.time() - t1:.1f}s)")
    if terrain:
        terrain.close()
    total = sum(p.stat().st_size for p in DATA_TILES.rglob("*") if p.is_file())
    print(f"wrote index for {len(tiles_meta)} tiles, {total / 1e6:.1f} MB -> {DATA_TILES}")
    t2 = time.time()
    try:
        from qa_report import write_report
        write_report(DATA_TILES)
    except Exception as exc:  # QA must never break a build
        print(f"  [warn] QA report failed: {exc}")
    print(f"  qa {time.time() - t2:.1f}s; total {time.time() - t0:.1f}s")
    return DATA_TILES / "index.json"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--no-merge", action="store_true", help="do not merge touching rowhouse footprints")
    ap.add_argument("--clean", action="store_true", help="delete existing tile dirs first and rewrite every tile")
    ap.add_argument("--no-cache", action="store_true", help="recompute every layer step even if its cache is current")
    ap.add_argument("--clear-cache", action="store_true", help="delete the layer cache and tile state before building")
    ap.add_argument("--layers", "--roads-only", dest="layers", nargs="?", const="", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.layers is not None:
        sys.exit("--layers/--roads-only are gone: every build is incremental now. Run build_tiles.py with no "
                 "flags; only the steps that changed are recomputed and only the tiles that changed are rewritten.")
    if a.clear_cache:
        layer_cache.clear()
    build(tuple(a.bbox), merge_rowhouses=not a.no_merge, clean=a.clean, no_cache=a.no_cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
