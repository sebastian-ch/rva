"""Roof colour from aerial orthoimagery.

`pipeline/fetch_naip.py` writes `data/raw/ortho_<slug>.tif` (NAIP, 0.6 m, working CRS, uint8, RGB or
RGB+NIR). This module turns it into one palette key per footprint, so a roof reads as the material it
is -- light membrane, asphalt shingle, red tile, copper -- instead of the seeded guess that
`heights.resolve_colors` falls back to when OSM has no `roof:colour` (which is nearly always).

Three things make a nadir photo hard to read on a roof, and each has an explicit answer here:

  * **Lean.** NAIP is orthorectified against bare earth, so a roof sits displaced radially from nadir
    by roughly `height * tan(off-nadir)`. Shrinking the footprint by that displacement leaves a core
    that is inside the roof wherever the roof actually landed. Buildings too small or too thin to
    survive the shrink yield nothing, which is the right failure: those are exactly the ones the
    displacement carries clean off their own footprint. `LEAN_FRAC` is an estimate of the typical
    angle over a frame, not a per-pixel solution -- see `docs/ortho-roof-colour.md`.
  * **Trees.** A crown over a roof is greener than any roof. NDVI decides when band 4 is present,
    excess green otherwise; vegetation pixels are dropped and a mostly-vegetated footprint returns
    nothing rather than the colour of a tree.
  * **Shadow.** Neighbours put part of a roof in shade, which drags the median dark. Pixels well
    below the footprint's own median luminance are dropped once.

What survives is classified in CIE L*a*b* by lightness and chroma, not by nearest-neighbour against
the stylized palette: a photograph of Richmond is nowhere near `palette.json`'s saturation, so hue
picks the coloured keys and lightness walks a neutral ladder. Anything undecidable returns None and
the caller keeps the colour it already had. "I do not know" is the important output here -- a wrong
confident colour is worse than the seeded guess, because it looks surveyed.
"""
from __future__ import annotations

import math
from pathlib import Path

import geopandas as gpd
import numpy as np

from lidar import _workers

# ---------------------------------------------------------------- sampling geometry

BASE_SHRINK_M = 1.0    # eaves, parapets, and the edge pixel that straddles the wall
LEAN_FRAC = 0.12       # roof displacement per metre of height (~7 deg off-nadir); estimated, see module docstring
MAX_SHRINK_M = 25.0
MIN_CORE_AREA_M2 = 2.0
MIN_PIXELS = 12        # at 0.6 m that is ~4 m2 of roof

# ---------------------------------------------------------------- pixel rejection

VEG_NDVI = 0.15        # (nir - red) / (nir + red) above this is a crown, not a roof
VEG_EXG = 0.08         # excess green (2g - r - b) when the ortho has no NIR band
MAX_VEG_FRAC = 0.5     # a footprint this vegetated is under a tree; report nothing
SHADOW_REL = 0.55      # drop pixels darker than this share of the footprint's median luminance

# ---------------------------------------------------------------- classification

CHROMA_MIN = 12.0        # C* below this is a grey roof with a colour cast, not a coloured roof
BLUE_CHROMA_MIN = 8.0    # blue needs less: no roof material is accidentally blue, shade aside
RED_HUE = (10.0, 75.0)   # tile, red shingle, rusted metal
GREEN_HUE = (100.0, 190.0)
BLUE_HUE = (200.0, 290.0)
LIGHT_L = 62.0           # white membrane, light gravel ballast
MID_L = 40.0             # weathered concrete, light grey metal
DARK_WARM_L = 35.0       # dark brown shingle reads as brick_dark, not as red tile
STRONG_CHROMA = 22.0


def shrink_for(height_m: float) -> float:
    """Inward buffer that keeps the sample inside the roof despite orthorectification lean."""
    return min(MAX_SHRINK_M, BASE_SHRINK_M + LEAN_FRAC * max(0.0, float(height_m)))


def srgb_to_lab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """CIE L*a*b* (D65, 2 deg) for an sRGB triple on 0..1."""
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047
    y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def classify_roof_tone(rgb: tuple[float, float, float]) -> str:
    """Palette key for a sampled roof colour (sRGB on 0..1). Always answers; the caller decides
    whether the sample was trustworthy enough to ask."""
    L, a, b = srgb_to_lab(rgb)
    chroma = math.hypot(a, b)
    hue = math.degrees(math.atan2(b, a)) % 360.0
    if chroma >= CHROMA_MIN:
        if RED_HUE[0] <= hue < RED_HUE[1]:
            if L >= LIGHT_L:
                return "roof_flat"          # pale sand-coloured ballast, not a tile roof
            if L < DARK_WARM_L and chroma < STRONG_CHROMA:
                return "brick_dark"         # brown asphalt shingle
            return "roof_red"
        if GREEN_HUE[0] <= hue < GREEN_HUE[1]:
            return "roof_green"
    if chroma >= BLUE_CHROMA_MIN and BLUE_HUE[0] <= hue < BLUE_HUE[1]:
        return "slate"
    if L >= LIGHT_L:
        return "roof_flat"
    if L >= MID_L:
        return "concrete"
    return "roof_dark"


def _vegetation_mask(rgb: np.ndarray, nir: np.ndarray | None) -> np.ndarray:
    """Per-pixel vegetation flag for (3, n) sRGB on 0..1 and an optional NIR band."""
    if nir is not None:
        denom = nir + rgb[0]
        ndvi = np.divide(nir - rgb[0], denom, out=np.zeros_like(denom), where=denom > 1e-6)
        return ndvi > VEG_NDVI
    return (2.0 * rgb[1] - rgb[0] - rgb[2]) > VEG_EXG


def roof_rgb(window) -> tuple[float, float, float, int] | None:
    """Median roof colour of a masked (bands, rows, cols) raster window, as (r, g, b, n_pixels) on
    0..1, or None when the window is too small, too vegetated or otherwise unreadable."""
    if window is None or len(getattr(window, "shape", ())) != 3 or window.shape[0] < 3:
        return None
    data = np.ma.getdata(window)
    if np.ma.isMaskedArray(window):
        valid = ~np.ma.getmaskarray(window).any(axis=0)
    else:
        valid = np.ones(window.shape[1:], bool)
    px = data[:, valid].astype(np.float64)
    if px.shape[1] < MIN_PIXELS:
        return None
    if np.issubdtype(data.dtype, np.integer):
        px /= float(np.iinfo(data.dtype).max)
    px = np.clip(px, 0.0, 1.0)

    rgb, nir = px[:3], px[3] if px.shape[0] >= 4 else None
    veg = _vegetation_mask(rgb, nir)
    if float(veg.mean()) > MAX_VEG_FRAC:
        return None
    rgb = rgb[:, ~veg]
    if rgb.shape[1] < MIN_PIXELS:
        return None

    luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    lit = luma >= SHADOW_REL * float(np.median(luma))
    if int(lit.sum()) >= MIN_PIXELS:
        rgb = rgb[:, lit]
    return float(np.median(rgb[0])), float(np.median(rgb[1])), float(np.median(rgb[2])), int(rgb.shape[1])


def _roof_chunk(args):
    """Worker: (index, palette key) for one slice of footprints."""
    ortho_path, wkbs, heights, offset = args
    import rasterio
    from rasterio.mask import mask as rio_mask
    from shapely import wkb as shapely_wkb

    out = []
    with rasterio.open(ortho_path) as ds:
        for i, (raw, h) in enumerate(zip(wkbs, heights)):
            if raw is None:
                continue
            g = shapely_wkb.loads(raw)
            if g is None or g.is_empty:
                continue
            core = g.buffer(-shrink_for(h))
            if core.is_empty or core.area < MIN_CORE_AREA_M2:
                continue
            try:
                window, _ = rio_mask(ds, [core.__geo_interface__], crop=True, filled=False, all_touched=False)
            except ValueError:      # footprint outside the raster
                continue
            sample = roof_rgb(window)
            if sample is not None:
                out.append((offset + i, classify_roof_tone(sample[:3])))
    return out


def roof_colors(buildings: gpd.GeoDataFrame, ortho_path: Path | None,
                heights: np.ndarray | None = None) -> list[str | None]:
    """Palette key per footprint from the ortho, aligned to `buildings`; None where unreadable."""
    n = len(buildings)
    out: list[str | None] = [None] * n
    if ortho_path is None or not Path(ortho_path).exists() or n == 0:
        return out
    if heights is None:
        heights = buildings["height"].to_numpy(dtype=float) if "height" in buildings else np.zeros(n)
    heights = np.nan_to_num(np.asarray(heights, dtype=float))

    wkbs = [g.wkb if g is not None else None for g in buildings.geometry]
    nproc = _workers(n, 500)
    chunk = (n + nproc - 1) // nproc
    jobs = [(str(ortho_path), wkbs[s:s + chunk], heights[s:s + chunk], s) for s in range(0, n, chunk)]
    results = None
    if nproc > 1:
        from concurrent.futures import BrokenExecutor, ProcessPoolExecutor
        try:
            with ProcessPoolExecutor(max_workers=nproc) as ex:
                results = list(ex.map(_roof_chunk, jobs))
        except BrokenExecutor:      # e.g. a caller with no __main__ guard under spawn
            print("  [warn] ortho worker pool unavailable; sampling serially")
            results = None
    if results is None:
        results = [_roof_chunk(j) for j in jobs]
    for part in results:
        for i, key in part:
            out[i] = key
    return out


def apply_roof_colors(b: gpd.GeoDataFrame, ortho_path: Path | None) -> int:
    """Replace heuristic roof colours in place with the orthoimagery classification.

    Only rows whose colour is still a guess are touched: an OSM `roof:colour` is surveyed evidence and
    outranks a photograph, and overrides are applied later still. Returns the number of rows changed.
    """
    if ortho_path is None or len(b) == 0 or "roof_color_source" not in b:
        return 0
    targets = b.index[b["roof_color_source"] == "heuristic"]
    if len(targets) == 0:
        return 0
    keys = roof_colors(b.loc[targets], ortho_path)
    changed = 0
    for idx, key in zip(targets, keys):
        if key is None:
            continue
        b.at[idx, "roof_color"] = key
        b.at[idx, "roof_color_source"] = "ortho"
        changed += 1
    if changed:
        print(f"  ortho roof colours: {changed}/{len(targets)} heuristic roofs classified from imagery")
    return changed
