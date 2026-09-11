"""The layer cache must be transparent: same layers out, and a miss whenever anything it depends on moves."""
from __future__ import annotations

import time

import geopandas as gpd
import pytest
from shapely.geometry import LineString, box

import build_tiles
import layer_cache


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(layer_cache, "CACHE_DIR", tmp_path / "cache")
    return tmp_path


@pytest.fixture
def raw_dir(tmp_path):
    d = tmp_path / "osm_slug"
    d.mkdir()
    gpd.GeoDataFrame([{"id": "a", "geometry": box(0, 0, 10, 10)}], crs="EPSG:32618").to_parquet(d / "buildings.parquet")
    return d


def _layers():
    return {
        "buildings": gpd.GeoDataFrame([{"id": "b1", "height": 12.0, "geometry": box(0, 0, 10, 10)}],
                                      crs="EPSG:32618"),
        "roads": gpd.GeoDataFrame([{"id": "r1", "deck": [1.0, 2.0, 3.0], "geometry": LineString([(0, 0), (5, 5)])}],
                                  crs="EPSG:32618"),
    }


def test_round_trip_preserves_layers_order_and_list_columns(cache_dir, raw_dir):
    key = layer_cache.fingerprint("slug", raw_dir, {})
    layer_cache.store("slug", key, _layers(), {"surveyed_trees": True})

    loaded, extras = layer_cache.load("slug", key)
    assert list(loaded) == ["buildings", "roads"]  # index.json layer order depends on this
    assert extras == {"surveyed_trees": True}
    # parquet hands lists back as ndarrays; the cache must undo that or _write_layer drops bridge decks
    assert loaded["roads"].iloc[0]["deck"] == [1.0, 2.0, 3.0]
    assert isinstance(loaded["roads"].iloc[0]["deck"], list)


def test_miss_returns_none(cache_dir, raw_dir):
    assert layer_cache.load("slug", layer_cache.fingerprint("slug", raw_dir, {})) is None


def test_options_and_region_change_the_key(cache_dir, raw_dir):
    a = layer_cache.fingerprint("slug", raw_dir, {"merge_rowhouses": True})
    b = layer_cache.fingerprint("slug", raw_dir, {"merge_rowhouses": False})
    assert a != b


def test_touching_a_source_changes_the_key(cache_dir, raw_dir):
    before = layer_cache.fingerprint("slug", raw_dir, {})
    src = raw_dir / "buildings.parquet"
    src.write_bytes(src.read_bytes() + b"\0")
    assert layer_cache.fingerprint("slug", raw_dir, {}) != before


def test_editing_a_layer_module_changes_the_key(cache_dir, raw_dir, monkeypatch):
    before = layer_cache.fingerprint("slug", raw_dir, {})
    impl = layer_cache.PIPELINE_DIR / "process.py"
    stat = impl.stat()
    try:
        impl.touch()
        assert layer_cache.fingerprint("slug", raw_dir, {}) != before
    finally:
        import os
        os.utime(impl, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def test_driver_modules_do_not_change_the_key(cache_dir, raw_dir):
    """Editing build_tiles/qa_report is the case the cache exists to keep fast."""
    names = {p.name for p in layer_cache._impl_files()}
    assert "build_tiles.py" not in names and "qa_report.py" not in names
    assert not any(n.startswith("fetch") for n in names)
    assert "process.py" in names and "lidar.py" in names


def test_unreadable_entry_is_a_miss_not_a_crash(cache_dir, raw_dir, capsys):
    key = layer_cache.fingerprint("slug", raw_dir, {})
    layer_cache.store("slug", key, _layers(), {})
    (layer_cache.CACHE_DIR / f"layers_slug_{key}" / "roads.parquet").write_bytes(b"garbage")
    assert layer_cache.load("slug", key) is None
    assert "unreadable layer cache" in capsys.readouterr().out


def test_prune_keeps_only_recent_entries(cache_dir, raw_dir):
    keys = []
    for i in range(5):
        key = layer_cache.fingerprint("slug", raw_dir, {"n": i})
        layer_cache.store("slug", key, _layers(), {})
        keys.append(key)
        time.sleep(0.01)
    kept = sorted(p.name for p in layer_cache.CACHE_DIR.glob("layers_slug_*"))
    assert len(kept) <= 3
    assert f"layers_slug_{keys[-1]}" in kept


def test_partial_rebuild_refuses_layers_it_would_leave_half_finished():
    """pois/landuse/buildings gain content after their processor runs; rewriting them alone loses it."""
    assert build_tiles.PARTIAL_LAYERS == {"roads", "crossings", "rail"}
    for name in ("pois", "landuse", "buildings", "water"):
        with pytest.raises(SystemExit) as exc:
            build_tiles.rebuild_layer_tiles((-77.0, 37.0, -76.9, 37.1), {name})
        assert name in str(exc.value) and "full build" in str(exc.value)
