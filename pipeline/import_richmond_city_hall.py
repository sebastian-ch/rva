"""Convert Richmond's public City Hall BIM I3S leaf mesh to the viewer's local GLB.

The source object is OBJECTID 68275 / Building_71606 in the public
urban_BuildingMultipatch SceneServer. The output is centered on the OSM parent
footprint because LandmarkModels places GLBs at that feature's centroid/ground.
"""
from __future__ import annotations

import argparse
import gzip
import json
import struct
import urllib.request
from pathlib import Path

import numpy as np
from pyproj import Transformer

NODE = "660"
BASE = "https://tiles.arcgis.com/tiles/k3vhq11XkBNeeOfM/arcgis/rest/services/urban_BuildingMultipatch_2/SceneServer/layers/0/nodes"
ANCHOR = (285051.19834309607, 4157670.4520459585)  # osm:way/113029199 centroid, EPSG:32618


def _read_url(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        data = response.read()
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


def _pad(data: bytes, byte: bytes = b"\0") -> bytes:
    return data + byte * ((-len(data)) % 4)


def convert(node_data: bytes, geometry: bytes, output: Path) -> None:
    node = json.loads(node_data)
    vertex_count, feature_count = struct.unpack_from("<II", geometry)
    if feature_count != 1:
        raise ValueError(f"expected one City Hall feature, found {feature_count}")
    vertex_stride = (len(geometry) - 8 - feature_count * 16) // vertex_count
    if vertex_stride not in (36, 44):
        raise ValueError(f"unexpected I3S vertex layout: {vertex_stride} bytes")

    offset = 8
    position = np.frombuffer(geometry, dtype="<f4", count=vertex_count * 3, offset=offset).reshape(-1, 3).copy()
    offset += vertex_count * 12
    normal = np.frombuffer(geometry, dtype="<f4", count=vertex_count * 3, offset=offset).reshape(-1, 3).copy()
    offset += vertex_count * 12
    offset += vertex_count * 8  # texture coordinates are not used by the stylized material
    color = np.frombuffer(geometry, dtype=np.uint8, count=vertex_count * 4, offset=offset).reshape(-1, 4).copy()

    origin_x, origin_y, origin_z = node["mbs"][:3]
    mercator_x = position[:, 0].astype(np.float64) + origin_x
    mercator_y = position[:, 1].astype(np.float64) + origin_y
    east, north = Transformer.from_crs(3857, 32618, always_xy=True).transform(mercator_x, mercator_y)
    absolute_z = position[:, 2].astype(np.float64) + origin_z
    base_z = float(absolute_z.min())

    # Viewer coordinates are x=east, y=up, z=-north.
    local_position = np.column_stack((east - ANCHOR[0], absolute_z - base_z, ANCHOR[1] - north)).astype("<f4")
    local_normal = np.column_stack((normal[:, 0], normal[:, 2], -normal[:, 1])).astype("<f4")
    lengths = np.linalg.norm(local_normal, axis=1)
    local_normal[lengths > 0] /= lengths[lengths > 0, None]

    parts = [_pad(local_position.tobytes()), _pad(local_normal.tobytes()), _pad(color.tobytes())]
    starts = [0, len(parts[0]), len(parts[0]) + len(parts[1])]
    binary = b"".join(parts)
    doc = {
        "asset": {
            "version": "2.0",
            "generator": "pipeline/import_richmond_city_hall.py",
            "extras": {"source": BASE.rsplit("/nodes", 1)[0], "objectId": 68275, "buildingFID": "Building_71606"},
        },
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "Richmond City Hall BIM"}],
        "meshes": [{"name": "Richmond City Hall", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "mode": 4}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": starts[0], "byteLength": len(parts[0]), "target": 34962},
            {"buffer": 0, "byteOffset": starts[1], "byteLength": len(parts[1]), "target": 34962},
            {"buffer": 0, "byteOffset": starts[2], "byteLength": len(parts[2]), "target": 34962},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": vertex_count, "type": "VEC3",
             "min": local_position.min(axis=0).tolist(), "max": local_position.max(axis=0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": vertex_count, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5121, "normalized": True, "count": vertex_count, "type": "VEC4"},
        ],
    }
    json_chunk = _pad(json.dumps(doc, separators=(",", ":")).encode(), b" ")
    body = struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)
    print(f"wrote {output}: {vertex_count // 3} triangles, {local_position[:, 1].max():.1f} m tall")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-json", type=Path)
    parser.add_argument("--geometry", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).parents[1] / "assets/landmarks/richmond-city-hall.glb")
    args = parser.parse_args()
    node_data = args.node_json.read_bytes() if args.node_json else _read_url(f"{BASE}/{NODE}")
    geometry = args.geometry.read_bytes() if args.geometry else _read_url(f"{BASE}/{NODE}/geometries/0")
    convert(node_data, geometry, args.output)


if __name__ == "__main__":
    main()
