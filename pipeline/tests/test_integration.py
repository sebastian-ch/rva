"""Fixture-based integration test: run process_* over a tiny raw dataset (pipeline/tests/fixtures/,
built by pipeline/tests/make_fixture.py) and validate every emitted feature against pipeline/schema.py.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

import lidar
from process import (
    process_buildings, process_landuse, process_pois, process_rail, process_roads, process_water,
)
from landmarks import resolve_landmarks
from schema import validate_feature
from terrain import Terrain

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _nn(v):
    """Mirror process._nn: NaN -> None."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def _row_props(gdf) -> list[dict]:
    """Mimic build_tiles._write_layer's property dict: NaN -> None, deck lists kept as lists."""
    cols = [c for c in gdf.columns if c != "geometry"]
    return [{c: _nn(row[c]) for c in cols} for _, row in gdf.iterrows()]


def _validate_all(layer: str, gdf) -> list[str]:
    problems = []
    for props in _row_props(gdf):
        problems += validate_feature(layer, props)
    return problems


@pytest.fixture(autouse=True)
def _hermetic_lidar(monkeypatch):
    # LiDAR is absent from the fixture on purpose; make sure sample_ndsm_stats can't fall back
    # to the real data/raw/ndsm.tif and make the test depend on data outside pipeline/tests/fixtures/.
    monkeypatch.setattr(lidar, "NDSM_PATH", Path("/nonexistent/ndsm.tif"))


@pytest.fixture(scope="module")
def terrain():
    dem = FIXTURES / "dem.tif"
    if not dem.exists():
        pytest.skip("fixtures missing; run: .venv/bin/python pipeline/tests/make_fixture.py")
    t = Terrain(dem)
    yield t
    t.close()


@pytest.fixture(scope="module")
def buildings(terrain):
    raw = FIXTURES / "osm" / "buildings.parquet"
    if not raw.exists():
        pytest.skip("fixtures missing; run: .venv/bin/python pipeline/tests/make_fixture.py")
    return process_buildings(
        raw, terrain=terrain, merge_rowhouses=True,
        overture_path=FIXTURES / "overture.parquet",
        lidar_npz=None,
        richmond_dir=FIXTURES / "richmond",
    )


# --------------------------------------------------------------------- buildings

def test_buildings_nonempty(buildings):
    assert len(buildings) > 0


def test_buildings_validate(buildings):
    problems = _validate_all("buildings", buildings)
    assert not problems, problems[:10]


def test_height_source_diversity(buildings):
    """At least one building resolved through a "real" source, not just default/lidar fallback."""
    sources = set(buildings["height_source"].dropna().unique())
    assert sources & {"osm_height", "osm_levels", "overture_height", "zoning"}


def test_capitol_matched_as_landmark(buildings):
    assert "virginia-state-capitol" in set(buildings["landmark"].dropna().unique())


# --------------------------------------------------------------------- roads / rail

def test_roads(terrain):
    roads, crossings = process_roads(FIXTURES / "osm" / "roads.parquet", terrain)
    assert len(roads) > 0
    assert (roads["width"] > 0).all()
    assert str(roads["sidewalk_left"].dtype) == "boolean"
    assert str(roads["sidewalk_right"].dtype) == "boolean"
    problems = _validate_all("roads", roads) + _validate_all("crossings", crossings)
    assert not problems, problems[:10]


def test_rail(terrain):
    rail = process_rail(FIXTURES / "osm" / "rail.parquet", terrain)
    # the fixture's clipped rail.parquet may legitimately be empty (no track within 300 m of the
    # Capitol) -- validate_feature is still exercised over whatever rows exist.
    problems = _validate_all("rail", rail)
    assert not problems, problems[:10]


# --------------------------------------------------------------------- landuse / water / pois

def test_landuse_water_pois():
    landuse = process_landuse(FIXTURES / "osm" / "landuse.parquet")
    water = process_water(FIXTURES / "osm" / "water.parquet")
    pois = process_pois(FIXTURES / "osm" / "pois.parquet")
    problems = (
        _validate_all("landuse", landuse) + _validate_all("water", water) + _validate_all("pois", pois)
    )
    assert not problems, problems[:10]


# --------------------------------------------------------------------- landmarks

def test_resolve_landmarks_capitol(buildings):
    lms = resolve_landmarks(FIXTURES / "osm", buildings, terrain=None)
    cap = lms["virginia-state-capitol"]
    assert cap["how"] == "building"
