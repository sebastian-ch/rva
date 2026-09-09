"""bpy-free helpers: find a landmark's matched footprint in the tiles and derive its local frame."""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TILES = ROOT / "data" / "tiles"


def shoelace(ring):
    a = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]; x1, y1 = ring[(i + 1) % len(ring)]
        a += x0 * y1 - x1 * y0
    return a / 2


def centroid(ring):
    a = shoelace(ring)
    if abs(a) < 1e-9:
        return ring[0]
    cx = cy = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]; x1, y1 = ring[(i + 1) % len(ring)]
        f = x0 * y1 - x1 * y0
        cx += (x0 + x1) * f; cy += (y0 + y1) * f
    return cx / (6 * a), cy / (6 * a)


def clean_ring(ring):
    out = []
    for p in ring:
        if not out or abs(out[-1][0] - p[0]) > 1e-6 or abs(out[-1][1] - p[1]) > 1e-6:
            out.append((float(p[0]), float(p[1])))
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-6 and abs(out[0][1] - out[-1][1]) < 1e-6:
        out.pop()
    return out


def convex_hull(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def obb(ring):
    """Minimum-area oriented box: dict(center, axis (unit, long), half_long, half_short, angle)."""
    hull = convex_hull(ring)
    best = None
    n = len(hull)
    for i in range(n):
        x0, y0 = hull[i]; x1, y1 = hull[(i + 1) % n]
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 1e-9:
            continue
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        us = [x * ux + y * uy for x, y in hull]; vs = [-x * uy + y * ux for x, y in hull]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            cu, cv = (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2
            du, dv = (max(us) - min(us)) / 2, (max(vs) - min(vs)) / 2
            center = (cu * ux - cv * uy, cu * uy + cv * ux)
            if du >= dv:
                best = (area, center, (ux, uy), du, dv)
            else:
                best = (area, center, (-uy, ux), dv, du)
    _, center, axis, hl, hs = best
    return {"center": center, "axis": axis, "half_long": hl, "half_short": hs, "angle": math.atan2(axis[1], axis[0])}


def find_footprint(slug, tiles_dir: Path = TILES):
    """Return dict(ring (centroid-relative, X east / Y north), centroid_proj, ground_z, height, props) or None."""
    # prefer the outline (building:parts inherit the slug); fall back to the largest part
    candidates = []
    for f in sorted(tiles_dir.glob("*/buildings.geojson")):
        fc = json.loads(f.read_text())
        for ft in fc["features"]:
            if ft["properties"].get("landmark") == slug:
                candidates.append((f, ft))
    if not candidates:
        return None
    def rank(c):
        p = c[1]["properties"]
        g = c[1]["geometry"]
        coords = g["coordinates"] if g["type"] == "Polygon" else max(g["coordinates"], key=lambda q: abs(shoelace(q[0])))
        return (0 if not p.get("is_part") else 1, -abs(shoelace(coords[0])))
    candidates.sort(key=rank)
    for f, ft in candidates[:1]:
        if True:
            g = ft["geometry"]
            coords = g["coordinates"] if g["type"] == "Polygon" else max(g["coordinates"], key=lambda p: abs(shoelace(p[0])))
            ring = clean_ring(coords[0])
            if shoelace(ring) < 0:
                ring.reverse()
            cx, cy = centroid(ring)
            rel = [(x - cx, y - cy) for x, y in ring]
            return {"ring": rel, "centroid_proj": (cx, cy), "ground_z": ft["properties"].get("ground_z", 0.0),
                    "height": ft["properties"].get("height", 10.0), "props": ft["properties"], "obb": obb(rel), "tile": f.parent.name}
    return None


def toward(fp, lon, lat):
    """(u, v) of a WGS84 target in the footprint's OBB frame (metres from the OBB centre). Used to orient fronts."""
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:32618", always_xy=True)
    x, y = tr.transform(lon, lat)
    cx, cy = fp["centroid_proj"]
    dx, dy = x - cx - fp["obb"]["center"][0], y - cy - fp["obb"]["center"][1]
    ax, ay = fp["obb"]["axis"]
    return dx * ax + dy * ay, -dx * ay + dy * ax
