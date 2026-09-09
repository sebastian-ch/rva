"""bpy helpers for procedural landmark massing. Units: metres. Blender X = east, Y = north, Z = up.
Every object gets a palette material and a 'Col' colour attribute (exported as COLOR_0)."""
from __future__ import annotations

import json
import math
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent.parent
PALETTE = {k: v for k, v in json.loads((ROOT / "assets" / "palette.json").read_text()).items() if not k.startswith("_")}

_materials: dict[str, bpy.types.Material] = {}


def _rgb(key):
    h = PALETTE[key].lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def material(key):
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(f"pal_{key}")
    r, g, b = _rgb(key)
    m.diffuse_color = (r, g, b, 1.0)
    m.roughness = 0.95
    try:
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.95
    except Exception:
        pass
    _materials[key] = m
    return m


class Builder:
    """Collects mesh parts (verts/faces + colour) and turns them into objects in one collection."""

    def __init__(self, slug):
        self.slug = slug
        self.coll = bpy.data.collections.new(slug)
        bpy.context.scene.collection.children.link(self.coll)
        self.n = 0

    def add(self, verts, faces, key, shade=1.0, name=None):
        mesh = bpy.data.meshes.new(name or f"{self.slug}_{self.n}")
        mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
        mesh.update()
        mesh.materials.append(material(key))
        r, g, b = (c * shade for c in _rgb(key))
        col = mesh.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
        for i in range(len(col.data)):
            col.data[i].color_srgb = (r, g, b, 1.0)
        mesh.color_attributes.active_color = col
        mesh.color_attributes.render_color_index = 0
        obj = bpy.data.objects.new(mesh.name, mesh)
        self.coll.objects.link(obj)
        self.n += 1
        return obj

    # ---- primitives -------------------------------------------------------------------------------------

    def extrude(self, ring, z0, z1, key, shade=1.0, cap=True, name=None):
        n = len(ring)
        verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        if cap:
            faces.append(tuple(range(n, 2 * n)))
        return self.add(verts, faces, key, shade, name)

    def box(self, cx, cy, z0, sx, sy, sz, key, rot=0.0, shade=1.0, name=None):
        ring = rect_ring(cx, cy, sx, sy, rot)
        return self.extrude(ring, z0, z0 + sz, key, shade, True, name)

    def cylinder(self, cx, cy, z0, r, h, key, n=12, shade=1.0, name=None):
        ring = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
        return self.extrude(ring, z0, z0 + h, key, shade, True, name)

    def cone(self, cx, cy, z0, r, h, key, n=12, shade=1.0, name=None):
        verts = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n), z0) for i in range(n)] + [(cx, cy, z0 + h)]
        faces = [(i, (i + 1) % n, n) for i in range(n)]
        return self.add(verts, faces, key, shade, name)

    def pyramid(self, cx, cy, z0, sx, sy, h, key, rot=0.0, shade=1.0, name=None):
        ring = rect_ring(cx, cy, sx, sy, rot)
        verts = [(x, y, z0) for x, y in ring] + [(cx, cy, z0 + h)]
        faces = [(i, (i + 1) % 4, 4) for i in range(4)]
        return self.add(verts, faces, key, shade, name)

    def hip(self, cx, cy, z0, sx, sy, h, key, rot=0.0, inset=None, shade=1.0, name=None):
        """Hipped roof over a rotated rectangle; ridge along the local x (length sx)."""
        if inset is None:
            inset = min(sy / 2, sx * 0.3)
        ring = rect_ring(cx, cy, sx, sy, rot)
        ux, uy = math.cos(rot), math.sin(rot)
        r0 = (cx - ux * (sx / 2 - inset), cy - uy * (sx / 2 - inset), z0 + h)
        r1 = (cx + ux * (sx / 2 - inset), cy + uy * (sx / 2 - inset), z0 + h)
        verts = [(x, y, z0) for x, y in ring] + [r0, r1]
        # ring order: (-x,-y), (x,-y), (x,y), (-x,y)
        faces = [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)]
        return self.add(verts, faces, key, shade, name)

    def gable(self, cx, cy, z0, sx, sy, h, key, rot=0.0, shade=1.0, name=None):
        return self.hip(cx, cy, z0, sx, sy, h, key, rot, inset=0.0, shade=shade, name=name)

    def dome(self, cx, cy, z0, r, h, key, seg=16, rings=6, shade=1.0, name=None):
        verts, faces = [], []
        for j in range(rings):
            ph = (j / rings) * math.pi / 2
            for i in range(seg):
                th = 2 * math.pi * i / seg
                verts.append((cx + r * math.cos(ph) * math.cos(th), cy + r * math.cos(ph) * math.sin(th), z0 + h * math.sin(ph)))
        top = len(verts)
        verts.append((cx, cy, z0 + h))
        for j in range(rings - 1):
            for i in range(seg):
                a = j * seg + i; b = j * seg + (i + 1) % seg
                faces.append((a, b, b + seg, a + seg))
        for i in range(seg):
            faces.append(((rings - 1) * seg + i, (rings - 1) * seg + (i + 1) % seg, top))
        return self.add(verts, faces, key, shade, name)

    def colonnade(self, p0, p1, z0, h, n, r, key, cap=True):
        """n columns evenly spaced from p0 to p1 (inclusive)."""
        for i in range(n):
            t = i / (n - 1) if n > 1 else 0.5
            x, y = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
            self.cylinder(x, y, z0, r, h, key, n=10)
            if cap:
                self.box(x, y, z0 + h, r * 2.6, r * 2.6, r * 0.8, key, shade=0.95)

    def pediment(self, cx, cy, z0, width, depth, h, key, rot=0.0, shade=1.0):
        """Temple pediment: triangular front across width, ridge running back through depth."""
        ux, uy = math.cos(rot), math.sin(rot)
        vx, vy = -uy, ux
        def P(u, v, z):
            return (cx + ux * u + vx * v, cy + uy * u + vy * v, z)
        verts = [P(-width / 2, -depth / 2, z0), P(width / 2, -depth / 2, z0), P(width / 2, depth / 2, z0), P(-width / 2, depth / 2, z0),
                 P(0, -depth / 2, z0 + h), P(0, depth / 2, z0 + h)]
        faces = [(0, 1, 4), (2, 3, 5), (1, 2, 5, 4), (3, 0, 4, 5), (0, 3, 2, 1)]
        return self.add(verts, faces, key, shade)

    def window_bays(self, ring, z, height=3.0, width=1.6, pitch=5.0, trim="cream", arched=False):
        """Windows and stone surrounds on each real footprint edge, with no floating OBB facades."""
        area = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
        for i, (ax, ay) in enumerate(ring):
            bx, by = ring[(i + 1) % len(ring)]
            length = math.hypot(bx - ax, by - ay)
            count = int(length / pitch)
            if count < 1:
                continue
            ux, uy = (bx - ax) / length, (by - ay) / length
            nx, ny = (uy, -ux) if area > 0 else (-uy, ux)
            rot = math.atan2(uy, ux)
            for j in range(count):
                t = (j + 0.5) / count
                x, y = ax + (bx - ax) * t + nx * 0.13, ay + (by - ay) * t + ny * 0.13
                self.box(x, y, z - 0.15, width + 0.4, 0.22, height + 0.3, trim, rot=rot, name="window-surround")
                x, y = x + nx * 0.13, y + ny * 0.13
                outline = [(-width / 2, 0), (width / 2, 0)]
                if arched:
                    outline += [(width / 2 * math.cos(a), height - width / 2 + width / 2 * math.sin(a)) for a in [k * math.pi / 8 for k in range(9)]]
                else:
                    outline += [(width / 2, height), (-width / 2, height)]
                verts = [(x + ux * u, y + uy * u, z + v) for u, v in outline]
                self.add(verts, [tuple(range(len(verts)))], "roof_dark", name="window-glass")
                self.box(x + nx * 0.01, y + ny * 0.01, z, 0.10, 0.06, height - (width / 2 if arched else 0), trim, rot=rot)
                self.box(x + nx * 0.01, y + ny * 0.01, z + height * 0.48, width, 0.06, 0.10, trim, rot=rot)

    def clock_face(self, x, y, z, radius, angle):
        """Vertical clock dial with hour marks and two hands, facing outward along angle."""
        nx, ny = math.cos(angle), math.sin(angle)
        ux, uy = -ny, nx
        def p(u, v, depth=0):
            return (x + ux * u + nx * depth, y + uy * u + ny * depth, z + v)
        circle = [p(radius * math.cos(a), radius * math.sin(a)) for a in [i * math.tau / 32 for i in range(32)]]
        self.add(circle, [tuple(range(32))], "cream", name="clock-dial")
        for i in range(12):
            a = math.tau * i / 12
            u, v = radius * 0.83 * math.sin(a), radius * 0.83 * math.cos(a)
            self.add([p(u - 0.055, v - 0.11, 0.02), p(u + 0.055, v - 0.11, 0.02), p(u + 0.055, v + 0.11, 0.02), p(u - 0.055, v + 0.11, 0.02)], [(0, 1, 2, 3)], "roof_dark", name="clock-mark")
        for angle, length in ((0, radius * 0.72), (math.pi / 3, radius * 0.50)):
            u, v = math.sin(angle) * length, math.cos(angle) * length
            self.add([p(-0.065, 0, 0.04), p(0.065, 0, 0.04), p(u + 0.045, v, 0.04), p(u - 0.045, v, 0.04)], [(0, 1, 2, 3)], "roof_dark", name="clock-hand")

    def band(self, ring, z0, thick, height, key, shade=0.9):
        """Cornice: a thin ledge that runs around the ring, protruding outward by `thick`."""
        outer = offset_ring(ring, thick)
        n = len(ring)
        verts = [(x, y, z0) for x, y in outer] + [(x, y, z0 + height) for x, y in outer]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n, 2 * n))] + [tuple(reversed(range(n)))]
        return self.add(verts, faces, key, shade)

    def select_all(self):
        bpy.ops.object.select_all(action="DESELECT")
        for o in self.coll.objects:
            o.select_set(True)
        if self.coll.objects:
            bpy.context.view_layer.objects.active = self.coll.objects[0]


# ---- geometry helpers ----------------------------------------------------------------------------------------

def rect_ring(cx, cy, sx, sy, rot=0.0):
    ux, uy = math.cos(rot), math.sin(rot)
    vx, vy = -uy, ux
    hx, hy = sx / 2, sy / 2
    return [(cx + ux * u + vx * v, cy + uy * u + vy * v) for u, v in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))]


def offset_ring(ring, d):
    """Outward (d > 0) mitred offset of a CCW ring."""
    n = len(ring)
    out = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        e0 = (p1[0] - p0[0], p1[1] - p0[1]); e1 = (p2[0] - p1[0], p2[1] - p1[1])
        l0 = math.hypot(*e0) or 1e-9; l1 = math.hypot(*e1) or 1e-9
        n0 = (e0[1] / l0, -e0[0] / l0); n1 = (e1[1] / l1, -e1[0] / l1)  # outward for CCW
        bx, by = n0[0] + n1[0], n0[1] + n1[1]
        bl = math.hypot(bx, by) or 1e-9
        cos_half = bl / 2
        m = d / max(cos_half, 0.3)
        out.append((p1[0] + bx / bl * m, p1[1] + by / bl * m))
    return out


def inset_ring(ring, d):
    return offset_ring(ring, -d)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()
