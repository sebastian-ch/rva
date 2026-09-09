"""Import one processed tile (buildings, roads, terrain) into Blender for reference
or as a base to model a landmark against.

Usage:
    blender --background --python blender/import_tile.py -- --tile 11_3 [--tiles-dir data/tiles]

Reads:
    <tiles-dir>/index.json
    <tiles-dir>/<tile>/buildings.geojson
    <tiles-dir>/<tile>/roads.geojson      (optional)
    <tiles-dir>/<tile>/terrain.json

Coordinate convention (see DATA_FORMAT.md): source data is EPSG:32618 meters.
Blender is Z-up, so we map projected easting -> Blender X, northing -> Blender Y,
elevation -> Blender Z. Everything is translated so the tile's SW corner sits at
local (0, 0): local_x = X - origin_x, local_y = Y - origin_y, where origin is the
tile's own bbox min (NOT the global index origin) -- this keeps geometry near the
scene origin regardless of which tile is loaded.

Builds one collection `tile_<id>` containing:
    - `Terrain` object: a grid mesh from terrain.json
    - `Buildings` collection: one extruded mesh per non-landmark building
    - `Landmarks` collection: one extruded mesh per building with a `landmark` tag
    - `Roads` collection: curve objects with bevel depth = width / 2 (best effort)

Palette materials are created from assets/palette.json, one Principled BSDF
material per key (roughness 0.95, base color from hex). Each building gets its
`wall_color` material assigned.

Run with Blender 4.x: `blender --background --python blender/import_tile.py -- --tile <id>`
"""

import json
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    args = {"tile": None, "tiles_dir": str(ROOT / "data" / "tiles")}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--tile":
            args["tile"] = argv[i + 1]
            i += 2
        elif a == "--tiles-dir":
            args["tiles_dir"] = argv[i + 1]
            i += 2
        else:
            i += 1

    if not args["tile"]:
        raise SystemExit("import_tile.py: --tile <id> is required, e.g. --tile 11_3")

    return args


def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip("#")
    r = int(hex_str[0:2], 16) / 255.0
    g = int(hex_str[2:4], 16) / 255.0
    b = int(hex_str[4:6], 16) / 255.0
    return (r, g, b, 1.0)


def load_palette_materials():
    """Create one material per palette.json key (skipping keys starting with '_')."""
    palette_path = ROOT / "assets" / "palette.json"
    palette = json.loads(palette_path.read_text())
    materials = {}
    for key, hex_val in palette.items():
        if key.startswith("_"):
            continue
        mat_name = f"pal_{key}"
        mat = bpy.data.materials.get(mat_name)
        if mat is None:
            mat = bpy.data.materials.new(mat_name)
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            if bsdf is not None:
                bsdf.inputs["Base Color"].default_value = hex_to_rgb(hex_val)
                bsdf.inputs["Roughness"].default_value = 0.95
        materials[key] = mat
    return materials


def get_or_create_collection(name, parent=None):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def polygon_rings_to_local(coords, origin_x, origin_y):
    """coords: list of [x, y] pairs (a GeoJSON ring, last point == first point).
    Returns list of (local_x, local_y) with the closing point dropped."""
    ring = coords[:-1] if len(coords) > 1 and coords[0] == coords[-1] else coords
    return [(pt[0] - origin_x, pt[1] - origin_y) for pt in ring]


def build_footprint_mesh(name, exterior, holes, height, ground_z):
    """Build an extruded mesh from an exterior ring + list of hole rings
    (each a list of (x, y) local coords), extruded from ground_z to
    ground_z + height. Flat top/bottom caps only (no roof shapes)."""
    bm = bmesh.new()

    def add_ring(ring, z):
        return [bm.verts.new((x, y, z)) for (x, y) in ring]

    bottom_exterior = add_ring(exterior, ground_z)
    bottom_holes = [add_ring(h, ground_z) for h in holes]

    bm.verts.ensure_lookup_table()
    try:
        bmesh.ops.edgenet_prepare
    except AttributeError:
        pass

    # Build bottom face via edges + triangle/ngon fill, honoring holes.
    all_bottom_verts = [bottom_exterior] + bottom_holes
    edges = []
    for ring in all_bottom_verts:
        n = len(ring)
        for i in range(n):
            edges.append(bm.edges.new((ring[i], ring[(i + 1) % n])))

    try:
        bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=True, edges=edges)
    except RuntimeError:
        pass

    # Extrude every resulting face upward by `height`.
    faces = [f for f in bm.faces]
    if faces:
        ret = bmesh.ops.extrude_face_region(bm, geom=faces)
        top_verts = [v for v in ret["geom"] if isinstance(v, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=top_verts, vec=(0, 0, height))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    return obj


def import_buildings(tile_dir, origin_x, origin_y, palette_materials, buildings_coll, landmarks_coll):
    path = tile_dir / "buildings.geojson"
    if not path.exists():
        print(f"import_tile: no buildings.geojson in {tile_dir}, skipping")
        return

    data = json.loads(path.read_text())
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        gtype = geom.get("type")
        obj_id = props.get("id", "building")

        if gtype == "Polygon":
            polygons = [geom["coordinates"]]
        elif gtype == "MultiPolygon":
            polygons = geom["coordinates"]
        else:
            continue

        height = props.get("height") or 6.0
        ground_z = props.get("ground_z") or 0.0
        is_landmark = bool(props.get("landmark"))

        for part_idx, rings in enumerate(polygons):
            if not rings:
                continue
            exterior = polygon_rings_to_local(rings[0], origin_x, origin_y)
            holes = [polygon_rings_to_local(r, origin_x, origin_y) for r in rings[1:]]
            if len(exterior) < 3:
                continue

            name = obj_id if part_idx == 0 else f"{obj_id}_{part_idx}"
            obj = build_footprint_mesh(name, exterior, holes, height, ground_z)

            for key, value in props.items():
                if value is None:
                    continue
                obj[key] = value

            wall_key = props.get("wall_color")
            mat = palette_materials.get(wall_key) if wall_key else None
            if mat is not None:
                obj.data.materials.append(mat)

            target_coll = landmarks_coll if is_landmark else buildings_coll
            target_coll.objects.link(obj)


def import_terrain(tile_dir, origin_x, origin_y, tile_coll):
    path = tile_dir / "terrain.json"
    if not path.exists():
        print(f"import_tile: no terrain.json in {tile_dir}, skipping")
        return

    data = json.loads(path.read_text())
    n = data["n"]
    size = data["size"]
    t_origin_x, t_origin_y = data["origin"]
    elev = data["elev"]

    if len(elev) != n * n:
        print(f"import_tile: terrain.json elev length {len(elev)} != n*n ({n * n}), skipping terrain")
        return

    step = size / (n - 1)

    bm = bmesh.new()
    verts = [[None] * n for _ in range(n)]
    for row in range(n):  # south -> north
        for col in range(n):  # west -> east
            x = (t_origin_x + col * step) - origin_x
            y = (t_origin_y + row * step) - origin_y
            z = elev[row * n + col]
            verts[row][col] = bm.verts.new((x, y, z))

    bm.verts.ensure_lookup_table()
    for row in range(n - 1):
        for col in range(n - 1):
            v00 = verts[row][col]
            v10 = verts[row][col + 1]
            v11 = verts[row + 1][col + 1]
            v01 = verts[row + 1][col]
            bm.faces.new((v00, v10, v11, v01))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("Terrain")
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new("Terrain", mesh)
    ground_mat = bpy.data.materials.get("pal_ground")
    if ground_mat is not None:
        obj.data.materials.append(ground_mat)
    tile_coll.objects.link(obj)


def import_roads(tile_dir, origin_x, origin_y, roads_coll):
    """Best-effort: roads as curve objects with bevel depth = width / 2."""
    try:
        path = tile_dir / "roads.geojson"
        if not path.exists():
            print(f"import_tile: no roads.geojson in {tile_dir}, skipping")
            return

        data = json.loads(path.read_text())
        for feat in data.get("features", []):
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            if geom.get("type") != "LineString":
                continue

            coords = geom["coordinates"]
            width = props.get("width") or 6.0
            road_id = props.get("id", "road")

            curve_data = bpy.data.curves.new(road_id, type="CURVE")
            curve_data.dimensions = "3D"
            curve_data.bevel_depth = width / 2.0
            curve_data.fill_mode = "FULL"

            spline = curve_data.splines.new("POLY")
            spline.points.add(len(coords) - 1)
            for i, (x, y) in enumerate(coords):
                spline.points[i].co = (x - origin_x, y - origin_y, 0.0, 1.0)

            obj = bpy.data.objects.new(road_id, curve_data)
            for key, value in props.items():
                if value is None:
                    continue
                obj[key] = value

            roads_coll.objects.link(obj)
    except Exception as exc:  # noqa: BLE001 - roads are optional/best-effort
        print(f"import_tile: roads import failed, skipping ({exc})")


def main():
    args = parse_args()
    tiles_dir = Path(args["tiles_dir"])
    if not tiles_dir.is_absolute():
        tiles_dir = ROOT / tiles_dir

    index = json.loads((tiles_dir / "index.json").read_text())
    tile_entry = next((t for t in index["tiles"] if t["id"] == args["tile"]), None)
    if tile_entry is None:
        raise SystemExit(f"import_tile.py: tile '{args['tile']}' not found in {tiles_dir / 'index.json'}")

    tile_dir = tiles_dir / args["tile"]
    minx, miny, _maxx, _maxy = tile_entry["bbox"]

    palette_materials = load_palette_materials()

    tile_coll_name = f"tile_{args['tile']}"
    tile_coll = get_or_create_collection(tile_coll_name)
    buildings_coll = get_or_create_collection("Buildings", tile_coll)
    landmarks_coll = get_or_create_collection("Landmarks", tile_coll)
    roads_coll = get_or_create_collection("Roads", tile_coll)

    import_terrain(tile_dir, minx, miny, tile_coll)
    import_buildings(tile_dir, minx, miny, palette_materials, buildings_coll, landmarks_coll)
    import_roads(tile_dir, minx, miny, roads_coll)

    print(f"import_tile: imported tile {args['tile']} into collection '{tile_coll_name}'")


if __name__ == "__main__":
    main()
