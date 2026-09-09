"""Stylized masonry along mapped downtown canals; geometry precedes tile clipping."""
import math
import geopandas as gpd
from shapely.geometry import box
from config import CRS_PROJ


def canal_banks(water):
    corridor = gpd.GeoSeries([box(-77.451, 37.530, -77.427, 37.539)], crs="EPSG:4326").to_crs(CRS_PROJ).iloc[0]
    rows = []
    for _, f in water.iterrows():
        name = str(f.get("name") or "")
        if f.kind != "canal" or not any(n in name for n in ("Haxall", "Kanawha")) or "Dry" in name or not f.geometry.intersects(corridor):
            continue
        z = f.get("water_z")
        if z is None or not math.isfinite(float(z)):
            continue
        # A modest illustrative coping, not a surveyed retaining-wall height.
        band = f.geometry.buffer(0.65).difference(f.geometry).intersection(corridor)
        if band.is_empty:
            continue
        rows.append(dict(id=f"bank:{f.id}", name=name + " canal bank", kind="canal_bank",
                         source="osm_stylized", base_z=float(z) - 0.4, top_z=float(z) + 0.65, geometry=band))
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_PROJ) if rows else gpd.GeoDataFrame(geometry=[], crs=CRS_PROJ)
