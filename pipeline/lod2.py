"""Import Roofer CityJSONSeq roofs and attach them to processed buildings.

Roofer emits complete LoD2.2 solids in the point-cloud CRS. The viewer already
has styled walls and building metadata, so this module keeps the measured roof
shell and short internal faces that close stepped roofs. The result is compact
indexed geometry stored as JSON in ``lod2_roof``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

import geopandas as gpd
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.ops import unary_union

MIN_POINT_DENSITY = 5.0
MAX_NODATA_FRACTION = 0.45
MAX_RMSE_M = 1.25
MAX_ROOF_RELIEF_M = 20.0
MIN_FOOTPRINT_COVERAGE = 0.5
ROOF_TYPES = {"slanted", "horizontal", "multiple horizontal"}


def cityjsonseq_files(path: Path) -> list[Path]:
    """Return CityJSONSeq files below *path*, or the file itself."""
    path = Path(path)
    if path.is_file():
        return [path]
    if not path.exists():
        return []
    return sorted(set(path.glob("*.city.jsonl")) | set(path.glob("*.jsonl")))


def _epsg(reference_system: str | None) -> str | None:
    if not reference_system:
        return None
    match = re.search(r"(?:EPSG[/ :]|/0/)(\d+)$", reference_system, re.IGNORECASE)
    return f"EPSG:{match.group(1)}" if match else None


def _lod22(part: dict) -> dict | None:
    return next((g for g in part.get("geometry", []) if str(g.get("lod")) == "2.2"), None)


def _surface_kind(geometry: dict, shell_index: int, surface_index: int) -> dict | None:
    semantics = geometry.get("semantics") or {}
    values = semantics.get("values") or []
    surfaces = semantics.get("surfaces") or []
    try:
        semantic_index = values[shell_index][surface_index]
        return surfaces[semantic_index] if semantic_index is not None else None
    except (IndexError, TypeError):
        return None


def _roof_mesh(feature: dict, scale: list[float], translate: list[float], transformer: Transformer | None) -> dict | None:
    objects = feature.get("CityObjects") or {}
    building = next((o for o in objects.values() if o.get("type") == "Building"), None)
    attrs = (building or {}).get("attributes") or {}
    if building is None or attrs.get("rf_success") is not True:
        return None
    # Roofer can serialize a nominally successful solid from sparse or incomplete
    # points. Keep the older procedural roof unless the fit clears explicit,
    # measured quality thresholds established by the Richmond depth-9 run.
    quality = [attrs.get("rf_pt_density"), attrs.get("rf_nodata_frac"), attrs.get("rf_rmse_lod22")]
    if (attrs.get("rf_pointcloud_unusable") is True
            or attrs.get("rf_roof_type") not in ROOF_TYPES
            or any(not isinstance(v, (int, float)) or not float("-inf") < v < float("inf") for v in quality)
            or quality[0] < MIN_POINT_DENSITY
            or quality[1] > MAX_NODATA_FRACTION
            or quality[2] > MAX_RMSE_M):
        return None
    parts = [o for o in objects.values() if o.get("type") == "BuildingPart"]
    vertices = feature.get("vertices") or []
    if not parts or not vertices:
        return None

    faces: list[list[list[int]]] = []
    roof_vertex_ids: set[int] = set()
    closure_candidates: list[list[list[int]]] = []
    for part in parts:
        geometry = _lod22(part)
        if geometry is None or geometry.get("type") != "Solid":
            continue
        for shell_index, shell in enumerate(geometry.get("boundaries") or []):
            for surface_index, rings in enumerate(shell):
                semantic = _surface_kind(geometry, shell_index, surface_index)
                if not semantic or not rings or not rings[0]:
                    continue
                clean = [[int(i) for i in ring] for ring in rings if len(ring) >= 3]
                if not clean:
                    continue
                if semantic.get("type") == "RoofSurface":
                    faces.append(clean)
                    roof_vertex_ids.update(i for ring in clean for i in ring)
                elif semantic.get("type") == "WallSurface" and semantic.get("on_footprint_edge") is False:
                    closure_candidates.append(clean)
    if not faces or len(roof_vertex_ids) < 3:
        return None

    def world(i: int) -> tuple[float, float, float]:
        v = vertices[i]
        x = v[0] * scale[0] + translate[0]
        y = v[1] * scale[1] + translate[1]
        z = v[2] * scale[2] + translate[2]
        if transformer is not None:
            x, y = transformer.transform(x, y)
        return x, y, z

    roof_floor = min(world(i)[2] for i in roof_vertex_ids)
    # Internal vertical faces close dormers and roof steps. Exclude interior or
    # party walls that descend below the roof because the styled extrusion owns them.
    for rings in closure_candidates:
        if min(world(i)[2] for ring in rings for i in ring) >= roof_floor - 0.05:
            faces.append(rings)

    used = sorted({i for face in faces for ring in face for i in ring})
    remap = {old: new for new, old in enumerate(used)}
    out_vertices = []
    for i in used:
        x, y, z = world(i)
        out_vertices.append([round(x, 2), round(y, 2), round(z - roof_floor, 2)])
    height = max(v[2] for v in out_vertices)
    # Taller relief generally means Roofer folded a mixed-height complex into one
    # shell. Our hybrid retains only the source footprint's exterior walls, so
    # those upper tiers would be left unsupported.
    if not (0 <= height <= MAX_ROOF_RELIEF_M):
        return None
    return {
        "v": out_vertices,
        "f": [[[remap[i] for i in ring] for ring in face] for face in faces],
    }


def _merge_meshes(first: dict, second: dict) -> dict:
    """Combine Roofer components emitted separately for one multipart source."""
    offset = len(first["v"])
    return {
        "v": first["v"] + second["v"],
        "f": first["f"] + [[[i + offset for i in ring] for ring in face] for face in second["f"]],
    }


def _covers_footprint(encoded: str, footprint) -> bool:
    """Reject partial shells that would suppress most of the procedural roof."""
    mesh = json.loads(encoded)
    surfaces = []
    for face in mesh["f"]:
        try:
            rings = [[(mesh["v"][i][0], mesh["v"][i][1]) for i in ring] for ring in face]
            surface = Polygon(rings[0], rings[1:])
        except (IndexError, TypeError, ValueError):
            continue
        # Vertical closure faces have zero projected area and do not contribute.
        if surface.is_valid and surface.area > 0.01:
            surfaces.append(surface)
    if not surfaces or footprint is None or footprint.is_empty or footprint.area <= 0:
        return False
    roof_area = unary_union(surfaces).intersection(footprint).area
    return roof_area / footprint.area >= MIN_FOOTPRINT_COVERAGE


def read_roofs(paths: Iterable[Path], target_crs: str) -> dict[str, str]:
    """Read Roofer CityJSONSeq files as ``source_id -> compact mesh JSON``."""
    roofs: dict[str, str] = {}
    for path in paths:
        file_roofs: dict[str, dict] = {}
        with Path(path).open() as stream:
            header = json.loads(next(stream))
            transform = header.get("transform") or {}
            scale = transform.get("scale", [1, 1, 1])
            translate = transform.get("translate", [0, 0, 0])
            source_crs = _epsg((header.get("metadata") or {}).get("referenceSystem"))
            transformer = None
            if source_crs and source_crs != target_crs:
                transformer = Transformer.from_crs(source_crs, target_crs, always_xy=True)
            for line in stream:
                if not line.strip():
                    continue
                feature = json.loads(line)
                try:
                    mesh = _roof_mesh(feature, scale, translate, transformer)
                except (IndexError, KeyError, TypeError, ValueError):
                    # Roofer reports success per object, but a damaged boundary or
                    # vertex reference must still fall back per building.
                    continue
                if mesh is not None:
                    building = next((o for o in (feature.get("CityObjects") or {}).values()
                                     if o.get("type") == "Building"), {})
                    source_id = (building.get("attributes") or {}).get("source_id") or feature.get("id")
                    key = str(source_id)
                    file_roofs[key] = _merge_meshes(file_roofs[key], mesh) if key in file_roofs else mesh
        # A later file is treated as a newer batch, while multipart records inside
        # one CityJSONSeq file are combined.
        roofs.update({key: json.dumps(mesh, separators=(",", ":")) for key, mesh in file_roofs.items()})
    return roofs


def attach_roofs(buildings: gpd.GeoDataFrame, source: Path, target_crs: str) -> gpd.GeoDataFrame:
    """Return buildings with valid Roofer roofs joined by their source IDs."""
    out = buildings.copy()
    if "lod2_roof" not in out:
        out["lod2_roof"] = None
    files = cityjsonseq_files(source)
    if not files or len(out) == 0:
        return out
    roofs = read_roofs(files, target_crs)
    matched = out["id"].astype(str).map(roofs)
    hidden = out["hidden"].fillna(False) if "hidden" in out else False
    plausible = matched.combine(out.geometry, lambda raw, geom: isinstance(raw, str) and _covers_footprint(raw, geom))
    use = matched.notna() & plausible & ~hidden
    if not use.any():
        print(f"  lod2 roofs: 0/{len(out)} buildings ({len(roofs)} valid reconstructions; no matching source IDs)")
        return out
    out.loc[use, "lod2_roof"] = matched[use]
    out.loc[use, "roof_source"] = "lod2"
    heights = matched[use].map(lambda raw: float(max(v[2] for v in json.loads(raw)["v"]))).astype(float)
    out.loc[use, "roof_height"] = heights
    print(f"  lod2 roofs: {int(use.sum())}/{len(out)} buildings ({len(roofs)} valid reconstructions)")
    return out
