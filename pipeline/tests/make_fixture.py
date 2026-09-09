"""Build a tiny raw-data fixture around the Capitol for the integration test.

Run once (not part of pytest -- it needs the full raw data under data/raw/, which is
gitignored and too large for CI): `.venv/bin/python pipeline/tests/make_fixture.py`

Clips the existing raw OSM / Overture / Richmond parquet files and the DEM to a ~300 m
box centered on the Virginia State Capitol, keeping only the tag columns process.py
actually reads, and writes the results under pipeline/tests/fixtures/.
"""
from __future__ import annotations

import sys
from pathlib import Path

import geopandas as gpd
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import box

PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from config import CRS_PROJ, DATA_RAW, bbox_slug, DEFAULT_BBOX  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# ~300 m box around the Capitol, in WGS84 lon/lat.
CAPITOL_LON, CAPITOL_LAT = -77.4340, 37.5388
DELTA = 0.0015
CLIP_WGS84 = box(CAPITOL_LON - DELTA, CAPITOL_LAT - DELTA, CAPITOL_LON + DELTA, CAPITOL_LAT + DELTA)

# Tag columns process.py reads (plus id/element/geometry, kept separately) -- see CLAUDE.md
# and the property dicts built in process_buildings / process_roads / process_rail /
# process_landuse / process_water / process_pois.
KEEP_TAGS = {
    "building", "building:levels", "height", "roof:shape", "roof:colour", "building:colour",
    "building:material", "name", "wikidata", "website", "contact:website", "min_height",
    "building:min_level", "highway", "lanes", "oneway", "surface", "sidewalk", "bridge",
    "tunnel", "layer", "railway", "landuse", "leisure", "amenity", "natural", "place",
    "water", "waterway", "shop", "tourism", "historic", "crossing", "area",
    "roof:levels", "roof:height",
}
ALWAYS_KEEP = {"element", "id", "geometry"}


def _keep_cols(gdf: gpd.GeoDataFrame) -> list[str]:
    cols = [c for c in gdf.columns if c in KEEP_TAGS or c in ALWAYS_KEEP or c.startswith("addr:")]
    return cols


def clip_osm_layer(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"  [skip] {src} missing")
        return 0
    g = gpd.read_parquet(src)
    if len(g):
        g = gpd.clip(g, CLIP_WGS84)
    g = g[_keep_cols(g)]
    dst.parent.mkdir(parents=True, exist_ok=True)
    g.to_parquet(dst)
    print(f"  {dst.relative_to(FIXTURES)}: {len(g)} features, {dst.stat().st_size} bytes")
    return len(g)


def clip_overture(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"  [skip] {src} missing")
        return 0
    g = gpd.read_parquet(src, columns=["id", "height", "num_floors", "roof_shape", "roof_height", "geometry"])
    if len(g):
        g = gpd.clip(g, CLIP_WGS84)
    dst.parent.mkdir(parents=True, exist_ok=True)
    g.to_parquet(dst)
    print(f"  {dst.relative_to(FIXTURES)}: {len(g)} features, {dst.stat().st_size} bytes")
    return len(g)


def clip_richmond_addresses(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"  [skip] {src} missing")
        return 0
    g = gpd.read_parquet(src, columns=["AddressLabel", "AddressId", "geometry"])
    if len(g):
        g = gpd.clip(g, CLIP_WGS84)
    dst.parent.mkdir(parents=True, exist_ok=True)
    g.to_parquet(dst)
    print(f"  {dst.relative_to(FIXTURES)}: {len(g)} features, {dst.stat().st_size} bytes")
    return len(g)


def clip_richmond_zoning(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"  [skip] {src} missing")
        return 0
    g = gpd.read_parquet(src, columns=["Name", "geometry"])
    if len(g):
        g = gpd.clip(g, CLIP_WGS84)
    dst.parent.mkdir(parents=True, exist_ok=True)
    g.to_parquet(dst)
    print(f"  {dst.relative_to(FIXTURES)}: {len(g)} features, {dst.stat().st_size} bytes")
    return len(g)


def clip_dem(src: Path, dst: Path) -> None:
    if not src.exists():
        print(f"  [skip] {src} missing")
        return
    with rasterio.open(src) as ds:
        # box is WGS84; reproject the clip box corners to the DEM's CRS (EPSG:32618).
        from pyproj import Transformer

        tr = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)
        minx, miny, maxx, maxy = CLIP_WGS84.bounds
        xs, ys = zip(*[tr.transform(x, y) for x, y in ((minx, miny), (maxx, maxy))])
        win = from_bounds(min(xs), min(ys), max(xs), max(ys), ds.transform)
        win = win.round_offsets().round_lengths()
        data = ds.read(window=win)
        transform = ds.window_transform(win)
        profile = ds.profile.copy()
        profile.update(height=data.shape[1], width=data.shape[2], transform=transform)
        dst.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(dst, "w", **profile) as out:
            out.write(data)
    print(f"  {dst.relative_to(FIXTURES)}: {dst.stat().st_size} bytes")


def main() -> None:
    slug = bbox_slug(DEFAULT_BBOX)
    raw_osm = DATA_RAW / f"osm_{slug}"
    print("clipping OSM layers...")
    for layer in ("buildings", "roads", "rail", "landuse", "water", "pois"):
        clip_osm_layer(raw_osm / f"{layer}.parquet", FIXTURES / "osm" / f"{layer}.parquet")
    print("clipping Overture...")
    clip_overture(DATA_RAW / f"overture_{slug}.parquet", FIXTURES / "overture.parquet")
    print("clipping Richmond open data...")
    rva = DATA_RAW / f"richmond_{slug}"
    clip_richmond_addresses(rva / "addresses.parquet", FIXTURES / "richmond" / "addresses.parquet")
    clip_richmond_zoning(rva / "zoning.parquet", FIXTURES / "richmond" / "zoning.parquet")
    print("clipping DEM...")
    clip_dem(DATA_RAW / f"dem_{slug}.tif", FIXTURES / "dem.tif")
    total = sum(p.stat().st_size for p in FIXTURES.rglob("*") if p.is_file())
    print(f"fixture total: {total} bytes ({total / 1e6:.3f} MB)")


if __name__ == "__main__":
    main()
