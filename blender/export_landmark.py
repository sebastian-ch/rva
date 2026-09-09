"""Export one hand-modeled landmark to glTF and register it in landmarks.json.

Usage:
    blender --background <file.blend> --python blender/export_landmark.py -- \
        --slug virginia-state-capitol [--out assets/landmarks]

Looks for a collection named `<slug>` in the open .blend file; if none exists,
falls back to a single object named `<slug>`. Errors out clearly if neither is
found. Applies all transforms on the selection, then exports
`assets/landmarks/<slug>.glb` via bpy.ops.export_scene.gltf(), attempting Draco
mesh compression first and retrying without it if Draco is unavailable in this
Blender build. Finally updates assets/landmarks/landmarks.json, setting the
matching entry's "model" field to "landmarks/<slug>.glb".

Modeling contract (read before building the landmark):
    - Origin at the footprint centroid, on the ground (Z = 0 in Blender / Y = 0
      in the exported glTF, since export_yup=True rotates Z-up -> Y-up).
      The viewer places the model at the matched OSM building's centroid and
      ground elevation, and hides the procedural extrusion in its place -- if
      the origin is off, the model floats or drifts sideways in the tile.
    - +Y up in the exported glTF (Blender Z-up is converted automatically by
      export_yup=True; do not pre-rotate the model to compensate).
    - Units are meters, matching the source data's EPSG:32618 meters.
    - The footprint/outline must match the real OSM building footprint
      reasonably closely so it drops into its tile without gaps or overlap
      with neighbors -- import the tile with import_tile.py and model over the
      procedural extrusion as a placement guide.

Run with Blender 4.x:
    blender --background path/to/landmark.blend --python blender/export_landmark.py -- --slug <slug>
"""

import json
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent.parent


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    args = {"slug": None, "out": str(ROOT / "assets" / "landmarks")}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--slug":
            args["slug"] = argv[i + 1]
            i += 2
        elif a == "--out":
            args["out"] = argv[i + 1]
            i += 2
        else:
            i += 1

    if not args["slug"]:
        raise SystemExit("export_landmark.py: --slug <slug> is required, e.g. --slug virginia-state-capitol")

    return args


def select_landmark(slug):
    """Select either the collection named `slug` (all its objects) or a single
    object named `slug`. Returns the list of selected objects."""
    bpy.ops.object.select_all(action="DESELECT")

    coll = bpy.data.collections.get(slug)
    if coll is not None:
        objects = list(coll.all_objects)
        if not objects:
            raise SystemExit(f"export_landmark.py: collection '{slug}' exists but is empty")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        return objects

    obj = bpy.data.objects.get(slug)
    if obj is not None:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        return [obj]

    raise SystemExit(
        f"export_landmark.py: no collection or object named '{slug}' found in this .blend. "
        f"Name the landmark's collection (or top-level object) exactly '{slug}' before exporting."
    )


def apply_transforms(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def export_glb(out_path, use_selection=True):
    """Try exporting with Draco compression; retry without it if the Blender
    build doesn't have Draco support (some minimal/headless builds don't)."""
    common_kwargs = dict(
        filepath=str(out_path),
        use_selection=use_selection,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
    )
    try:
        bpy.ops.export_scene.gltf(
            **common_kwargs,
            export_draco_mesh_compression_enable=True,
        )
        print(f"export_landmark: exported with Draco compression to {out_path}")
    except (TypeError, RuntimeError) as exc:
        print(f"export_landmark: Draco export failed ({exc}), retrying without compression")
        bpy.ops.export_scene.gltf(**common_kwargs)
        print(f"export_landmark: exported without compression to {out_path}")


def update_landmarks_json(slug, model_rel_path):
    path = ROOT / "assets" / "landmarks" / "landmarks.json"
    entries = json.loads(path.read_text())

    match = next((e for e in entries if e.get("slug") == slug), None)
    if match is None:
        raise SystemExit(
            f"export_landmark.py: exported {model_rel_path} but slug '{slug}' has no entry in "
            f"{path}; add it there first."
        )

    match["model"] = model_rel_path
    path.write_text(json.dumps(entries, indent=2) + "\n")
    print(f"export_landmark: updated {path} -- {slug}.model = '{model_rel_path}'")


def main():
    args = parse_args()
    out_dir = Path(args["out"])
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    objects = select_landmark(args["slug"])
    apply_transforms(objects)

    out_path = out_dir / f"{args['slug']}.glb"
    export_glb(out_path)

    model_rel_path = f"landmarks/{args['slug']}.glb"
    update_landmarks_json(args["slug"], model_rel_path)


if __name__ == "__main__":
    main()
