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

from footprint import find_footprint, toward  # noqa: E402
from landmark_lib import Builder, clear_scene, rect_ring  # noqa: E402
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


def cabell_library(b, fp):
    f = Frame(fp)
    b.extrude(fp["ring"], -0.5, 13, "glass", 0.95, name="podium")
    b.box(*f.P(8, 6), 13, 62, 32, 10, "cream", rot=f.rot_u, name="upper")
    b.box(*f.P(f.hl - 30, -f.hs + 14), 13, 30, 8, 6, "concrete", rot=f.rot_u, shade=0.9)  # cantilevered reading room


BUILDERS = {
    "virginia-state-capitol": capitol,
    "main-street-station": main_street_station,
    "old-city-hall": old_city_hall,
    "the-jefferson-hotel": jefferson_hotel,
    "federal-reserve-bank-of-richmond": federal_reserve,
    "james-monroe-building": james_monroe,
    "dominion-energy-tower-600-canal-place": dominion_tower,
    "altria-theater": altria_theater,
    "carpenter-theatre-dominion-energy-center": carpenter_theatre,
    "vcu-cabell-library": cabell_library,
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
