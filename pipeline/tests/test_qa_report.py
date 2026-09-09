from __future__ import annotations

import json

from qa_report import write_report


def _write(path, obj):
    path.write_text(json.dumps(obj))


def test_write_report(tmp_path):
    tiles_dir = tmp_path / "tiles"
    tile_a = tiles_dir / "0_0"
    tile_b = tiles_dir / "0_1"
    tile_a.mkdir(parents=True)
    tile_b.mkdir(parents=True)

    index = {
        "crs": "EPSG:32618",
        "tile_size": 250,
        "origin": [0, 0],
        "bbox_wgs84": [-77.45, 37.52, -77.41, 37.55],
        "tiles": [
            {"id": "0_0", "x": 0, "y": 0, "bbox": [0, 0, 250, 250],
             "layers": ["buildings", "roads", "terrain"]},
            {"id": "0_1", "x": 0, "y": 1, "bbox": [0, 250, 250, 500],
             "layers": ["buildings"]},
        ],
    }
    _write(tiles_dir / "index.json", index)

    # 3 buildings: one default-height square, one osm_height tall building (>150m),
    # one tiny (sub-15m^2) osm_height footprint with a landmark slug.
    buildings = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": "osm:way/1", "name": None, "height": 9.0,
                    "height_source": "default", "roof_shape": "flat",
                    "wall_color": "brick", "landmark": None,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
                },
            },
            {
                "type": "Feature",
                "properties": {
                    "id": "osm:way/2", "name": "Tall Tower", "height": 200.0,
                    "height_source": "osm_height", "roof_shape": "flat",
                    "wall_color": "glass", "landmark": "matched-landmark",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[20, 0], [40, 0], [40, 20], [20, 20], [20, 0]]],
                },
            },
            {
                "type": "Feature",
                "properties": {
                    "id": "osm:way/3", "name": None, "height": 8.0,
                    "height_source": "osm_height", "roof_shape": "gable",
                    "wall_color": "brick", "landmark": None,
                },
                "geometry": {
                    "type": "Polygon",
                    # 2m x 2m = 4 m^2, well under 15 m^2
                    "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
                },
            },
        ],
    }
    _write(tile_a / "buildings.geojson", buildings)

    roads = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"id": "osm:way/10", "highway": "residential", "width": 7.0},
             "geometry": {"type": "LineString", "coordinates": [[0, 0], [10, 0]]}},
            {"type": "Feature", "properties": {"id": "osm:way/11", "highway": "service", "width": None},
             "geometry": {"type": "LineString", "coordinates": [[0, 0], [5, 0]]}},
        ],
    }
    _write(tile_a / "roads.geojson", roads)

    landmarks_path = tmp_path / "landmarks.json"
    _write(landmarks_path, [
        {"slug": "matched-landmark", "name": "Matched Landmark", "in_first_slice": True},
        {"slug": "unmatched-landmark", "name": "Unmatched Landmark", "in_first_slice": True},
        {"slug": "not-in-slice", "name": "Not In Slice", "in_first_slice": False},
    ])

    report = write_report(tiles_dir, landmarks_path)

    assert report["buildings"]["total"] == 3
    assert report["buildings"]["height_source_hist"]["default"] == 1
    assert report["buildings"]["height_source_hist"]["osm_height"] == 2
    assert report["buildings"]["default_count"] == 1
    assert abs(report["buildings"]["default_share"] - (1 / 3)) < 1e-9
    assert report["buildings"]["named_count"] == 1
    assert report["buildings"]["small_footprint_count"] == 1
    assert "osm:way/3" in report["buildings"]["small_footprint_ids"]

    tall = report["buildings"]["tall_buildings"]
    assert len(tall) == 1
    assert tall[0]["id"] == "osm:way/2"
    assert tall[0]["height"] == 200.0

    assert report["roads"]["total"] == 2
    assert report["roads"]["null_width_count"] == 1
    assert report["roads"]["highway_hist"]["residential"] == 1

    per_tile = {row["id"]: row for row in report["per_tile"]}
    assert per_tile["0_0"]["buildings"] == 3
    assert per_tile["0_0"]["roads"] == 2
    assert per_tile["0_0"]["has_terrain"] is True
    # tile 0_1 has no buildings.geojson file on disk -> 0 buildings, excluded from per_tile.
    assert "0_1" not in per_tile

    lm = report["landmarks"]
    assert lm["in_first_slice_total"] == 2
    assert lm["matched"] == ["matched-landmark"]
    assert lm["unmatched"] == ["unmatched-landmark"]

    qa_md = tiles_dir / "qa.md"
    qa_json = tiles_dir / "qa.json"
    assert qa_md.exists()
    assert qa_json.exists()
    assert "unmatched-landmark" in qa_md.read_text()
