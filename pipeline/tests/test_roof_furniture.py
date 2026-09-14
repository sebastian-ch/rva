import json

import geopandas as gpd
import numpy as np
from shapely.geometry import box

from roof_furniture import attach, detect


def building():
    return gpd.GeoDataFrame({"id": ["osm:way/1"], "name": [None], "type": ["office"], "landmark": [None],
                             "roof_source": ["lidar"], "height": [10.0], "ground_z": [5.0]},
                            geometry=[box(0, 0, 20, 20)], crs="EPSG:32618").iloc[0]


def test_detects_compact_object_and_rejects_roof_edge_noise():
    xy = np.array([(x + 0.5, y + 0.5) for x in range(20) for y in range(20)])
    z = np.full(len(xy), 15.0)
    equipment = (xy[:, 0] >= 8) & (xy[:, 0] < 12) & (xy[:, 1] >= 7) & (xy[:, 1] < 10)
    z[equipment] = 17.0
    z[xy[:, 0] < 2] = 18.0

    props = detect(building(), np.c_[xy, z], cell=1.0)

    assert len(props) == 1
    assert props[0]["x"] == 10
    assert props[0]["y"] == 8.5
    assert props[0]["h"] == 2


def test_attach_uses_only_reviewed_exact_ids(tmp_path):
    buildings = gpd.GeoDataFrame({"id": ["osm:way/1", "osm:way/2"]},
                                 geometry=[box(0, 0, 1, 1), box(2, 0, 3, 1)], crs="EPSG:32618")
    supplement = tmp_path / "roof-props.json"
    supplement.write_text(json.dumps({"buildings": {
        "osm:way/1": [{"x": 0.5, "y": 0.5, "w": 2, "d": 2, "h": 1, "a": 0, "b": 0}],
        "missing": [{"x": 4, "y": 4, "w": 2, "d": 2, "h": 1, "a": 0, "b": 0}],
    }}))

    result = attach(buildings, supplement).set_index("id")

    assert json.loads(result.loc["osm:way/1", "roof_props"])[0]["x"] == 0.5
    assert result.loc["osm:way/2", "roof_props"] is None


def test_attach_rejects_parent_object_buried_by_existing_part(tmp_path):
    buildings = gpd.GeoDataFrame({
        "id": ["osm:way/parent", "osm:way/part"],
        "parent": [None, "osm:way/parent"],
        "ground_z": [5.0, 5.0],
        "height": [10.0, 20.0],
    }, geometry=[box(0, 0, 20, 20), box(5, 5, 15, 15)], crs="EPSG:32618")
    supplement = tmp_path / "roof-props.json"
    supplement.write_text(json.dumps({"buildings": {
        "osm:way/parent": [{"x": 10, "y": 10, "w": 8, "d": 6, "h": 4, "a": 0, "b": 0}],
    }}))

    result = attach(buildings, supplement).set_index("id")

    assert result.loc["osm:way/parent", "roof_props"] is None
