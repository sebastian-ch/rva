"""deps.code_fingerprint must move when code a step runs changes, and stay put when unrelated code changes."""
from __future__ import annotations

import importlib
import re
import sys
import textwrap

import pytest

import deps


@pytest.fixture
def fake_pipeline(tmp_path, monkeypatch):
    """A throwaway pipeline dir with modules a (entry), b (used by a.f) and c (not used by a.f)."""
    (tmp_path / "config.py").write_text("X = 1\n")
    (tmp_path / "b.py").write_text("import config\n\ndef helper(v):\n    return v + config.X\n")
    (tmp_path / "c.py").write_text("def unused():\n    return 3\n")
    (tmp_path / "a.py").write_text(textwrap.dedent("""
        from b import helper
        import c
        LIMIT = 10

        def f(v):
            return _inner(v)

        def _inner(v):
            return helper(v) if v < LIMIT else v

        def g(v):
            return c.unused() + v
    """))
    monkeypatch.setattr(deps, "PIPELINE_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    # the real `config` stays in sys.modules: the fake one is only ever read as text by deps
    for m in ("a", "b", "c"):
        sys.modules.pop(m, None)
    deps.clear_caches()
    yield tmp_path
    for m in ("a", "b", "c"):
        sys.modules.pop(m, None)
    deps.clear_caches()


def _fp(name="f"):
    deps.clear_caches()
    a = importlib.import_module("a")
    return deps.code_fingerprint((getattr(a, name),))


def _edit(path, old, new):
    path.write_text(path.read_text().replace(old, new))


def test_only_reached_definitions_are_hashed(fake_pipeline):
    fp = _fp()
    assert set(fp["partial"]["a"]["defs"]) == {"f", "_inner", "LIMIT"}
    assert fp["partial"]["a"]["imports"] == {"helper": "b"}
    assert set(fp["whole"]) == {"b", "config"}          # c is only used by g


def test_editing_the_entry_function_or_its_helpers_changes_the_key(fake_pipeline):
    before = _fp()
    _edit(fake_pipeline / "a.py", "return helper(v) if v < LIMIT", "return helper(v) if v <= LIMIT")
    assert _fp() != before
    before = _fp()
    _edit(fake_pipeline / "a.py", "LIMIT = 10", "LIMIT = 11")
    assert _fp() != before


def test_editing_an_unrelated_function_in_the_same_module_keeps_the_key(fake_pipeline):
    before = _fp()
    _edit(fake_pipeline / "a.py", "return c.unused() + v", "return c.unused() + v + 1")
    assert _fp() == before


def test_reached_modules_are_hashed_whole_and_unreached_ones_are_not(fake_pipeline):
    before = _fp()
    _edit(fake_pipeline / "c.py", "return 3", "return 4")
    assert _fp() == before
    _edit(fake_pipeline / "b.py", "return v + config.X", "return v + config.X + 1")
    assert _fp() != before
    before = _fp()
    _edit(fake_pipeline / "config.py", "X = 1", "X = 2")  # config is always included
    assert _fp() != before


def test_nested_imports_count(fake_pipeline):
    _edit(fake_pipeline / "a.py", "def g(v):\n", "def g(v):\n    import c as cc\n")
    _edit(fake_pipeline / "a.py", "def f(v):\n    return _inner(v)", "def f(v):\n    from c import unused\n    return _inner(v)")
    assert "c" in _fp()["whole"]


def test_mtime_only_changes_keep_the_key(fake_pipeline):
    """A git checkout that restores identical text must keep the cache warm."""
    before = _fp()
    (fake_pipeline / "b.py").touch()
    assert _fp() == before


# ---------------------------------------------------------------- the real pipeline

def test_buildings_step_reaches_its_height_sources_and_roads_does_not():
    import process
    b = deps.code_fingerprint((process.process_buildings,), ("terrain",))
    r = deps.code_fingerprint((process.process_roads,), ("terrain",))
    assert {"heights", "lidar", "roofs", "overture", "richmond", "terrain", "config"} <= set(b["whole"])
    assert "process" in b["partial"] and "process_buildings" in b["partial"]["process"]["defs"]
    assert "apply_overrides" in b["partial"]["process"]["defs"]
    assert not {"lidar", "roofs", "overture", "richmond"} & set(r["whole"])
    assert "process_buildings" not in r["partial"]["process"]["defs"]


def test_layer_modules_avoid_patterns_the_analysis_cannot_see():
    """`from x import *`, globals(), eval() and importlib would let an edit slip past a step key."""
    bad = re.compile(r"^\s*from \S+ import \*|\bglobals\(\)|\beval\(|\bimportlib\b", re.M)
    offenders = []
    for p in sorted(deps.PIPELINE_DIR.glob("*.py")):
        if p.name.startswith("fetch") or p.name in {"deps.py", "dem_noaa.py"}:
            continue
        if bad.search(p.read_text()):
            offenders.append(p.name)
    assert offenders == []
