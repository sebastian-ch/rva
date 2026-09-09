"""QA report over data/tiles: coverage, height/roof histograms, geometry sanity checks.

Reads plain JSON (no geopandas) to stay fast and dependency-light. Writes
data/tiles/qa.md (human-readable) and data/tiles/qa.json (raw dict).
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import DATA_TILES, LANDMARKS_PATH

MIN_RING_VERTS = 4
MIN_AREA_M2 = 15.0
TALL_THRESHOLD_M = 150.0


def _ring_area(ring: list[list[float]]) -> float:
    """Shoelace area of a (possibly unclosed) ring."""
    n = len(ring)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def _exterior_rings(geom: dict[str, Any]) -> list[list[list[float]]]:
    """Return the list of exterior rings (one per polygon part) for a Polygon/MultiPolygon geometry."""
    if geom is None:
        return []
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if coords is None:
        return []
    if gtype == "Polygon":
        return [coords[0]] if coords else []
    if gtype == "MultiPolygon":
        return [poly[0] for poly in coords if poly]
    return []


def _load_geojson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    return data.get("features", [])


def write_report(tiles_dir: Path = DATA_TILES, landmarks_path: Path = LANDMARKS_PATH) -> dict:
    tiles_dir = Path(tiles_dir)
    index_path = tiles_dir / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    tile_entries = index.get("tiles", [])

    total_buildings = 0
    height_source_hist: Counter[str] = Counter()
    roof_shape_hist: Counter[str] = Counter()
    wall_color_hist: Counter[str] = Counter()
    named_count = 0
    tall_buildings: list[dict[str, Any]] = []
    small_footprint_ids: list[str] = []
    small_footprint_count = 0
    roof_azimuth_count = 0
    landmark_slugs_seen: set[str] = set()

    total_roads = 0
    roads_null_width = 0
    highway_hist: Counter[str] = Counter()

    per_tile_rows: list[dict[str, Any]] = []

    for entry in tile_entries:
        tid = entry.get("id")
        layers = entry.get("layers", [])
        tile_dir = tiles_dir / tid

        b_features = _load_geojson(tile_dir / "buildings.geojson") if "buildings" in layers else []
        r_features = _load_geojson(tile_dir / "roads.geojson") if "roads" in layers else []

        tile_building_count = len(b_features)
        tile_default_count = 0

        for feat in b_features:
            props = feat.get("properties", {}) or {}
            total_buildings += 1

            hs = props.get("height_source")
            height_source_hist[hs] += 1
            if hs == "default":
                tile_default_count += 1

            roof_shape_hist[props.get("roof_shape")] += 1
            wall_color_hist[props.get("wall_color")] += 1

            if props.get("name"):
                named_count += 1

            height = props.get("height")
            if isinstance(height, (int, float)) and height > TALL_THRESHOLD_M:
                tall_buildings.append({"id": props.get("id"), "name": props.get("name"), "height": height})

            landmark = props.get("landmark")
            if landmark:
                landmark_slugs_seen.add(landmark)

            if "roof_azimuth" in props and props.get("roof_azimuth") is not None:
                roof_azimuth_count += 1

            geom = feat.get("geometry")
            rings = _exterior_rings(geom)
            bad = False
            for ring in rings:
                verts = len(ring)
                if verts > 0 and ring[0] == ring[-1]:
                    verts -= 1
                if verts < MIN_RING_VERTS or _ring_area(ring) < MIN_AREA_M2:
                    bad = True
                    break
            if not rings:
                bad = True
            if bad:
                small_footprint_count += 1
                if len(small_footprint_ids) < 10:
                    small_footprint_ids.append(props.get("id"))

        for feat in r_features:
            props = feat.get("properties", {}) or {}
            total_roads += 1
            width = props.get("width")
            if width is None or width == 0:
                roads_null_width += 1
            highway_hist[props.get("highway")] += 1

        has_terrain = "terrain" in layers
        default_share = (tile_default_count / tile_building_count) if tile_building_count else 0.0
        if tile_building_count > 0:
            per_tile_rows.append({
                "id": tid,
                "buildings": tile_building_count,
                "default_share": default_share,
                "roads": len(r_features),
                "has_terrain": has_terrain,
            })

    per_tile_rows.sort(key=lambda r: r["default_share"], reverse=True)

    default_count = height_source_hist.get("default", 0)
    default_share_overall = (default_count / total_buildings) if total_buildings else 0.0

    lidar_count = height_source_hist.get("lidar", 0)
    overture_count = height_source_hist.get("overture_height", 0) + height_source_hist.get("overture_levels", 0)
    lidar_share = (lidar_count / total_buildings) if total_buildings else 0.0
    overture_share = (overture_count / total_buildings) if total_buildings else 0.0

    # Landmarks.
    landmarks = []
    if Path(landmarks_path).exists():
        try:
            landmarks = json.loads(Path(landmarks_path).read_text())
        except (json.JSONDecodeError, OSError):
            landmarks = []
    # non-building landmarks (bridges, sites, memorials) are resolved by pipeline/landmarks.py into landmarks.json
    resolved_path = Path(tiles_dir) / "landmarks.json"
    if resolved_path.exists():
        try:
            for slug, v in json.loads(resolved_path.read_text()).items():
                if v.get("how"):
                    landmark_slugs_seen.add(slug)
        except (OSError, ValueError):
            pass
    in_slice = [lm for lm in landmarks if lm.get("in_first_slice")]
    matched_slugs = [lm["slug"] for lm in in_slice if lm.get("slug") in landmark_slugs_seen]
    unmatched_slugs = [lm["slug"] for lm in in_slice if lm.get("slug") not in landmark_slugs_seen]

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox_wgs84": index.get("bbox_wgs84"),
        "buildings": {
            "total": total_buildings,
            "height_source_hist": dict(height_source_hist),
            "roof_shape_hist": dict(roof_shape_hist),
            "wall_color_hist": dict(wall_color_hist),
            "default_count": default_count,
            "default_share": default_share_overall,
            "named_count": named_count,
            "tall_buildings": tall_buildings,
            "small_footprint_count": small_footprint_count,
            "small_footprint_ids": small_footprint_ids,
            "roof_azimuth_count": roof_azimuth_count,
        },
        "per_tile": per_tile_rows,
        "roads": {
            "total": total_roads,
            "null_width_count": roads_null_width,
            "highway_hist": dict(highway_hist.most_common(10)),
        },
        "landmarks": {
            "in_first_slice_total": len(in_slice),
            "matched": matched_slugs,
            "unmatched": unmatched_slugs,
        },
        "coverage": {
            "lidar_share": lidar_share,
            "overture_share": overture_share,
        },
    }

    tiles_dir.mkdir(parents=True, exist_ok=True)
    (tiles_dir / "qa.json").write_text(json.dumps(report, indent=1))
    (tiles_dir / "qa.md").write_text(_render_markdown(report))

    return report


def _pct(n: int, d: int) -> str:
    return f"{(n / d * 100):.1f}%" if d else "n/a"


def _render_markdown(report: dict) -> str:
    b = report["buildings"]
    total = b["total"]
    lines: list[str] = []
    lines.append(f"# QA report — {report['generated_at']}")
    lines.append("")
    lines.append(f"bbox (WGS84): `{report['bbox_wgs84']}`")
    lines.append("")

    lines.append("## Buildings")
    lines.append("")
    lines.append(f"- total: {total}")
    lines.append(f"- named: {b['named_count']} ({_pct(b['named_count'], total)})")
    lines.append(f"- default height share: {b['default_count']} ({_pct(b['default_count'], total)})")
    lines.append(f"- footprints under {MIN_AREA_M2:.0f} m² or < {MIN_RING_VERTS} vertices: {b['small_footprint_count']}"
                 + (f" (first 10 ids: {', '.join(str(i) for i in b['small_footprint_ids'])})" if b['small_footprint_ids'] else ""))
    lines.append(f"- with roof_azimuth: {b['roof_azimuth_count']}")
    lines.append("")

    lines.append("### height_source")
    lines.append("")
    lines.append("| source | count | share |")
    lines.append("|---|---|---|")
    for k, v in sorted(b["height_source_hist"].items(), key=lambda kv: -kv[1]):
        lines.append(f"| {k} | {v} | {_pct(v, total)} |")
    lines.append("")

    lines.append("### roof_shape")
    lines.append("")
    lines.append("| shape | count |")
    lines.append("|---|---|")
    for k, v in sorted(b["roof_shape_hist"].items(), key=lambda kv: -kv[1]):
        lines.append(f"| {k} | {v} |")
    lines.append("")

    lines.append("### wall_color")
    lines.append("")
    lines.append("| color | count |")
    lines.append("|---|---|")
    for k, v in sorted(b["wall_color_hist"].items(), key=lambda kv: -kv[1]):
        lines.append(f"| {k} | {v} |")
    lines.append("")

    lines.append(f"### Buildings taller than {TALL_THRESHOLD_M:.0f} m")
    lines.append("")
    if b["tall_buildings"]:
        lines.append("| id | name | height |")
        lines.append("|---|---|---|")
        for tb in b["tall_buildings"]:
            lines.append(f"| {tb['id']} | {tb['name']} | {tb['height']} |")
    else:
        lines.append("(none)")
    lines.append("")

    lines.append("## Per-tile (top 15 by default-height share, buildings > 0)")
    lines.append("")
    lines.append("| tile | buildings | default share | roads | terrain |")
    lines.append("|---|---|---|---|---|")
    for row in report["per_tile"][:15]:
        lines.append(
            f"| {row['id']} | {row['buildings']} | {_pct(int(round(row['default_share'] * row['buildings'])), row['buildings'])} "
            f"| {row['roads']} | {'yes' if row['has_terrain'] else 'no'} |"
        )
    lines.append("")

    r = report["roads"]
    lines.append("## Roads")
    lines.append("")
    lines.append(f"- total: {r['total']}")
    lines.append(f"- null/0 width: {r['null_width_count']} ({_pct(r['null_width_count'], r['total'])})")
    lines.append("")
    lines.append("| highway | count |")
    lines.append("|---|---|")
    for k, v in r["highway_hist"].items():
        lines.append(f"| {k} | {v} |")
    lines.append("")

    lm = report["landmarks"]
    lines.append("## Landmarks (in_first_slice)")
    lines.append("")
    lines.append(f"- total in slice: {lm['in_first_slice_total']}")
    lines.append(f"- matched: {len(lm['matched'])}")
    lines.append(f"- unmatched: {len(lm['unmatched'])}")
    if lm["unmatched"]:
        lines.append(f"- unmatched slugs: {', '.join(lm['unmatched'])}")
    lines.append("")

    c = report["coverage"]
    lines.append("## Coverage")
    lines.append("")
    lines.append(f"- LiDAR-sourced heights: {_pct(int(round(c['lidar_share'] * total)), total)}")
    lines.append(f"- Overture-sourced heights: {_pct(int(round(c['overture_share'] * total)), total)}")
    lines.append("")

    return "\n".join(lines)


def main(argv=None) -> int:
    report = write_report()
    b = report["buildings"]
    total = b["total"]
    print(f"buildings: {total}, default height share: {_pct(b['default_count'], total)}, named: {b['named_count']}")
    print(f"roof_shape: {dict(sorted(b['roof_shape_hist'].items(), key=lambda kv: -kv[1]))}")
    print(f"tall (>{TALL_THRESHOLD_M:.0f}m): {len(b['tall_buildings'])}, small footprints: {b['small_footprint_count']}")
    print(f"roads: {report['roads']['total']}, null width: {report['roads']['null_width_count']}")
    lm = report["landmarks"]
    print(f"landmarks in slice: {lm['in_first_slice_total']}, unmatched: {lm['unmatched']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
