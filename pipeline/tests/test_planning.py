from __future__ import annotations

import json

import geopandas as gpd
import pytest
from shapely.geometry import box

from planning import normalize_arcgis_urban


def test_arcgis_urban_normalizes_inherited_rules_and_parcel_overrides():
    branch = "branch-1"
    parcels = gpd.GeoDataFrame({
        "GlobalID": ["p1", "p2"], "HeightMax": [None, 40.0], "NumFloorsMax": [None, None],
        "CoverageMax": [None, None], "FARMax": [None, None], "Tiers": [None, None],
        "Skyplanes": [None, None], "Develop": [0, 1], "DevelopmentType": ["None", "Custom"],
        "BuildingTypeID": [None, "bt1"], "geometry": [box(0, 0, 10, 10), box(10, 0, 20, 10)],
    }, crs="EPSG:32618")
    zones = gpd.GeoDataFrame({
        "BranchID": [branch], "ZoneTypeID": ["zone-1"], "PlanningMethod": ["zoning"],
        "PlanningHorizon": ["future"], "geometry": [box(0, -1, 21, 11)],
    }, crs=parcels.crs)
    zone_types = [{
        "GlobalID": "zone-1", "Proposal": 1, "Label": "MX-1", "ZoneTypeName": "Mixed use",
        "HeightMax": 30.0, "NumFloorsMax": 8, "CoverageMax": .8, "FARMax": 5,
        "Tiers": '[{"startHeight":0}]', "Skyplanes": None,
    }]

    out = normalize_arcgis_urban(parcels, zones, zone_types, branch_id=branch,
                                  branch_name="Scenario 1", source_url="https://example.test")
    assert list(out.max_height_m) == [30.0, 40.0]
    assert list(out.max_floors) == [8.0, 8.0]
    assert out.iloc[0].max_coverage_ratio == pytest.approx(.8)
    assert json.loads(out.iloc[0].tiers_json) == [{"startHeight": 0}]
    assert json.loads(out.iloc[0].provenance)["max_height_m"] == "zone_type"
    assert json.loads(out.iloc[1].provenance)["max_height_m"] == "parcel"
    assert out.iloc[0].scenario == "Scenario 1" and bool(out.iloc[0].is_proposal)


def test_arcgis_urban_rejects_overlapping_zones_in_one_branch():
    parcels = gpd.GeoDataFrame({"GlobalID": ["p1"], "geometry": [box(0, 0, 1, 1)]}, crs="EPSG:32618")
    zones = gpd.GeoDataFrame({
        "BranchID": ["b", "b"], "ZoneTypeID": ["z1", "z2"],
        "PlanningMethod": ["zoning", "zoning"], "PlanningHorizon": ["future", "future"],
        "geometry": [box(-1, -1, 2, 2), box(-1, -1, 2, 2)],
    }, crs=parcels.crs)
    with pytest.raises(ValueError, match="overlapping zone polygons"):
        normalize_arcgis_urban(parcels, zones, [], branch_id="b", branch_name="test", source_url="x")
