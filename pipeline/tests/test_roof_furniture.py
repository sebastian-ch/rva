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


def test_small_height_error_seats_objects_on_modeled_roof_and_large_error_rejects():
    xy = np.array([(x + 0.5, y + 0.5) for x in range(20) for y in range(20)])
    equipment = (xy[:, 0] >= 8) & (xy[:, 0] < 12) & (xy[:, 1] >= 7) & (xy[:, 1] < 10)

    def props_for(plane):
        z = np.full(len(xy), plane)
        z[equipment] = plane + 2
        return detect(building(), np.c_[xy, z], cell=1.0)

    near = props_for(16.2)  # modeled wall top is 15: a 1.2 m height error, same roof
    assert len(near) == 1 and near[0]["b"] == 0 and near[0]["h"] == 2
    assert props_for(17.0) == []  # 2 m off: probably an unmodeled tier


def test_review_seats_on_roofer_mesh_and_drops_objects_it_already_models():
    from types import SimpleNamespace

    from roof_furniture_review import settle

    mesh = {"v": [[0, 0, 0.4], [20, 0, 0.4], [20, 20, 0.4], [0, 20, 0.4],
                  [8, 7, 2.4], [12, 7, 2.4], [12, 10, 2.4], [8, 10, 2.4]],
            "f": [[[0, 1, 2, 3]], [[4, 5, 6, 7]]]}
    row = SimpleNamespace(roof_source="lod2", lod2_roof=json.dumps(mesh))
    open_roof = {"x": 3, "y": 3, "w": 2, "d": 2, "h": 2, "a": 0, "b": 0.0}
    modeled = {"x": 10, "y": 8.5, "w": 4, "d": 3, "h": 2, "a": 0, "b": 0.0}

    kept, dropped = settle(row, [open_roof, modeled])

    assert dropped == 1
    assert kept == [{**open_roof, "b": 0.4}]


def test_review_skips_roofs_under_parking_polygons():
    from roof_furniture_review import eligible

    buildings = gpd.GeoDataFrame({"id": ["deck", "office"], "roof_shape": ["flat", "flat"], "hidden": [False, False]},
                                 geometry=[box(0, 0, 30, 30), box(40, 0, 70, 30)], crs="EPSG:32618")
    landuse = gpd.GeoDataFrame({"kind": ["parking"]}, geometry=[box(-1, -1, 31, 31)], crs="EPSG:32618")

    assert list(eligible(buildings, 300, landuse)["id"]) == ["office"]
