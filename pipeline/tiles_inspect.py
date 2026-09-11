#!/usr/bin/env python3
"""CLI to inspect data/tiles without pulling geopandas into the picture -- plain json only.

Usage:
    python pipeline/tiles_inspect.py stats
    python pipeline/tiles_inspect.py find "Capitol"
    python pipeline/tiles_inspect.py tile 3_2
    python pipeline/tiles_inspect.py bridges
    python pipeline/tiles_inspect.py landmarks
    python pipeline/tiles_inspect.py validate

Never dumps whole features -- summaries only (see CLAUDE.md token-usage rules).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import DATA_TILES  # noqa: E402
from schema import LAYER_KEYS, validate_feature  # noqa: E402

LAYERS = tuple(LAYER_KEYS.keys())


def _load_index() -> dict:
    p = DATA_TILES / "index.json"
    if not p.exists():
        sys.exit(f"no index.json under {DATA_TILES}; run pipeline/build_tiles.py first")
    return json.loads(p.read_text())


def _load_landmarks() -> dict:
    p = DATA_TILES / "landmarks.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _iter_features(layer: str):
    """Read only active manifest layers; incremental builds can leave stale files."""
    for entry in _load_index()["tiles"]:
        if layer not in entry["layers"]:
            continue
        tdir = DATA_TILES / entry["id"]
        fp = tdir / f"{layer}.geojson"
        if not fp.exists():
            continue
        d = json.loads(fp.read_text())
        for feat in d.get("features", []):
            yield tdir.name, feat


def _centroid(geom: dict) -> tuple[float, float] | None:
    """Rough (unweighted) centroid of a Polygon/MultiPolygon/LineString/Point -- good enough for diagnostics."""
    coords: list = []

    def flatten(c):
        if not c:
            return
        if isinstance(c[0], (int, float)):
            coords.append(c)
        else:
            for sub in c:
                flatten(sub)

    flatten(geom.get("coordinates"))
    if not coords:
        return None
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _local(x: float, y: float, origin: list[float]) -> tuple[float, float]:
    return x - origin[0], -(y - origin[1])


# ---------------------------------------------------------------- subcommands


def cmd_stats(_args) -> int:
    idx = _load_index()
    counts = Counter()
    height_src = Counter()
    roof_src = Counter()
    for layer in LAYERS:
        for _tid, feat in _iter_features(layer):
            counts[layer] += 1
            if layer == "buildings":
                p = feat["properties"]
                height_src[p.get("height_source")] += 1
                roof_src[p.get("roof_source")] += 1
    total_bytes = sum(p.stat().st_size for p in DATA_TILES.rglob("*") if p.is_file())
    print(f"tiles: {len(idx['tiles'])}  bytes: {total_bytes:,} ({total_bytes / 1e6:.1f} MB)")
    print("feature counts:")
    for layer in LAYERS:
        print(f"  {layer:10s} {counts[layer]:6d}")
    print("height_source histogram:", dict(height_src))
    print("roof_source histogram:  ", dict(roof_src))
    return 0


def cmd_find(args) -> int:
    idx = _load_index()
    origin = idx["origin"]
    needle = args.text.lower()
    hits = 0
    for tid, feat in _iter_features("buildings"):
        p = feat["properties"]
        name, addr = p.get("name") or "", p.get("addr") or ""
        if needle not in name.lower() and needle not in addr.lower():
            continue
        c = _centroid(feat["geometry"])
        local_str = f"({c[0] - origin[0]:.2f}, {-(c[1] - origin[1]):.2f})" if c else "(?, ?)"
        print(f"{p.get('id')}  name={name!r} addr={addr!r} height={p.get('height')} "
              f"source={p.get('height_source')} tile={tid} local={local_str}")
        hits += 1
    print(f"{hits} match(es)")
    return 0


def cmd_tile(args) -> int:
    idx = _load_index()
    tid = args.id
    tdir = DATA_TILES / tid
    if not tdir.exists():
        sys.exit(f"no such tile: {tid}")
    meta = next((t for t in idx["tiles"] if t["id"] == tid), None)
    print(f"tile {tid}  bbox={meta['bbox'] if meta else '?'}")
    counts = {}
    for layer in LAYERS:
        fp = tdir / f"{layer}.geojson"
        if fp.exists():
            d = json.loads(fp.read_text())
            counts[layer] = len(d.get("features", []))
    print("layer counts:", counts)
    if meta:
        minx, miny, maxx, maxy = meta["bbox"]
        lms = _load_landmarks()
        here = [slug for slug, v in lms.items() if minx <= v["x"] < maxx and miny <= v["y"] < maxy]
        print("landmarks in tile:", here)
    return 0


def cmd_bridges(_args) -> int:
    by_name: dict[str, dict] = {}
    for layer in ("roads", "rail"):
        for _tid, feat in _iter_features(layer):
            p = feat["properties"]
            if not p.get("bridge"):
                continue
            deck = p.get("deck")
            name = p.get("name") or "(unnamed)"
            entry = by_name.setdefault(name, {"segments": 0, "zmin": None, "zmax": None})
            entry["segments"] += 1
            if isinstance(deck, str):
                try:
                    deck = json.loads(deck)
                except (TypeError, ValueError):
                    deck = None
            if isinstance(deck, list) and len(deck) == 6:
                for z in (deck[2], deck[5]):
                    entry["zmin"] = z if entry["zmin"] is None else min(entry["zmin"], z)
                    entry["zmax"] = z if entry["zmax"] is None else max(entry["zmax"], z)
    for name in sorted(by_name):
        e = by_name[name]
        zr = f"{e['zmin']}..{e['zmax']}" if e["zmin"] is not None else "?"
        print(f"{name}: segments={e['segments']} deck_z=[{zr}]")
    print(f"{len(by_name)} bridge name(s)")
    return 0


def cmd_landmarks(_args) -> int:
    idx = _load_index()
    origin = idx["origin"]
    lms = _load_landmarks()
    for slug, v in lms.items():
        lx, lz = _local(v["x"], v["y"], origin)
        print(f"{slug:30s} how={v['how']!s:16s} osm_name={v.get('osm_name')!r:30s} local=({lx:.2f}, {lz:.2f})")
    print(f"{len(lms)} landmark(s)")
    return 0


def cmd_validate(_args) -> int:
    problems: list[str] = []
    totals = Counter()
    for layer in LAYERS:
        for tid, feat in _iter_features(layer):
            totals[layer] += 1
            for msg in validate_feature(layer, feat["properties"]):
                problems.append(f"[{layer}/{tid}] {msg}")
    print("feature totals:", dict(totals))
    print(f"problems: {len(problems)}")
    for msg in problems[:20]:
        print(" ", msg)
    if len(problems) > 20:
        print(f"  ... and {len(problems) - 20} more")
    return 1 if problems else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("stats").set_defaults(func=cmd_stats)

    p = sub.add_parser("find")
    p.add_argument("text")
    p.set_defaults(func=cmd_find)

    p = sub.add_parser("tile")
    p.add_argument("id")
    p.set_defaults(func=cmd_tile)

    sub.add_parser("bridges").set_defaults(func=cmd_bridges)
    sub.add_parser("landmarks").set_defaults(func=cmd_landmarks)
    sub.add_parser("validate").set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
