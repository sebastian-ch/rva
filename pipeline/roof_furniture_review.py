"""Propose roof-furniture candidates for review; the build never runs this.

Reads the newest cached `roof_furniture` buildings layer, runs `roof_furniture.detect` over eligible flat
roofs, drops objects an accepted Roofer shell already models, and writes a candidates JSON plus PNG contact
sheets (LiDAR residual above the roof plane beside the NAIP crop, with the proposed boxes drawn on both).
Accepted records are copied into `assets/supplements/richmond-roof-furniture.json` with `--accept`.

  .venv/bin/python pipeline/roof_furniture_review.py --out /tmp/rf [--min-area 300] [--ids a,b]
  .venv/bin/python pipeline/roof_furniture_review.py --out /tmp/rf --accept --reject id1,id2 [--drop id:0]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import zlib
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from shapely import contains_xy
from shapely.geometry import Point, Polygon

from config import ASSETS, DATA_RAW, DEFAULT_BBOX, bbox_slug
from layer_cache import CACHE_DIR
from roof_furniture import CELL_M, dense_surface, detect, _dominant_plane, EDGE_INSET_M

SUPPLEMENT = ASSETS / "supplements" / "richmond-roof-furniture.json"
PANEL = 180
PER_ROW = 4


def latest_buildings(slug: str) -> gpd.GeoDataFrame:
    entries = sorted((CACHE_DIR / f"steps_{slug}").glob("roof_furniture_*/buildings.parquet"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not entries:
        raise SystemExit("no cached roof_furniture step; run build_tiles.py first")
    return gpd.read_parquet(entries[0])


def latest_layer(slug: str, step: str, layer: str) -> gpd.GeoDataFrame | None:
    entries = sorted((CACHE_DIR / f"steps_{slug}").glob(f"{step}_*/{layer}.parquet"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    return gpd.read_parquet(entries[0]) if entries else None


def eligible(b: gpd.GeoDataFrame, min_area: float, landuse: gpd.GeoDataFrame | None) -> gpd.GeoDataFrame:
    """Flat, visible roofs; parking decks tagged only building=yes are caught by the parking polygon over
    them, since their top-level cars pass every shape gate."""
    hidden = b["hidden"].fillna(False).astype(bool) if "hidden" in b else False
    out = b[(b.roof_shape == "flat") & ~hidden & (b.area >= min_area)]
    if landuse is not None and len(out):
        park = landuse[landuse["kind"] == "parking"]
        hit = gpd.overlay(out[["id", "geometry"]], park[["geometry"]], how="intersection", keep_geom_type=True)
        frac = hit.assign(a=hit.area).groupby("id")["a"].sum() / out.set_index("id").area
        decks = set(frac[frac >= 0.5].index)
        print(f"skipping {len(decks)} roofs under parking polygons")
        out = out[~out["id"].isin(decks)]
    return out


def lod2_height(mesh_json: str | None, x: float, y: float) -> float | None:
    """Highest Roofer surface above the eave at (x, y), or None when no face covers it."""
    if not mesh_json:
        return None
    mesh = json.loads(mesh_json)
    v = np.asarray(mesh["v"], float)
    best = None
    for face in mesh["f"]:
        ring = v[face[0]]
        if len(ring) < 3 or not Polygon(ring[:, :2]).buffer(0.05).contains(Point(x, y)):
            continue
        a = np.c_[ring[:, :2], np.ones(len(ring))]
        coef, *_ = np.linalg.lstsq(a, ring[:, 2], rcond=None)
        z = float(coef[0] * x + coef[1] * y + coef[2])
        best = z if best is None else max(best, z)
    return best


def settle(building, props: list[dict]) -> tuple[list[dict], int]:
    """Seat objects on the rendered roof. On an accepted Roofer shell the base is the mesh surface under the
    object's centre; objects the shell already models (it rises over half their height there) are dropped."""
    if building.roof_source != "lod2":
        return props, 0
    kept = []
    for p in props:
        z = lod2_height(building.lod2_roof, p["x"], p["y"])
        if z is None or z - p["b"] > 0.5 * p["h"]:
            continue
        kept.append({**p, "b": round(z, 2)})
    return kept, len(props) - len(kept)


# ------------------------------------------------------------------ contact sheets

def _png(path: Path, rgb: np.ndarray) -> None:
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[r].astype(np.uint8).tobytes() for r in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _line(img, p0, p1, color):
    n = int(max(abs(p1[0] - p0[0]), abs(p1[1] - p0[1]))) + 1
    for t in np.linspace(0, 1, n):
        c, r = int(round(p0[0] + (p1[0] - p0[0]) * t)), int(round(p0[1] + (p1[1] - p0[1]) * t))
        if 0 <= r < img.shape[0] and 0 <= c < img.shape[1]:
            img[r, c] = color


def _box_corners(p):
    ca, sa = math.cos(p["a"]), math.sin(p["a"])
    hw, hd = p["w"] / 2, p["d"] / 2
    return [(p["x"] + ca * u - sa * v, p["y"] + sa * u + ca * v) for u, v in
            ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd))]


def _residual_colors(d: np.ndarray) -> np.ndarray:
    """Blue below the plane, grey on it, orange for object heights (1-6 m), magenta above."""
    c = np.empty((len(d), 3))
    c[:] = (220, 60, 220)
    obj = (d >= 1) & (d <= 6)
    c[obj] = np.c_[np.full(obj.sum(), 255), 220 - 25 * d[obj], np.full(obj.sum(), 40)]
    c[d < 1] = (170, 170, 170)
    c[d <= 0.5] = (120, 120, 120)
    c[d < -0.5] = (40, 60, 140)
    return c


def panels(building, pts, props, ortho) -> np.ndarray:
    minx, miny, maxx, maxy = building.geometry.bounds
    span = max(maxx - minx, maxy - miny) + 4
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    x0, y1 = cx - span / 2, cy + span / 2
    scale = PANEL / span
    to_px = lambda x, y: ((x - x0) * scale, (y1 - y) * scale)

    res = np.full((PANEL, PANEL, 3), 30, np.uint8)
    inner = building.geometry.buffer(-EDGE_INSET_M)
    sel = pts[contains_xy(inner, pts[:, 0], pts[:, 1])] if not inner.is_empty else pts[:0]
    plane = _dominant_plane(sel[:, 2]) if len(sel) else None
    if plane is not None:
        inside = pts[contains_xy(building.geometry, pts[:, 0], pts[:, 1])]
        d = inside[:, 2] - plane[0]
        cols = ((inside[:, 0] - x0) * scale).astype(int)
        rows = ((y1 - inside[:, 1]) * scale).astype(int)
        ok = (cols >= 0) & (cols < PANEL) & (rows >= 0) & (rows < PANEL)
        color = _residual_colors(d)
        size = max(1, int(math.ceil(CELL_M * scale)))
        for dr in range(size):
            for dc in range(size):
                r, c = (rows + dr)[ok], (cols + dc)[ok]
                good = (r < PANEL) & (c < PANEL)
                res[r[good], c[good]] = color[ok][good]

    orth = np.zeros((PANEL, PANEL, 3), np.uint8)
    win = from_bounds(x0, y1 - span, x0 + span, y1, ortho.transform)
    data = ortho.read((1, 2, 3), window=win, out_shape=(3, PANEL, PANEL), boundless=True, fill_value=0)
    orth[:] = np.moveaxis(data, 0, -1)

    for img in (res, orth):
        ring = list(building.geometry.exterior.coords) if building.geometry.geom_type == "Polygon" else \
            [c for g in building.geometry.geoms for c in g.exterior.coords]
        for a, b in zip(ring[:-1], ring[1:]):
            _line(img, to_px(*a), to_px(*b), (255, 255, 255))
        for p in props:
            cs = [to_px(*c) for c in _box_corners(p)]
            for i in range(4):
                _line(img, cs[i], cs[(i + 1) % 4], (0, 255, 255))
    gap = np.full((PANEL, 4, 3), 0, np.uint8)
    return np.concatenate([res, gap, orth], axis=1)


def write_sheets(out: Path, cells: list[tuple[str, np.ndarray]], per_sheet: int = 16) -> list[dict]:
    index = []
    for s in range(0, len(cells), per_sheet):
        chunk = cells[s:s + per_sheet]
        rows = math.ceil(len(chunk) / PER_ROW)
        cw, ch = chunk[0][1].shape[1] + 10, PANEL + 10
        sheet = np.full((rows * ch, PER_ROW * cw, 3), 80, np.uint8)
        for i, (bid, img) in enumerate(chunk):
            r, c = divmod(i, PER_ROW)
            sheet[r * ch + 5:r * ch + 5 + PANEL, c * cw + 5:c * cw + 5 + img.shape[1]] = img
            index.append({"sheet": s // per_sheet, "row": r, "col": c, "id": bid})
        _png(out / f"sheet_{s // per_sheet:03d}.png", sheet)
    return index


# ------------------------------------------------------------------ main

def propose(args) -> None:
    slug = bbox_slug(DEFAULT_BBOX)
    b = latest_buildings(slug)
    b = b.assign(area=b.area)
    cand = eligible(b, args.min_area, latest_layer(slug, "landuse", "landuse"))
    if args.ids:
        cand = b[b["id"].isin(args.ids.split(","))]
    print(f"eligible roofs: {len(cand)}")
    pts = dense_surface(DATA_RAW / f"lidar_{slug}.npz", cand)
    pts = pts[np.argsort(pts[:, 0])]
    print(f"dense surface points: {len(pts):,}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ortho = rasterio.open(DATA_RAW / f"ortho_{slug}.tif")
    records, cells, stats = {}, [], {"buildings": 0, "objects": 0, "modeled": 0}
    for row in cand.sort_values("area", ascending=False).itertuples():
        minx, miny, maxx, maxy = row.geometry.bounds
        lo, hi = np.searchsorted(pts[:, 0], [minx - 3, maxx + 3])
        sub = pts[lo:hi]
        sub = sub[(sub[:, 1] >= miny - 3) & (sub[:, 1] <= maxy + 3)]
        props = detect(row, sub)
        kept, modeled = settle(row, props)
        stats["modeled"] += modeled
        if not kept:
            continue
        stats["buildings"] += 1
        stats["objects"] += len(kept)
        records[row.id] = {"name": row.name, "area": round(row.area), "roof_source": row.roof_source,
                           "height": row.height, "props": kept}
        cells.append((row.id, panels(row, sub, kept, ortho)))
    index = write_sheets(out, cells)
    for item in index:
        records[item["id"]]["sheet"] = [item["sheet"], item["row"], item["col"]]
    (out / "candidates.json").write_text(json.dumps(records, indent=1))
    print(f"candidates: {stats}  sheets: {math.ceil(len(cells) / 16)} -> {out}")


def accept(args) -> None:
    records = json.loads((Path(args.out) / "candidates.json").read_text())
    reject = set(filter(None, (args.reject or "").split(",")))
    drop_obj = {}
    for spec in filter(None, (args.drop or "").split(",")):
        bid, idx = spec.rsplit(":", 1)
        drop_obj.setdefault(bid, set()).add(int(idx))
    sup = json.loads(SUPPLEMENT.read_text())
    added = 0
    for bid, rec in records.items():
        if bid in reject or bid in sup["buildings"]:
            continue
        props = [p for i, p in enumerate(rec["props"]) if i not in drop_obj.get(bid, set())]
        if props:
            sup["buildings"][bid] = props
            added += 1
    if args.reviewed is not None:
        sup["reviewed_candidates"] = args.reviewed
    if args.selection:
        sup["selection"] = args.selection
    SUPPLEMENT.write_text(json.dumps(sup, indent=2) + "\n")
    print(f"added {added} buildings; supplement now {len(sup['buildings'])}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-area", type=float, default=300)
    ap.add_argument("--ids")
    ap.add_argument("--accept", action="store_true")
    ap.add_argument("--reject", help="comma-separated building ids to leave unchanged")
    ap.add_argument("--drop", help="comma-separated id:index objects to drop from accepted buildings")
    ap.add_argument("--selection", help="replacement selection note for the supplement")
    ap.add_argument("--reviewed", type=int, help="total candidate buildings reviewed, recorded in the supplement")
    args = ap.parse_args()
    accept(args) if args.accept else propose(args)


if __name__ == "__main__":
    main()
