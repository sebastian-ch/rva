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
            "osm:way/1": {"type": "Building", "attributes": {"rf_success": success, "source_id": "osm:way/1"}},
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
        {"id": "osm:way/1", "hidden": False, "roof_source": "lidar", "roof_height": 1.0, "geometry": box(100, 200, 110, 210)},
        {"id": "osm:way/2", "hidden": False, "roof_source": "heuristic", "roof_height": 0.0, "geometry": box(120, 200, 130, 210)},
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
