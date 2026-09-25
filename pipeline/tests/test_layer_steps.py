"""Steps rerun exactly when their own inputs, code or upstream layers change."""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import box

import layer_cache
import layer_steps
from layer_steps import Step, StepContext, run_steps


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(layer_cache, "CACHE_DIR", tmp_path / "cache")
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "a.txt").write_text("a")
    (tmp_path / "raw" / "b.txt").write_text("b")
    return tmp_path


def _ctx(tmp_path, **kw) -> StepContext:
    return StepContext("richmond", (-77.44, 37.54, -77.43, 37.55), "slug", tmp_path / "raw",
                       tmp_path / "dem.tif", None, None, **kw)


def _gdf(v):
    return gpd.GeoDataFrame([{"v": v, "geometry": box(0, 0, 1, 1)}], crs="EPSG:32618")


def _steps(runs: dict, cache_b=True):
    def run_a(ctx, layers):
        runs["a"] = runs.get("a", 0) + 1
        return {"x": _gdf(1)}

    def run_b(ctx, layers):
        runs["b"] = runs.get("b", 0) + 1
        return {"y": _gdf(int(layers["x"].iloc[0].v) + 1)}, {"b_ran": True}

    return [Step("a", ("x",), run_a, sources=lambda c: [c.raw_dir / "a.txt"]),
            Step("b", ("y",), run_b, reads=("x",), sources=lambda c: [c.raw_dir / "b.txt"], cache=cache_b)]


def test_second_build_loads_every_step_from_cache(env):
    runs = {}
    layers, extras, report = run_steps(_ctx(env), _steps(runs))
    assert [r["how"] for r in report] == ["processed", "processed"]
    assert extras == {"b_ran": True} and int(layers["y"].iloc[0].v) == 2
    layers, extras, report = run_steps(_ctx(env), _steps(runs))
    assert [r["how"] for r in report] == ["cached", "cached"]
    assert runs == {"a": 1, "b": 1}
    assert extras == {"b_ran": True} and int(layers["y"].iloc[0].v) == 2


def test_a_changed_source_reruns_its_step_and_everything_downstream(env):
    runs = {}
    run_steps(_ctx(env), _steps(runs))
    (env / "raw" / "a.txt").write_text("aa")
    _, _, report = run_steps(_ctx(env), _steps(runs))
    assert [r["how"] for r in report] == ["processed", "processed"]


def test_a_changed_downstream_source_reruns_only_that_step(env):
    runs = {}
    run_steps(_ctx(env), _steps(runs))
    (env / "raw" / "b.txt").write_text("bb")
    _, _, report = run_steps(_ctx(env), _steps(runs))
    assert [r["how"] for r in report] == ["cached", "processed"]
    assert runs == {"a": 1, "b": 2}


def test_no_cache_and_uncacheable_steps_always_run(env):
    runs = {}
    run_steps(_ctx(env), _steps(runs, cache_b=False))
    _, _, report = run_steps(_ctx(env), _steps(runs, cache_b=False))
    assert [r["how"] for r in report] == ["cached", "processed"]
    _, _, report = run_steps(_ctx(env, no_cache=True), _steps(runs, cache_b=False))
    assert [r["how"] for r in report] == ["processed", "processed"]


def test_options_are_part_of_the_key_only_for_steps_that_declare_them(env):
    runs = {}
    steps = _steps(runs)
    steps[0].options = ("merge_rowhouses",)
    run_steps(_ctx(env), steps)
    _, _, report = run_steps(_ctx(env, merge_rowhouses=False), steps)
    assert [r["how"] for r in report] == ["processed", "processed"]  # b reruns because x's key changed


def test_a_step_may_only_write_what_it_declares(env):
    bad = Step("bad", ("x",), lambda ctx, layers: {"x": _gdf(1), "z": _gdf(2)})
    with pytest.raises(RuntimeError, match="declares"):
        run_steps(_ctx(env), [bad])


def test_reading_an_unproduced_layer_is_an_error(env):
    with pytest.raises(RuntimeError, match="before any step produced"):
        run_steps(_ctx(env), [Step("b", ("y",), lambda c, l: {}, reads=("x",))])


def test_layers_come_back_in_the_documented_order(env):
    steps = [Step(n, (n,), (lambda n: lambda c, l: {n: _gdf(0)})(n)) for n in ("pois", "water", "buildings")]
    layers, _, _ = run_steps(_ctx(env), steps)
    assert list(layers) == ["buildings", "water", "pois"]


# ---------------------------------------------------------------- the real registry

def test_registry_covers_every_augmentation_and_keys_resolve(env):
    """Every step's entries must exist and analyse; augmentations must read what they modify."""
    for region in ("richmond", "honolulu"):
        steps = layer_steps.steps_for(region)
        names = [s.name for s in steps]
        assert names[:6] == ["buildings", "roads", "rail", "landuse", "water", "pois"]
        if region == "richmond":
            assert names[6:] == ["lod2_roofs", "roof_furniture", "groundcover", "city_decks", "hydro_shoreline", "canal_banks", "trees",
                                 "streetlights"]
        else:
            assert names[6:] == ["coast"] and steps[-1].cache is False
        produced = set()
        ctx = _ctx(env)
        ctx.region = region
        for s in steps:
            assert set(s.reads) <= produced, s.name
            for layer in s.produces:
                if layer in produced:
                    assert layer in s.reads, f"{s.name} rewrites {layer} without reading it"
            produced |= set(s.produces)
            assert len(s.key(ctx, {})) == 16


def test_overrides_only_touch_buildings_and_the_tree_merge(env, monkeypatch):
    """The most common edit: assets/supplements/overrides.json."""
    steps = layer_steps.steps_for("richmond")
    ctx = _ctx(env)
    overrides = env / "overrides.json"
    overrides.write_text("[]")
    monkeypatch.setattr(layer_steps, "ASSETS", env)
    (env / "supplements").mkdir()
    (env / "supplements" / "overrides.json").write_text("[]")
    before = {s.name: s.key(ctx, {}) for s in steps}
    (env / "supplements" / "overrides.json").write_text("[{}]")
    after = {s.name: s.key(ctx, {}) for s in steps}
    changed = {n for n in before if before[n] != after[n]}
    assert changed == {"buildings"}
    # the tree merge reads buildings, so its key moves through the upstream chain
    trees = next(s for s in steps if s.name == "trees")
    assert trees.key(ctx, {"buildings": before["buildings"]}) != trees.key(ctx, {"buildings": after["buildings"]})
