from __future__ import annotations

import json

import geopandas as gpd
from shapely.geometry import box

from lod2 import attach_roofs, read_roofs


def _write_cityjsonseq(path, *, success=True):
    header = {
        "type": "CityJSON", "version": "2.0", "vertices": [], "CityObjects": {},
        "transform": {"scale": [0.01, 0.01, 0.01], "translate": [100, 200, 10]},
        "metadata": {"referenceSystem": "https://www.opengis.net/def/crs/EPSG/0/32618"},
    }
    feature = {
        "type": "CityJSONFeature", "id": "osm:way/1",
        "vertices": [
            [0, 0, 500], [1000, 0, 500], [1000, 1000, 700], [0, 1000, 700],
            [0, 0, 0], [1000, 0, 0], [1000, 0, 500], [0, 0, 500],
        ],
        "CityObjects": {
            "osm:way/1": {"type": "Building", "attributes": {
                "rf_success": success, "source_id": "osm:way/1", "rf_pointcloud_unusable": False,
                "rf_roof_type": "slanted", "rf_pt_density": 20.0, "rf_nodata_frac": 0.1,
                "rf_rmse_lod22": 0.4, "rf_h_ground": 10.0,
            }},
            "osm:way/1-0": {
                "type": "BuildingPart",
                "geometry": [{
                    "type": "Solid", "lod": "2.2",
                    "boundaries": [[[[0, 1, 2, 3]], [[4, 5, 6, 7]]]],
                    "semantics": {
                        "surfaces": [{"type": "RoofSurface"}, {"type": "WallSurface", "on_footprint_edge": True}],
                        "values": [[0, 1]],
                    },
                }],
            },
        },
    }
    path.write_text(json.dumps(header) + "\n" + json.dumps(feature) + "\n")


def test_reads_only_successful_lod22_roof_and_normalizes_height(tmp_path):
    path = tmp_path / "roof.city.jsonl"
    _write_cityjsonseq(path)
    roofs = read_roofs([path], "EPSG:32618")
    mesh = json.loads(roofs["osm:way/1"])
    assert mesh["f"] == [[[0, 1, 2, 3]]]
    assert mesh["v"] == [[100.0, 200.0, 0.0], [110.0, 200.0, 0.0], [110.0, 210.0, 2.0], [100.0, 210.0, 2.0]]


def test_attaches_by_source_id_and_keeps_fallbacks(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    _write_cityjsonseq(source / "roof.city.jsonl")
    buildings = gpd.GeoDataFrame([
        {"id": "osm:way/1", "hidden": False, "height": 5.0, "roof_source": "lidar", "roof_height": 1.0, "geometry": box(100, 200, 110, 210)},
        {"id": "osm:way/2", "hidden": False, "height": 5.0, "roof_source": "heuristic", "roof_height": 0.0, "geometry": box(120, 200, 130, 210)},
    ], crs="EPSG:32618")
    out = attach_roofs(buildings, source, "EPSG:32618")
    assert out.iloc[0].roof_source == "lod2"
    assert out.iloc[0].roof_height == 2.0
    assert json.loads(out.iloc[0].lod2_roof)["f"]
    assert out.iloc[1].roof_source == "heuristic"
    assert out.iloc[1].lod2_roof is None


def test_failed_reconstruction_is_ignored(tmp_path):
    path = tmp_path / "failed.city.jsonl"
    _write_cityjsonseq(path, success=False)
    assert read_roofs([path], "EPSG:32618") == {}


def test_bad_vertex_reference_falls_back_per_building(tmp_path):
    path = tmp_path / "damaged.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    damaged = json.loads(lines[1])
    part = next(o for o in damaged["CityObjects"].values() if o["type"] == "BuildingPart")
    part["geometry"][0]["boundaries"][0][0][0][0] = 999
    path.write_text(lines[0] + "\n" + json.dumps(damaged) + "\n" + lines[1] + "\n")
    roofs = read_roofs([path], "EPSG:32618")
    assert list(roofs) == ["osm:way/1"]


def test_low_quality_fit_is_ignored(tmp_path):
    path = tmp_path / "sparse.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    building = next(o for o in feature["CityObjects"].values() if o["type"] == "Building")
    building["attributes"]["rf_rmse_lod22"] = 1.26
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    assert read_roofs([path], "EPSG:32618") == {}


def test_implausibly_tall_roof_is_ignored(tmp_path):
    path = tmp_path / "tall.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    feature["vertices"][2][2] = 2600
    feature["vertices"][3][2] = 2600
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    assert read_roofs([path], "EPSG:32618") == {}


def test_partial_roof_keeps_existing_procedural_roof(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    _write_cityjsonseq(source / "roof.city.jsonl")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 5.0, "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 130, 230),
    }], crs="EPSG:32618")
    out = attach_roofs(buildings, source, "EPSG:32618")
    assert out.iloc[0].roof_source == "lidar"
    assert out.iloc[0].lod2_roof is None


def test_multipart_records_in_one_batch_are_combined(tmp_path):
    path = tmp_path / "multipart.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    second = json.loads(lines[1])
    second["id"] = "component-2"
    for vertex in second["vertices"]:
        vertex[0] += 2000
    path.write_text(lines[0] + "\n" + lines[1] + "\n" + json.dumps(second) + "\n")
    mesh = json.loads(read_roofs([path], "EPSG:32618")["osm:way/1"])
    assert len(mesh["v"]) == 8
    assert mesh["f"][1] == [[4, 5, 6, 7]]


def test_later_batch_replaces_older_mesh(tmp_path):
    old = tmp_path / "old.city.jsonl"
    new = tmp_path / "new.city.jsonl"
    _write_cityjsonseq(old)
    _write_cityjsonseq(new)
    lines = new.read_text().splitlines()
    feature = json.loads(lines[1])
    for vertex in feature["vertices"]:
        vertex[0] += 2000
    new.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    mesh = json.loads(read_roofs([old, new], "EPSG:32618")["osm:way/1"])
    assert len(mesh["v"]) == 4
    assert min(vertex[0] for vertex in mesh["v"]) == 120.0


def test_low_addition_does_not_lift_the_main_roof(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    _write_cityjsonseq(source / "roof.city.jsonl")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 7.0,
        "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 110, 210),
    }], crs="EPSG:32618")
    out = attach_roofs(buildings, source, "EPSG:32618")
    mesh = json.loads(out.iloc[0].lod2_roof)
    assert min(vertex[2] for vertex in mesh["v"]) == 0.0
    assert max(vertex[2] for vertex in mesh["v"]) == 0.0


def test_short_wall_does_not_leave_a_gap_below_roof(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    _write_cityjsonseq(source / "roof.city.jsonl")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 3.0,
        "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 110, 210),
    }], crs="EPSG:32618")
    out = attach_roofs(buildings, source, "EPSG:32618")
    mesh = json.loads(out.iloc[0].lod2_roof)
    assert min(vertex[2] for vertex in mesh["v"]) == 0.0
    assert max(vertex[2] for vertex in mesh["v"]) == 2.0


def test_near_vertical_roof_plane_is_ignored(tmp_path):
    path = tmp_path / "spike.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    feature["vertices"][2][1] = 100
    feature["vertices"][3][1] = 100
    feature["vertices"][2][2] = 900
    feature["vertices"][3][2] = 900
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    assert read_roofs([path], "EPSG:32618") == {}


def test_oversegmented_small_roof_keeps_procedural_fallback(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    path = source / "roof.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    building = next(o for o in feature["CityObjects"].values() if o["type"] == "Building")
    building["attributes"]["rf_ridgelines"] = 6
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 5.0,
        "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 110, 210),
    }], crs="EPSG:32618")
    out = attach_roofs(buildings, source, "EPSG:32618")
    assert out.iloc[0].roof_source == "lidar"
    assert out.iloc[0].lod2_roof is None


def test_oversegmented_medium_roof_keeps_procedural_fallback(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    path = source / "roof.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    building = next(o for o in feature["CityObjects"].values() if o["type"] == "Building")
    building["attributes"]["rf_ridgelines"] = 7
    building["attributes"]["rf_roof_planes"] = 28
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 10.0,
        "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 120, 220),
    }], crs="EPSG:32618")

    out = attach_roofs(buildings, source, "EPSG:32618")

    assert out.iloc[0].roof_source == "lidar"
    assert out.iloc[0].lod2_roof is None


def test_tall_complex_small_roof_keeps_procedural_fallback(tmp_path):
    source = tmp_path / "lod2"
    source.mkdir()
    path = source / "roof.city.jsonl"
    _write_cityjsonseq(path)
    lines = path.read_text().splitlines()
    feature = json.loads(lines[1])
    feature["vertices"][2][2] = 1100
    feature["vertices"][3][2] = 1100
    building = next(o for o in feature["CityObjects"].values() if o["type"] == "Building")
    building["attributes"]["rf_ridgelines"] = 1
    building["attributes"]["rf_roof_planes"] = 9
    path.write_text(lines[0] + "\n" + json.dumps(feature) + "\n")
    buildings = gpd.GeoDataFrame([{
        "id": "osm:way/1", "hidden": False, "height": 5.0,
        "roof_source": "lidar", "roof_height": 1.0,
        "geometry": box(100, 200, 110, 210),
    }], crs="EPSG:32618")

    out = attach_roofs(buildings, source, "EPSG:32618")

    assert out.iloc[0].roof_source == "lidar"
    assert out.iloc[0].lod2_roof is None
