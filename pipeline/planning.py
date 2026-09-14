"""Normalize planning inputs without confusing limits with observed buildings.

The renderer's building table describes what exists.  This module creates a
separate parcel-level contract for zoning/buildout rules that may describe a
future scenario.  Source-specific names stay at this boundary.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd


RULE_FIELDS = {
    "max_height_m": "HeightMax",
    "max_floors": "NumFloorsMax",
    "max_coverage_ratio": "CoverageMax",
    "max_far": "FARMax",
    "tiers_json": "Tiers",
    "skyplanes_json": "Skyplanes",
}


def _records(path: Path) -> list[dict[str, Any]]:
    doc = json.loads(path.read_text())
    if "error" in doc:
        raise ValueError(f"{path}: {doc['error']}")
    return [feature.get("attributes", feature) for feature in doc.get("features", [])]


def _clean_json(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)) or value == "":
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return value
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def normalize_arcgis_urban(
    parcels: gpd.GeoDataFrame,
    zones: gpd.GeoDataFrame,
    zone_types: list[dict[str, Any]],
    *,
    branch_id: str,
    branch_name: str,
    source_url: str,
) -> gpd.GeoDataFrame:
    """Return canonical parcel constraints for one ArcGIS Urban branch.

    A value stored directly on a parcel wins over its zone-type default.  The
    `provenance` object records that decision independently for every field.
    """
    selected = zones[zones["BranchID"].astype(str).str.lower() == branch_id.lower()].copy()
    if selected.empty:
        raise ValueError(f"branch {branch_id!r} has no zone polygons")
    if parcels.crs is None or selected.crs is None:
        raise ValueError("parcel and zone CRS must be declared")
    selected = selected.to_crs(parcels.crs)
    points = gpd.GeoDataFrame(
        {"geometry": parcels.geometry.representative_point()}, index=parcels.index, crs=parcels.crs
    )
    joined = gpd.sjoin(
        points, selected[["ZoneTypeID", "PlanningMethod", "PlanningHorizon", "geometry"]],
        how="left", predicate="within",
    )
    if joined.index.duplicated().any():
        raise ValueError(f"branch {branch_id!r} contains overlapping zone polygons")

    types = {str(row["GlobalID"]).lower(): row for row in zone_types}
    rows: list[dict[str, Any]] = []
    for idx, parcel in parcels.iterrows():
        match = joined.loc[idx]
        zone_id = match.get("ZoneTypeID")
        zone = types.get(str(zone_id).lower()) if pd.notna(zone_id) else None
        provenance: dict[str, str] = {}
        values: dict[str, Any] = {}
        for canonical, source_field in RULE_FIELDS.items():
            direct = parcel.get(source_field)
            inherited = zone.get(source_field) if zone else None
            value = direct if pd.notna(direct) else inherited
            if canonical.endswith("_json"):
                value = _clean_json(value)
            elif value is not None and not pd.isna(value):
                value = float(value)
            else:
                value = None
            values[canonical] = value
            if value is not None:
                provenance[canonical] = "parcel" if pd.notna(direct) else "zone_type"

        parcel_id = parcel.get("GlobalID") or parcel.get("OBJECTID")
        rows.append({
            "id": f"arcgis-urban:parcel/{parcel_id}",
            "source": "arcgis_urban",
            "source_url": source_url,
            "source_feature_id": str(parcel_id),
            "scenario": branch_name,
            "planning_method": match.get("PlanningMethod") if pd.notna(match.get("PlanningMethod")) else None,
            "planning_horizon": match.get("PlanningHorizon") if pd.notna(match.get("PlanningHorizon")) else None,
            "is_proposal": bool(zone.get("Proposal")) if zone else None,
            "zone_code": zone.get("Label") if zone else None,
            "zone_name": zone.get("ZoneTypeName") if zone else None,
            "develop": bool(parcel.get("Develop")) if pd.notna(parcel.get("Develop")) else None,
            "development_type": parcel.get("DevelopmentType") if pd.notna(parcel.get("DevelopmentType")) else None,
            "building_type_id": parcel.get("BuildingTypeID") if pd.notna(parcel.get("BuildingTypeID")) else None,
            **values,
            "provenance": json.dumps(provenance, separators=(",", ":"), sort_keys=True),
            "geometry": parcel.geometry,
        })
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=parcels.crs)


def build_manchester_constraints(raw_dir: Path, output: Path, branch_name: str = "Scenario 1") -> gpd.GeoDataFrame:
    """Build the reviewed Manchester ArcGIS Urban planning companion table."""
    branches = _records(raw_dir / "layer_7.json")
    branch = next((row for row in branches if row.get("BranchName") == branch_name), None)
    if branch is None:
        raise ValueError(f"unknown branch {branch_name!r}; choices: {[x.get('BranchName') for x in branches]}")
    parcels = gpd.read_file(raw_dir / "layer_4.geojson")
    zones = gpd.read_file(raw_dir / "layer_1.geojson")
    result = normalize_arcgis_urban(
        parcels, zones, _records(raw_dir / "layer_9.json"),
        branch_id=branch["GlobalID"], branch_name=branch_name,
        source_url="https://www.arcgis.com/home/item.html?id=494a43abc50d4e30a8426dbfb4fcfd2d",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    result.to_parquet(output)
    return result

