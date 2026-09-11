"""Fingerprinted cache for the processed layer stage of build_tiles.

The layer stage (buildings/roads/water/... plus the Richmond vegetation and hydro passes) is the slow
part of a build; the tiling loop after it is not. When only the tiling, terrain, QA or viewer side is
being iterated on, the layers are unchanged and can be read back from GeoParquet instead of recomputed.

The key covers every raw source the stage reads, the pipeline modules that implement it, and the build
options — so a new LiDAR, hydro or city download, or an edited `process.py`, cannot silently survive.
Drivers that only consume finished layers (`build_tiles`, `qa_report`, `tiles_inspect`, the fetchers)
are excluded, since editing those is exactly the case the cache exists to make fast.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import geopandas as gpd

from config import CRS_PROJ, DATA_RAW, REGION

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "cache"
PIPELINE_DIR = Path(__file__).resolve().parent
# Modules that only read finished layers, or that produce raw files already covered by their own mtimes.
NON_LAYER_MODULES = {"build_tiles.py", "qa_report.py", "tiles_inspect.py", "layer_cache.py", "dem_noaa.py"}


def _stat(p: Path) -> list:
    st = p.stat()
    return [p.name, st.st_mtime_ns, st.st_size]


def _source_files(slug: str, raw_dir: Path) -> list[Path]:
    """Every raw input the layer stage may read, whether or not it currently exists."""
    root = Path(__file__).resolve().parents[1]
    paths = sorted(raw_dir.glob("*.parquet"))
    paths += [DATA_RAW / f"overture_{slug}.parquet", DATA_RAW / f"lidar_{slug}.npz",
              DATA_RAW / f"vgin_{slug}.parquet", DATA_RAW / f"dem_{slug}.tif", DATA_RAW / "ndsm.tif",
              DATA_RAW / f"canopies_{slug}.parquet", DATA_RAW / "richmond_hydro_2025.gpkg",
              DATA_RAW / f"coast_{slug}.parquet", DATA_RAW / f"cch_{slug}.parquet"]
    paths += sorted((DATA_RAW / f"richmond_{slug}").glob("*.parquet"))
    paths += sorted((root / "assets" / "supplements").glob("*.json"))
    paths += sorted((root / "assets" / "supplements").glob("*.geojson"))
    return [p for p in paths if p.exists()]


def _impl_files() -> list[Path]:
    return sorted(p for p in PIPELINE_DIR.glob("*.py")
                  if p.name not in NON_LAYER_MODULES and not p.name.startswith("fetch"))


def fingerprint(slug: str, raw_dir: Path, options: dict) -> str:
    parts = {
        "region": REGION,
        "options": options,
        "sources": [_stat(p) for p in _source_files(slug, raw_dir)],
        "impl": [_stat(p) for p in _impl_files()],
    }
    blob = json.dumps(parts, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


def _dir_for(slug: str, key: str) -> Path:
    return CACHE_DIR / f"layers_{slug}_{key}"


def _restore(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Undo parquet's list -> ndarray promotion so cached layers behave like freshly processed ones."""
    import numpy as np

    for col in gdf.columns:
        if col != gdf.geometry.name and gdf[col].dtype == object:
            if gdf[col].map(lambda v: isinstance(v, np.ndarray)).any():
                gdf[col] = gdf[col].map(lambda v: v.tolist() if isinstance(v, np.ndarray) else v)
    return gdf


def load(slug: str, key: str) -> tuple[dict[str, gpd.GeoDataFrame], dict] | None:
    """Cached (layers, extras), or None on a miss or an unreadable entry."""
    d = _dir_for(slug, key)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text())
        layers = {name: _restore(gpd.read_parquet(d / f"{name}.parquet")) for name in meta["layers"]}
    except Exception as exc:
        print(f"  [warn] unreadable layer cache {d.name}: {exc}")
        return None
    return layers, meta.get("extras", {})


def store(slug: str, key: str, layers: dict[str, gpd.GeoDataFrame], extras: dict) -> None:
    d = _dir_for(slug, key)
    tmp = d.with_name(d.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for name, gdf in layers.items():
            gdf.to_parquet(tmp / f"{name}.parquet")
        # insertion order is preserved: it decides the order of each tile's "layers" list in index.json
        (tmp / "meta.json").write_text(json.dumps({"layers": list(layers), "extras": extras}, indent=1))
    except Exception as exc:  # a cache write must never fail a build
        print(f"  [warn] could not write layer cache: {exc}")
        shutil.rmtree(tmp, ignore_errors=True)
        return
    shutil.rmtree(d, ignore_errors=True)
    tmp.rename(d)
    prune(slug, keep=key)


def prune(slug: str, keep: str, limit: int = 3) -> None:
    """Keep the newest few entries for this region so switching branches stays fast without filling the disk."""
    entries = sorted((p for p in CACHE_DIR.glob(f"layers_{slug}_*") if p.is_dir()),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for p in entries[limit:]:
        if not p.name.endswith(keep):
            shutil.rmtree(p, ignore_errors=True)


def clear() -> None:
    shutil.rmtree(CACHE_DIR, ignore_errors=True)
