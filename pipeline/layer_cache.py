"""Per-step cache for the layer stage of build_tiles, plus the per-tile write state.

The layer stage is a list of steps (`layer_steps.STEPS`): the six base processors and the region
augmentations that run after them (city decks, the surveyed shoreline, canal banks, the tree merge, the
Honolulu coast). Each step is cached on its own, so an edit only recomputes the steps that read what
changed. A step's key covers:

  - the raw sources it declares,
  - the pipeline code it runs (see `deps.py`): the functions it calls, every top-level definition
    those functions reference in their own module, and the whole file of every other local module
    they reach, plus the step's glue and the same-module helpers that glue reaches,
  - the build options it reads, the region and the bbox,
  - the keys of the steps that produced the layers it reads.

Editing `assets/supplements/overrides.json` therefore recomputes `buildings` and the tree merge (which
reads buildings) and nothing else; editing the sidewalk code in `process.py` recomputes `roads` only.

The tile state (`tile_state_path`) remembers, per tile and layer, a digest of the features that fed the
last write, so the tiling loop can skip tiles whose content did not change. See `row_digests`.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from pandas.util import hash_pandas_object

from config import ROOT

CACHE_DIR = ROOT / "data" / "cache"
PIPELINE_DIR = Path(__file__).resolve().parent
STATE_VERSION = 2  # state-schema version; tile output code changes are fingerprinted automatically


def stat_entry(p: Path) -> list:
    st = p.stat()
    return [p.name, st.st_mtime_ns, st.st_size]


def make_key(parts: dict) -> str:
    blob = json.dumps(parts, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


# ---------------------------------------------------------------- step cache

def _dir_for(slug: str, step: str, key: str) -> Path:
    return CACHE_DIR / f"steps_{slug}" / f"{step}_{key}"


def _restore(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Undo parquet's list -> ndarray promotion so cached layers behave like freshly processed ones."""
    for col in gdf.columns:
        if col != gdf.geometry.name and gdf[col].dtype == object:
            if gdf[col].map(lambda v: isinstance(v, np.ndarray)).any():
                gdf[col] = gdf[col].map(lambda v: v.tolist() if isinstance(v, np.ndarray) else v)
    return gdf


def load_step(slug: str, step: str, key: str) -> tuple[dict[str, gpd.GeoDataFrame], dict] | None:
    """Cached (layers, extras) for one step, or None on a miss or an unreadable entry."""
    d = _dir_for(slug, step, key)
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


def store_step(slug: str, step: str, key: str, layers: dict[str, gpd.GeoDataFrame], extras: dict) -> None:
    d = _dir_for(slug, step, key)
    tmp = d.with_name(d.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for name, gdf in layers.items():
            gdf.to_parquet(tmp / f"{name}.parquet")
        (tmp / "meta.json").write_text(json.dumps({"layers": list(layers), "extras": extras}, indent=1))
    except Exception as exc:  # a cache write must never fail a build
        print(f"  [warn] could not write layer cache: {exc}")
        shutil.rmtree(tmp, ignore_errors=True)
        return
    shutil.rmtree(d, ignore_errors=True)
    tmp.rename(d)
    prune(slug, step, keep=key)


def prune(slug: str, step: str, keep: str, limit: int = 3) -> None:
    """Keep the newest few entries per step so switching branches stays fast without filling the disk."""
    entries = sorted((p for p in (CACHE_DIR / f"steps_{slug}").glob(f"{step}_*") if p.is_dir()),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for p in entries[limit:]:
        if not p.name.endswith(keep):
            shutil.rmtree(p, ignore_errors=True)


def clear() -> None:
    shutil.rmtree(CACHE_DIR, ignore_errors=True)


# ---------------------------------------------------------------- tile state

def tile_state_path(slug: str) -> Path:
    return CACHE_DIR / f"tiles_{slug}.json"


def load_tile_state(slug: str) -> dict:
    p = tile_state_path(slug)
    if not p.exists():
        return {}
    try:
        state = json.loads(p.read_text())
    except Exception as exc:
        print(f"  [warn] unreadable tile state {p.name}: {exc}")
        return {}
    return state.get("tiles", {}) if state.get("version") == STATE_VERSION else {}


def save_tile_state(slug: str, tiles: dict) -> None:
    p = tile_state_path(slug)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"version": STATE_VERSION, "tiles": tiles}, separators=(",", ":")))
    except Exception as exc:
        print(f"  [warn] could not write tile state: {exc}")


def _normalize(v):
    """Make a cell hash the same whether it came from a processor or from a parquet round-trip."""
    if isinstance(v, np.ndarray):
        v = v.tolist()
    if isinstance(v, (list, tuple, dict)):
        return json.dumps(v, sort_keys=True, default=str)
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def row_digests(gdf: gpd.GeoDataFrame) -> np.ndarray:
    """One uint64 per row over geometry (WKB) and every property, order-independent of the columns."""
    if len(gdf) == 0:
        return np.zeros(0, dtype=np.uint64)
    df = pd.DataFrame(gdf.drop(columns=gdf.geometry.name))
    df = df[sorted(df.columns)]
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].map(_normalize)
    df["__wkb"] = gdf.geometry.to_wkb()
    return hash_pandas_object(df, index=False).to_numpy(dtype=np.uint64)


def digest_rows(digests: np.ndarray, idx) -> str:
    """Order-independent digest of the rows `idx` selects; the same set of features -> the same digest."""
    sel = np.sort(np.asarray(digests, dtype=np.uint64)[np.asarray(idx, dtype=np.intp)])
    return hashlib.sha1(sel.tobytes()).hexdigest()[:16]
