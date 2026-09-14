"""The layer stage as an explicit list of steps, each cached on its own key.

A step declares what it produces, which layers it reads, which functions it runs and which raw files it
depends on. `run_steps` walks the list in order, computes each step's key (`layer_cache` docstring), and
either loads the step's output from the cache or runs it. Augmentations (city decks, the surveyed
shoreline, canal banks, the tree merge, the Honolulu coast) are steps like any other, so every layer that
reaches the tiling loop is complete: there is no such thing as a half-augmented partial rebuild any more.

Adding a layer or an augmentation means appending a `Step` here (and, for a new layer, registering it in
`schema.LAYER_KEYS`, `DATA_FORMAT.md` and the viewer's `tileBuild.ts`).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import geopandas as gpd
import pandas as pd

import deps
import layer_cache
from config import ASSETS, CRS_PROJ, DATA_RAW, REGION, ROOT

LAYER_ORDER = ["buildings", "roads", "crossings", "rail", "landuse", "water", "pois"]


@dataclass
class StepContext:
    region: str
    bbox: tuple
    slug: str
    raw_dir: Path
    dem_path: Path
    terrain: object | None
    hydro: object | None
    merge_rowhouses: bool = True
    no_cache: bool = False
    # outputs the cache does not carry
    beach_profile: tuple | None = None

    def richmond(self, name: str) -> Path:
        return DATA_RAW / f"richmond_{self.slug}" / name


@dataclass
class Step:
    name: str
    produces: tuple[str, ...]
    run: Callable[[StepContext, dict], dict | tuple[dict, dict]]
    entries: tuple = ()                      # functions whose code the step runs (analysed by deps.py)
    modules: tuple[str, ...] = ()            # whole local modules the step depends on beyond `entries`
    reads: tuple[str, ...] = ()              # layers read from earlier steps
    sources: Callable[[StepContext], list[Path]] = lambda ctx: []
    options: tuple[str, ...] = ()            # StepContext fields that change the result
    regions: tuple[str, ...] | None = None   # None = every region
    cache: bool = True

    def key(self, ctx: StepContext, upstream: dict[str, str]) -> str:
        parts = {
            "region": ctx.region,
            "bbox": [round(v, 6) for v in ctx.bbox],
            "options": {o: getattr(ctx, o) for o in self.options},
            "sources": [layer_cache.stat_entry(p) for p in self.sources(ctx) if p.exists()],
            "code": deps.code_fingerprint(self.entries, self.modules),
            "glue": deps.source_of(self.run),
            "reads": {layer: upstream.get(layer) for layer in self.reads},
        }
        return layer_cache.make_key(parts)


def _concat(a: gpd.GeoDataFrame, b: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(pd.concat([a, b], ignore_index=True), crs=CRS_PROJ)


# ---------------------------------------------------------------- base processors

def _buildings(ctx: StepContext, layers: dict):
    from process import process_buildings
    buildings_path = ctx.raw_dir / "buildings.parquet"
    if ctx.region == "honolulu":
        import sys
        from honolulu import enrich_buildings
        city_path = DATA_RAW / f"cch_{ctx.slug}.parquet"
        if not city_path.exists():
            sys.exit("CCH data missing: run pipeline/fetch_honolulu.py with ISO_REGION=honolulu first")
        enriched = enrich_buildings(gpd.read_parquet(city_path), gpd.read_parquet(buildings_path))
        buildings_path = DATA_RAW / f"enriched_buildings_{ctx.slug}.parquet"
        enriched.to_parquet(buildings_path)
    return {"buildings": process_buildings(
        buildings_path, ctx.terrain, ctx.merge_rowhouses,
        overture_path=DATA_RAW / f"overture_{ctx.slug}.parquet",
        lidar_npz=DATA_RAW / f"lidar_{ctx.slug}.npz",
        richmond_dir=DATA_RAW / f"richmond_{ctx.slug}",
        richmond_structures_path=ctx.richmond("structures.parquet"),
        vgin_path=DATA_RAW / f"vgin_{ctx.slug}.parquet")}


def _buildings_sources(ctx: StepContext) -> list[Path]:
    paths = [ctx.raw_dir / "buildings.parquet", ctx.dem_path,
             DATA_RAW / f"overture_{ctx.slug}.parquet", DATA_RAW / f"lidar_{ctx.slug}.npz",
             DATA_RAW / "ndsm.tif", DATA_RAW / f"vgin_{ctx.slug}.parquet", DATA_RAW / f"cch_{ctx.slug}.parquet",
             ASSETS / "supplements" / "overrides.json", ASSETS / "landmarks" / "landmarks.json"]
    paths += sorted((DATA_RAW / f"richmond_{ctx.slug}").glob("*.parquet"))
    return paths


def _roads(ctx: StepContext, layers: dict):
    from process import process_roads
    roads, crossings = process_roads(ctx.raw_dir / "roads.parquet", ctx.terrain)
    return {"roads": roads, "crossings": crossings}


def _rail(ctx: StepContext, layers: dict):
    from process import process_rail
    return {"rail": process_rail(ctx.raw_dir / "rail.parquet", ctx.terrain)}


def _landuse(ctx: StepContext, layers: dict):
    from process import process_landuse
    return {"landuse": process_landuse(ctx.raw_dir / "landuse.parquet")}


def _water(ctx: StepContext, layers: dict):
    from process import process_water
    return {"water": process_water(ctx.raw_dir / "water.parquet", ctx.terrain)}


def _pois(ctx: StepContext, layers: dict):
    from process import process_pois
    return {"pois": process_pois(ctx.raw_dir / "pois.parquet")}


# ---------------------------------------------------------------- Richmond augmentations

def _city_decks(ctx: StepContext, layers: dict):
    from process import process_richmond_decks
    decks = process_richmond_decks(ctx.richmond("structures.parquet"))
    return {"landuse": _concat(layers["landuse"], decks) if len(decks) else layers["landuse"]}


def _hydro_shoreline(ctx: StepContext, layers: dict):
    """Surveyed river polygons replace OSM water; land must stop at that shoreline, island holes included."""
    if ctx.hydro is None:
        return {}
    from hydro import merge_water
    landuse = layers["landuse"].copy()
    landuse.geometry = landuse.geometry.difference(ctx.hydro.mask)
    return {"water": merge_water(layers["water"], ctx.hydro), "landuse": landuse}


def _canal_banks(ctx: StepContext, layers: dict):
    from riverfront import canal_banks
    banks = canal_banks(layers["water"])
    return {"landuse": _concat(layers["landuse"], banks) if len(banks) else layers["landuse"]}


def _trees(ctx: StepContext, layers: dict):
    inventory_path = ctx.richmond("trees.parquet")
    if not inventory_path.exists():
        return {}, {"surveyed_trees": False}
    from vegetation import inventory_trees, lidar_canopies, merge_trees
    inventory = inventory_trees(gpd.read_parquet(inventory_path))
    crowns = gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
    lidar_path = DATA_RAW / f"lidar_{ctx.slug}.npz"
    if lidar_path.exists() and ctx.terrain:
        # The crown extraction has its own mtime cache beside the source; this step's key covers its inputs.
        crown_path = DATA_RAW / f"canopies_{ctx.slug}.parquet"
        inputs = [lidar_path, ctx.dem_path, Path(__file__).with_name("vegetation.py")]
        if crown_path.exists() and crown_path.stat().st_mtime > max(p.stat().st_mtime for p in inputs):
            crowns = gpd.read_parquet(crown_path)
        else:
            crowns = lidar_canopies(lidar_path, ctx.terrain)
            crowns.to_parquet(crown_path)
    pois = merge_trees(layers["pois"], inventory, crowns, layers["buildings"], layers["water"])
    print(f"  vegetation: {len(inventory)} active inventory trees, {len(crowns)} LiDAR crowns")
    return {"pois": pois}, {"surveyed_trees": len(crowns) > 0}


# ---------------------------------------------------------------- Honolulu augmentation

def _coast(ctx: StepContext, layers: dict):
    """Ocean, beach profile and coastal structures. Not cached: the beach profile is live geometry."""
    from honolulu import ocean_layer, coastal_green_spaces, coastal_structures
    base = ctx.terrain.base if ctx.terrain else 0.0
    coast = gpd.read_parquet(DATA_RAW / f"coast_{ctx.slug}.parquet")
    ocean = ocean_layer(coast, ctx.bbox, base, coast_is_water=True)
    landuse = layers["landuse"]
    beaches = landuse[landuse.kind == "beach"]
    if len(beaches) and len(ocean):
        ctx.beach_profile = (beaches.geometry.union_all(), ocean.geometry.union_all(), float(ocean.iloc[0].water_z))
    landuse = coastal_green_spaces(landuse, ocean)
    structure_sources = []
    structures_path = ctx.raw_dir / "coastal_structures.parquet"
    if structures_path.exists():
        structure_sources.append(gpd.read_parquet(structures_path).to_crs(CRS_PROJ))
    supplement = ROOT / "assets/supplements/honolulu-coastal.geojson"
    if supplement.exists():
        structure_sources.append(gpd.read_file(supplement).to_crs(CRS_PROJ))
    if structure_sources:
        structures = coastal_structures(gpd.GeoDataFrame(pd.concat(structure_sources, ignore_index=True), crs=CRS_PROJ), base)
        landuse = _concat(landuse, structures)
    return {"landuse": landuse, "water": _concat(layers["water"], ocean)}


def steps_for(region: str) -> list[Step]:
    import process
    import hydro
    import riverfront
    import vegetation
    steps = [
        Step("buildings", ("buildings",), _buildings, entries=(process.process_buildings,), modules=("terrain",),
             sources=_buildings_sources, options=("merge_rowhouses",)),
        Step("roads", ("roads", "crossings"), _roads, entries=(process.process_roads,), modules=("terrain",),
             sources=lambda c: [c.raw_dir / "roads.parquet", c.dem_path]),
        Step("rail", ("rail",), _rail, entries=(process.process_rail,), modules=("terrain",),
             sources=lambda c: [c.raw_dir / "rail.parquet", c.dem_path]),
        Step("landuse", ("landuse",), _landuse, entries=(process.process_landuse,),
             sources=lambda c: [c.raw_dir / "landuse.parquet"]),
        Step("water", ("water",), _water, entries=(process.process_water,), modules=("terrain",),
             sources=lambda c: [c.raw_dir / "water.parquet", c.dem_path]),
        Step("pois", ("pois",), _pois, entries=(process.process_pois,),
             sources=lambda c: [c.raw_dir / "pois.parquet"]),
        Step("city_decks", ("landuse",), _city_decks, entries=(process.process_richmond_decks,), reads=("landuse",),
             sources=lambda c: [c.richmond("structures.parquet")], regions=("richmond",)),
        Step("hydro_shoreline", ("water", "landuse"), _hydro_shoreline, entries=(hydro.merge_water, hydro.load_hydro),
             reads=("water", "landuse"), sources=lambda c: [DATA_RAW / "richmond_hydro_2025.gpkg", c.dem_path],
             regions=("richmond",)),
        Step("canal_banks", ("landuse",), _canal_banks, entries=(riverfront.canal_banks,), reads=("landuse", "water"),
             regions=("richmond",)),
        Step("trees", ("pois",), _trees, entries=(vegetation.inventory_trees, vegetation.lidar_canopies, vegetation.merge_trees),
             modules=("terrain",), reads=("pois", "buildings", "water"),
             sources=lambda c: [c.richmond("trees.parquet"), DATA_RAW / f"lidar_{c.slug}.npz", c.dem_path],
             regions=("richmond",)),
    ]
    if region == "honolulu":
        import honolulu
        steps[0] = Step("buildings", ("buildings",), _buildings,
                        entries=(process.process_buildings, honolulu.enrich_buildings), modules=("terrain",),
                        sources=_buildings_sources, options=("merge_rowhouses",))
        steps.append(Step("coast", ("landuse", "water"), _coast,
                          entries=(honolulu.ocean_layer, honolulu.coastal_green_spaces, honolulu.coastal_structures),
                          modules=("terrain",), reads=("landuse", "water"),
                          sources=lambda c: [DATA_RAW / f"coast_{c.slug}.parquet", c.raw_dir / "coastal_structures.parquet",
                                             ROOT / "assets/supplements/honolulu-coastal.geojson"],
                          regions=("honolulu",), cache=False))
    return [s for s in steps if s.regions is None or region in s.regions]


def run_steps(ctx: StepContext, steps: list[Step] | None = None) -> tuple[dict, dict, list[dict]]:
    """Run (or load) every step for the region. Returns (layers, extras, report)."""
    steps = steps_for(ctx.region) if steps is None else steps
    layers: dict[str, gpd.GeoDataFrame] = {}
    extras: dict = {}
    producer: dict[str, str] = {}   # layer -> key of the step that last wrote it
    report = []
    for step in steps:
        missing = [l for l in step.reads if l not in layers]
        if missing:
            raise RuntimeError(f"step {step.name} reads {missing} before any step produced them")
        t0 = time.time()
        key = step.key(ctx, producer)
        cached = None
        if step.cache and not ctx.no_cache:
            cached = layer_cache.load_step(ctx.slug, step.name, key)
        if cached is not None:
            out, step_extras = cached
            how = "cached"
        else:
            result = step.run(ctx, layers)
            out, step_extras = result if isinstance(result, tuple) else (result, {})
            unexpected = set(out) - set(step.produces)
            if unexpected:
                raise RuntimeError(f"step {step.name} wrote {sorted(unexpected)} but declares {step.produces}")
            if step.cache and not ctx.no_cache:
                layer_cache.store_step(ctx.slug, step.name, key, out, step_extras)
            how = "processed"
        for name, gdf in out.items():
            layers[name] = gdf
            producer[name] = key
        extras.update(step_extras)
        dt = time.time() - t0
        report.append({"step": step.name, "how": how, "seconds": round(dt, 1), "key": key})
        print(f"  step {step.name:16s} {how:9s} {dt:6.1f}s")
    # index.json lists each tile's layers in this order; keep it stable across regions and cache states
    ordered = {name: layers[name] for name in LAYER_ORDER if name in layers}
    ordered.update({name: gdf for name, gdf in layers.items() if name not in ordered})
    return ordered, extras, report
