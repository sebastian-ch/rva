from __future__ import annotations

import geopandas as gpd
from shapely.geometry import LineString, Point, box

from build_tiles import _tile_layer


def test_road_tile_clips_features_to_its_bounds():
    roads = gpd.GeoDataFrame([
        {"id": "road", "highway": "residential", "footway": None,
         "geometry": LineString([(0, 9), (10, 9)])},
        {"id": "sidewalk", "highway": "footway", "footway": "sidewalk",
         "geometry": LineString([(0, 12), (10, 12)])},
    ], crs="EPSG:32618")

    part = _tile_layer(roads, roads.sindex, "roads", box(0, 0, 10, 10))

    assert list(part["id"]) == ["road"]
    assert tuple(part.total_bounds) == (0.0, 9.0, 10.0, 9.0)


# ---------------------------------------------------------------- incremental tile writes

import json

import pytest
from pyproj import Transformer

from build_tiles import write_tiles
from config import CRS_PROJ, TILE_SIZE, snap_down

BBOX = (-77.440, 37.540, -77.436, 37.543)  # ~2 x 2 tiles


def _origin():
    tr = Transformer.from_crs("EPSG:4326", CRS_PROJ, always_xy=True)
    xs, ys = zip(*[tr.transform(x, y) for x, y in ((BBOX[0], BBOX[1]), (BBOX[2], BBOX[3]))])
    return snap_down(min(xs), TILE_SIZE), snap_down(min(ys), TILE_SIZE)


def _layers(heights=(10.0, 20.0), with_road=True):
    ox, oy = _origin()
    b = [{"id": "b0", "height": heights[0], "geometry": box(ox + 10, oy + 10, ox + 30, oy + 30)},
         {"id": "b1", "height": heights[1], "geometry": box(ox + 260, oy + 10, ox + 280, oy + 30)}]
    layers = {"buildings": gpd.GeoDataFrame(b, crs=CRS_PROJ)}
    r = [{"id": "r0", "highway": "residential", "geometry": LineString([(ox + 5, oy + 100), (ox + 400, oy + 100)])}] if with_road else []
    layers["roads"] = gpd.GeoDataFrame(r, columns=["id", "highway", "geometry"], geometry="geometry", crs=CRS_PROJ)
    return layers


def _run(tmp_path, layers, state):
    return write_tiles(layers, None, None, None, BBOX, False, state, "fp", tiles_dir=tmp_path)


def test_unchanged_tiles_are_not_rewritten_and_counts_survive(tmp_path):
    meta, state, grid, n = _run(tmp_path, _layers(), {})
    assert grid["grid"][1] == 2 and grid["grid"][0] >= 2
    assert n["written"] == 4 and n["unchanged"] == 0  # 2 building tiles + the road crossing 2 tiles
    first = {p.relative_to(tmp_path): p.stat().st_mtime_ns for p in tmp_path.rglob("*.geojson")}
    meta2, state2, _, n2 = _run(tmp_path, _layers(), state)
    assert n2["written"] == 0 and n2["unchanged"] == 4
    assert {p.relative_to(tmp_path): p.stat().st_mtime_ns for p in tmp_path.rglob("*.geojson")} == first
    assert meta2 == meta and state2 == state


def test_one_edited_building_rewrites_one_tile_file(tmp_path):
    _, state, _, _ = _run(tmp_path, _layers(), {})
    meta, state2, _, n = _run(tmp_path, _layers(heights=(10.0, 25.0)), state)
    assert n["written"] == 1 and n["unchanged"] == 3
    tile = next(m for m in meta if m["counts"].get("buildings") and m["x"] == 1)
    feats = json.loads((tmp_path / tile["id"] / "buildings.geojson").read_text())["features"]
    assert feats[0]["properties"]["height"] == 25.0
    assert state2["0_0"]["layers"]["buildings"] == state["0_0"]["layers"]["buildings"]


def test_a_layer_that_leaves_a_tile_has_its_file_removed(tmp_path):
    meta, state, _, _ = _run(tmp_path, _layers(), {})
    assert (tmp_path / "0_0" / "roads.geojson").exists()
    meta2, state2, _, n = _run(tmp_path, _layers(with_road=False), state)
    assert n["removed"] == 2 and not (tmp_path / "0_0" / "roads.geojson").exists()
    assert all("roads" not in m["layers"] and "roads" not in m["counts"] for m in meta2)
    assert "roads" not in state2["0_0"]["layers"]


def test_a_missing_file_is_rewritten_even_when_its_digest_matches(tmp_path):
    _, state, _, _ = _run(tmp_path, _layers(), {})
    (tmp_path / "0_0" / "buildings.geojson").unlink()
    _, _, _, n = _run(tmp_path, _layers(), state)
    assert n["written"] == 1 and (tmp_path / "0_0" / "buildings.geojson").exists()


def test_tile_code_change_rewrites_files_with_unchanged_rows(tmp_path, monkeypatch):
    _, state, _, _ = _run(tmp_path, _layers(), {})
    monkeypatch.setattr("build_tiles.deps.code_fingerprint", lambda entries: {"changed": True})
    _, _, _, n = _run(tmp_path, _layers(), state)
    assert n["written"] == 4 and n["unchanged"] == 0


def test_stale_tile_dirs_outside_the_grid_are_dropped(tmp_path):
    (tmp_path / "9_9").mkdir()
    (tmp_path / "9_9" / "roads.geojson").write_text("{}")
    _run(tmp_path, _layers(), {})
    assert not (tmp_path / "9_9").exists()


def test_pois_write_a_compact_binary_table_and_replace_legacy_geojson(tmp_path):
    ox, oy = _origin()
    layers = {"pois": gpd.GeoDataFrame([{
        "id": "tree-1", "name": None, "kind": "tree", "species": "Quercus alba",
        "geometry": Point(ox + 10.12, oy + 20.34),
    }], crs=CRS_PROJ)}
    legacy = tmp_path / "0_0"
    legacy.mkdir()
    (legacy / "pois.geojson").write_text("obsolete")
    meta, _, _, _ = _run(tmp_path, layers, {})
    tile = next(m for m in meta if "pois" in m["layers"])
    payload = (tmp_path / tile["id"] / "pois.bin").read_bytes()
    assert payload[:4] == b"POI1"
    assert not (tmp_path / tile["id"] / "pois.geojson").exists()
