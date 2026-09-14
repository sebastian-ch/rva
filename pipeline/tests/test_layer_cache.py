"""The step cache must be transparent (same layers out) and the row digests must be content-only."""
from __future__ import annotations

import time

import geopandas as gpd
import numpy as np
import pytest
from shapely.geometry import LineString, box

import layer_cache


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(layer_cache, "CACHE_DIR", tmp_path / "cache")
    return tmp_path


def _layers():
    return {
        "buildings": gpd.GeoDataFrame([{"id": "b1", "height": 12.0, "geometry": box(0, 0, 10, 10)}],
                                      crs="EPSG:32618"),
        "roads": gpd.GeoDataFrame([{"id": "r1", "deck": [1.0, 2.0, 3.0], "geometry": LineString([(0, 0), (5, 5)])}],
                                  crs="EPSG:32618"),
    }


def test_round_trip_preserves_layers_order_and_list_columns(cache_dir):
    layer_cache.store_step("slug", "roads", "k1", _layers(), {"surveyed_trees": True})

    loaded, extras = layer_cache.load_step("slug", "roads", "k1")
    assert list(loaded) == ["buildings", "roads"]
    assert extras == {"surveyed_trees": True}
    # parquet hands lists back as ndarrays; the cache must undo that or _write_layer drops bridge decks
    assert loaded["roads"].iloc[0]["deck"] == [1.0, 2.0, 3.0]
    assert isinstance(loaded["roads"].iloc[0]["deck"], list)


def test_miss_returns_none(cache_dir):
    assert layer_cache.load_step("slug", "roads", "nope") is None


def test_unreadable_entry_is_a_miss_not_a_crash(cache_dir, capsys):
    layer_cache.store_step("slug", "roads", "k1", _layers(), {})
    (layer_cache.CACHE_DIR / "steps_slug" / "roads_k1" / "roads.parquet").write_bytes(b"garbage")
    assert layer_cache.load_step("slug", "roads", "k1") is None
    assert "unreadable layer cache" in capsys.readouterr().out


def test_prune_keeps_only_recent_entries_per_step(cache_dir):
    for i in range(5):
        layer_cache.store_step("slug", "roads", f"k{i}", _layers(), {})
        time.sleep(0.01)
    layer_cache.store_step("slug", "buildings", "b0", _layers(), {})
    kept = sorted(p.name for p in (layer_cache.CACHE_DIR / "steps_slug").iterdir())
    assert len([k for k in kept if k.startswith("roads_")]) <= 3
    assert "roads_k4" in kept and "buildings_b0" in kept


# ---------------------------------------------------------------- row digests

def _gdf(rows):
    return gpd.GeoDataFrame(rows, crs="EPSG:32618")


def test_digest_ignores_row_order_and_column_order():
    a = _gdf([{"id": "1", "h": 3.0, "geometry": box(0, 0, 1, 1)}, {"id": "2", "h": 4.0, "geometry": box(2, 2, 3, 3)}])
    b = _gdf([{"h": 4.0, "id": "2", "geometry": box(2, 2, 3, 3)}, {"h": 3.0, "id": "1", "geometry": box(0, 0, 1, 1)}])
    da, db = layer_cache.row_digests(a), layer_cache.row_digests(b)
    assert layer_cache.digest_rows(da, [0, 1]) == layer_cache.digest_rows(db, [0, 1])
    assert layer_cache.digest_rows(da, [0]) != layer_cache.digest_rows(da, [1])


def test_digest_sees_property_and_geometry_changes():
    base = _gdf([{"id": "1", "h": 3.0, "geometry": box(0, 0, 1, 1)}])
    d0 = layer_cache.digest_rows(layer_cache.row_digests(base), [0])
    taller = _gdf([{"id": "1", "h": 3.5, "geometry": box(0, 0, 1, 1)}])
    moved = _gdf([{"id": "1", "h": 3.0, "geometry": box(0, 0, 1, 1.5)}])
    assert layer_cache.digest_rows(layer_cache.row_digests(taller), [0]) != d0
    assert layer_cache.digest_rows(layer_cache.row_digests(moved), [0]) != d0


def test_digest_is_the_same_after_a_parquet_round_trip(cache_dir):
    """Cached layers must not look changed to the tiling loop: lists become ndarrays, None may become NaN."""
    fresh = _gdf([{"id": "r1", "deck": [1.0, 2.0], "name": None, "w": float("nan"), "geometry": LineString([(0, 0), (5, 5)])},
                  {"id": "r2", "deck": None, "name": "Main", "w": 3.0, "geometry": LineString([(0, 0), (5, 6)])}])
    layer_cache.store_step("slug", "roads", "k", {"roads": fresh}, {})
    cached = layer_cache.load_step("slug", "roads", "k")[0]["roads"]
    assert isinstance(cached.iloc[0]["deck"], list)
    df, dc = layer_cache.row_digests(fresh), layer_cache.row_digests(cached)
    assert layer_cache.digest_rows(df, [0, 1]) == layer_cache.digest_rows(dc, [0, 1])
    # and an ndarray deck straight from parquet (before _restore) hashes like the list
    raw = cached.copy()
    raw["deck"] = raw["deck"].map(lambda v: np.asarray(v) if isinstance(v, list) else v)
    assert layer_cache.digest_rows(layer_cache.row_digests(raw), [0, 1]) == layer_cache.digest_rows(df, [0, 1])


def test_empty_layer_digests():
    assert len(layer_cache.row_digests(_gdf([]).set_geometry([]) if False else gpd.GeoDataFrame(geometry=[], crs="EPSG:32618"))) == 0


# ---------------------------------------------------------------- tile state

def test_tile_state_round_trip_and_version(cache_dir):
    state = {"0_0": {"layers": {"roads": {"digest": "abc", "count": 3}}, "terrain": "t"}}
    layer_cache.save_tile_state("slug", state)
    assert layer_cache.load_tile_state("slug") == state
    p = layer_cache.tile_state_path("slug")
    p.write_text(p.read_text().replace(f'"version":{layer_cache.STATE_VERSION}', '"version":0'))
    assert layer_cache.load_tile_state("slug") == {}
    p.write_bytes(b"{")
    assert layer_cache.load_tile_state("slug") == {}
