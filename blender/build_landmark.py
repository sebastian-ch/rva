"""Procedural first-pass landmark models, built against each landmark's OSM footprint and exported to glTF.

    .venv/bin/python blender/build_landmark.py -- --slug virginia-state-capitol [--save out.blend] [--no-export]
    .venv/bin/python blender/build_landmark.py -- --all

Models are stylised massing (palette materials, chunky primitives), meant as a floor until hand-modelled.
Origin = footprint centroid on the ground; Blender X = east, Y = north, Z = up (glTF export is Y-up).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bpy  # noqa: E402

from footprint import clean_ring, find_footprint, shoelace, toward  # noqa: E402
from landmark_lib import Builder, clear_scene, inset_ring, offset_ring, rect_ring  # noqa: E402
import export_landmark  # noqa: E402

ROOT = HERE.parent


class Frame:
    """OBB frame: u along the long axis, v along the short axis, +v chosen to point north-ish (y > 0)."""

    def __init__(self, fp):
        o = fp["obb"]
        self.cx, self.cy = o["center"]
        self.ux, self.uy = o["axis"]
        self.vx, self.vy = -self.uy, self.ux
        if self.vy < 0:
            self.vx, self.vy = -self.vx, -self.vy
        if self.uy < 0:  # keep u pointing north-ish too, so "south end" = -u for N-S buildings
            self.ux, self.uy = -self.ux, -self.uy
        self.hl, self.hs = o["half_long"], o["half_short"]
        self.rot_u = math.atan2(self.uy, self.ux)
        self.rot_v = math.atan2(self.vy, self.vx)

    def P(self, u, v):
        return (self.cx + self.ux * u + self.vx * v, self.cy + self.uy * u + self.vy * v)

    def rect(self, u, v, su, sv):
        return rect_ring(*self.P(u, v), su, sv, self.rot_u)


def _body(b: Builder, fp, h, key, shade=1.0, cornice=True):
    b.extrude(fp["ring"], -0.5, h, key, shade, name="body")
    if cornice:
        b.band(fp["ring"], h - 0.6, 0.5, 0.6, key, shade * 0.88)


# ---------------------------------------------------------------- landmarks

def capitol(b, fp):
    f = Frame(fp)
    _body(b, fp, 16.5, "cream")
    b.window_bays(fp["ring"], 4.0, height=3.0, width=1.5, pitch=5.2, trim="concrete")
    b.window_bays(fp["ring"], 10.0, height=3.8, width=1.7, pitch=5.2, trim="cream")
    b.band(fp["ring"], 2.0, 0.3, 0.35, "concrete")
    # central temple runs along v (north-south); wings along u
    b.hip(*f.P(0, 0), 16.5, 46, 27, 5.5, "slate", rot=f.rot_v, inset=6)
    for s in (-1, 1):
        b.hip(*f.P(s * (f.hl - 14), 0), 16.5, 26, 22, 4.5, "slate", rot=f.rot_u, inset=5)
        # wing porticos (4 columns) on the south face
        p0 = f.P(s * (f.hl - 14) - 6, -f.hs + 2.5); p1 = f.P(s * (f.hl - 14) + 6, -f.hs + 2.5)
        b.colonnade(p0, p1, 2.0, 11.5, 4, 0.7, "cream")
        b.pediment(*f.P(s * (f.hl - 14), -f.hs + 2.5), 13.8, 16, 5, 3.0, "cream", rot=f.rot_u, shade=0.96)
    # main south portico: 6 Ionic columns, entablature, pediment
    v0 = -23.5 + 2.5
    p0 = f.P(-10.5, v0); p1 = f.P(10.5, v0)
    b.colonnade(p0, p1, 2.5, 13.0, 6, 0.95, "cream")
    b.box(*f.P(0, v0 + 1.5), 15.5, 27, 8, 1.6, "cream", rot=f.rot_u, shade=0.94)
    b.pediment(*f.P(0, v0 + 1.5), 17.1, 27, 8.5, 5.0, "cream", rot=f.rot_u, shade=0.97)
    # steps
    for i in range(4):
        b.box(*f.P(0, v0 - 3 - i * 0.9), -0.2, 20 - i * 0.6, 1.0, 2.6 - i * 0.6, "concrete", rot=f.rot_u, shade=0.95)


def main_street_station(b, fp):
    f = Frame(fp)
    # head house at the south end of the long axis
    hh_u = -f.hl + 20
    b.box(*f.P(hh_u, 0), -0.5, 40, 2 * f.hs, 18, "brick", rot=f.rot_u, name="headhouse")
    b.window_bays(f.rect(hh_u, 0, 40, 2 * f.hs), 3, height=4.5, width=2.2, pitch=5.5, trim="sand", arched=True)
    b.window_bays(f.rect(hh_u, 0, 40, 2 * f.hs), 10.8, height=3.7, width=1.8, pitch=5.5, trim="sand")
    b.band(f.rect(hh_u, 0, 40, 2 * f.hs), 17.4, 0.5, 0.6, "sand", 0.95)
    b.hip(*f.P(hh_u, 0), 18, 40, 2 * f.hs, 6.5, "roof_red", rot=f.rot_u, inset=8)
    # dormers
    for du in (-12, 0, 12):
        for sv in (-1, 1):
            b.gable(*f.P(hh_u + du, sv * (f.hs - 4)), 18.2, 4, 5, 2.2, "roof_red", rot=f.rot_v)
    # clock tower at the south-west corner
    tu, tv = -f.hl + 5.5, -f.hs + 6
    b.box(*f.P(tu, tv), -0.5, 10, 10, 36, "brick", rot=f.rot_u, name="tower")
    b.band(f.rect(tu, tv, 10, 10), 30, 0.6, 3.5, "sand", 0.97)  # clock stage
    for k in range(4):
        ang = f.rot_u + k * math.pi / 2
        x, y = f.P(tu, tv)
        b.clock_face(x + 5.62 * math.cos(ang), y + 5.62 * math.sin(ang), 31.75, 1.6, ang)
    b.band(f.rect(tu, tv, 10, 10), 35.4, 0.7, 0.6, "sand", 0.9)
    b.pyramid(*f.P(tu, tv), 36, 11.4, 11.4, 9, "roof_red", rot=f.rot_u)
    # Amtrak documents a 123 x 517 ft shed. Fit its north end to the footprint;
    # the overlap with the simplified headhouse hides their connecting joint.
    su, sw = min(517 * 0.3048, 2 * f.hl), 123 * 0.3048
    shed_c = f.hl - su / 2
    # 2025 LiDAR: eaves ~25.3 m absolute, ridge vent ~32.4 m; ground ~8.25 m.
    # Raise the eaves, not the peak: the old narrow, deep roof made the shed read low.
    eave, ridge = 17.0, 22.3
    # Platform-level glazing; the railway's exaggerated datum is ~31.5 world m
    # here, versus the model base at 13.8. Lift the upper storey with that datum.
    platform, upper_eave = 17.5, 27.0
    b.box(*f.P(shed_c, 0), 0, su, sw, platform, "steel", rot=f.rot_u, shade=0.45, name="shed_base")
    b.box(*f.P(shed_c, 0), platform, su, sw, upper_eave-platform, "steel", rot=f.rot_u)
    b.window_bays(f.rect(shed_c, 0, su, sw), platform+0.4, height=8.2, width=4.1, pitch=4.8, trim="steel")
    for u in range(int(-su/2)+3, int(su/2), 6):
        for side in [-1,1]:
            b.box(*f.P(shed_c+u, side*(sw/2+0.12)), 0, 0.5, 0.45, platform, "steel", rot=f.rot_u)
    rise = upper_eave-eave
    eave, ridge = upper_eave, ridge+rise
    b.band(f.rect(shed_c, 0, su, sw), eave - 0.6, 0.4, 0.6, "sand", 0.95)
    b.gable(*f.P(shed_c, 0), eave, su, sw + 0.6, ridge - eave, "steel", rot=f.rot_u)
    # Clerestory: physical height ~24.1 m plus the explicit display-datum rise.
    b.box(*f.P(shed_c, 0), 21.5 + rise, su * 0.9, 4, 1.4, "steel", rot=f.rot_u, shade=0.9)
    b.gable(*f.P(shed_c, 0), 22.9 + rise, su * 0.9, 4.6, 1.2, "steel", rot=f.rot_u, shade=0.95)


def old_city_hall(b, fp):
    f = Frame(fp)
    _body(b, fp, 22, "concrete", 0.92)
    b.window_bays(fp["ring"], 3, height=4.2, width=1.8, pitch=4.8, trim="sand", arched=True)
    b.window_bays(fp["ring"], 10, height=4, width=1.8, pitch=4.8, trim="concrete", arched=True)
    b.window_bays(fp["ring"], 17, height=3.1, width=1.5, pitch=4.8, trim="sand", arched=True)
    b.band(fp["ring"], 8.5, 0.4, 0.5, "concrete", 0.8)
    b.band(fp["ring"], 15.5, 0.4, 0.5, "concrete", 0.8)
    b.hip(*f.P(0, 0), 22, 2 * f.hl - 6, 2 * f.hs - 6, 7, "roof_dark", rot=f.rot_u, inset=8)
    for su in (-1, 1):
        for sv in (-1, 1):
            u, v = su * (f.hl - 5), sv * (f.hs - 5)
            b.box(*f.P(u, v), -0.5, 8, 8, 28, "concrete", rot=f.rot_u, shade=0.9)
            b.pyramid(*f.P(u, v), 28, 8.8, 8.8, 7, "roof_dark", rot=f.rot_u)
    # clock tower on the north (Broad Street) face
    tu, tv = 0, f.hs - 7
    b.box(*f.P(tu, tv), -0.5, 12, 12, 44, "concrete", rot=f.rot_u, shade=0.94, name="tower")
    b.band(f.rect(tu, tv, 12, 12), 38, 0.6, 3.0, "sand", 0.95)
    for k in range(4):
        ang = f.rot_u + k * math.pi / 2
        x, y = f.P(tu, tv)
        b.clock_face(x + 6.65 * math.cos(ang), y + 6.65 * math.sin(ang), 39.5, 1.3, ang)
    b.pyramid(*f.P(tu, tv), 44, 13.2, 13.2, 16, "roof_dark", rot=f.rot_u)


def richmond_city_hall(b, fp):
    """1971 tower: dark four-storey plinth, expressed frame and overhanging roof."""
    f = Frame(fp)
    # The broad street-level base is visually distinct from the narrower office tower.
    # The matched OSM parent is the full raised site (roughly 97 x 99 m), not
    # the building envelope. The source multipatch resolves a 71 x 58 m base,
    # while its separately mapped tower part is about 53 x 33 m.
    base_su, base_sv = min(71.0, 2 * f.hl), min(58.0, 2 * f.hs)
    base = f.rect(0, 0, base_su, base_sv)
    b.extrude(base, -0.5, 14.5, "slate", 0.88, name="four-storey-plinth")
    for z in (2.2, 5.7, 9.2, 12.7):
        b.band(base, z, 0.16, 1.7, "glass", 0.55)
    su, sv = min(53.0, base_su - 8.0), min(33.0, base_sv - 8.0)
    tower = f.rect(0, 0, su, sv)
    b.extrude(tower, 14.5, 94.5, "concrete", 0.82, name="office-tower")

    # Deep window ribbons and the projecting horizontal spandrels make the real
    # tower read as nineteen storeys instead of one monolithic slab.
    floor = (94.5 - 14.5) / 19
    for i in range(19):
        z = 14.5 + i * floor + 0.65
        b.band(tower, z, 0.22, floor * 0.58, "glass", 0.62)

    # Detached perimeter columns survive at map scale as a shallow frame in
    # front of the curtain wall. Avoid corners duplicated by the two loops.
    for i in range(7):
        u = -su / 2 + (i + 0.5) * su / 7
        for side in (-1, 1):
            b.box(*f.P(u, side * (sv / 2 + 0.48)), 14.5, 0.65, 0.95, 80,
                  "concrete", rot=f.rot_u, shade=0.96, name="perimeter-column")
    for i in range(5):
        v = -sv / 2 + (i + 0.5) * sv / 5
        for end in (-1, 1):
            b.box(*f.P(end * (su / 2 + 0.48), v), 14.5, 0.95, 0.65, 80,
                  "concrete", rot=f.rot_u, shade=0.96, name="perimeter-column")

    # The roof canopy, service box and antenna form the recognizable top profile.
    b.box(*f.P(0, 0), 94.5, su + 3.2, sv + 3.2, 1.5, "concrete", rot=f.rot_u,
          shade=0.92, name="overhanging-roof")
    b.box(*f.P(0, 0), 96.0, 15, 10, 5.2, "steel", rot=f.rot_u,
          shade=0.78, name="service-box")
    b.cylinder(*f.P(0, 0), 101.2, 0.42, 8.0, "steel", n=10, shade=0.8, name="antenna")

    # Raised entrance canopy on the east side. It remains intentionally chunky
    # at this scale rather than pretending to be a survey of the lobby glazing.
    b.box(*f.P(su / 2 + 3.4, 0), 3.8, 7.0, 18.0, 0.7, "glass", rot=f.rot_u,
          shade=0.8, name="entrance-canopy")


def jefferson_hotel(b, fp):
    f = Frame(fp)
    _body(b, fp, 21, "brick")
    b.band(fp["ring"], 4.5, 0.3, 0.6, "sand", 0.95)
    b.hip(*f.P(0, 0), 21, 2 * f.hl - 4, 2 * f.hs - 4, 6.5, "roof_dark", rot=f.rot_u, inset=10)
    # signature tower on the north (Franklin Street) side
    tu, tv = 0, f.hs - 9
    b.box(*f.P(tu, tv), -0.5, 13, 13, 38, "brick", rot=f.rot_u, name="tower")
    b.band(f.rect(tu, tv, 13, 13), 33, 0.6, 2.5, "sand", 0.97)
    b.pyramid(*f.P(tu, tv), 38, 14.2, 14.2, 9, "roof_red", rot=f.rot_u)
    for su in (-1, 1):
        u, v = su * (f.hl - 5), -f.hs + 5
        b.cylinder(*f.P(u, v), -0.5, 3.2, 26, "brick", n=12)
        b.cone(*f.P(u, v), 26, 3.6, 5, "roof_dark", n=12)


def _slab_tower(b, f, u, v, su, sv, h, key, base_h, base_key, fp, fins=True, fin_key="glass"):
    _body(b, fp, base_h, base_key, cornice=False)
    b.box(*f.P(u, v), base_h, su, sv, h - base_h, key, rot=f.rot_u, name="tower")
    if fins:
        n = max(3, int(su / 7))
        for i in range(n):
            uu = u - su / 2 + su * (i + 0.5) / n
            for sgn in (-1, 1):
                b.box(*f.P(uu, v + sgn * (sv / 2 + 0.4)), base_h, su / n * 0.55, 0.8, h - base_h - 1, fin_key, rot=f.rot_u, shade=0.95)
    b.box(*f.P(u, v), h, su * 0.5, sv * 0.6, 3.5, "steel", rot=f.rot_u, shade=0.9)  # mechanical penthouse


def federal_reserve(b, fp):
    f = Frame(fp)
    _slab_tower(b, f, 0, 0, 62, 24, 119, "concrete", 10, "concrete", fp)


def james_monroe(b, fp):
    f = Frame(fp)
    _slab_tower(b, f, 0, 0, 70, 30, 137, "slate", 12, "concrete", fp, fins=True, fin_key="concrete")


def dominion_tower(b, fp):
    f = Frame(fp)
    _body(b, fp, 18, "concrete", cornice=False)
    su, sv, top, slope = 60, 40, 84, 12
    ring = f.rect(0, 0, su, sv)
    b.extrude(ring, 18, top, "glass", name="tower")
    # sloped crown: high on the north edge, low on the south
    ux, uy, vx, vy = f.ux, f.uy, f.vx, f.vy
    def P(u, v, z):
        return (f.cx + ux * u + vx * v, f.cy + uy * u + vy * v, z)
    verts = [P(-su / 2, -sv / 2, top), P(su / 2, -sv / 2, top), P(su / 2, sv / 2, top + slope), P(-su / 2, sv / 2, top + slope)]
    faces = [(0, 1, 2, 3)]
    b.add(verts, faces, "glass", 0.92)
    b.add([P(-su / 2, sv / 2, top), P(su / 2, sv / 2, top), P(su / 2, sv / 2, top + slope), P(-su / 2, sv / 2, top + slope)], [(0, 1, 2, 3)], "steel", 0.9)
    for s in (-1, 1):
        b.add([P(s * su / 2, -sv / 2, top), P(s * su / 2, sv / 2, top), P(s * su / 2, sv / 2, top + slope)], [(0, 1, 2)], "glass", 0.9)


MONROE_PARK = (-77.4518, 37.5463)  # the Mosque's minaret facade faces the park across Laurel Street


def altria_theater(b, fp):
    f = Frame(fp)
    _body(b, fp, 17, "sand", 0.98)
    b.cylinder(*f.P(0, 0), 17, 15, 4, "sand", n=20, shade=0.95)
    b.dome(*f.P(0, 0), 21, 15, 10, "roof_green", seg=20)
    b.cylinder(*f.P(0, 0), 31, 1.2, 4, "landmark_accent", n=8)
    # entrance end = the end of the long axis that faces Monroe Park (toward() is in the raw OBB frame;
    # Frame may have flipped u, so compare the two u directions in world space)
    tu, _tv = toward(fp, *MONROE_PARK)
    fx, fy = f.P(1, 0); ox, oy = f.P(0, 0)
    ax, ay = fp["obb"]["axis"]
    sign = 1 if ((fx - ox) * ax + (fy - oy) * ay) * tu > 0 else -1
    for sv in (-1, 1):
        mx, my = f.P(sign * (f.hl - 7), sv * (f.hs - 7))
        b.cylinder(mx, my, -0.5, 3.2, 36, "sand", n=12)
        b.cylinder(mx, my, 36, 3.8, 1.0, "roof_green", n=12)
        b.cone(mx, my, 37, 3.4, 6, "roof_green", n=12)
    b.box(*f.P(sign * (f.hl - 2), 0), -0.5, 6, 30, 14, "sand", rot=f.rot_u, shade=1.02)  # entrance block


def carpenter_theatre(b, fp):
    f = Frame(fp)
    _body(b, fp, 18, "sand")
    b.box(*f.P(-f.hl + 11, 0), 18, 20, 2 * f.hs - 6, 12, "brick_dark", rot=f.rot_u, name="flytower")
    b.box(*f.P(f.hl - 3, f.hs - 3), 5, 10, 3, 1.2, "landmark_accent", rot=f.rot_u)  # corner marquee
    b.band(fp["ring"], 12, 0.4, 0.8, "terracotta", 0.95)


def _facade_pixels(b, f, text, front_u, center_v, z0, pixel, key, vertical=False):
    """Chunky 3x5 sign lettering that stays legible after the landmark mesh is merged."""
    glyphs = {
        "B": ("110", "101", "110", "101", "110"),
        "Y": ("101", "101", "010", "010", "010"),
        "R": ("110", "101", "110", "101", "101"),
        "D": ("110", "101", "101", "101", "110"),
        "F": ("111", "100", "110", "100", "100"),
        "V": ("101", "101", "101", "101", "010"),
    }
    runs = list(text) if vertical else [text]
    for run_index, run in enumerate(runs):
        width = (len(run) * 4 - 1) * pixel
        base_z = z0 - run_index * pixel * 6 if vertical else z0
        for letter_index, letter in enumerate(run):
            for row, bits in enumerate(glyphs[letter]):
                for col, bit in enumerate(bits):
                    if bit == "0":
                        continue
                    v = center_v - width / 2 + (letter_index * 4 + col + 0.5) * pixel
                    z = base_z + (4 - row) * pixel
                    b.box(*f.P(front_u - 0.08, v), z, pixel * 0.78, 0.16, pixel * 0.78,
                          key, rot=f.rot_v, shade=1.02, name="sign-letter")


def byrd_theatre(b, fp):
    """Cary Street façade: brick auditorium, limestone ornament, marquee and historic blade sign.

    Visual references: the public-domain 2023 exterior photograph on Wikimedia Commons and the Byrd
    Theatre Foundation's history/restoration pages, which identify the marquee and two-storey BYRD blade.
    """
    f = Frame(fp)
    height = max(17.0, min(19.0, fp.get("height", 18.0)))
    b.extrude(fp["ring"], -0.5, height, "brick_dark", 0.88, name="auditorium")
    b.band(fp["ring"], height - 0.7, 0.35, 0.7, "brick", 0.78)
    b.extrude(fp["ring"], height, height + 0.35, "roof_dark", 0.9, name="flat-roof")

    front = -f.hl
    facade_width = min(2 * f.hs - 0.8, 24.0)

    def front_box(v, z, width, depth, tall, key, shade=1.0, name=None):
        return b.box(*f.P(front - depth / 2, v), z, width, depth, tall, key,
                     rot=f.rot_v, shade=shade, name=name)

    # Pale upper-storey ornament and the three tall window compositions visible above the marquee.
    front_box(0, 12.7, facade_width, 0.32, 0.65, "cream", 0.9, "ornament-band")
    for v, width, tall in ((-6.2, 2.5, 5.0), (0, 3.3, 5.8), (6.2, 2.5, 5.0)):
        front_box(v, 7.4, width + 0.7, 0.34, tall + 0.7, "cream", 0.92, "window-surround")
        front_box(v, 7.75, width, 0.48, tall, "roof_dark", 0.82, "upper-window")
        front_box(v, 9.8, 0.16, 0.52, tall - 0.8, "cream", 0.92, "window-mullion")

    # Deep pressed-metal canopy, reader board, entrance glazing and the rooftop BYRD letters.
    marquee_width = min(facade_width - 1.5, 18.0)
    front_box(0, 3.35, marquee_width, 4.2, 0.65, "cream", 0.88, "marquee-canopy")
    front_box(-2.0, 4.0, marquee_width * 0.72, 4.45, 2.7, "cream", 0.96, "reader-board")
    front_box(-2.0, 4.25, marquee_width * 0.65, 4.62, 0.12, "roof_dark", 0.8, "reader-line")
    front_box(-2.0, 5.9, marquee_width * 0.65, 4.62, 0.12, "roof_dark", 0.8, "reader-line")
    _facade_pixels(b, f, "BYRD", front - 4.72, -2.0, 6.95, 0.38, "brick_dark")
    for v in (-4.5, -2.25, 0, 2.25, 4.5):
        front_box(v, 0.15, 1.75, 0.38, 3.0, "roof_dark", 0.72, "entrance-glass")
        front_box(v, 0.15, 0.12, 0.52, 3.0, "cream", 0.9, "door-mullion")

    # The restored historic profile includes a tall vertical sign; a narrow low-poly blade gives the
    # landmark its recognisable silhouette without relying on a texture or external font.
    blade_v = -min(f.hs - 2.0, 8.5)
    front_box(blade_v, 7.0, 2.3, 1.0, 10.0, "brick_dark", 0.82, "byrd-blade")
    _facade_pixels(b, f, "BYRD", front - 1.08, blade_v, 14.4, 0.28, "landmark_accent", vertical=True)


def cabell_library(b, fp):
    f = Frame(fp)
    b.extrude(fp["ring"], -0.5, 13, "glass", 0.95, name="podium")
    b.box(*f.P(8, 6), 13, 62, 32, 10, "cream", rot=f.rot_u, name="upper")
    b.box(*f.P(f.hl - 30, -f.hs + 14), 13, 30, 8, 6, "concrete", rot=f.rot_u, shade=0.9)  # cantilevered reading room


def costar_tower(b, fp):
    """Foundry Park's glass office tower; footprint and height are LiDAR-reviewed."""
    f = Frame(fp)
    tower_h = float(fp["height"])
    crown_base = tower_h - 10.0
    # Preserve the reviewed override outline: this is a tight site beside the
    # existing CoStar building, so an OBB body would cover its neighbours.
    b.extrude(fp["ring"], -0.5, crown_base, "glass", 0.82, name="curtain-wall-tower")
    # Sparse floor ribbons establish scale without posing as a curtain-wall survey.
    for z in range(6, int(crown_base), 12):
        b.band(fp["ring"], z, 0.12, 0.34, "steel", 0.82)
    # The expressed vertical spines and projecting crown are the high-signal skyline cue.
    # Keep the spines just outside the wall rather than burying them in it: coplanar
    # surfaces shimmer as the camera zoom changes.
    spine_u, spine_v = f.hl + 0.35, f.hs + 0.35
    for u, v in ((spine_u, spine_v), (spine_u, -spine_v), (-spine_u, spine_v), (-spine_u, -spine_v)):
        b.box(*f.P(u, v), 0, 0.7, 0.7, tower_h, "steel", rot=f.rot_u, shade=0.95, name="vertical-crown-spine")
    b.box(*f.P(0, 0), crown_base, 2 * f.hl + 1.2, 2 * f.hs + 1.2, 1.25, "steel", rot=f.rot_u,
          shade=0.9, name="crown-belt")
    # Leave the top 1.6 m open for the service mass; embedding it in this box
    # would put its top coplanar with the crown and make the colors flicker.
    b.box(*f.P(0, 0), crown_base + 1.25, 2 * f.hl - 5.0, 2 * f.hs - 5.0, tower_h - 1.6 - (crown_base + 1.25), "glass", rot=f.rot_u,
          shade=0.72, name="glazed-crown")
    # A recessed roof service/drone-port mass adds close-view detail without exceeding the reviewed height.
    b.box(*f.P(0, 0), tower_h - 1.6, min(18.0, 2 * f.hl - 10), min(14.0, 2 * f.hs - 10), 1.6,
          "roof_dark", rot=f.rot_u, shade=0.82, name="rooftop-service")


def foundry_park_south(b, fp):
    """Six-storey CoStar amenity building, using its mapped footprint and height."""
    f = Frame(fp)
    height = float(fp["height"])
    # Keep the irregular surveyed outline at street level, but make the upper
    # storeys visibly step back. Public project imagery consistently shows broad
    # planted terraces rather than a single six-storey parking-garage-like block.
    podium_h, middle_h, top_h = 5.8, 11.8, height - 1.0
    b.extrude(fp["ring"], -0.5, podium_h, "deck", 0.92, name="timber-podium")
    for z in (0.38, 3.58):
        b.band(fp["ring"], z, 0.14, 2.25, "glass", 0.70)
        b.band(fp["ring"], z + 2.55, 0.30, 0.22, "deck", 1.0)

    # Shift each inset volume away from the Tredegar (+v) edge, exposing two
    # planted terraces toward the riverfront public frontage. The sizes remain
    # safely inside the documented footprint.
    middle = f.rect(0, -1.5, 68, 28)
    b.extrude(middle, podium_h, middle_h, "deck", 0.94, name="middle-terrace-wing")
    for z in (6.18, 9.38):
        b.band(middle, z, 0.14, 2.25, "glass", 0.70)
        b.band(middle, z + 2.55, 0.30, 0.22, "deck", 1.0)

    top = f.rect(3, -6, 52, 18)
    b.extrude(top, middle_h, top_h, "deck", 0.96, name="upper-terrace-wing")
    for z in (12.18, 15.38):
        b.band(top, z, 0.14, 2.25, "glass", 0.72)
        b.band(top, z + 2.55, 0.30, 0.22, "deck", 1.0)

    # Dense roof planting and the two exposed deck planes are deliberately broad:
    # they are the cues that survive the map's normal oblique camera distance.
    b.box(*f.P(0, 7.8), middle_h + 0.02, 60, 7, 0.28, "roof_green", rot=f.rot_u,
          shade=0.98, name="lower-planted-terrace")
    b.box(*f.P(3, -6), top_h, 45, 12, 0.8, "roof_green", rot=f.rot_u,
          shade=0.98, name="planted-roof")
    # A compact Tredegar forecourt makes the public edge legible at map scale.
    # It remains a low visual terrace, not a claim about paving joints or furniture.
    b.box(*f.P(-18, f.hs + 3), -0.5, 58, 7, 0.22, "concrete", rot=f.rot_u,
          shade=0.98, name="tredegar-forecourt")
    b.box(*f.P(14, f.hs + 2), -0.27, 18, 4, 0.18, "roof_green", rot=f.rot_u,
          shade=0.98, name="forecourt-planting")


def _corner_rect(fp, corners):
    """(cx, cy, sx, sy, rot) for a quadrilateral given as projected corner points, relative to the footprint
    centroid. Used where a footprint is not one rectangle and OBB fractions would misplace the roofs."""
    ox, oy = fp["centroid_proj"]
    pts = [(x - ox, y - oy) for x, y in corners]
    (ax, ay), (bx, by), (cx_, cy_), _ = pts
    cx, cy = sum(x for x, _ in pts) / 4, sum(y for _, y in pts) / 4
    return cx, cy, math.hypot(bx - ax, by - ay), math.hypot(cx_ - bx, cy_ - by), math.atan2(by - ay, bx - ax)


def pump_house(b, fp):
    """Byrd Park Pump House (1883, Wilfred Cutshaw): rough grey granite Gothic Revival pump station with steep
    slate gables, pointed-arch windows and the open-air dance hall in the roof storey.

    The OSM way (236152567) is an L: a 39 x 16 m pump-room block along the canal and a lower 23 x 14 m wing
    at its west end. Walls come from the real ring; roofs sit on the two blocks by their surveyed corners.
    Massing from the VDHR nomination and public photographs; nothing traced from imagery.
    """
    eave, ridge = 8.0, 15.0
    wing_eave, wing_ridge = 5.6, 10.0
    granite, roof = "steel", "roof_dark"

    # main block corners (EPSG:32618): SW end at the wing, NE end at the river
    main = [(280335.1, 4157305.7), (280368.3, 4157285.5), (280376.9, 4157299.5), (280342.8, 4157320.3)]
    wing = [(280311.2, 4157312.5), (280318.5, 4157324.3), (280338.0, 4157312.5), (280330.7, 4157300.7)]
    mcx, mcy, msx, msy, mrot = _corner_rect(fp, main)
    wcx, wcy, wsx, wsy, wrot = _corner_rect(fp, wing)

    # walls: the whole surveyed ring to the wing eave, then only the pump room up to its taller eave
    b.extrude(fp["ring"], -0.5, wing_eave, granite, 0.92, name="walls")
    b.band(fp["ring"], 0.3, 0.25, 0.9, granite, 0.8)  # rusticated plinth
    b.band(fp["ring"], wing_eave - 0.45, 0.35, 0.45, granite, 0.78)  # eave course
    main_ring = rect_ring(mcx, mcy, msx, msy, mrot)
    b.extrude(main_ring, wing_eave - 0.2, eave, granite, 0.92, name="pump-room")
    b.band(main_ring, eave - 0.45, 0.35, 0.45, granite, 0.78)

    # tall two-storey pointed windows on the pump room; small ones on the wing
    b.window_bays(main_ring, 1.2, height=3.6, width=1.3, pitch=3.9, trim="concrete", arched="pointed")
    b.window_bays(main_ring, 5.4, height=2.2, width=1.1, pitch=3.9, trim="concrete", arched="pointed")
    b.window_bays(rect_ring(wcx, wcy, wsx, wsy, wrot), 1.2, height=2.8, width=1.2, pitch=4.2, trim="concrete", arched="pointed")

    # steep slate gables, pump-room ridge along the canal
    b.gable(mcx, mcy, eave, msx + 0.9, msy + 0.9, ridge - eave, roof, rot=mrot, name="main-roof")
    b.gable(wcx, wcy, wing_eave, wsx + 0.9, wsy + 0.9, wing_ridge - wing_eave, roof, rot=wrot, name="wing-roof")
    # gable ends in granite, flush under the roof, so the ends do not read as open sheds
    ux, uy = math.cos(mrot), math.sin(mrot)
    for s in (-1, 1):
        ex, ey = mcx + ux * s * (msx / 2 - 0.05), mcy + uy * s * (msx / 2 - 0.05)
        b.pediment(ex, ey, eave, msy, 0.1, ridge - eave, granite, rot=mrot + math.pi / 2, shade=0.9)
    wux, wuy = math.cos(wrot), math.sin(wrot)
    ex, ey = wcx - wux * (wsx / 2 - 0.05), wcy - wuy * (wsx / 2 - 0.05)
    b.pediment(ex, ey, wing_eave, wsy, 0.1, wing_ridge - wing_eave, granite, rot=wrot + math.pi / 2, shade=0.9)

    # cross gables over the dance hall: one each side, centred on the long facades
    nx, ny = -uy, ux
    for s in (-1, 1):
        gx, gy = mcx + nx * s * (msy / 2 - 3.0), mcy + ny * s * (msy / 2 - 3.0)
        b.box(gx, gy, eave - 0.3, 6.0, 6.0, 1.6, granite, rot=mrot, shade=0.9, name="cross-gable-wall")
        b.gable(gx, gy, eave + 1.3, 6.4, 6.6, 3.4, roof, rot=mrot + math.pi / 2, name="cross-gable")
        # its pointed window
        wx, wy = gx + nx * s * 3.31, gy + ny * s * 3.31
        b.box(wx, wy, eave - 0.1, 1.7, 0.2, 2.4, "concrete", rot=mrot, name="window-surround")
    # dormers along both eaves, and a ridge ventilator
    for k in (-1, 1):
        for s in (-1, 1):
            dx, dy = mcx + ux * k * msx * 0.32 + nx * s * (msy / 2 - 1.6), mcy + uy * k * msx * 0.32 + ny * s * (msy / 2 - 1.6)
            b.box(dx, dy, eave + 0.6, 1.8, 1.8, 1.4, granite, rot=mrot, shade=0.9, name="dormer")
            b.gable(dx, dy, eave + 2.0, 2.2, 2.2, 1.1, roof, rot=mrot + math.pi / 2)
    b.box(mcx, mcy, ridge - 0.6, 3.2, 1.4, 1.5, roof, rot=mrot, shade=0.85, name="ridge-vent")
    b.gable(mcx, mcy, ridge + 0.9, 3.6, 1.8, 0.7, roof, rot=mrot, shade=0.85)


def carillon(b, fp):
    """Virginia War Memorial Carillon (1932, Cram & Ferguson): a 73 m brick Georgian Revival bell tower with
    limestone trim, rising from a low memorial base whose wings carry round-arched loggias.

    Footprint = OSM outline way/527243391; the mapped tower part (way/527243392) is 10 x 10 m, centred on
    the long axis and set toward the south side. OSM height 73.15 m; proportions from public photographs.
    """
    f = Frame(fp)
    top = max(70.0, float(fp.get("height") or 73.15))
    base_h = 7.6
    tower_u, tower_v, ts = 0.3, -2.2, 10.2

    # memorial base: brick with a limestone plinth, cornice and parapet
    b.extrude(fp["ring"], -0.5, base_h, "brick", 0.96, name="base")
    b.band(fp["ring"], 0.2, 0.3, 1.0, "cream", 0.95)
    b.band(fp["ring"], base_h - 0.7, 0.45, 0.7, "cream", 0.97)
    b.band(fp["ring"], base_h + 0.4, 0.15, 0.6, "cream", 0.92)  # parapet coping
    b.extrude(fp["ring"], base_h, base_h + 0.25, "roof_flat", 0.85, name="base-roof")
    # arcaded loggias on the wings, both long faces
    for su in (-1, 1):
        wing = f.rect(su * (f.hl - 5.5), -2.2, 10.0, 21.0)
        b.window_bays(wing, 1.2, height=4.6, width=2.4, pitch=3.5, trim="cream", arched=True, glass="brick_dark")
    # entrance bay on the front (+v) bump
    b.window_bays(f.rect(0, 11.0, 12.0, 5.0), 0.6, height=5.2, width=2.8, pitch=4.5, trim="cream", arched=True, glass="brick_dark")

    # shaft
    shaft = f.rect(tower_u, tower_v, ts, ts)
    belfry_z = top - 21.0
    b.extrude(shaft, base_h, belfry_z, "brick", 1.0, name="shaft")
    b.band(shaft, base_h + 0.8, 0.3, 1.2, "cream", 0.96)  # tower plinth
    # limestone corner quoins
    for su in (-1, 1):
        for sv in (-1, 1):
            b.box(*f.P(tower_u + su * (ts / 2 - 0.3), tower_v + sv * (ts / 2 - 0.3)), base_h, 0.8, 0.8,
                  belfry_z - base_h, "cream", rot=f.rot_u, shade=0.94, name="quoin")
    # tall recessed window slots, three tiers on every face
    for z, h in ((base_h + 4.0, 7.0), (base_h + 15.0, 9.0), (base_h + 28.0, 9.0)):
        b.window_bays(shaft, z, height=h, width=1.5, pitch=ts, trim="cream", glass="brick_dark")

    # belfry: limestone stage with tall arched openings on each face, then cornice
    belfry = f.rect(tower_u, tower_v, ts + 0.4, ts + 0.4)
    belfry_h = 11.5
    b.extrude(belfry, belfry_z - 0.2, belfry_z + belfry_h, "cream", 0.98, name="belfry")
    b.band(belfry, belfry_z - 0.4, 0.5, 0.8, "cream", 0.9)
    b.window_bays(belfry, belfry_z + 1.2, height=8.2, width=3.0, pitch=ts + 0.4, trim="cream", arched=True, glass="brick_dark")
    b.band(belfry, belfry_z + belfry_h - 0.2, 0.7, 1.0, "cream", 0.9)

    # stepped crown and pyramidal cap with a small lantern
    z = belfry_z + belfry_h + 0.8
    b.box(*f.P(tower_u, tower_v), z, ts - 1.0, ts - 1.0, 1.6, "cream", rot=f.rot_u, shade=0.94, name="crown-step")
    z += 1.6
    b.box(*f.P(tower_u, tower_v), z, ts - 3.0, ts - 3.0, 1.2, "cream", rot=f.rot_u, shade=0.92, name="crown-step")
    z += 1.2
    cap_h = top - 1.8 - z
    b.pyramid(*f.P(tower_u, tower_v), z, ts - 3.0, ts - 3.0, cap_h, "slate", rot=f.rot_u, name="cap")
    b.cylinder(*f.P(tower_u, tower_v), top - 2.4, 0.55, 1.6, "cream", n=8, name="lantern")
    b.cone(*f.P(tower_u, tower_v), top - 0.8, 0.7, 0.8, "slate", n=8)


def cookie_factory_lofts(b, fp):
    """Cookie Factory Lofts (1927, Southern Biscuit Co. / later Interbake Foods / FFV): a six-storey
    reinforced-concrete factory in Manchester, wrapped by lower single-storey wings, topped with a riveted
    steel water tank and the "HOME OF FFV COOKIES AND CRACKERS" rooftop sign on its scaffold tower.

    fp["ring"] is the full OSM outline (way/265138862, the low wings). The tall block is a separate
    building:part (way/466009777, 40 m / 6 levels); its four surveyed corners (EPSG:32618) place it here
    since it is not centred on the outline's own OBB. Sign wording, water tower and proportions from the
    public Google Maps street-level photo; nothing else traced from imagery.
    """
    wing_h = 8.0
    tower_h = 40.0
    wall, trim, glass = "concrete", "cream", "roof_dark"

    # low wings wrapping the tower, then the tall block on its own surveyed footprint
    b.extrude(fp["ring"], -0.5, wing_h, wall, 0.92, name="wings")
    b.band(fp["ring"], wing_h - 0.5, 0.3, 0.5, trim, 0.88)

    main = [(282040.17, 4160186.74), (282009.9, 4160211.83), (282039.04, 4160245.82), (282068.58, 4160221.52)]
    mcx, mcy, msx, msy, mrot = _corner_rect(fp, main)
    main_ring = rect_ring(mcx, mcy, msx, msy, mrot)
    tux, tuy = math.cos(mrot), math.sin(mrot)
    tvx, tvy = -tuy, tux

    def TP(u, v):
        return (mcx + tux * u + tvx * v, mcy + tuy * u + tvy * v)

    b.extrude(main_ring, wing_h - 0.3, tower_h, wall, 0.95, name="tower")
    b.band(main_ring, 0.3, 0.25, 1.0, trim, 0.85)  # plinth
    # ground-floor arcade, four tiers of factory sash windows, then the frieze under the cornice
    b.window_bays(main_ring, 1.5, height=4.0, width=2.0, pitch=6.5, trim=trim, arched=True, glass=glass)
    for z in (7.5, 14.0, 20.5, 27.0):
        b.window_bays(main_ring, z, height=4.3, width=1.8, pitch=4.6, trim=trim, glass=glass)
    b.band(main_ring, 33.5, 0.15, 1.0, "roof_dark", 0.8)  # dark frieze (INTERBAKE FOODS lettering band)
    b.window_bays(main_ring, 35.0, height=3.5, width=1.8, pitch=4.6, trim=trim, glass=glass)
    b.band(main_ring, tower_h - 1.0, 0.35, 1.0, trim, 0.9)  # cornice
    b.extrude(main_ring, tower_h, tower_h + 0.3, "roof_flat", 0.85, name="roof")

    # riveted steel water tank on a braced leg tower, set back from the sign
    wx, wy = TP(11.0, 0.0)
    tank_base = tower_h + 8.0
    for su in (-1, 1):
        for sv in (-1, 1):
            lx, ly = TP(11.0 + su * 3.2, sv * 3.2)
            b.box(lx, ly, tower_h + 0.2, 0.35, 0.35, tank_base - tower_h - 0.2, "steel", rot=mrot, shade=0.9, name="tank-leg")
    b.cylinder(wx, wy, tower_h + 4.0, 3.6, 0.25, "steel", n=8, shade=0.85, name="tank-brace")
    b.cylinder(wx, wy, tank_base, 4.3, 5.0, "steel", n=14, name="tank")
    b.band(rect_ring(wx, wy, 8.6, 8.6, mrot), tank_base + 0.3, 0.1, 0.3, "steel", 0.9)
    b.cone(wx, wy, tank_base + 5.0, 4.3, 2.4, "roof_dark", n=14, name="tank-roof")
    b.cylinder(wx, wy, tank_base + 7.4, 0.2, 1.0, "steel", n=6)

    # rooftop sign scaffold, set toward the opposite end from the tank: steel lattice legs, ribbon bands
    # for "HOME OF" and "COOKIES AND CRACKERS", and the bold "FFV" cursive pixel-text between them
    sign_u, sign_half = -10.0, 13.0
    scaffold_h = 12.6
    p0, p1 = TP(sign_u, -sign_half), TP(sign_u, sign_half)
    b.colonnade(p0, p1, tower_h + 0.2, scaffold_h, 6, 0.14, "steel", cap=False)
    for v in (-sign_half + 1.5, sign_half - 1.5):
        lx, ly = TP(sign_u, v)
        b.box(lx, ly, tower_h + 0.2, 0.3, 0.3, scaffold_h, "steel", rot=mrot, shade=0.85, name="sign-brace")
    b.box(*TP(sign_u, 0.0), tower_h + 10.9, 0.6, sign_half * 2 - 2.0, 1.5, "seven_red", rot=mrot, name="sign-ribbon-top")
    b.box(*TP(sign_u, 0.0), tower_h + 1.4, 0.6, sign_half * 2 - 2.0, 1.5, "roof_dark", rot=mrot, shade=0.95, name="sign-ribbon-bottom")

    # bold pixel "FFV" between the two ribbons, the sign's most recognisable element
    glyphs = {"F": ("111", "100", "110", "100", "100"), "V": ("101", "101", "101", "101", "010")}
    pixel = 1.8
    width = (3 * 4 - 1) * pixel
    for li, letter in enumerate("FFV"):
        for row, bits in enumerate(glyphs[letter]):
            for col, bit in enumerate(bits):
                if bit == "0":
                    continue
                v = -width / 2 + (li * 4 + col + 0.5) * pixel
                z = tower_h + 3.1 + (4 - row) * pixel
                b.box(*TP(sign_u - 0.3, v), z, pixel * 0.78, 0.16, pixel * 0.78, "seven_white",
                      rot=mrot + math.pi / 2, name="sign-letter")


def _massing_parts(fp):
    """{part_id: [ring, ...]} for the landmark's building parts, centroid-relative and CCW. LiDAR massing parts are
    keyed by their tier ("base", "mid", ...), OSM parts by "way/<id>"."""
    import json

    ox, oy = fp["centroid_proj"]
    parts = {}
    fc = json.loads((ROOT / "data" / "tiles" / fp["tile"] / "buildings.geojson").read_text())
    for ft in fc["features"]:
        p = ft["properties"]
        if p.get("landmark") != fp["props"]["landmark"] or not p.get("is_part"):
            continue
        g = ft["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            ring = clean_ring(poly[0])
            if shoelace(ring) < 0:
                ring.reverse()
            parts.setdefault(p["id"].rsplit(":", 1)[-1], []).append([(x - ox, y - oy) for x, y in ring])
    return parts


def _inside(ring, x, y):
    hit = False
    for i in range(len(ring)):
        (x0, y0), (x1, y1) = ring[i - 1], ring[i]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def vmfa(b, fp):
    """Virginia Museum of Fine Arts: pale limestone gallery wings in three roof tiers, with skylit gallery
    roofs and the glazed entrance front on North Arthur Ashe Boulevard.

    Walls follow the 2025 Richmond LiDAR massing parts on way/146689449 (base 6 m, galleries 15.8 m, a
    north block to 19.5 m with 21.5 m roof structures), not the OBB. The site falls ~3.5 m to the south-west,
    so walls start well below the centroid grade. Detailing is generic; nothing traced from imagery.
    """
    parts = _massing_parts(fp)
    f = Frame(fp)
    stone, trim = "cream", "concrete"
    base_h, mid_h, upper_h = 6.0, 15.8, 19.5
    boulevard = (281470.0 - fp["centroid_proj"][0], 4159380.0 - fp["centroid_proj"][1])

    # base storey on the full outline, and the entrance glazing on the edges facing the Boulevard
    ring = fp["ring"]
    b.extrude(ring, -4.5, base_h, stone, 0.9, name="base")
    b.band(ring, 0.0, 0.25, 0.8, trim, 0.85)
    b.band(ring, base_h - 0.5, 0.3, 0.5, trim, 0.9)
    ex, ey = boulevard
    el = math.hypot(ex, ey)
    for i, (ax, ay) in enumerate(ring):
        bx, by = ring[(i + 1) % len(ring)]
        length = math.hypot(bx - ax, by - ay)
        if length < 8.0:
            continue
        ux, uy = (bx - ax) / length, (by - ay) / length
        nx, ny = uy, -ux  # outward for a CCW ring
        if (nx * ex + ny * ey) / el < 0.6:
            continue
        rot = math.atan2(uy, ux)
        mx, my = (ax + bx) / 2 + nx * 0.12, (ay + by) / 2 + ny * 0.12
        b.box(mx, my, 0.2, length - 2.0, 0.2, base_h - 1.2, "glass", rot=rot, name="entrance-glass")
        for k in range(int((length - 2.0) / 2.5) + 1):
            t = -(length - 2.0) / 2 + k * (length - 2.0) / max(1, int((length - 2.0) / 2.5))
            b.box(mx + ux * t + nx * 0.12, my + uy * t + ny * 0.12, 0.2, 0.14, 0.14, base_h - 1.2, "steel", rot=rot, name="mullion")
    b.extrude(ring, base_h, base_h + 0.2, "roof_flat", 0.9, name="base-roof")

    # gallery wings: blank limestone with a tall clerestory band, flat roofs with rows of skylights
    for mid in parts.get("mid", []):
        b.extrude(mid, base_h - 0.3, mid_h, stone, 0.96, name="galleries")
        b.band(mid, mid_h - 0.7, 0.35, 0.7, trim, 0.9)
        b.band(mid, mid_h, 0.1, 0.5, stone, 0.9)  # parapet
        b.extrude(mid, mid_h, mid_h + 0.15, "roof_flat", 0.92, name="gallery-roof")
        b.window_bays(mid, base_h + 1.5, height=2.2, width=4.0, pitch=12.0, trim=trim, glass="glass")
    # long skylight strips along the wings: step each row in 3 m cells and merge the runs that stay clear
    higher = parts.get("upper", []) + parts.get("top", [])

    def clear(u, v):
        corners = [f.P(u + du, v + dv) for du in (-1.5, 1.5) for dv in (-2.5, 2.5)]
        return all(any(_inside(m, *c) for m in parts.get("mid", [])) for c in corners) and \
            not any(_inside(h, *c) for h in higher for c in corners)

    for v in range(-42, 43, 14):
        run = []
        for u in [k * 3.0 for k in range(-26, 27)] + [None]:
            if u is not None and clear(u, v):
                run.append(u)
                continue
            if len(run) >= 4:
                u0, u1 = run[0] - 1.0, run[-1] + 1.0
                b.box(*f.P((u0 + u1) / 2, v), mid_h + 0.1, u1 - u0, 3.6, 0.4, "steel", rot=f.rot_u, shade=0.9, name="skylight-curb")
                b.gable(*f.P((u0 + u1) / 2, v), mid_h + 0.5, u1 - u0, 3.6, 1.2, "glass", rot=f.rot_u, name="skylight")
            run = []

    # taller north block, then its roof structures: the big glazed lantern and a smaller stone plant room
    for up in parts.get("upper", []):
        b.extrude(up, mid_h - 0.3, upper_h, stone, 1.0, name="north-block")
        b.band(up, upper_h - 0.6, 0.35, 0.6, trim, 0.92)
        b.extrude(up, upper_h, upper_h + 0.15, "roof_flat", 0.95, name="north-roof")
    for top in parts.get("top", []):
        z0 = mid_h  # the lantern overhangs the north block's edge, so both start at the gallery roof
        area = abs(sum(top[i - 1][0] * top[i][1] - top[i][0] * top[i - 1][1] for i in range(len(top)))) / 2
        if area > 250:
            b.extrude(top, z0 - 0.2, 21.0, "glass", 0.95, name="lantern")
            b.band(top, 21.0, 0.2, 0.5, "steel", 0.9)
            b.extrude(top, 21.5, 21.6, "glass", 1.05, name="lantern-roof")
        else:
            b.extrude(top, z0 - 0.2, 21.5, stone, 0.88, name="plant-room")
            b.band(top, 21.0, 0.2, 0.5, trim, 0.85)


def science_museum(b, fp):
    """Science Museum of Virginia in Broad Street Station (1919, John Russell Pope): a limestone Beaux-Arts
    terminal whose saucer-domed rotunda and Doric portico face West Broad Street, with the old concourse arm
    running north-east toward the tracks and the museum's Dome theatre in the north-west wing.

    Outline = OSM way/252997396; tier rings (EPSG:32618) are from the 2025 Richmond LiDAR. The station steps
    down the hill: Broad Street is at 65.9 m, the rear at 60.5 m, and the main block and arm share one
    ~81 m roof. The viewer multiplies terrain by Z_SCALE (1.6) and not buildings, so heights below are
    display heights above the outline's ground_z, set so the front reads ~14 m tall from Broad Street.
    Dome colours (dark rotunda, white theatre) follow public aerial photos; portico column count is generic; nothing traced from imagery.
    """
    ox, oy = fp["centroid_proj"]

    def rel(pts):
        ring = [(x - ox, y - oy) for x, y in pts]
        return ring if shoelace(ring) > 0 else ring[::-1]  # band/window_bays expect CCW

    front = (65.9 - float(fp["ground_z"])) * 1.6  # Broad Street pavement in display coordinates
    wing_h, roof, drum_top, crown = 10.5, 22.0, 30.5, 39.1
    stone, trim, dome_key = "cream", "concrete", "slate"

    # low wings on the whole outline (north-west wing and the north-east block)
    ring = fp["ring"]
    b.extrude(ring, -1.0, wing_h, stone, 0.9, name="wings")
    b.band(ring, wing_h - 0.5, 0.3, 0.5, trim, 0.88)
    b.extrude(ring, wing_h, wing_h + 0.15, "roof_flat", 0.9, name="wing-roof")

    # main block and concourse arm: one roof level, tall arched windows above the rear ground storey
    main = rel([(282181.9, 4160014.7), (282187.0, 4160017.0), (282196.0, 4160014.0), (282207.3, 4160005.1),
                (282217.0, 4160017.0), (282221.5, 4160013.6), (282253.5, 4160054.4), (282266.8, 4160043.0),
                (282235.1, 4160003.5), (282233.9, 4160000.3), (282240.7, 4159995.0), (282239.0, 4159992.0),
                (282236.0, 4159989.0), (282229.1, 4159989.4), (282240.0, 4159979.0), (282244.5, 4159966.9),
                (282225.9, 4159943.0), (282212.8, 4159951.9), (282208.0, 4159947.3), (282173.6, 4159973.8),
                (282178.2, 4159978.8), (282165.7, 4159989.3), (282184.4, 4160012.7)])
    b.extrude(main, wing_h - 0.3, roof, stone, 0.97, name="main-block")
    b.band(main, roof - 1.2, 0.45, 1.2, trim, 0.92)  # entablature
    b.band(main, roof, 0.1, 0.8, stone, 0.9)  # attic parapet
    b.extrude(main, roof, roof + 0.2, "roof_flat", 0.92, name="main-roof")
    b.window_bays(main, front + 2.5, height=6.5, width=2.4, pitch=6.5, trim=trim, arched=True, glass="glass")

    # rotunda: octagonal attic drum with lunettes, then the low saucer dome (LiDAR crown ~98 m)
    drum = rel([(282189.0, 4159985.0), (282198.0, 4159999.0), (282211.0, 4160000.0), (282223.0, 4159990.0),
                (282224.0, 4159977.0), (282215.0, 4159966.0), (282201.0, 4159967.0), (282194.0, 4159972.0)])
    b.extrude(drum, roof - 0.2, drum_top, stone, 1.0, name="drum")
    b.band(drum, drum_top - 0.8, 0.4, 0.8, trim, 0.92)
    b.window_bays(drum, roof + 2.2, height=3.6, width=3.4, pitch=7.0, trim=trim, arched=True, glass="glass")
    dx, dy = 282206.9 - ox, 4159979.8 - oy
    b.cylinder(dx, dy, drum_top - 0.1, 14.6, 0.6, trim, n=24, shade=0.9, name="dome-ring")
    b.dome(dx, dy, drum_top + 0.5, 14.0, crown - drum_top - 1.4, dome_key, seg=24, rings=6, name="dome")
    b.cylinder(dx, dy, crown - 1.0, 2.2, 0.9, trim, n=12, shade=0.95, name="oculus-curb")

    # Doric portico on the Broad Street front: stylobate at pavement level, columns, entablature
    p0, p1 = (282173.6 - ox, 4159973.8 - oy), (282208.0 - ox, 4159947.3 - oy)
    length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    ux, uy = (p1[0] - p0[0]) / length, (p1[1] - p0[1]) / length
    nx, ny = uy, -ux  # outward, away from the rotunda
    rot = math.atan2(uy, ux)
    tc, half = 22.7, 14.0  # the rotunda's projection on this edge, and the portico half-width

    def E(t, out):
        return (p0[0] + ux * t + nx * out, p0[1] + uy * t + ny * out)

    b.box(*E(tc, 1.4), front - 1.0, 2 * half + 3.0, 3.6, 1.2, trim, rot=rot, shade=0.95, name="stylobate")
    b.box(*E(tc, 0.12), front, 2 * half, 0.25, roof - front - 1.6, stone, rot=rot, shade=0.62, name="portico-recess")
    b.colonnade(E(tc - half + 1.0, 1.6), E(tc + half - 1.0, 1.6), front + 0.2, roof - front - 2.4, 8, 0.75, stone)
    b.box(*E(tc, 1.0), roof - 2.2, 2 * half + 1.0, 2.6, 2.2, stone, rot=rot, shade=0.98, name="portico-entablature")
    b.band(rect_ring(*E(tc, 1.0), 2 * half + 1.0, 2.6, rot), roof - 0.4, 0.2, 0.4, trim, 0.9)

    # Dome theatre in the north-west wing (OSM part way/334113913): drum wall, then its shallow dome
    tx, ty = 282186.4 - ox, 4160040.3 - oy
    b.cylinder(tx, ty, wing_h - 0.2, 14.45, 1.3, stone, n=24, shade=0.93, name="theatre-drum")
    b.dome(tx, ty, wing_h + 1.1, 14.45, 7.1, "seven_white", seg=24, rings=5, name="theatre-dome")


def sacred_heart(b, fp):
    """Cathedral of the Sacred Heart (1906, Joseph H. McGinnis): an Indiana-limestone Latin cross with a
    gabled nave and transepts, lean-to aisles, a round west apse, an octagonal drum and copper dome over the
    crossing, and twin domed bell towers flanking the Ionic portico that faces Monroe Park (east).

    Walls follow the OSM parts on way/229623396 (nave+apse 463800180, aisles 463800179, transept 463800178,
    crossing 463800176, drum 463800190, towers 463800186/188, portico 463800185). OSM part heights are rough,
    so heights are from the 2025 Richmond LiDAR: aisles 11 m, nave eaves 17.5 / ridge 21.5 m, towers 29 m
    with caps to 36 m, dome crown ~43 m. The brick west wing uses its own parts (822799759/62/63/64).
    Column count and trim are generic; nothing traced from imagery.
    """
    parts = _massing_parts(fp)

    def part(way):
        return parts[f"way/{way}"][0]

    def cen(ring):
        return sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring)

    stone, trim, roof, copper = "cream", "concrete", "slate", "roof_green"
    aisle_h, eave, ridge = 11.0, 17.5, 21.5
    # nave axis from the tower faces: u runs west (apse) to east (front)
    (ax, ay), (bx, by) = part(463800186)[3], part(463800186)[0]
    rot = math.atan2(by - ay, bx - ax)
    ux, uy = math.cos(rot), math.sin(rot)
    vx, vy = -uy, ux

    def span(ring, c):
        us = [(x - c[0]) * ux + (y - c[1]) * uy for x, y in ring]
        vs = [(x - c[0]) * vx + (y - c[1]) * vy for x, y in ring]
        return min(us), max(us), min(vs), max(vs)

    # stone base on the whole outline (porches and links between parts), then the brick west wing on its parts
    base = inset_ring(fp["ring"], 0.1)  # tucked inside the part walls it shares edges with, so they do not z-fight
    b.extrude(base, -0.5, 6.0, stone, 0.95, name="base")
    b.extrude(base, 6.0, 6.15, "roof_flat", 0.85, name="base-roof")
    for way, h in ((822799759, 7.7), (822799764, 8.8), (822799763, 12.0), (822799762, 12.0)):
        r = part(way)
        b.extrude(r, -0.5, h, "brick", 0.95, name="west-wing")
        b.band(r, h - 0.8, 0.25, 0.5, trim, 0.88)
        b.extrude(r, h, h + 0.15, "roof_flat", 0.85, name="west-wing-roof")
        b.window_bays(r, 1.8 if h < 10 else 7.4, height=2.4, width=1.2, pitch=3.8, trim=trim)
    b.window_bays(part(822799763), 1.8, height=2.4, width=1.2, pitch=3.8, trim=trim)
    b.window_bays(part(822799762), 1.8, height=2.4, width=1.2, pitch=3.8, trim=trim)

    # aisles: limestone walls with round-headed windows, flat lead roofs
    aisles = part(463800179)
    b.extrude(aisles, -0.5, aisle_h, stone, 0.95, name="aisles")
    b.band(aisles, 0.2, 0.25, 1.0, trim, 0.9)
    b.band(aisles, aisle_h - 0.7, 0.35, 0.7, trim, 0.9)
    b.extrude(aisles, aisle_h, aisle_h + 0.15, "roof_flat", 0.85, name="aisle-roof")
    b.window_bays(aisles, 3.5, height=5.0, width=1.8, pitch=5.5, trim=trim, arched=True, glass="glass")

    # nave and apse: clerestory walls to the eaves, a gable along the axis and a half-cone over the apse
    nave = part(463800180)
    c = cen(part(463800190))  # crossing centre
    u0, u1, v0, v1 = span(nave, c)
    half = (v1 - v0) / 2
    vm = (v0 + v1) / 2
    b.extrude(nave, aisle_h - 0.3, eave, stone, 0.98, name="nave")
    b.band(nave, eave - 0.6, 0.35, 0.6, trim, 0.92)
    b.window_bays(nave, aisle_h + 1.3, height=3.6, width=2.0, pitch=4.5, trim=trim, arched=True, glass="glass")
    apse_u = u0 + half  # apse centre: the round end has the nave's half-width as its radius
    gu0, gu1 = apse_u, u1
    gc = (c[0] + ux * (gu0 + gu1) / 2 + vx * vm, c[1] + uy * (gu0 + gu1) / 2 + vy * vm)
    b.gable(*gc, eave, gu1 - gu0 + 0.4, 2 * half + 0.8, ridge - eave, roof, rot=rot, name="nave-roof")
    b.cone(c[0] + ux * apse_u + vx * vm, c[1] + uy * apse_u + vy * vm, eave, half + 0.4, ridge - eave, roof, n=20, name="apse-roof")

    # transept: same eaves and ridge, gabled across the nave, with pediments on both ends
    tr = part(463800178)
    tc = cen(tr)
    tu0, tu1, tv0, tv1 = span(tr, tc)
    b.extrude(tr, -0.5, eave, stone, 0.97, name="transept")
    b.band(tr, eave - 0.6, 0.35, 0.6, trim, 0.92)
    b.window_bays(tr, 4.0, height=6.0, width=2.2, pitch=6.0, trim=trim, arched=True, glass="glass")
    b.gable(*tc, eave, tv1 - tv0 + 0.8, tu1 - tu0 + 0.4, ridge - eave, roof, rot=rot + math.pi / 2, name="transept-roof")
    for s in (-1, 1):
        ex, ey = tc[0] + vx * s * ((tv1 - tv0) / 2 + 0.2), tc[1] + vy * s * ((tv1 - tv0) / 2 + 0.2)
        b.pediment(ex, ey, eave, tu1 - tu0 + 0.6, 0.5, ridge - eave + 0.4, stone, rot=rot, shade=0.95)

    # crossing: square base above the roofs, octagonal drum with arched windows, copper dome and lantern
    b.extrude(part(463800176), eave, ridge + 2.0, stone, 1.0, name="crossing")
    b.band(part(463800176), ridge + 1.5, 0.3, 0.5, trim, 0.9)
    drum = part(463800190)
    drum_top = 30.5
    b.extrude(drum, ridge + 1.8, drum_top, stone, 1.0, name="drum")
    b.band(drum, drum_top - 0.7, 0.35, 0.7, trim, 0.92)
    b.window_bays(drum, ridge + 3.2, height=3.8, width=1.6, pitch=5.0, trim=trim, arched=True, glass="glass")
    r = math.sqrt(abs(shoelace(drum)) / math.pi)
    b.dome(*c, drum_top, r - 0.2, 10.5, copper, seg=24, rings=6, name="dome")
    b.cylinder(*c, drum_top + 10.2, 1.1, 1.6, stone, n=8, name="lantern")
    b.cone(*c, drum_top + 11.8, 1.3, 1.2, copper, n=8)

    # twin bell towers: square shafts, open belfry stage, then small copper domes
    tower_h = 29.0
    for way in (463800186, 463800188):
        t = part(way)
        tx, ty = cen(t)
        side = math.sqrt(abs(shoelace(t)))
        b.extrude(t, -0.5, tower_h, stone, 1.0, name="tower")
        for z in (aisle_h - 0.7, ridge - 0.6):
            b.band(t, z, 0.3, 0.7, trim, 0.9)
        b.window_bays(t, ridge + 0.8, height=4.6, width=2.0, pitch=side - 0.5, trim=trim, arched=True, glass="brick_dark")
        b.band(t, tower_h - 0.8, 0.45, 0.8, trim, 0.9)
        b.cylinder(tx, ty, tower_h, side / 2 - 0.6, 1.4, stone, n=12, shade=0.95, name="tower-drum")
        b.dome(tx, ty, tower_h + 1.4, side / 2 - 0.8, 3.8, copper, seg=16, rings=5, name="tower-dome")
        b.cylinder(tx, ty, tower_h + 5.0, 0.4, 1.6, stone, n=6)

    # portico between the towers: stylobate, six Ionic columns, entablature and pediment
    po = part(463800185)
    (p0x, p0y), (p1x, p1y) = po[0], po[1]  # the outer (east) edge
    pc = cen(po)
    pw = math.hypot(p1x - p0x, p1y - p0y)
    col_h = 12.0
    inset = (-ux * 1.0, -uy * 1.0)  # columns a metre in from the outer edge
    b.box(*pc, -0.5, 4.8, pw + 1.0, 1.4, trim, rot=rot, shade=0.95, name="stylobate")
    b.colonnade((p0x + inset[0], p0y + inset[1]), (p1x + inset[0], p1y + inset[1]), 0.9, col_h, 6, 0.55, stone)
    b.box(*pc, 0.9 + col_h, 4.2, pw, 1.6, stone, rot=rot, shade=0.98, name="entablature")
    b.pediment(*pc, 2.5 + col_h, pw, 4.2, 3.2, stone, rot=rot + math.pi / 2, shade=0.97)


def st_pauls(b, fp):
    """St. Paul's Episcopal Church (1845, Thomas S. Stewart): a stuccoed Greek Revival temple facing East Grace
    Street across from Capitol Square, with a Corinthian portico and a tiered steeple over the vestibule; the
    parish house and a lower wing wrap a courtyard to the west.

    OSM has one relation (19918536) for the whole group, with the courtyard as a hole that fp["ring"] drops,
    so the church, parish house and wing rings (EPSG:32618) are split out here. Heights are from the 2025
    Richmond LiDAR above each piece's own ground: church eaves 11 / ridge 15 m, steeple 38.5 m, parish house
    12.6 m, wing 8 m. The site falls ~6.5 m from Grace Street to the parish house and the viewer multiplies
    terrain by Z_SCALE (1.6), so each piece is set on its own display ground. Column count and steeple stages
    are generic; nothing traced from imagery.
    """
    ox, oy = fp["centroid_proj"]
    g0 = float(fp["ground_z"])

    def rel(pts):
        ring = [(x - ox, y - oy) for x, y in pts]
        return ring if shoelace(ring) > 0 else ring[::-1]

    def ground(dem):  # display z of a DEM elevation, relative to the model origin
        return (dem - g0) * 1.6

    stone, trim, roof = "cream", "concrete", "slate"
    bottom = ground(43.0) - 0.5  # lowest DEM cell under the group

    # parish house (west) and the low wing on the Grace / 8th Street corner
    west = rel([(284834.31, 4157551.53), (284843.52, 4157543.93), (284840.47, 4157540.16), (284842.5, 4157538.41),
                (284838.67, 4157533.64), (284811.84, 4157554.51), (284826.41, 4157573.01), (284841.82, 4157561.03)])
    wing = rel([(284807.0, 4157588.09), (284818.11, 4157602.23), (284853.73, 4157574.49), (284849.31, 4157568.63),
                (284857.26, 4157562.36), (284862.67, 4157568.75), (284853.91, 4157557.48), (284844.83, 4157564.55),
                (284841.82, 4157561.03), (284826.41, 4157573.01), (284817.63, 4157561.88)])
    for ring, top, name in ((west, ground(46.7) + 12.6, "parish-house"), (wing, ground(49.2) + 8.0, "wing")):
        b.extrude(ring, bottom, top, stone, 0.9, name=name)
        b.band(ring, top - 0.8, 0.25, 0.5, trim, 0.86)
        b.extrude(ring, top, top + 0.15, "roof_flat", 0.85, name=f"{name}-roof")
        b.window_bays(ring, top - 3.6, height=2.4, width=1.2, pitch=3.8, trim=trim)

    # church body: front (Grace Street) edge fl -> fr, back edge bl -> br
    fl, fr = (284862.71 - ox, 4157568.71 - oy), (284882.07 - ox, 4157553.63 - oy)
    bl, br = (284840.41 - ox, 4157540.06 - oy), (284859.83 - ox, 4157525.29 - oy)
    width = math.hypot(fr[0] - fl[0], fr[1] - fl[1])
    wx, wy = (fr[0] - fl[0]) / width, (fr[1] - fl[1]) / width  # across the front
    mx, my = (fl[0] + fr[0]) / 2, (fl[1] + fr[1]) / 2  # front centre
    bx, by = (bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2
    length = math.hypot(mx - bx, my - by)
    dx, dy = (bx - mx) / length, (by - my) / length  # from the front toward the back
    rot_w = math.atan2(wy, wx)

    def C(across, back):
        return (mx + wx * across + dx * back, my + wy * across + dy * back)

    base = ground(47.9)  # Grace Street pavement
    eave, ridge = base + 11.0, base + 15.0
    portico_d = 5.5
    body = [C(-width / 2, portico_d), C(width / 2, portico_d), C(width / 2, length), C(-width / 2, length)]
    if shoelace(body) < 0:
        body.reverse()
    b.extrude(body, bottom, eave, stone, 0.97, name="church")
    b.band(body, eave - 1.0, 0.4, 1.0, trim, 0.92)  # entablature
    b.window_bays(body, base + 2.5, height=6.5, width=2.0, pitch=5.2, trim=trim, arched=True, glass="glass")
    b.gable(*C(0, (portico_d + length) / 2), eave, length - portico_d + 0.6, width + 0.8, ridge - eave, roof,
            rot=math.atan2(dy, dx), name="church-roof")
    b.pediment(*C(0, length - 0.2), eave, width + 0.4, 0.4, ridge - eave, stone, rot=rot_w, shade=0.95)

    # Corinthian portico on Grace Street: steps, six columns, entablature and pediment
    b.box(*C(0, portico_d / 2), bottom, width - 1.0, portico_d + 1.5, base - bottom + 1.2, trim, rot=rot_w, shade=0.95, name="steps")
    b.colonnade(C(-width / 2 + 2.0, 0.8), C(width / 2 - 2.0, 0.8), base + 1.2, eave - base - 2.2, 6, 0.6, stone)
    b.box(*C(0, portico_d / 2), eave - 1.0, width - 1.0, portico_d + 0.4, 1.0, stone, rot=rot_w, shade=0.98, name="portico-entablature")
    b.pediment(*C(0, portico_d / 2), eave, width - 1.0, portico_d + 0.4, ridge - eave, stone, rot=rot_w, shade=0.97)

    # steeple over the vestibule: square tower, columned octagonal belfry, smaller lantern, then a cap
    sx, sy = C(0, portico_d + 3.5)
    tower = rect_ring(sx, sy, 7.0, 7.0, rot_w)
    t1, t2, t3, top = ridge + 6.0, base + 29.0, base + 34.5, base + 38.5
    b.extrude(tower, eave - 0.5, t1, stone, 1.0, name="steeple-base")
    b.band(tower, t1 - 0.8, 0.35, 0.8, trim, 0.92)
    b.window_bays(tower, ridge + 1.0, height=3.4, width=1.4, pitch=6.5, trim=trim, arched=True, glass="brick_dark")
    b.cylinder(sx, sy, t1, 3.1, t2 - t1, stone, n=8, shade=0.98, name="belfry")
    for k in range(8):
        a = rot_w + math.pi / 8 + k * math.pi / 4
        b.cylinder(sx + 3.3 * math.cos(a), sy + 3.3 * math.sin(a), t1, 0.28, t2 - t1 - 0.6, stone, n=6)
    b.cylinder(sx, sy, t2 - 0.6, 3.7, 0.8, trim, n=8, shade=0.92, name="belfry-cornice")
    b.cylinder(sx, sy, t2 + 0.2, 2.2, t3 - t2 - 0.2, stone, n=8, shade=0.97, name="lantern")
    b.cylinder(sx, sy, t3 - 0.5, 2.6, 0.6, trim, n=8, shade=0.92)
    b.cone(sx, sy, t3 + 0.1, 2.3, top - t3 - 0.9, roof, n=8, name="steeple-cap")
    b.cylinder(sx, sy, top - 1.0, 0.18, 1.0, "steel", n=6)


def _tapered(b, ring, z0, z1, inset, key, shade=1.0, name=None):
    """Extrusion whose walls lean inward by `inset` over their height (battered walls)."""
    top = inset_ring(ring, inset)
    n = len(ring)
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in top]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n, 2 * n))]
    return b.add(verts, faces, key, shade, name)


def _front_edge(ring, target):
    """(a, b) of the ring edge whose midpoint is nearest `target` (centroid-relative)."""
    best = None
    for i in range(len(ring)):
        a, c = ring[i], ring[(i + 1) % len(ring)]
        d = math.hypot((a[0] + c[0]) / 2 - target[0], (a[1] + c[1]) / 2 - target[1])
        if best is None or d < best[0]:
            best = (d, a, c)
    return best[1], best[2]


def _edge_frame(a, c):
    """Helpers for building on one footprint edge a -> c of a CCW ring: F(along, out) and the edge's rotation."""
    length = math.hypot(c[0] - a[0], c[1] - a[1])
    ux, uy = (c[0] - a[0]) / length, (c[1] - a[1]) / length
    nx, ny = uy, -ux  # outward for a CCW ring
    mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2

    def F(along, out):
        return (mx + ux * along + nx * out, my + uy * along + ny * out)

    return F, length, math.atan2(uy, ux)


def egyptian_building(b, fp):
    """Egyptian Building (1845, Thomas S. Stewart), the Medical College of Virginia's first home: stuccoed
    battered walls with corner torus mouldings, a deep cavetto cornice, and on College Street a recessed
    portico of two papyrus columns between pylon-like antae under a winged-disc lintel.

    Footprint = OSM way/224530980 (31 x 19 m). LiDAR puts the cornice at 15-17 m (OSM says 20 m). The ground
    falls ~2.3 m across the block, so walls start below grade. Proportions are generic; nothing traced.
    """
    ring = fp["ring"]
    ox, oy = fp["centroid_proj"]
    stone, trim, dark = "sand", "cream", "roof_dark"
    wall_h, cornice_h, batter = 13.0, 16.2, 0.7

    _tapered(b, ring, -4.0, wall_h, batter, stone, 0.95, name="walls")
    top = inset_ring(ring, batter)
    b.band(top, wall_h - 0.5, 0.3, 0.5, trim, 0.88)  # torus moulding under the cornice
    # cavetto cornice: a deep concave flare from the wall head, then the fillet and the flat roof
    n = len(top)
    prev, prev_z = top, wall_h
    for k, (out, z) in enumerate(((0.35, wall_h + 1.2), (0.95, wall_h + 2.2), (1.7, cornice_h - 0.5))):
        ring_k = offset_ring(top, out)
        verts = [(x, y, prev_z) for x, y in prev] + [(x, y, z) for x, y in ring_k]
        b.add(verts, [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)], trim, 0.9 + 0.03 * k, name="cavetto")
        prev, prev_z = ring_k, z
    flare = prev
    b.extrude(flare, cornice_h - 0.5, cornice_h, trim, 0.97, name="cornice-fillet")
    b.extrude(top, wall_h, cornice_h - 0.2, "roof_flat", 0.85, name="roof")

    # tall narrow windows on the battered walls, two storeys, each on the wall line at its own height
    for z, h in ((2.0, 3.2), (7.0, 3.4)):
        b.window_bays(inset_ring(ring, batter * (z + 4.0) / (wall_h + 4.0)), z, height=h, width=1.3, pitch=5.2, trim=trim, glass=dark)

    # College Street portico: recess between antae, two papyrus columns, winged-disc lintel
    a, c = _front_edge(ring, (285371.0 - ox, 4157449.5 - oy))
    F, length, rot = _edge_frame(a, c)
    b.box(*F(0, 0.15), -1.0, 8.4, 0.5, 11.0, "shadow", rot=rot, shade=1.2, name="portico-recess")
    for s in (-1, 1):
        b.box(*F(s * 5.6, 0.7), -1.0, 2.8, 1.6, 12.2, stone, rot=rot, shade=1.0, name="anta")
        cx, cy = F(s * 2.1, 0.9)
        b.cylinder(cx, cy, -0.5, 0.75, 9.2, stone, n=10, shade=0.97, name="papyrus-column")
        b.cone(cx, cy, 8.7, 1.25, -1.4, stone, n=10)  # bell capital
        b.cylinder(cx, cy, 8.7, 1.25, 0.4, stone, n=10, shade=0.95)
    b.box(*F(0, 0.9), 9.1, 14.0, 1.8, 2.1, trim, rot=rot, shade=0.97, name="lintel")
    b.box(*F(0, 1.85), 9.6, 5.0, 0.1, 0.9, "landmark_accent", rot=rot, shade=0.9, name="winged-disc")
    b.box(*F(0, 0.9), -1.0, 10.0, 3.4, 0.9, trim, rot=rot, shade=0.9, name="steps")


def riverfront_plaza_tower(b, fp):
    """Riverfront Plaza (1990): twin granite-and-glass office towers with notched corners on East Byrd
    Street. Each tower's shaft rises to ~82 m, then steps back in a two-tier crown to ~92 m with a
    mechanical penthouse to ~98 m (2025 Richmond LiDAR).

    Footprints are the notched OSM outlines (way/225274657 west, way/266759715 east); heights are set above
    each tower's own median ground, since the east tower's lot falls ~10 m toward the river and the viewer
    multiplies terrain by Z_SCALE (1.6). Storey banding and colours are generic; nothing traced.
    """
    f = Frame(fp)
    g = float(fp["ground_z"])
    local = {"riverfront-plaza-west-tower": 25.5, "riverfront-plaza-east-tower": 25.2}[fp["props"]["landmark"]]
    base = (local - g) * 1.6
    shaft, tier1, tier2, pent = base + 82.0, base + 87.5, base + 92.0, base + 98.0
    ring = fp["ring"]
    stone, glass = "sand", "glass"

    b.extrude(ring, -14.5, shaft, stone, 0.95, name="shaft")  # east lot bottoms out 13.4 m below the origin
    b.band(ring, base, 0.4, 7.5, stone, 0.88)  # granite base storeys
    z = base + 9.0
    while z < shaft - 3.0:  # ribbon windows, one band per storey
        b.band(ring, z, 0.06, 2.3, glass, 0.95)
        z += 3.75
    b.band(ring, shaft - 1.0, 0.45, 1.0, stone, 0.9)

    # stepped crown on the tower's box, a glazed tier, a stone tier and the penthouse
    su, sv = 2 * f.hl, 2 * f.hs
    t1 = f.rect(0, 0, su - 12.0, sv - 12.0)  # clear of the ~4.5 m corner notches
    b.extrude(t1, shaft, tier1, glass, 0.9, name="crown-1")
    b.band(t1, tier1 - 0.8, 0.35, 0.8, stone, 0.9)
    t2 = f.rect(0, 0, su - 24.0, sv - 24.0)
    b.extrude(t2, tier1, tier2, stone, 0.93, name="crown-2")
    b.band(t2, tier2 - 0.7, 0.3, 0.7, stone, 0.86)
    b.box(*f.P(0, 0), tier2, (su - 24.0) * 0.5, (sv - 24.0) * 0.5, pent - tier2, "steel", rot=f.rot_u, shade=0.9, name="penthouse")


def hippodrome(b, fp):
    """Hippodrome Theater (1914), Jackson Ward: a brick auditorium behind a pale three-bay facade on North
    2nd Street with a projecting marquee and a tall vertical HIPPODROME blade sign, restored in 2011.

    Footprint = OSM relation/4043108 (41 x 15 m); LiDAR roof 10 m with the front parapet to ~12.3 m.
    Letter shapes and facade proportions are generic; nothing traced from imagery.
    """
    ring = fp["ring"]
    ox, oy = fp["centroid_proj"]
    body_h, parapet = 10.0, 12.3

    b.extrude(ring, -0.8, body_h, "brick", 0.9, name="auditorium")
    b.band(ring, body_h - 0.5, 0.25, 0.5, "brick_dark", 0.85)
    b.extrude(ring, body_h, body_h + 0.2, "roof_dark", 0.9, name="roof")

    a, c = _front_edge(ring, (284636.2 - ox, 4158365.1 - oy))
    F, width, rot = _edge_frame(a, c)
    # pale facade slab with a stepped parapet, two upper windows and the entrance under the marquee
    b.box(*F(0, 0.3), -0.8, width + 0.4, 0.8, parapet + 0.8, "cream", rot=rot, shade=0.97, name="facade")
    b.box(*F(0, 0.35), parapet, width * 0.5, 0.7, 0.9, "cream", rot=rot, shade=0.95, name="parapet-step")
    b.box(*F(0, 0.72), parapet - 1.1, width + 0.6, 0.3, 0.5, "terracotta", rot=rot, shade=0.9, name="cornice")
    for s in (-1, 1):
        b.box(*F(s * 3.6, 0.75), 6.0, 2.4, 0.1, 3.4, "glass", rot=rot, shade=0.95, name="upper-window")
    for k in (-1, 0, 1):
        b.box(*F(k * 2.4, 0.75), 0.0, 1.9, 0.1, 3.0, "roof_dark", rot=rot, shade=0.85, name="entrance")
    # marquee over the sidewalk: canopy, reader board, and the chasing-light fascia
    b.box(*F(0, 2.3), 3.6, width - 2.0, 3.6, 0.5, "cream", rot=rot, shade=0.9, name="marquee-canopy")
    b.box(*F(0, 2.3), 4.1, width - 3.0, 3.2, 1.6, "seven_white", rot=rot, name="reader-board")
    b.box(*F(0, 2.3), 5.7, width - 3.0, 3.3, 0.25, "landmark_accent", rot=rot, name="marquee-lights")
    # vertical blade sign near one end of the facade, lettered on both faces
    blade = F(width / 2 - 1.6, 2.2)
    b.box(*blade, 6.2, 0.5, 2.6, 10.8, "seven_red", rot=rot, shade=0.95, name="blade")
    b.box(*blade, 16.9, 0.7, 2.9, 0.4, "landmark_accent", rot=rot, name="blade-cap")
    ux, uy = math.cos(rot), math.sin(rot)
    for side in (-1, 1):
        _sign_pixels(b, "HIPPODROME", (blade[0] + ux * side * 0.3, blade[1] + uy * side * 0.3), rot, 16.4, 0.17, "landmark_accent")


def childrens_hospital(b, fp):
    """Children's Hospital of Richmond at VCU, the Children's Tower (2023) at 1000 East Broad Street: a glass
    inpatient tower on the Marshall Street side rising from a broad podium, with a lower glazed front and
    entrance along Broad Street.

    OSM splits the complex into osm:way/224510150 (Broad St) and osm:way/224510149 (Inpatient Pavilion), both
    shorter than the building now stands; an override (assets/supplements/overrides.json) replaces them with
    their exact union so this one model covers both. Tier outlines (EPSG:32618) and heights are from the 2025
    Richmond LiDAR on flat ground: front 20 m, podium 64.5 m, tower 78 m, core 84 m, plant 95 m. Facade
    banding and colours are generic; nothing traced from imagery.
    """
    ox, oy = fp["centroid_proj"]

    def rel(pts):
        ring = [(x - ox, y - oy) for x, y in pts]
        return ring if shoelace(ring) > 0 else ring[::-1]

    glass, band, frame = "glass", "cream", "steel"
    front_h, podium_h, tower_h, core_h, plant_h = 20.0, 64.5, 78.0, 84.0, 95.0

    def storeys(ring, z0, z1, pitch=4.2):
        """Glass curtain wall with a pale spandrel band at every floor."""
        z = z0 + pitch
        while z < z1 - 1.0:
            b.band(ring, z - 0.5, 0.08, 0.7, band, 0.95)
            z += pitch

    # low glazed front along Broad Street and the entrance canopy, on the whole footprint
    ring = fp["ring"]
    b.extrude(ring, -1.0, front_h, glass, 0.92, name="front")
    storeys(ring, 0.0, front_h, pitch=5.0)
    b.band(ring, front_h - 0.9, 0.3, 0.9, band, 0.92)
    b.extrude(ring, front_h, front_h + 0.2, "roof_flat", 0.9, name="front-roof")

    # podium: every tier outline starts a little below the tier beneath so no roof edge shows a seam
    podium = rel([(285073.0, 4157600.0), (285122.1, 4157663.2), (285179.4, 4157620.5), (285127.0, 4157556.0),
                  (285123.0, 4157556.0), (285106.6, 4157573.6)])
    b.extrude(podium, front_h - 0.3, podium_h, glass, 0.96, name="podium")
    storeys(podium, front_h, podium_h)
    b.band(podium, podium_h - 1.2, 0.35, 1.2, band, 0.93)
    b.extrude(podium, podium_h, podium_h + 0.2, "roof_flat", 0.9, name="podium-roof")

    # tower on the Marshall Street side, its higher core, and the rooftop plant screen
    tower = rel([(285103.0, 4157638.0), (285122.1, 4157663.2), (285179.4, 4157620.5), (285162.4, 4157599.0),
                 (285150.0, 4157591.0), (285142.0, 4157598.0), (285133.7, 4157612.6)])
    b.extrude(tower, podium_h - 0.3, tower_h, glass, 1.0, name="tower")
    storeys(tower, podium_h, tower_h)
    b.band(tower, tower_h - 1.0, 0.35, 1.0, band, 0.95)
    b.extrude(tower, tower_h, tower_h + 0.2, "roof_flat", 0.92, name="tower-roof")
    core = rel([(285110.0, 4157641.0), (285123.0, 4157661.0), (285176.0, 4157621.0), (285162.4, 4157599.0),
                (285150.1, 4157602.0), (285139.6, 4157612.6)])
    b.extrude(core, tower_h - 0.3, core_h, glass, 1.03, name="core")
    storeys(core, tower_h, core_h)
    b.band(core, core_h - 0.9, 0.3, 0.9, band, 0.95)
    b.extrude(core, core_h, core_h + 0.2, "roof_flat", 0.92, name="core-roof")
    plant = rel([(285135.8, 4157622.5), (285117.2, 4157637.5), (285126.5, 4157649.2), (285145.2, 4157634.2)])
    b.extrude(plant, core_h - 0.2, plant_h, frame, 0.88, name="plant-screen")
    b.band(plant, plant_h - 0.6, 0.2, 0.6, frame, 0.8)


PIXEL_GLYPHS = {
    "D": ("110", "101", "101", "101", "110"), "E": ("111", "100", "110", "100", "111"),
    "H": ("101", "101", "111", "101", "101"), "I": ("111", "010", "010", "010", "111"),
    "M": ("101", "111", "111", "101", "101"), "O": ("111", "101", "101", "101", "111"),
    "P": ("110", "101", "110", "100", "100"), "R": ("110", "101", "110", "101", "101"),
}


def _sign_pixels(b, text, at, rot, top_z, pixel, key):
    """Vertical stack of chunky 3x5 letters on a blade sign's face, `at` its face centre, `rot` the blade's
    thin axis. Letters read top to bottom, each 6 pixels tall."""
    ux, uy = math.cos(rot), math.sin(rot)
    vx, vy = -uy, ux  # across the blade face
    for li, letter in enumerate(text):
        for row, bits in enumerate(PIXEL_GLYPHS[letter]):
            for col, bit in enumerate(bits):
                if bit == "0":
                    continue
                along = (col - 1) * pixel
                z = top_z - li * pixel * 6 - row * pixel
                b.box(at[0] + vx * along, at[1] + vy * along, z - pixel, pixel * 0.1 + 0.12, pixel * 0.85, pixel * 0.85,
                      key, rot=rot, shade=1.02, name="sign-letter")


BUILDERS = {
    "virginia-state-capitol": capitol,
    "main-street-station": main_street_station,
    "old-city-hall": old_city_hall,
    "richmond-city-hall": richmond_city_hall,
    "the-jefferson-hotel": jefferson_hotel,
    "federal-reserve-bank-of-richmond": federal_reserve,
    "james-monroe-building": james_monroe,
    "dominion-energy-tower-600-canal-place": dominion_tower,
    "altria-theater": altria_theater,
    "carpenter-theatre-dominion-energy-center": carpenter_theatre,
    "byrd-theatre": byrd_theatre,
    "vcu-cabell-library": cabell_library,
    "costar-tower": costar_tower,
    "foundry-park-south": foundry_park_south,
    "byrd-park-pump-house": pump_house,
    "virginia-war-memorial-carillon": carillon,
    "cookie-factory-lofts": cookie_factory_lofts,
    "virginia-museum-of-fine-arts": vmfa,
    "science-museum-of-virginia": science_museum,
    "cathedral-of-the-sacred-heart": sacred_heart,
    "st-pauls-episcopal-church": st_pauls,
    "egyptian-building": egyptian_building,
    "riverfront-plaza-west-tower": riverfront_plaza_tower,
    "riverfront-plaza-east-tower": riverfront_plaza_tower,
    "hippodrome-theater": hippodrome,
    "childrens-hospital-of-richmond-at-vcu": childrens_hospital,
}


def build(slug, save=None, export=True):
    fp = find_footprint(slug)
    if fp is None:
        raise SystemExit(f"no footprint matched for {slug}; run the pipeline first")
    clear_scene()
    b = Builder(slug)
    BUILDERS[slug](b, fp)
    print(f"{slug}: {b.n} parts, footprint {len(fp['ring'])} pts, ground_z {fp['ground_z']}")
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(save).resolve()))
    if export:
        b.select_all()
        # The viewer uses vertex colors and one material. Merge the kit parts before
        # export so windows do not each cost a draw call or a separate Draco decode.
        bpy.ops.object.join()
        obj = bpy.context.object
        for poly in obj.data.polygons:
            poly.material_index = 0
        while len(obj.data.materials) > 1:
            obj.data.materials.pop(index=len(obj.data.materials) - 1)
        out = ROOT / "assets" / "landmarks" / f"{slug}.glb"
        export_landmark.export_glb(out, use_selection=True)
        export_landmark.update_landmarks_json(slug, f"landmarks/{slug}.glb")
        print(f"  -> {out.name} {out.stat().st_size / 1e3:.0f} kB")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    slugs, save, export = [], None, True
    i = 0
    while i < len(argv):
        if argv[i] == "--slug":
            slugs.append(argv[i + 1]); i += 2
        elif argv[i] == "--all":
            slugs = list(BUILDERS); i += 1
        elif argv[i] == "--save":
            save = argv[i + 1]; i += 2
        elif argv[i] == "--no-export":
            export = False; i += 1
        else:
            i += 1
    if not slugs:
        raise SystemExit("usage: build_landmark.py -- (--slug <slug> | --all) [--save file.blend] [--no-export]")
    for s in slugs:
        build(s, save if len(slugs) == 1 else None, export)


if __name__ == "__main__":
    main()
