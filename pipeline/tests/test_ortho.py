"""Tests for pipeline/ortho.py: roof colour sampled from orthoimagery.

The classifier is deliberately conservative, so most of what is worth guarding is what it *refuses*
to answer: too few pixels, a tree crown over the roof, a footprint too small to survive the lean
shrink. A wrong confident colour is worse than the seeded guess it replaces, because it looks surveyed.
"""
from __future__ import annotations

import numpy as np
import pytest
from shapely.geometry import Polygon

import geopandas as gpd

from config import CRS_PROJ, load_palette
from heights import ROOF_KEYS
from ortho import (
    BASE_SHRINK_M,
    LEAN_FRAC,
    MAX_SHRINK_M,
    MIN_PIXELS,
    apply_roof_colors,
    classify_roof_tone,
    roof_colors,
    roof_rgb,
    shrink_for,
    srgb_to_lab,
)

rasterio = pytest.importorskip("rasterio")


def _hex_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _window(rgb, n=64, nir=None, mask=None):
    """A (bands, rows, cols) uint8 window of one flat colour, optionally masked."""
    side = int(np.ceil(np.sqrt(n)))
    bands = [np.full((side, side), int(round(c * 255)), np.uint8) for c in rgb]
    if nir is not None:
        bands.append(np.full((side, side), int(round(nir * 255)), np.uint8))
    arr = np.stack(bands)
    if mask is None:
        return arr
    return np.ma.masked_array(arr, mask=np.broadcast_to(mask, arr.shape))


# --------------------------------------------------------------------- srgb_to_lab

def test_lab_of_white_and_black():
    L, a, b = srgb_to_lab((1.0, 1.0, 1.0))
    assert L == pytest.approx(100.0, abs=0.5)
    assert abs(a) < 0.5 and abs(b) < 0.5
    assert srgb_to_lab((0.0, 0.0, 0.0))[0] == pytest.approx(0.0, abs=0.5)


def test_lab_grey_is_neutral():
    for v in (0.2, 0.5, 0.8):
        _, a, b = srgb_to_lab((v, v, v))
        assert abs(a) < 0.5 and abs(b) < 0.5, "a grey pixel must carry no chroma"


# --------------------------------------------------------------------- classify_roof_tone

@pytest.mark.parametrize("hexcolor, expected, what", [
    ("#e8e6e0", "roof_flat", "white TPO membrane"),
    ("#bdb9ae", "roof_flat", "light gravel ballast"),
    ("#8b8b88", "concrete", "weathered concrete deck"),
    ("#3a3a38", "roof_dark", "black asphalt shingle"),
    ("#2b2c2e", "roof_dark", "tar and gravel"),
    ("#9c4a33", "roof_red", "red clay tile"),
    ("#a85a3c", "roof_red", "terracotta"),
    ("#4a3128", "brick_dark", "brown asphalt shingle"),
    ("#4e8b78", "roof_green", "copper patina"),
    ("#3f5a78", "slate", "blue-grey standing seam"),
])
def test_classify_representative_roofs(hexcolor, expected, what):
    assert classify_roof_tone(_hex_rgb(hexcolor)) == expected, what


def test_classify_only_returns_palette_roof_keys():
    rng = np.random.default_rng(0)
    for rgb in rng.random((400, 3)):
        assert classify_roof_tone(tuple(rgb)) in ROOF_KEYS


def test_classify_keys_exist_in_palette():
    palette = load_palette()
    for key in ROOF_KEYS:
        assert key in palette


def test_grey_cast_does_not_become_a_coloured_roof():
    """A grey roof photographed under a warm sun still has a small a*/b*; it must stay neutral."""
    assert classify_roof_tone(_hex_rgb("#8e8a82")) in ("concrete", "roof_flat")
    assert classify_roof_tone(_hex_rgb("#46443f")) == "roof_dark"


# --------------------------------------------------------------------- shrink_for

def test_shrink_grows_with_height_and_is_capped():
    assert shrink_for(0.0) == pytest.approx(BASE_SHRINK_M)
    assert shrink_for(10.0) == pytest.approx(BASE_SHRINK_M + 10 * LEAN_FRAC)
    assert shrink_for(1000.0) == MAX_SHRINK_M
    assert shrink_for(-5.0) == pytest.approx(BASE_SHRINK_M), "a negative height must not shrink less than base"


# --------------------------------------------------------------------- roof_rgb

def test_roof_rgb_medians_a_flat_window():
    r, g, b, n = roof_rgb(_window((0.8, 0.78, 0.74), n=100))
    assert (round(r, 2), round(g, 2), round(b, 2)) == (0.8, 0.78, 0.74)
    assert n >= MIN_PIXELS


def test_roof_rgb_rejects_a_window_with_too_few_pixels():
    assert roof_rgb(_window((0.5, 0.5, 0.5), n=4)) is None


def test_roof_rgb_rejects_a_mostly_masked_window():
    arr = _window((0.5, 0.5, 0.5), n=100)
    mask = np.zeros(arr.shape[1:], bool)
    mask[1:, :] = True          # leave one 10-pixel row, under MIN_PIXELS
    assert roof_rgb(np.ma.masked_array(arr, np.broadcast_to(mask, arr.shape))) is None


def test_roof_rgb_rejects_a_canopy_over_the_roof():
    """High NDVI over most of the footprint: this is a tree, and the answer is None, not green."""
    assert roof_rgb(_window((0.25, 0.35, 0.2), n=100, nir=0.85)) is None


def test_roof_rgb_rejects_greenery_without_a_nir_band():
    assert roof_rgb(_window((0.25, 0.45, 0.2), n=100)) is None


def test_roof_rgb_keeps_a_roof_the_nir_band_says_is_not_vegetation():
    sample = roof_rgb(_window((0.25, 0.35, 0.2), n=100, nir=0.2))
    assert sample is not None


def test_roof_rgb_drops_shadowed_pixels():
    """Half a roof in a neighbour's shadow must not drag the colour dark."""
    lit = np.full((10, 20), 200, np.uint8)
    lit[:, 10:] = 40                       # right half shadowed
    arr = np.stack([lit, lit, lit])
    r, g, b, n = roof_rgb(arr)
    assert r > 0.7, "the shadowed half should have been dropped before the median"
    assert n == 100


def test_roof_rgb_keeps_a_uniformly_dark_roof():
    """A genuinely dark roof has no bright half to fall back on; it must not be rejected as shadow."""
    r, _, _, _ = roof_rgb(_window((0.16, 0.16, 0.16), n=100))
    assert r == pytest.approx(0.16, abs=0.01)


def test_roof_rgb_ignores_windows_without_three_bands():
    assert roof_rgb(np.zeros((2, 10, 10), np.uint8)) is None
    assert roof_rgb(None) is None


# --------------------------------------------------------------------- raster integration

def _write_ortho(path, colors_by_block, res=0.6, origin=(0.0, 100.0), blocks=(2, 1)):
    """A tiny 4-band ortho split left/right into flat colour blocks."""
    from rasterio.transform import from_origin

    cols, rows = 200, 100
    arr = np.zeros((4, rows, cols), np.uint8)
    for i, (rgb, nir) in enumerate(colors_by_block):
        x0 = i * cols // blocks[0]
        x1 = (i + 1) * cols // blocks[0]
        for band, value in enumerate(list(rgb) + [nir]):
            arr[band, :, x0:x1] = int(round(value * 255))
    with rasterio.open(path, "w", driver="GTiff", width=cols, height=rows, count=4, dtype="uint8",
                       crs=CRS_PROJ, transform=from_origin(origin[0], origin[1], res, res)) as ds:
        ds.write(arr)
    return path


def _square(cx, cy, half):
    return Polygon([(cx - half, cy - half), (cx + half, cy - half), (cx + half, cy + half), (cx - half, cy + half)])


def test_roof_colors_reads_the_raster_under_each_footprint(tmp_path, monkeypatch):
    monkeypatch.setenv("ISO_SERIAL", "1")       # keep the worker pool out of the test
    ortho = _write_ortho(tmp_path / "ortho.tif", [(_hex_rgb("#e8e6e0"), 0.30), (_hex_rgb("#3a3a38"), 0.28)])
    # raster spans x 0..120, y 40..100; the split is at x = 60
    b = gpd.GeoDataFrame(
        {"height": [8.0, 8.0]},
        geometry=[_square(30, 70, 10), _square(90, 70, 10)], crs=CRS_PROJ)
    assert roof_colors(b, ortho) == ["roof_flat", "roof_dark"]


def test_roof_colors_returns_none_for_a_footprint_off_the_raster(tmp_path, monkeypatch):
    monkeypatch.setenv("ISO_SERIAL", "1")
    ortho = _write_ortho(tmp_path / "ortho.tif", [(_hex_rgb("#e8e6e0"), 0.3), (_hex_rgb("#3a3a38"), 0.3)])
    b = gpd.GeoDataFrame({"height": [8.0]}, geometry=[_square(9000, 9000, 10)], crs=CRS_PROJ)
    assert roof_colors(b, ortho) == [None]


def test_a_tall_tower_on_a_thin_footprint_reports_nothing(tmp_path, monkeypatch):
    """The lean shrink eats the footprint rather than sampling the street beside a leaning tower."""
    monkeypatch.setenv("ISO_SERIAL", "1")
    ortho = _write_ortho(tmp_path / "ortho.tif", [(_hex_rgb("#e8e6e0"), 0.3), (_hex_rgb("#3a3a38"), 0.3)])
    b = gpd.GeoDataFrame({"height": [120.0]}, geometry=[_square(30, 70, 6)], crs=CRS_PROJ)
    assert roof_colors(b, ortho) == [None]


def test_roof_colors_with_no_raster_is_all_none():
    b = gpd.GeoDataFrame({"height": [8.0]}, geometry=[_square(30, 70, 10)], crs=CRS_PROJ)
    assert roof_colors(b, None) == [None]
    assert roof_colors(b, "/nonexistent/ortho.tif") == [None]


# --------------------------------------------------------------------- apply_roof_colors

def _frame(sources):
    return gpd.GeoDataFrame(
        {"height": [8.0] * len(sources),
         "roof_color": ["roof_red"] * len(sources),
         "roof_color_source": list(sources)},
        geometry=[_square(30 + 0.0 * i, 70, 10) for i in range(len(sources))], crs=CRS_PROJ)


def test_apply_roof_colors_replaces_only_the_guesses(tmp_path, monkeypatch):
    monkeypatch.setenv("ISO_SERIAL", "1")
    ortho = _write_ortho(tmp_path / "ortho.tif", [(_hex_rgb("#e8e6e0"), 0.3), (_hex_rgb("#3a3a38"), 0.3)])
    b = _frame(["heuristic", "osm"])
    assert apply_roof_colors(b, ortho) == 1
    assert list(b["roof_color"]) == ["roof_flat", "roof_red"], "a surveyed roof:colour outranks the photo"
    assert list(b["roof_color_source"]) == ["ortho", "osm"]


def test_apply_roof_colors_leaves_the_guess_when_the_imagery_is_unreadable(tmp_path, monkeypatch):
    monkeypatch.setenv("ISO_SERIAL", "1")
    ortho = _write_ortho(tmp_path / "ortho.tif", [(_hex_rgb("#3d6a2e"), 0.9), (_hex_rgb("#3d6a2e"), 0.9)])
    b = _frame(["heuristic"])
    assert apply_roof_colors(b, ortho) == 0
    assert list(b["roof_color"]) == ["roof_red"]
    assert list(b["roof_color_source"]) == ["heuristic"]


def test_apply_roof_colors_without_a_raster_is_a_no_op():
    b = _frame(["heuristic"])
    assert apply_roof_colors(b, None) == 0
    assert list(b["roof_color_source"]) == ["heuristic"]
