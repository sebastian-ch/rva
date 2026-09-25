"""City of Richmond streetlight and pole surveys -> surveyed lamp and utility-pole POIs.

The city publishes two GNSS surveys: luminaires (fixture type, lamp use) and poles (material, height, owner).
A luminaire fix sits within ~0.7 m of its pole for most records, so each luminaire snaps to its pole and one
lamp is emitted per pole and kind. Wooden poles become `utility_pole` POIs whether or not they carry a lamp.

The survey does not cover every neighbourhood (most of Southside is missing), so the renderer cannot drop its
procedural roadside lamps everywhere. Roads that run close to surveyed luminaires for most of their length get
`lamps_surveyed`; the renderer only places procedural lamps on the others.
"""
from __future__ import annotations

import math

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

from config import CRS_PROJ

SNAP_M = 3.0          # luminaire fix -> pole
OSM_DUP_M = 12.0      # an OSM street_lamp this close to a surveyed luminaire is the same lamp
COVER_M = 60.0        # a road sample this close to a surveyed luminaire is covered by the survey
COVER_FRAC = 0.8      # share of a road's samples that must be covered
SAMPLE_M = 10.0
# The surveyed poles stand at the curb, but rendered carriageways are centreline x OSM width, so a quarter of the
# fixes land on the asphalt. Push them just past the rendered edge; one needing a longer move than MAX_SHIFT_M is a
# median pole on a boulevard mapped as one way, or a bad fix, and is dropped.
CURB_CLEARANCE_M = 0.6
MAX_SHIFT_M = 4.0
NOT_CARRIAGEWAY = {"footway", "path", "track", "cycleway", "steps", "pedestrian", "corridor", "bridleway"}
FT = 0.3048
# Decorative post-top fixtures (Richmond's Hanover and Granville lanterns, the Fan gaslights, the Canal
# Walk and district-specific posts). Everything else is an arm-mounted cobrahead, shoebox or flood.
POST_TOP_FIXTURES = {"Hanover", "Granville", "MA", "CDA", "Sentry", "CanalWalk", "5thStBr", "WindsorFarms", "Gaslight"}
WOOD = {"Creosote Wood", "Salt Treated Wood"}


def _above_ground_m(height_ft, length_ft) -> float:
    """Surveyed height above ground, else the pole length less the usual 10% + 2 ft setting depth."""
    if isinstance(height_ft, (int, float)) and math.isfinite(height_ft) and height_ft > 0:
        return round(height_ft * FT, 2)
    if isinstance(length_ft, (int, float)) and math.isfinite(length_ft) and length_ft > 0:
        return round((0.9 * length_ft - 2) * FT, 2)
    return math.nan


def lamp_kind(luminaire_type, fixture) -> str:
    return "lamp_post" if luminaire_type == "Pedestrian" or fixture in POST_TOP_FIXTURES else "streetlight"


def survey_pois(luminaires: gpd.GeoDataFrame, poles: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Surveyed lamps (snapped to their poles, one per pole and kind) plus every wooden pole."""
    lum = luminaires.to_crs(CRS_PROJ)
    pol = poles.to_crs(CRS_PROJ)
    lxy = np.c_[lum.geometry.x, lum.geometry.y]
    pxy = np.c_[pol.geometry.x, pol.geometry.y]
    kind = [lamp_kind(t, f) for t, f in zip(lum["LuminaireType"], lum["FixtureType"])]
    if len(pxy) and len(lxy):
        dist, idx = cKDTree(pxy).query(lxy)
        snapped = dist <= SNAP_M
    else:
        idx, snapped = np.zeros(len(lxy), int), np.zeros(len(lxy), bool)
    xy = np.where(snapped[:, None], pxy[idx] if len(pxy) else lxy, lxy)
    lamps = pd.DataFrame({
        "id": [f"cor_luminaire:{o}" for o in lum["OBJECTID"]],
        "kind": kind,
        # a pole carrying two luminaires of one kind is one lamp; unsnapped fixes dedupe on a 0.5 m grid
        "key": [f"p{idx[i]}" if snapped[i] else f"{round(xy[i, 0] * 2)}_{round(xy[i, 1] * 2)}" for i in range(len(lxy))],
        "x": xy[:, 0], "y": xy[:, 1],
    }).drop_duplicates(["key", "kind"]).drop(columns="key")
    lamps["pole_height"] = math.nan

    wood = pol[pol["Material"].isin(WOOD)]
    utility = pd.DataFrame({
        "id": [f"cor_pole:{o}" for o in wood["OBJECTID"]], "kind": "utility_pole",
        "x": wood.geometry.x.values, "y": wood.geometry.y.values,
        "pole_height": [_above_ground_m(h, l) for h, l in zip(wood["PoleHeight"], wood["PoleLength"])],
    })
    out = pd.concat([lamps, utility], ignore_index=True)
    return gpd.GeoDataFrame(out.drop(columns=["x", "y"]).assign(name=None, source="city_survey"),
                            geometry=gpd.points_from_xy(out["x"], out["y"]), crs=CRS_PROJ)


def clear_carriageways(survey: gpd.GeoDataFrame, roads: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Move survey points off rendered carriageways to CURB_CLEARANCE_M past the edge; drop far misses."""
    tunnel = roads["tunnel"].fillna(False).astype(bool) if "tunnel" in roads else False
    car = roads[~roads["highway"].isin(NOT_CARRIAGEWAY) & ~tunnel & roads["width"].notna()]
    if len(car) == 0 or len(survey) == 0:
        return survey
    paved = shapely.union_all(car.geometry.buffer(car["width"].to_numpy() / 2 + CURB_CLEARANCE_M).to_numpy())
    shapely.prepare(paved)
    x, y = survey.geometry.x.to_numpy(), survey.geometry.y.to_numpy()
    inside = shapely.contains_xy(paved, x, y)
    if not inside.any():
        return survey
    lines = shapely.shortest_line(survey.geometry.to_numpy()[inside], paved.boundary)
    shift = shapely.length(lines)
    ends = shapely.get_point(lines, 1)
    out = survey.copy()
    geoms = out.geometry.to_numpy().copy()
    geoms[np.flatnonzero(inside)] = ends
    out = out.set_geometry(geoms)
    keep = np.ones(len(out), bool)
    keep[np.flatnonzero(inside)[shift > MAX_SHIFT_M]] = False
    print(f"  streetlights: moved {int((shift <= MAX_SHIFT_M).sum())} off carriageways, dropped {int((~keep).sum())}")
    return out[keep]


def merge_survey(pois: gpd.GeoDataFrame, survey: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Add surveyed lamps and poles; drop OSM street lamps the survey already has."""
    lamps = survey[survey["kind"].isin(("streetlight", "lamp_post"))]
    osm_lamp = (pois["kind"] == "streetlight").to_numpy()
    if osm_lamp.any() and len(lamps):
        pts = np.c_[pois.geometry.x, pois.geometry.y][osm_lamp]
        dist, _ = cKDTree(np.c_[lamps.geometry.x, lamps.geometry.y]).query(pts)
        drop = np.zeros(len(pois), bool)
        drop[np.flatnonzero(osm_lamp)[dist <= OSM_DUP_M]] = True
        pois = pois[~drop]
    return gpd.GeoDataFrame(pd.concat([pois, survey], ignore_index=True), crs=CRS_PROJ)


def mark_surveyed_roads(roads: gpd.GeoDataFrame, survey: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Flag roads that run within COVER_M of surveyed luminaires for at least COVER_FRAC of their length."""
    lamps = survey[survey["kind"].isin(("streetlight", "lamp_post"))]
    out = roads.copy()
    if len(lamps) == 0 or len(out) == 0:
        out["lamps_surveyed"] = False
        return out
    tree = cKDTree(np.c_[lamps.geometry.x, lamps.geometry.y])
    flags = []
    for geom in out.geometry:
        length = geom.length if geom is not None else 0
        if not length:
            flags.append(False)
            continue
        steps = np.linspace(0, length, max(2, int(length / SAMPLE_M) + 1))
        pts = np.array([(p.x, p.y) for p in (geom.interpolate(s) for s in steps)])
        dist, _ = tree.query(pts, distance_upper_bound=COVER_M)
        flags.append(bool(np.mean(np.isfinite(dist)) >= COVER_FRAC))
    out["lamps_surveyed"] = flags
    return out
